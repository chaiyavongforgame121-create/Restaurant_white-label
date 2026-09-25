// stripe-refund — give a diner's card payment back, on the branch's own Stripe account.
//
// POST { order_id, amount?, reason?, idempotency_key?, cancel? }
//   amount           dollars; left out, everything that can still be refunded goes back
//   reason           the operator's own words, stored with the refund and in Stripe's metadata
//   idempotency_key  a random id the back office makes once per refund it means to issue and
//                    keeps across retries of that refund (see refundIdempotencyKey)
//   cancel           true: refund whatever is left AND cancel the order, as the caller, with
//                    `reason` as the cancellation reason. No amount may be given.
//
// → 200 { ok: true, refund_id, amount, stripe_status, recorded }
// → 200 { ok: true, cancelled: true, refund_id | null, amount, stripe_status | null, recorded }  (cancel)
// → 4xx/5xx { error, ... }  (codes below; card-refund.ts in the back office words them)
//
// Why this exists (docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md): a diner's card payment is a
// DIRECT charge on the branch's connected Stripe account. The money, the fee, any refund and any
// dispute all live in that account; the platform never holds it. So a refund is made there, with
// the Stripe-Account header, and nowhere else. refund_order only ever changed the order's status
// (its comment pointed at an Omise "refund-payment" function that never existed), so before this
// a "refund" in the back office told the owner money went back when none did.
//
// What it does, in order:
//   1. The caller must hold orders.refund at the order's branch (my_capabilities, the rule RLS
//      and refund_order use): owner, admin or manager. With cancel: true, the right to cancel
//      instead (orders.cancel or kitchen.access, exactly as cancel_order): the kitchen's Reject
//      and a cancel from Orders or Live deliveries must be able to give the diner's money back as
//      part of the cancel, and that refund is always the whole remainder, never a chosen amount.
//   2. The order's paid Stripe card payment, and the account the charge lives on, are read with
//      the service role. The account is never taken from the request.
//   3. The PaymentIntent is read back from Stripe: it must have succeeded and must be this
//      order's, and its captured and already-refunded amounts cap the refund alongside our books.
//   4. The refund is created on the connected account with an idempotency key.
//   5. The refund is recorded in payment_refunds through stripe_connect_record_refund, the same
//      SQL the Connect webhook (stripe-connect-webhook) uses: 'pending' until Stripe settles it
//      ('succeeded' at once for most cards). The webhook moves it on from Stripe's own events and
//      records refunds made straight in the branch's Stripe Dashboard, so our table and Stripe
//      cannot drift apart.
//   6. Cancel only: cancel_order runs with the CALLER's token, so its own permission checks, the
//      status history ("by staff") and every cancel trigger (stock, points, credits, the delivery)
//      apply as for any cancel. Since 20260925120000 the database refuses to cancel a paid online
//      card order until payment_refunds covers it ('card_refund_required'); step 5 is what makes
//      that true, so the refund is always recorded before the cancel is asked for.
//
// Refund first, cancel second. The other way round, a refund Stripe refused would leave a
// cancelled order holding the diner's money. Refunded but not cancelled is the safe half-way state
// ('cancel_failed' below): the money is back and asking again only retries the cancel, because by
// then nothing is left to refund.
//
// Without cancel, the order's status and the audit trail are NOT touched here: the back office
// calls refund_order once this has answered ok, as it always has, so a refusal from Stripe can
// never be followed by an order that says "refunded".
//
// Not gated on the card_payment entitlement: a restaurant whose package lapsed must still be able
// to give a diner their money back.
//
// Error codes:
//   400 invalid_body | order_id_required | invalid_amount (also: an amount sent with cancel)
//   401 auth_required | invalid_token
//   403 not_authorized
//   404 order_not_found
//   409 not_paid_by_card | no_stripe_account | payment_not_settled | payment_mismatch
//       | nothing_to_refund | over_refund (with refundable, dollars)
//       | disputed (plain refund only) — a formal dispute (needs_response, under_review, lost) has
//         already taken the money back; Stripe refuses such a refund, so it is not asked
//       | cannot_cancel_status (cancel; with status) — the order is closed; nothing was refunded
//       | cancel_failed (cancel; with cancel_error = cancel_order's code, refund_id, amount,
//         stripe_status) — the refund stands, the order is still open; ask again to cancel
//   422 stripe_refused (with stripe_code) — Stripe said no; no money moved
//   500 lookup_failed | internal_error | refund_not_recorded (cancel; with refund_id, amount) —
//       unknown outcome, or Stripe refunded and our books could not take it yet; retry with the
//       same idempotency_key
//   502 stripe_unreachable — unknown outcome; retry with the same idempotency_key
//   503 stripe_not_configured

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  booksBehindStripe,
  chargeAccount,
  classifyStripeFailure,
  CLOSED_ORDER_STATUSES,
  disputeTookTheMoney,
  dollarsToCents,
  intentBelongsTo,
  LIVE_REFUND_STATUSES,
  mayRequest,
  parseReason,
  pickRefundablePayment,
  planRefund,
  refundIdempotencyKey,
  storedCents,
  wantsCancel,
} from './refund-plan.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');

