// stripe-create-payment-intent — a diner pays a branch by card, into the branch's own Stripe account.
//
// Stripe Connect, Standard-type accounts, DIRECT CHARGES (docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md).
// Every PaymentIntent this function creates lives on the order's branch's connected account (the
// Stripe-Account header), for exactly the order's server-side total, with no application fee: the
// charge, its fee, its payout, refunds and disputes are the branch's, and the platform takes nothing.
//
// It REPLACES the old function of the same name, which created the intent on the platform's own
// account: with STRIPE_SECRET_KEY set for the subscription billing, that sent diners' money to the
// platform. That path is gone. Every call to Stripe below goes through stripeApi(), which will not
// run without a connected account id read from the database, so there is no way left to charge the
// platform account from here (rule 1 of the decision doc).
//
// Actions (POST, JSON body; the caller is the signed-in diner who placed the order):
//
//   { action: 'config', branch_id }
//       Before any order exists. The checkout mounts Stripe's Payment Element in deferred-intent
//       mode, which needs the publishable key and the branch's connected account up front.
//       → 200 { publishable_key, stripe_account }        409 card_not_ready
//
//   { order_id }                     (action 'create', the default)
//       Create — or hand out again — the PaymentIntent for the order's pending card payment.
//       Idempotent: the same order and payment always get the same intent back, and a payment
//       never gets a second one.
//       → 200 { state: 'awaiting', client_secret, publishable_key, stripe_account, amount, currency,
//               payment_intent_id }        (amount in cents)
//       → 200 { state: 'paid' | 'processing', payment_intent_id }  Stripe has the money or is taking it
//       → 409 already_paid | order_not_payable | not_awaiting_card_payment | payment_window_expired
//             | card_not_ready | payment_mismatch | payment_in_progress        400 amount_too_small
//
//   { action: 'status', order_id }
//       Re-read the order's PaymentIntent from Stripe, server side, and apply it through
//       public.stripe_connect_apply_payment_intent — the same SQL the Connect webhook applies events
//       with — so a diner back from 3-D Secure is not left waiting for a slow webhook: a success
//       completes the payment and releases the order to the kitchen, a decline marks it failed, a
//       payment in flight is noted (the 30-minute expiry leaves those alone). A late payment for a
//       closed order is refunded by the webhook, which receives the same success.
//       → 200 { state: 'paid' | 'processing' | 'failed' | 'awaiting' | 'canceled', failure_code,
//               payment_status, order_status, payment_intent_id }
//
// Without STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY every action answers 503
// stripe_not_configured. Deployed with verify_jwt on or off alike: the diner's JWT is checked here.
//
// Pure decisions live in ./logic.ts, pinned by apps/web/src/lib/card-payment-edge.test.ts. A
// Management API / MCP deploy passes logic.ts and _shared/entitlements.ts with this file.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  edgeHasFeature,
  edgeOwnsFeature,
  featureNotEntitledBody,
  loadEntitlements,
} from '../_shared/entitlements.ts';
import {
  accountReady,
  cardPaymentRefusal,
  decideExistingIntent,
  dinerStateAfterApply,
  failureCode,
  GATE_STATUS,
  PAYMENT_INTENT_ID,
  paymentIntentIdempotencyKey,
  paymentIntentParams,
  STRIPE_ACCOUNT_ID,
  toCents,
  type AppliedIntent,
  type ExpectedCharge,
  type IntentSnapshot,
} from './logic.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/** Pinned everywhere we talk to Stripe (stripe-webhook, the Connect functions). A mismatch changes
 *  payload shapes, and stripe_connect_apply_payment_intent reads this version's PaymentIntent. */
const STRIPE_API_VERSION = '2025-08-27.basil';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

interface OrderRow {
  id: string;
  order_number: string;
  branch_id: string;
  customer_id: string | null;
  status: string;
  total: number | string;
  awaiting_payment: boolean | null;
  created_at: string;
  source: string | null;
}