/** Pinned everywhere we talk to Stripe (stripe-webhook, the payment and Connect functions). */
const STRIPE_API_VERSION = '2025-08-27.basil';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Body {
  order_id?: unknown;
  amount?: unknown;
  reason?: unknown;
  idempotency_key?: unknown;
  cancel?: unknown;
}

interface StripeError {
  error?: { type?: string; code?: string; decline_code?: string; message?: string };
}

interface StripeIntent {
  id: string;
  status: string;
  amount_received?: number;
  metadata?: Record<string, string>;
  latest_charge?: { id?: string; amount_refunded?: number; disputed?: boolean } | string | null;
}

interface StripeRefund {
  id: string;
  status: string | null;
  amount: number;
}

/** The refund a request made, when it made one. */
interface MadeRefund {
  refund_id: string;
  amount: number;
  stripe_status: string;
  recorded: boolean;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors(new Response('ok'));
  if (req.method !== 'POST') return cors(json({ error: 'method_not_allowed' }, 405));

  // Said plainly, before anything else is read, so an unconfigured project answers the same way
  // to everyone and the back office can tell the owner what is missing.
  if (!STRIPE_SECRET_KEY) return cors(json({ error: 'stripe_not_configured' }, 503));

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return cors(json({ error: 'auth_required' }, 401));

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return cors(json({ error: 'invalid_body' }, 400));
  }
  if (!body || typeof body !== 'object') return cors(json({ error: 'invalid_body' }, 400));
  const orderId = typeof body.order_id === 'string' ? body.order_id : '';
  if (!UUID_RE.test(orderId)) return cors(json({ error: 'order_id_required' }, 400));
  const cancel = wantsCancel(body.cancel);

  // An absent amount means "everything left"; a present one must be whole, positive cents. A
  // cancel always gives back everything left, so an amount there is a caller's mistake.
  let requestedCents: number | null = null;
  if (body.amount !== undefined && body.amount !== null) {
    if (cancel) return cors(json({ error: 'invalid_amount' }, 400));
    requestedCents = dollarsToCents(body.amount);
    if (requestedCents === null) return cors(json({ error: 'invalid_amount' }, 400));
  }
  const reason = parseReason(body.reason);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return cors(json({ error: 'invalid_token' }, 401));
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  try {
    const { data: order, error: orderErr } = await admin
      .from('orders')
      .select('id, branch_id, order_number, status')
      .eq('id', orderId)
      .maybeSingle();
    if (orderErr) {
      console.error('stripe-refund: order read failed', orderErr);
      return cors(json({ error: 'lookup_failed' }, 500));
    }
    if (!order) return cors(json({ error: 'order_not_found' }, 404));

    // The same right refund_order asks for, or with cancel the same right cancel_order asks for,
    // through the same rule (owner rows cover every branch, restaurant owner_user_id and platform
    // admins hold everything, active rows only).
    const capabilities = await capabilitiesAt(userClient, order.branch_id as string);
    if (!mayRequest(capabilities, cancel)) return cors(json({ error: 'not_authorized' }, 403));

    // A closed order cannot be cancelled, so the refund that would go with the cancel is not made
    // either. (A plain refund of a cancelled order is still allowed: that is how the back office
    // gives back a card the old paths left held.)
    if (cancel && (CLOSED_ORDER_STATUSES as readonly string[]).includes(order.status as string)) {
      return cors(json({ error: 'cannot_cancel_status', status: order.status }, 409));
    }

    const { data: payRows, error: payErr } = await admin
      .from('payments')
      .select('id, amount, status, method, gateway, gateway_charge_id, gateway_metadata, created_at')
      .eq('order_id', order.id)
      .eq('method', 'card');
    if (payErr) {
      console.error('stripe-refund: payments read failed', payErr);
      return cors(json({ error: 'lookup_failed' }, 500));
    }
    const payment = pickRefundablePayment(payRows ?? []);

    let made: MadeRefund | null = null;
    // Nothing to give back when there is no paid Stripe card payment, and nothing the restaurant
    // CAN give back when a formal dispute has already taken the money (Stripe refuses those). A
    // cancel goes straight to cancel_order then; a plain refund reports why it cannot refund.
    const skipRefund = cancel && (!payment || disputeTookTheMoney(payment.gateway_metadata));
    if (!payment && !cancel) return cors(json({ error: 'not_paid_by_card' }, 409));
    // A plain refund of a charge whose dispute has already taken the money: Stripe would refuse it
    // (charge_disputed). Answered here, before any Stripe call, with a code the back office words
    // as "answer the dispute in the branch's Stripe Dashboard" — the same thing it offers instead.
    if (payment && !cancel && disputeTookTheMoney(payment.gateway_metadata)) {
      return cors(json({ error: 'disputed' }, 409));
    }

    if (payment && !skipRefund) {
      const intentId = payment.gateway_charge_id as string;

      const { data: accountRow } = await admin
        .from('branch_payment_accounts')
        .select('stripe_account_id')
        .eq('branch_id', order.branch_id)
        .maybeSingle();
      const branchAccount = (accountRow?.stripe_account_id as string | undefined) ?? null;
      const account = chargeAccount(payment.gateway_metadata, branchAccount);
      if (!account) return cors(json({ error: 'no_stripe_account' }, 409));

      // Read the intent back from the account it lives on. This is the server-side truth for what
      // was captured and what has already gone back (a refund made in the branch's own Stripe
      // Dashboard counts before the webhook has recorded it), and it proves the intent is this
      // order's. The payments row is the only thing tying order, intent and account together;
      // checking Stripe's own metadata as well means no bad row can ever aim a refund at another
      // restaurant's charge.
      const intentRes = await stripeFetch(
        `payment_intents/${encodeURIComponent(intentId)}?expand[]=latest_charge`,
        account,
        { method: 'GET' },
      );
      if (!intentRes.ok) {
        const failure = classifyStripeFailure(intentRes.status, intentRes.error?.error?.type);
        console.error('stripe-refund: intent read failed', intentId, intentRes.status, intentRes.error);
        return cors(
          failure === 'unknown'
            ? json({ error: 'stripe_unreachable' }, 502)
            : json({ error: 'stripe_refused', stripe_code: intentRes.error?.error?.code ?? null }, 422),
        );
      }
      const intent = intentRes.data as StripeIntent;
      if (!intentBelongsTo(intent, { orderId: order.id as string, paymentId: payment.id, account, branchAccount })) {
        // An intent that names another order or payment, or an unstamped intent on an account that
        // is not this branch's: refusing costs a support ticket, refunding could drain someone else.
        console.error('stripe-refund: intent does not belong to this order', {
          order: order.id,
          payment: payment.id,
          intent: intent.id,
          stamped_order: intent.metadata?.order_id ?? null,
          stamped_payment: intent.metadata?.payment_id ?? null,
        });
        return cors(json({ error: 'payment_mismatch' }, 409));
      }
      if (intent.status !== 'succeeded') {
        return cors(json({ error: 'payment_not_settled', stripe_status: intent.status }, 409));
      }
      const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
      const refundedAtStripeCents = typeof charge?.amount_refunded === 'number' ? charge.amount_refunded : null;

      const refundedInBooksCents = await refundedInBooks(admin, payment.id);
      if (refundedInBooksCents === null) return cors(json({ error: 'lookup_failed' }, 500));

      const plan = planRefund({
        capturedCents: intent.amount_received ?? 0,
        recordedCents: storedCents(payment.amount),
        refundedInBooksCents,
        refundedAtStripeCents,
        requestedCents,
      });

      if (!plan.ok) {
        // With cancel, "nothing left to refund" is not a refusal: the money is already back, or
        // on its way, and the cancel can go ahead. If Stripe knows of refunds our books do not
        // (made in the Dashboard, the webhook not landed yet), they are recorded first, because
        // cancel_order counts payment_refunds.
        if (!(cancel && plan.error === 'nothing_to_refund')) {
          return cors(
            json(
              { error: plan.error, refundable: plan.remainingCents / 100 },
              plan.error === 'invalid_amount' ? 400 : 409,
            ),
          );
        }
        if (booksBehindStripe(refundedInBooksCents, refundedAtStripeCents)) {
          await syncRefundsFromStripe(admin, account, intent.id);
        }
      } else {
        const params = new URLSearchParams({
          payment_intent: intent.id,
          amount: String(plan.amountCents),
          'metadata[order_id]': order.id as string,
          'metadata[order_number]': String(order.order_number ?? ''),
          'metadata[payment_id]': payment.id,
          'metadata[branch_id]': order.branch_id as string,
          // The key stripe_connect_record_refund reads, so the Connect webhook credits the right
          // person even if its event lands before this function has recorded the refund.
          'metadata[created_by]': userId,
          // Lets the Connect webhook tell a back-office refund from one made in the Dashboard, and
          // the Dashboard's reader tell a refund that came with a cancel from a partial one.
          'metadata[source]': cancel ? 'favornoms_cancel' : 'favornoms_back_office',
        });
        if (reason) params.set('metadata[reason]', reason);

        const refundRes = await stripeFetch('refunds', account, {
          method: 'POST',
          body: params,
          idempotencyKey: refundIdempotencyKey({
            paymentId: payment.id,
            clientKey: body.idempotency_key,
            amountCents: plan.amountCents,
            alreadyRefundedCents: plan.alreadyRefundedCents,
          }),
        });
        if (!refundRes.ok) {
          const failure = classifyStripeFailure(refundRes.status, refundRes.error?.error?.type);
          console.error('stripe-refund: refund refused', intent.id, refundRes.status, refundRes.error);
          if (failure === 'unknown') return cors(json({ error: 'stripe_unreachable' }, 502));
          return cors(
            json(
              {
                error: 'stripe_refused',
                stripe_code: refundRes.error?.error?.code ?? refundRes.error?.error?.type ?? null,
              },
              422,
            ),
          );
        }
        const refund = refundRes.data as StripeRefund;

        // Recorded through the same SQL the Connect webhook uses, keyed by the Stripe refund id, so
        // whichever of the two lands first writes the row and the other meets it there. The status
        // is the one in the object Stripe just returned to this server-side call ('pending' while
        // Stripe works on it, 'succeeded' for most cards); from here on only the webhook's refund
        // events move it, and a late 'pending' never takes a settled refund back. The same call
        // marks the payment refunded once the succeeded refunds cover it.
        let recorded = await recordRefund(admin, account, refund, userId, reason);
        // Refunds Stripe held before this one that our books did not (made in the branch's own
        // Stripe Dashboard, their webhook not landed yet) are recorded now too. cancel_order and
        // refund_order count payment_refunds, not Stripe, so without them a cancel that has just
        // refunded the rest was still refused ('card_refund_required') and needed a second press.
        // The listing includes the refund made above; every row is upserted by its Stripe id.
        const booksBehind = booksBehindStripe(refundedInBooksCents, refundedAtStripeCents);
        if (booksBehind || (!recorded && cancel)) {
          await syncRefundsFromStripe(admin, account, intent.id);
        }
        if (!recorded && cancel) {
          // The cancel below would be refused without this row. The listing above was one more try
          // through Stripe's own list; if that failed too, the operator retries with the same key,
          // Stripe answers with this same refund, and the recording is attempted again. Recorded
          // means the books now hold everything refunded before this request and this refund.
          recorded = ((await refundedInBooks(admin, payment.id)) ?? 0) >= plan.alreadyRefundedCents + refund.amount;
          if (!recorded) {
            return cors(
              json({ error: 'refund_not_recorded', refund_id: refund.id, amount: refund.amount / 100 }, 500),
            );
          }
        }
        made = {
          refund_id: refund.id,
          amount: refund.amount / 100,
          stripe_status: refund.status ?? 'pending',
          recorded,
        };
      }
    }

    if (!cancel) {
      // Only a plain refund reaches here with made set: every other way out returned above.
      return cors(json({ ok: true, ...(made as MadeRefund) }));
    }

    // As the caller, so cancel_order's permission checks, "by staff" in the status history and
    // the cancel triggers are exactly those of any other cancel.
    const { error: cancelErr } = await userClient.rpc('cancel_order', {
      p_order_id: order.id,
      p_reason: reason,
    });
    if (cancelErr) {
      console.error('stripe-refund: cancel after refund failed', order.id, cancelErr.message);
      return cors(
        json(
          {
            error: 'cancel_failed',
            cancel_error: cancelErr.message,
            refund_id: made?.refund_id ?? null,
            amount: made?.amount ?? 0,
            stripe_status: made?.stripe_status ?? null,
          },
          409,
        ),
      );
    }

    return cors(
      json({
        ok: true,
        cancelled: true,
        refund_id: made?.refund_id ?? null,
        amount: made?.amount ?? 0,
        stripe_status: made?.stripe_status ?? null,
        recorded: made?.recorded ?? true,
      }),
    );
  } catch (err) {
    // Unknown outcome: the refund may have been made. The back office keeps its idempotency key
    // for a retry, and Stripe answers that retry with the refund instead of a second one.
    console.error('stripe-refund: internal error', err);
    return cors(json({ error: 'internal_error' }, 500));
  }
});