interface PaymentRow {
  id: string;
  method: string;
  status: string;
  amount: number | string;
  gateway: string | null;
  gateway_charge_id: string | null;
  gateway_metadata: Record<string, unknown> | null;
}

interface AccountRow {
  stripe_account_id: string | null;
  charges_enabled: boolean | null;
}

type Intent = IntentSnapshot & { client_secret?: string };

type StripeResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; error: Record<string, unknown> };

/**
 * The one way this function talks to Stripe, and always AS the connected account.
 *
 * `account` is required and must look like a Stripe account id; without it nothing is sent. That
 * is the structural half of "the platform account is never charged for a diner": there is no call
 * in this file that could reach the platform's own balance.
 */
async function stripeApi(
  secretKey: string,
  account: string,
  method: 'GET' | 'POST',
  path: string,
  body?: URLSearchParams,
  idempotencyKey?: string,
): Promise<StripeResult> {
  if (!STRIPE_ACCOUNT_ID.test(account)) {
    return { ok: false, status: 0, error: { code: 'no_connected_account' } };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Stripe-Version': STRIPE_API_VERSION,
    'Stripe-Account': account,
  };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com${path}`, { method, headers, body });
  } catch (e) {
    return { ok: false, status: 0, error: { code: 'network_error', message: (e as Error)?.message ?? '' } };
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON answer (an outage page) is an error either way.
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: (data.error as Record<string, unknown>) ?? {} };
  }
  return { ok: true, data };
}

function retrieveIntent(secretKey: string, account: string, id: string) {
  return stripeApi(secretKey, account, 'GET', `/v1/payment_intents/${encodeURIComponent(id)}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // Read per request, so keys the owner sets after a deploy are picked up without a redeploy.
  const secretKey = Deno.env.get('STRIPE_SECRET_KEY');
  const publishableKey = Deno.env.get('STRIPE_PUBLISHABLE_KEY');
  if (!secretKey || !publishableKey) return json(503, { error: 'stripe_not_configured' });

  let body: { action?: unknown; order_id?: unknown; branch_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const action = body.action === undefined ? 'create' : body.action;
  if (action !== 'create' && action !== 'status' && action !== 'config') {
    return json(400, { error: 'invalid_action' });
  }

  const header = req.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return json(401, { error: 'auth_required' });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  // `Bearer <publishable key>` (a signed-out browser) resolves to no user and is refused here.
  const { data: { user } } = await admin.auth.getUser(header.slice(7).trim());
  if (!user) return json(401, { error: 'auth_required' });

  if (action === 'config') {
    const branchId = typeof body.branch_id === 'string' ? body.branch_id : '';
    if (!UUID.test(branchId)) return json(400, { error: 'branch_id_required' });
    const account = await loadAccount(admin, branchId);
    if (!accountReady(account)) return json(409, { error: 'card_not_ready' });
    // A new order needs the restaurant to be paid up, as place-order asks it.
    const ent = await loadEntitlements(admin, { branchId });
    if (!edgeHasFeature(ent, 'card_payment')) return json(403, featureNotEntitledBody('card_payment'));
    return json(200, { publishable_key: publishableKey, stripe_account: account.stripe_account_id });
  }

  const orderId = typeof body.order_id === 'string' ? body.order_id : '';
  if (!UUID.test(orderId)) return json(400, { error: 'order_id_required' });

  const loaded = await loadDinerOrder(admin, orderId, user.id);
  if (!loaded) return json(404, { error: 'order_not_found' });
  const { order, payment } = loaded;
  const account = await loadAccount(admin, order.branch_id);

  if (action === 'status') return await handleStatus(admin, secretKey, order, payment, account);
  return await handleCreate(admin, secretKey, publishableKey, order, payment, account);
});

/** The branch's connected account. Service role only: the table is never written by a client. */
async function loadAccount(admin: SupabaseClient, branchId: string): Promise<AccountRow | null> {
  const { data, error } = await admin
    .from('branch_payment_accounts')
    .select('stripe_account_id, charges_enabled')
    .eq('branch_id', branchId)
    .maybeSingle();
  if (error) {
    // Fail closed: an unreadable account is not a card-ready one.
    console.error('branch_payment_account_read_failed', { branch_id: branchId, detail: error.message });
    return null;
  }
  return (data as AccountRow | null) ?? null;
}

/**
 * The order, if the caller is the diner who placed it, with its card payment.
 *
 * Ownership is the order's customer record belonging to this login (customers are one row per
 * branch and user). Anything else — another diner's order, a counter sale, an order id that does
 * not exist — is the same 404, so an order id proves nothing to someone who guessed it.
 */
async function loadDinerOrder(
  admin: SupabaseClient,
  orderId: string,
  userId: string,
): Promise<{ order: OrderRow; payment: PaymentRow | null } | null> {
  const { data: order } = await admin
    .from('orders')
    .select('id, order_number, branch_id, customer_id, status, total, awaiting_payment, created_at, source')
    .eq('id', orderId)
    .maybeSingle();
  const o = order as OrderRow | null;
  if (!o || !o.customer_id || (o.source ?? 'web') !== 'web') return null;
  const { data: customer } = await admin.from('customers').select('user_id').eq('id', o.customer_id).maybeSingle();
  if ((customer as { user_id: string | null } | null)?.user_id !== userId) return null;
  const { data: payments } = await admin
    .from('payments')
    .select('id, method, status, amount, gateway, gateway_charge_id, gateway_metadata')
    .eq('order_id', o.id)
    .eq('method', 'card')
    .order('created_at', { ascending: false })
    .limit(1);
  return { order: o, payment: ((payments ?? [])[0] as PaymentRow | undefined) ?? null };
}

/**
 * The account a payment's intent lives on: the one recorded on the payment (place-order records
 * it at order time, and this function when it creates the intent), else the branch's current one.
 * stripe_connect_apply_payment_intent checks the same account, in the same order.
 */
function accountOf(payment: PaymentRow, account: AccountRow | null): string | null {
  const recorded = payment.gateway_metadata?.stripe_account;
  if (typeof recorded === 'string' && STRIPE_ACCOUNT_ID.test(recorded)) return recorded;
  const current = account?.stripe_account_id ?? null;
  return current && STRIPE_ACCOUNT_ID.test(current) ? current : null;
}

/**
 * Apply a PaymentIntent as Stripe has it now, through the same SQL the Connect webhook uses: a
 * success completes the payment and confirms the order (which clears awaiting_payment for the
 * kitchen), a decline marks it failed, anything else is only noted. Idempotent with the webhook
 * applying the same object; a completed payment is never moved back. Null when the database could
 * not be reached — the caller then says "processing" and the webhook records it.
 */
async function applyIntent(
  admin: SupabaseClient,
  stripeAccount: string,
  intent: Record<string, unknown>,
): Promise<AppliedIntent | null> {
  const { data, error } = await admin.rpc('stripe_connect_apply_payment_intent', {
    p_account: stripeAccount,
    p_intent: intent,
  });
  if (error) {
    console.error('apply_payment_intent_failed', { payment_intent: intent.id, detail: error.message });
    return null;
  }
  const applied = (data ?? null) as AppliedIntent | null;
  if (applied && !applied.ok) {
    console.error('apply_payment_intent_refused', { payment_intent: intent.id, error: applied.error });
  } else if (applied?.action === 'refund_required') {
    // The Connect webhook receives the same success and refunds it (idempotency key
    // late_payment_refund:<pi>). Not duplicated here: a second caller with different parameters
    // on that key would make Stripe refuse the webhook's own refund.
    console.warn('card_paid_for_closed_order', { payment_intent: intent.id, order_status: applied.order_status });
  }
  return applied;
}