/** The caller's capabilities at the branch; empty when they cannot be read (refuse, never guess). */
async function capabilitiesAt(client: SupabaseClient, branchId: string): Promise<unknown[]> {
  const { data, error } = await client.rpc('my_capabilities', { p_branch_id: branchId });
  if (error || !Array.isArray(data)) return [];
  return data as unknown[];
}

/** Cents of this payment's pending and succeeded refunds in payment_refunds, or null when the
 *  table could not be read. */
async function refundedInBooks(admin: SupabaseClient, paymentId: string): Promise<number | null> {
  const { data, error } = await admin
    .from('payment_refunds')
    .select('amount, status')
    .eq('payment_id', paymentId)
    .in('status', [...LIVE_REFUND_STATUSES]);
  if (error) {
    console.error('stripe-refund: refunds read failed', error);
    return null;
  }
  return (data ?? []).reduce((sum, r) => sum + storedCents(r.amount), 0);
}

/**
 * Record every refund Stripe holds for the PaymentIntent, as the Connect webhook's charge.refunded
 * handling does. Used by a cancel when our books are behind Stripe; each row is upserted by its
 * Stripe id, so repeating this is harmless.
 */
async function syncRefundsFromStripe(admin: SupabaseClient, account: string, intentId: string): Promise<void> {
  const res = await stripeFetch(
    `refunds?payment_intent=${encodeURIComponent(intentId)}&limit=100`,
    account,
    { method: 'GET' },
  );
  if (!res.ok) {
    console.error('stripe-refund: listing refunds failed', intentId, res.status, res.error);
    return;
  }
  const list = (res.data as { data?: StripeRefund[] } | null)?.data ?? [];
  for (const refund of list) {
    const { data, error } = await admin.rpc('stripe_connect_record_refund', {
      p_account: account,
      p_refund: refund,
      p_created_by: null,
      p_reason: null,
    });
    const result = data as { ok?: boolean } | null;
    if (error || result?.ok !== true) {
      console.error('stripe-refund: recording a listed refund failed', refund.id, error ?? result);
    }
  }
}