async function handleStatus(
  admin: SupabaseClient,
  secretKey: string,
  order: OrderRow,
  payment: PaymentRow | null,
  account: AccountRow | null,
): Promise<Response> {
  if (!payment) return json(404, { error: 'payment_not_found' });
  const base = { order_status: order.status, payment_status: payment.status };
  if (payment.status === 'completed' || payment.status === 'refunded') {
    return json(200, { ...base, state: 'paid', failure_code: null, payment_intent_id: payment.gateway_charge_id });
  }
  const piId = payment.gateway_charge_id;
  if (payment.gateway !== 'stripe' || !piId || !PAYMENT_INTENT_ID.test(piId)) {
    // No attempt has been started yet.
    return json(200, { ...base, state: 'awaiting', failure_code: null, payment_intent_id: null });
  }
  const onAccount = accountOf(payment, account);
  if (!onAccount) return json(409, { error: 'card_not_ready' });
  const got = await retrieveIntent(secretKey, onAccount, piId);
  if (!got.ok) {
    console.error('stripe_retrieve_failed', { payment_intent: piId, status: got.status, code: got.error.code });
    return json(502, { error: 'stripe_error', stripe_code: got.error.code ?? null });
  }
  const pi = got.data as unknown as Intent;
  const applied = await applyIntent(admin, onAccount, got.data);
  const state = dinerStateAfterApply(pi, applied);
  return json(200, {
    state,
    failure_code: state === 'failed' ? failureCode(pi) : null,
    payment_status: applied?.ok && applied.status ? applied.status : payment.status,
    order_status: applied?.ok && applied.order_status ? applied.order_status : order.status,
    payment_intent_id: pi.id,
  });
}