/**
 * payment_refunds is written by the service role alone, through stripe_connect_record_refund
 * (migration 20260925100000), which also keeps who asked and why from the first writer that knew.
 * Returns false when the row could not be written; the money has moved regardless, and the
 * Connect webhook's refund.created event records it on its own.
 */
async function recordRefund(
  admin: SupabaseClient,
  account: string,
  refund: StripeRefund,
  createdBy: string,
  reason: string | null,
): Promise<boolean> {
  const { data, error } = await admin.rpc('stripe_connect_record_refund', {
    p_account: account,
    p_refund: refund,
    p_created_by: createdBy,
    p_reason: reason,
  });
  const result = data as { ok?: boolean; error?: string } | null;
  if (error || result?.ok !== true) {
    console.error('stripe-refund: recording the refund failed', refund.id, error ?? result);
    return false;
  }
  return true;
}

/** One Stripe call as the platform, acting on a connected account. */
async function stripeFetch(
  path: string,
  account: string,
  opts: { method: 'GET' | 'POST'; body?: URLSearchParams; idempotencyKey?: string },
): Promise<{ ok: true; status: number; data: unknown } | { ok: false; status: number; error: StripeError | null }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    'Stripe-Version': STRIPE_API_VERSION,
    // A direct charge lives on the connected account; without this header the call would act on
    // the platform's own account, where the charge does not exist.
    'Stripe-Account': account,
  };
  if (opts.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/${path}`, { method: opts.method, headers, body: opts.body });
  } catch (err) {
    console.error('stripe-refund: Stripe unreachable', path, err);
    return { ok: false, status: 599, error: null };
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, error: payload as StripeError | null };
  return { ok: true, status: res.status, data: payload };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cors(res: Response) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  return res;
}