async function handleCreate(
  admin: SupabaseClient,
  secretKey: string,
  publishableKey: string,
  order: OrderRow,
  payment: PaymentRow | null,
  account: AccountRow | null,
): Promise<Response> {
  const refusal = cardPaymentRefusal({ order, payment, account, nowMs: Date.now() });
  if (refusal) return json(GATE_STATUS[refusal], { error: refusal, ...(refusal === 'already_paid' ? { state: 'paid' } : {}) });
  // cardPaymentRefusal proved all three; the narrowing is for the compiler.
  if (!payment || !accountReady(account)) return json(409, { error: 'card_not_ready' });

  // Card payment is a paid feature. Gated on the feature, not on `entitled`: an order placed while
  // the account was live must still be payable, or the restaurant loses money it has already
  // agreed to take.
  const ent = await loadEntitlements(admin, { branchId: order.branch_id });
  if (!edgeOwnsFeature(ent, 'card_payment')) return json(403, featureNotEntitledBody('card_payment'));

  const cents = toCents(order.total)!;
  // The payment row was written by place-order with the order's total. If the two ever disagree,
  // charging either one would be a guess.
  if (toCents(payment.amount) !== cents) {
    console.error('payment_amount_mismatch', { order_id: order.id, payment_id: payment.id });
    return json(409, { error: 'payment_mismatch' });
  }
  const expected: ExpectedCharge = { cents, orderId: order.id, paymentId: payment.id };

  // An intent already made for this payment: hand it out again, or report where it stands. A
  // payment never gets a second intent (see decideExistingIntent for why).
  const existingId = payment.gateway_charge_id;
  if (existingId && PAYMENT_INTENT_ID.test(existingId)) {
    // Where it was made. If the branch has connected another account since, the intent is still on
    // the old one — still the branch's own account — and is paid there.
    const onAccount = accountOf(payment, account) ?? account.stripe_account_id;
    const got = await retrieveIntent(secretKey, onAccount, existingId);
    if (!got.ok) {
      console.error('stripe_retrieve_failed', { payment_intent: existingId, status: got.status, code: got.error.code });
      return got.error.code === 'resource_missing'
        ? json(409, { error: 'payment_mismatch' })
        : json(502, { error: 'stripe_error', stripe_code: got.error.code ?? null });
    }
    const pi = got.data as unknown as Intent;
    switch (decideExistingIntent(pi, expected)) {
      case 'reuse':
        return json(200, clientSecretBody(pi, publishableKey, onAccount, cents));
      case 'succeeded': {
        const applied = await applyIntent(admin, onAccount, got.data);
        return json(200, { state: dinerStateAfterApply(pi, applied), payment_intent_id: pi.id });
      }
      case 'processing':
        // Noted on the payment too, so the 30-minute expiry leaves an order whose money is on its
        // way alone.
        await applyIntent(admin, onAccount, got.data);
        return json(200, { state: 'processing', payment_intent_id: pi.id });
      case 'canceled':
        // Cancelled at Stripe; the webhook voids the payment. Nothing is left to pay.
        await applyIntent(admin, onAccount, got.data);
        return json(409, { error: 'not_awaiting_card_payment' });
      default:
        console.error('existing_intent_mismatch', { order_id: order.id, payment_intent: pi.id, status: pi.status });
        return json(409, { error: 'payment_mismatch' });
    }
  }

  const stripeAccount = account.stripe_account_id;
  const created = await stripeApi(
    secretKey,
    stripeAccount,
    'POST',
    '/v1/payment_intents',
    paymentIntentParams({
      cents,
      orderId: order.id,
      orderNumber: order.order_number,
      paymentId: payment.id,
      branchId: order.branch_id,
    }),
    paymentIntentIdempotencyKey(payment.id, stripeAccount),
  );
  if (!created.ok) {
    console.error('stripe_create_failed', {
      order_id: order.id,
      status: created.status,
      code: created.error.code,
      message: created.error.message,
    });
    // Two requests racing on one idempotency key: the second is told to try again in a moment.
    if (created.error.code === 'idempotency_key_in_use') return json(409, { error: 'payment_in_progress' });
    return json(502, { error: 'stripe_error', stripe_code: created.error.code ?? null });
  }
  const pi = created.data as unknown as Intent;

  // Store the intent on the payment BEFORE handing its secret out: the webhook finds the payment by
  // this id, and a payment nobody can find is money nobody records. Only onto a payment still
  // waiting and with no other intent: two racing requests share one idempotency key and so write
  // the same id. If nothing was written, the payment changed under us (expired, cancelled): the
  // new intent is cancelled, so it can never take money for a payment that is not waiting.
  const { data: stored, error: storeErr } = await admin
    .from('payments')
    .update({
      gateway: 'stripe',
      gateway_charge_id: pi.id,
      gateway_metadata: {
        ...(payment.gateway_metadata ?? {}),
        stripe_account: stripeAccount,
        payment_intent: pi.id,
      },
    })
    .eq('id', payment.id)
    .in('status', ['pending', 'failed'])
    .or(`gateway_charge_id.is.null,gateway_charge_id.eq.${pi.id}`)
    .select('id');
  if (storeErr || (stored ?? []).length === 0) {
    console.error('payment_intent_store_failed', { payment_id: payment.id, payment_intent: pi.id, detail: storeErr?.message ?? 'no_row' });
    if (!storeErr) {
      const cancelled = await stripeApi(secretKey, stripeAccount, 'POST', `/v1/payment_intents/${encodeURIComponent(pi.id)}/cancel`, new URLSearchParams());
      if (!cancelled.ok) console.error('orphan_intent_cancel_failed', { payment_intent: pi.id, code: cancelled.error.code });
      return json(409, { error: 'not_awaiting_card_payment' });
    }
    // A database error: the diner is refused, and a retry gets the same intent back from Stripe
    // (same key) and stores it then.
    return json(500, { error: 'payment_record_failed' });
  }
  return json(200, clientSecretBody(pi, publishableKey, stripeAccount, cents));
}

function clientSecretBody(pi: Intent, publishableKey: string, stripeAccount: string, cents: number) {
  return {
    state: 'awaiting',
    client_secret: pi.client_secret ?? null,
    publishable_key: publishableKey,
    stripe_account: stripeAccount,
    amount: cents,
    currency: 'usd',
    payment_intent_id: pi.id,
  };
}
