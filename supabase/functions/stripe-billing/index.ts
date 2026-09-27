// Restaurants paying the PLATFORM for their package by card (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md).
// Not diners paying restaurants: that is Stripe Connect (stripe-connect-onboard / -webhook).
//
// POST { action, ... } with the caller's JWT (deploy with verify_jwt on; the JWT is checked here too).
//
//   start        { request_id, branch_id }  merchant with billing.manage
//                Takes payment for a request the plan page has just filed (request_package_change:
//                the server has priced it; Stripe is told net amounts, never asked to price).
//                  - a restaurant already paying by card: its ONE subscription is updated in place
//                    and the difference charged to the card on file now -> { kind:'applied' }, or,
//                    when the card needs 3-D Secure or is declined, { kind:'action_required', url }
//                    with Stripe's invoice page (the change waits until it is paid). This works
//                    whether or not card billing is switched on: the switch controls NEW card
//                    purchases, and a restaurant on the Stripe rail can only change through Stripe
//                    (the manual approval refuses it, §9.9);
//                  - first card purchase: card billing off (platform_settings.billing.stripe_enabled)
//                    or no key -> 503 stripe_not_configured, and the request stays a manual request;
//                    otherwise a Stripe Checkout session (subscription mode, the monthly lines + each
//                    one-time fee at its net amount) -> { kind:'checkout', url }.
//                A request already tied to an invoice is resolved from it first (open -> its page
//                again, paid -> settled, void or past 23 h -> voided and cancelled: 409
//                payment_expired). A change the database cannot apply after Stripe applied it is
//                undone (refund, customer balance, items put back) and answered 409 with what
//                happened to the money: charged_refunded (all refunded), charged_not_applied (the
//                refund failed; a person follows up) or change_not_applied (nothing was charged),
//                with the settle's `reason` (§9.5, §10.9). 409 payment_in_progress: the same
//                payment is still being sent by another call; try again.
//   confirm      { session_id }  merchant   After Checkout returns: settles the request from the
//                session as Stripe has it now, so the page does not wait for the webhook.
//                { settled:true } or { settled:false, status } (status charged_refunded when the
//                payment went through for something that cannot be applied: the webhook refunds it).
//   portal       { branch_id }  merchant    Stripe's customer portal (card, invoices, cancel at
//                period end; no plan switching): { url }. Works while card billing is off too.
//   status       platform admin             The setup page's checklist. Booleans and ids, never a
//                secret. Answers even with no key set (that is what the checklist shows).
//   set_enabled  { enabled }  platform admin  The switch. On requires the secret key and the
//                webhook secret, and prepares the prices and the portal configuration first.
//
// WHO. The merchant actions ask the database AS THE CALLER (billing_checkout_context,
// billing_branch_context read auth.uid() and apply user_can_manage_billing); every write is made
// with the service role through the billing_* functions. Platform admin =
// user.app_metadata.is_platform_admin === true from auth.getUser(jwt).
//
// WHERE STRIPE SENDS THE MERCHANT BACK is built here from PUBLIC_ADMIN_URL (resolveAdminOrigin: a
// request Origin is honoured only when it is an allowed admin origin), never taken from the body.
//
// RETRYING NEVER CHARGES TWICE (§9.4, §10). The request is locked (billing_mark_change_started)
// before a change is sent. A change is sent as the full target under ONE key per request
// (billing_change:<request_id>), so a retry replays Stripe's first answer; the invoice a change is
// paid through is stored on the request before anything else happens (a hard step once paid), and
// a request that already has one is resolved from it (paid -> settle, open -> its page, void or
// expired -> cancelled). One-time fees with no proration invoice go on an invoice made first and
// empty, never left pending for a renewal. A Checkout key carries the previous session id, and a
// replayed session that is no longer open is never handed out.
//
// Every Stripe call is API v1 pinned to STRIPE_API_VERSION (stripeRequest), form-encoded, and every
// create carries an Idempotency-Key. Request bodies are built in ../_shared/stripe-billing.ts, which
// the admin app's tests pin.
//
// Secrets: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY (only reported), STRIPE_WEBHOOK_SECRET (the
// switch refuses to turn on without it), STRIPE_CONNECT_WEBHOOK_SECRET (only reported),
// PUBLIC_ADMIN_URL, optional STRIPE_BILLING_RETURN_ORIGINS / STRIPE_CONNECT_RETURN_ORIGINS (more
// HTTPS admin origins, comma separated). STRIPE_BILLING_ENABLED is retired: the switch is in the
// database.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient, type User } from 'jsr:@supabase/supabase-js@2';
import {
  isRetryableStripeFailure,
  isStripeObjectId,
  isUuid,
  resolveAdminOrigin,
  stripeKeyMode,
  stripeRequest,
} from '../_shared/stripe-connect.ts';
import {
  type CheckoutContext,
  type MonthlyCode,
  type PriceIds,
  type TargetQuantities,
  BillingParamsError,
  CHANGE_INVOICE_TTL_MS,
  MONTHLY_CODES,
  SETUP_PRODUCT_IDS,
  MONTHLY_PRODUCT_IDS,
  accountSummary,
  balanceUndoIdempotencyKey,
  balanceUndoParams,
  billingAnchor,
  catalogMonthlyCents,
  changeFailureCode,
  changeIdempotencyKey,
  changeInvoiceIdempotencyKey,
  changeInvoiceState,
  changeSettleArgs,
  checkoutIdempotencyKey,
  checkoutSessionParams,
  checkoutSettleArgs,
  checkoutUrls,
  customerBelongsTo,
  customerParams,
  feeInvoiceItemIdempotencyKey,
  feeInvoiceItemParams,
  feeInvoiceParams,
  grantedLines,
  idOf,
  idempotencyKey,
  invoiceBalanceMovement,
  invoicePaymentTargets,
  invoiceSubscriptionId,
  invoiceTiedToRequest,
  isAlreadyRefunded,
  isIdempotencyError,
  isIdempotencyInUse,
  isStripeManagedStatus,
  isUsablePortalConfiguration,
  itemsMatch,
  parseCheckoutContext,
  portalConfigurationParams,
  portalReturnUrl,
  priceLookupKey,
  priceMatches,
  priceParams,
  productParams,
  refundIdempotencyKey,
  refundOutcome,
  refundParams,
  refundTargetId,
  requestInvoiceItems,
  revertIdempotencyKey,
  revertParams,
  sessionIsPaid,
  shouldCancelOldSubscription,
  stripeDashboardBase,
  subscriptionItemsByCode,
  subscriptionUpdateParams,
  targetQuantities,
  updateAddsOneTimeFees,
} from '../_shared/stripe-billing.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_MODE = stripeKeyMode(STRIPE_SECRET_KEY);
const IS_LOCAL_STACK = /localhost|127\.0\.0\.1/.test(SUPABASE_URL);
const PUBLIC_ADMIN_URL =
  Deno.env.get('PUBLIC_ADMIN_URL')?.replace(/\/$/, '') ??
  (IS_LOCAL_STACK ? 'https://localhost:3004' : '');
const EXTRA_RETURN_ORIGINS = [
  Deno.env.get('STRIPE_BILLING_RETURN_ORIGINS'),
  Deno.env.get('STRIPE_CONNECT_RETURN_ORIGINS'),
]
  .filter((v): v is string => typeof v === 'string' && v.length > 0)
  .join(',');

const ACTIONS = ['start', 'confirm', 'portal', 'status', 'set_enabled'] as const;
type Action = (typeof ACTIONS)[number];

/** The subscription as a settle reads it: the card on it and on its customer, expanded. */
const SETTLE_EXPAND = [
  'default_payment_method',
  'customer.invoice_settings.default_payment_method',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Json = Record<string, unknown>;

/** A refusal answered as JSON with its status. Thrown so a helper can end the request. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Json,
  ) {
    super(String(body.error ?? 'refused'));
  }
}

function refuse(status: number, error: string, extra: Json = {}): never {
  throw new Refusal(status, { error, ...extra });
}

interface Env {
  req: Request;
  user: User;
  /** The caller's own client: auth.uid() is the caller, so the SQL's permission checks apply. */
  userClient: SupabaseClient;
  admin: SupabaseClient;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const body = (await req.json().catch(() => null)) as Json | null;
  const action = body?.action as Action | undefined;
  if (!body || typeof body !== 'object' || !action || !ACTIONS.includes(action)) {
    return json({ error: 'bad_request', allowed_actions: ACTIONS }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'auth_required' }, 401);
  const jwt = authHeader.slice(7);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData.user) return json({ error: 'invalid_token' }, 401);
  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const env: Env = { req, user: userData.user, userClient, admin };

  try {
    switch (action) {
      case 'start':
        return await start(env, body);
      case 'confirm':
        return await confirm(env, body);
      case 'portal':
        return await portal(env, body);
      case 'status':
        requirePlatformAdmin(env.user);
        return json(await buildStatus(env.admin));
      case 'set_enabled':
        return await setEnabled(env, body);
    }
  } catch (err) {
    if (err instanceof Refusal) return json(err.body, err.status);
    if (err instanceof BillingParamsError) {
      console.error('stripe-billing: refused to build a Stripe request', action, err.code);
      return json({ error: 'cannot_bill', detail: err.code }, 409);
    }
    console.error('stripe-billing failed', action, err);
    return json({ error: 'internal_error' }, 500);
  }
  return json({ error: 'bad_request' }, 400);
});

// ---------------------------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------------------------

async function start(env: Env, body: Json): Promise<Response> {
  const requestId = body.request_id;
  const branchId = body.branch_id;
  if (!isUuid(requestId) || !isUuid(branchId)) refuse(400, 'bad_request');
  requireKey();

  // The branch decides which plan page Stripe sends the merchant back to; it must be one the
  // caller may bill (and, below, one of the request's restaurant's).
  const branch = await loadBranchContext(env.userClient, branchId);
  if (!branch.can_manage) refuse(403, 'forbidden');

  // The switch controls NEW card purchases only (§9.9, UIM-5). Off, a restaurant that is not on
  // the Stripe rail keeps exactly what it had before card billing existed: the request filed a
  // moment ago stays a request for manual approval. A restaurant already paying by card goes on
  // through Stripe: the manual approval refuses it, so there is no other way to change its package.
  // One exception: a change still tied to its invoice (the row left the Stripe rail while it
  // waited) is resolved from that invoice below, so an unpaid one is voided and the request let go.
  const enabled = await stripeEnabled(env.userClient);
  const dormant = !enabled && !branch.stripe_managed;
  const ctx = await loadCheckoutContext(env.userClient, requestId).catch((err: unknown) => {
    if (dormant && err instanceof Refusal) refuse(503, 'stripe_not_configured');
    throw err;
  });
  if (dormant && !ctx.request.stripe_invoice_id) refuse(503, 'stripe_not_configured');
  if (ctx.request.status !== 'pending')
    refuse(409, 'request_not_pending', { status: ctx.request.status });
  if (branch.restaurant_id !== ctx.restaurant.id) refuse(403, 'branch_not_in_restaurant');

  // Already being paid through an invoice (3-D Secure, a declined card, a paid invoice whose settle
  // did not finish): resolved from it, whatever the row looks like now, and nothing new is ever
  // sent (§9.4, §10.1): open -> its page again; paid -> settled; void, uncollectible or past its
  // 23 h window -> voided, the request cancelled, answered payment_expired.
  if (ctx.request.stripe_invoice_id) {
    return await resolveChangeInvoice(
      env,
      ctx,
      ctx.subscription?.stripe_subscription_id ?? null,
      ctx.request.stripe_invoice_id,
    );
  }
  if (ctx.stripe_managed) return await changeSubscription(env, ctx);
  if (!enabled) refuse(503, 'stripe_not_configured');
  return await openCheckout(env, ctx, adminOrigin(env.req), branchId);
}

/** First card purchase (D4, D5): one Checkout session in subscription mode. */
async function openCheckout(
  env: Env,
  ctx: CheckoutContext,
  origin: string,
  branchId: string,
): Promise<Response> {
  const customerId = await ensureCustomer(env.admin, ctx);

  // One live subscription per restaurant (§9.2). A restaurant that is not on the Stripe rail can
  // still have a subscription Stripe is retrying (its grace ended before Stripe gave up); buying
  // again would leave that one billing the new card too. It is cancelled, and its open invoices
  // voided, BEFORE anything new can be paid.
  const oldSubId = ctx.subscription?.stripe_subscription_id;
  if (isStripeObjectId(oldSubId)) {
    await cancelOldSubscription(env.admin, ctx.restaurant.id, oldSubId, 'new_checkout', true);
  }

  const monthly = ctx.monthly_lines
    .filter((l) => l.quantity > 0)
    .map((l) => ({ code: l.code, cents: l.unit_amount_cents }));
  const prices = await ensurePrices(monthly);
  await ensureSetupProducts(setupCodesOf(ctx));

  const sub = ctx.subscription;
  const trialEnd = billingAnchor(
    Date.now(),
    sub?.trial_ends_at,
    sub?.current_period_end,
    sub?.status,
  );
  const params = checkoutSessionParams(
    ctx,
    customerId,
    prices,
    checkoutUrls(origin, branchId),
    trialEnd,
  );

  // The key carries the session already stored on the request: a double click gets the same
  // session back, while "Continue to payment" later makes a new one instead of replaying a session
  // that may have expired since (ME-7). A replay is Stripe's saved answer, so its status is stale:
  // the session is re-read, and one that is no longer open is never handed out.
  const previous = ctx.request.stripe_checkout_session_id;
  let session = await openSession(
    await createSession(params, checkoutIdempotencyKey(ctx.request.id, previous, params)),
  );
  if (!session.open) {
    session = await openSession(
      await createSession(
        params,
        checkoutIdempotencyKey(ctx.request.id, previous, params, session.id),
      ),
    );
    if (!session.open) {
      refuse(502, 'stripe_error', {
        step: 'checkout_session',
        detail: 'Stripe returned a Checkout session that is not open.',
      });
    }
  }

  // One open Checkout per restaurant (D12). Expired AFTER the new one exists, and never the one
  // handed out, so a double click cannot expire the session it returns.
  await expireOtherSessions(customerId, session.id);

  await markRequest(env.admin, ctx.request.id, session.id, null, null);
  return json({ kind: 'checkout', url: session.url });
}

async function createSession(params: Record<string, string>, key: string): Promise<string> {
  const session = await stripe<{ id?: unknown }>(
    'POST',
    '/v1/checkout/sessions',
    { params, idempotencyKey: key },
    'checkout_session',
  );
  if (!isStripeObjectId(session.id)) {
    refuse(502, 'stripe_error', {
      step: 'checkout_session',
      detail: 'Stripe answered without a session.',
    });
  }
  return session.id;
}

/** The session as Stripe has it NOW (never a replayed answer): open, and its page. */
async function openSession(id: string): Promise<{ id: string; open: boolean; url: string }> {
  const s = await stripe<Json>('GET', `/v1/checkout/sessions/${id}`, {}, 'checkout_session_read');
  const url = typeof s.url === 'string' && s.url.startsWith('https://') ? s.url : '';
  return { id, open: s.status === 'open' && url !== '', url };
}

// ---------------------------------------------------------------------------------------------
// A paying restaurant's change (D7): its one subscription, updated in place and charged now
// ---------------------------------------------------------------------------------------------

async function changeSubscription(env: Env, ctx: CheckoutContext): Promise<Response> {
  const subId = ctx.subscription?.stripe_subscription_id;
  if (!isStripeObjectId(subId)) refuse(409, 'no_subscription');

  const current = await stripe<Json>(
    'GET',
    `/v1/subscriptions/${subId}`,
    { params: { expand: ['latest_invoice'] } },
    'subscription_read',
  );
  if ((current.metadata as Json | undefined)?.restaurant_id !== ctx.restaurant.id) {
    // Every subscription made here carries its restaurant; one that does not is not changed.
    refuse(409, 'subscription_mismatch');
  }
  if (!isStripeManagedStatus(current.status))
    refuse(409, 'subscription_not_active', { status: current.status });
  const items = subscriptionItemsByCode(current);
  if (!items.ok) refuse(409, 'subscription_unexpected_items', { detail: items.error });
  const customerId = idOf(current.customer);

  const target = targetQuantities(ctx);
  const hasFees = ctx.charges.some((c) => c.net_cents > 0);

  // Charged already but the invoice never stored (the function stopped after Stripe answered): the
  // fees carry the request, so that invoice is found and resolved instead of charging again. Fees
  // an earlier update left pending are noted, to be removed before they are invoiced (money-rr-5).
  let pendingFees: string[] = [];
  if (hasFees) {
    const fees = await findRequestFees(customerId, subId, ctx.request.id, current.latest_invoice);
    if (fees.invoiceId) return await resolveChangeInvoice(env, ctx, subId, fees.invoiceId);
    pendingFees = fees.pendingItemIds;
  }

  if (itemsMatch(target, items.items)) {
    // Nothing changes on the subscription (the same package filed again, or only a one-time fee).
    await discardOlderPendingUpdate(env, ctx, current);
    // Or an earlier call's update of this request already put them there and was paid: resolved
    // from that invoice, so nothing is charged twice and the settle carries its invoice (edge-rr-3).
    const applied = await appliedChangeInvoice(env.admin, ctx, current);
    if (applied) return await resolveChangeInvoice(env, ctx, subId, applied);
    if (!hasFees) return await settleChange(env, ctx, subId, null);
    // Only a one-time fee (delivery moved from one branch to another): no subscription update is
    // sent at all; the fee is charged on an invoice of its own (money-rr-5).
    await ensureSetupProducts(setupCodesOf(ctx));
    return await chargeFeesNow(env, ctx, subId, customerId, pendingFees);
  }

  // Only a product the subscription does not have yet needs a price: existing items keep theirs.
  const adding = ctx.monthly_lines
    .filter((l) => l.quantity > 0 && !items.items[l.code])
    .map((l) => ({ code: l.code, cents: l.unit_amount_cents }));
  const prices = await ensurePrices(adding);
  await ensureSetupProducts(setupCodesOf(ctx));

  const params = subscriptionUpdateParams(ctx, items.items, prices);
  // Locked BEFORE anything is sent (money-rr-1, money-rr-4): from here the request cannot be
  // replaced or rejected until it is resolved or its 23 h window passes, even if this function
  // stops before the invoice is stored.
  await markChangeStarted(env.admin, ctx.request.id);
  const res = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'POST', `/v1/subscriptions/${subId}`, {
    params,
    idempotencyKey: changeIdempotencyKey(ctx.request.id),
  });
  if (!res.ok) {
    // The same change is still being sent by another call (a double click, a reload): busy, try
    // again; the retry replays whatever that call did (edge-rr-3).
    if (isIdempotencyInUse(res.status, res.error)) refuse(409, 'payment_in_progress');
    if (isIdempotencyError(res.status, res.error))
      return await resolveKeyConflict(env, ctx, subId, target, hasFees);
    stripeFailed('subscription_update', res.status, res.error);
  }
  const updated = res.data;
  const previousInvoice = idOf(current.latest_invoice);
  const invoiceId = idOf(updated.latest_invoice);

  // A pending update (3-D Secure or declined) waits on the subscription's latest invoice; an
  // applied change with proration made a new invoice. Either way it is judged from a FRESH read
  // of that invoice, never from this answer, which may be a replay (ME-4).
  if (updated.pending_update || (invoiceId && invoiceId !== previousInvoice)) {
    if (!isStripeObjectId(invoiceId)) {
      await logEvent(
        env.admin,
        'stripe.change_invoice_unavailable',
        'error',
        'a package change needs payment but Stripe returned no invoice',
        ctx.restaurant.id,
        { request_id: ctx.request.id, subscription: subId },
      );
      refuse(502, 'stripe_error', {
        step: 'subscription_update',
        detail: 'Stripe returned no invoice to pay.',
      });
    }
    return await resolveChangeInvoice(env, ctx, subId, invoiceId);
  }
  if (updateAddsOneTimeFees(params)) {
    // No invoice (a change during a trial prorates nothing), so the fees the update added only wait
    // on the subscription as pending items. They are removed and charged on an invoice of their own
    // now, rather than silently waiting for the next renewal (money-rr-5).
    const fees = await findRequestFees(customerId, subId, ctx.request.id, null);
    if (fees.invoiceId) return await resolveChangeInvoice(env, ctx, subId, fees.invoiceId);
    return await chargeFeesNow(env, ctx, subId, customerId, fees.pendingItemIds);
  }
  return await settleChange(env, ctx, subId, null);
}

/**
 * The paid invoice of this request's change when an earlier or concurrent call already applied it
 * (edge-rr-3): the request's change was sent (stripe_change_started_at, read fresh: the other call
 * may have marked it after this one loaded the request), the items now bill its target, and the
 * subscription's latest invoice is a paid subscription_update made after that, inside the 23 h
 * window, that no other request holds. Settling with that invoice rather than with none makes the
 * two calls' settles one duplicate, so a refusal can never refund an upgrade the other applied.
 * Null when that cannot be told: the change is then settled with no invoice, as before.
 */
async function appliedChangeInvoice(
  admin: SupabaseClient,
  ctx: CheckoutContext,
  sub: Json,
): Promise<string | null> {
  const latest = sub.latest_invoice as Json | null;
  if (!latest || typeof latest !== 'object' || !isStripeObjectId(latest.id)) return null;
  if (latest.status !== 'paid' || latest.billing_reason !== 'subscription_update') return null;
  const createdMs = typeof latest.created === 'number' ? latest.created * 1000 : 0;
  if (Date.now() - createdMs > CHANGE_INVOICE_TTL_MS) return null;

  const { data: row, error: rowErr } = await admin
    .from('billing_requests')
    .select('stripe_change_started_at')
    .eq('id', ctx.request.id)
    .maybeSingle();
  if (rowErr) {
    console.error('billing_requests read failed', ctx.request.id, rowErr);
    refuse(500, 'read_failed');
  }
  const startedMs = Date.parse(
    String((row as { stripe_change_started_at?: unknown } | null)?.stripe_change_started_at ?? ''),
  );
  // Five minutes for the two clocks (Stripe's and the database's) to disagree.
  if (!Number.isFinite(startedMs) || createdMs < startedMs - 5 * 60 * 1000) return null;

  const { data, error } = await admin.rpc('billing_request_for_invoice', {
    p_invoice_id: latest.id,
  });
  if (error) {
    console.error('billing_request_for_invoice failed', latest.id, error);
    refuse(500, 'read_failed');
  }
  return data == null || data === ctx.request.id ? latest.id : null;
}

/**
 * A pending update still waiting on the subscription while this request changes nothing there is
 * an older request's (this request's own would change the items). It is discarded by voiding its
 * invoice, or paying that page later would apply a package nobody has any more (ME-1).
 */
async function discardOlderPendingUpdate(env: Env, ctx: CheckoutContext, current: Json) {
  const latest = current.latest_invoice as Json | null;
  if (!current.pending_update || !latest || latest.status !== 'open') return;
  if (!isStripeObjectId(latest.id)) return;
  if (!(await voidInvoice(env.admin, ctx.restaurant.id, latest.id, ctx.request.id)))
    refuse(502, 'stripe_error', {
      step: 'invoice_void',
      detail: 'An older change waiting for payment could not be discarded.',
    });
}

/**
 * Stripe refused the change key with a 400 idempotency_error: this request's first update was sent
 * with a different body (it added an item, which now has an id). What that first update did is
 * read back from the subscription instead of guessed (§9.4).
 */
async function resolveKeyConflict(
  env: Env,
  ctx: CheckoutContext,
  subId: string,
  target: TargetQuantities,
  hasFees: boolean,
): Promise<Response> {
  const sub = await stripe<Json>(
    'GET',
    `/v1/subscriptions/${subId}`,
    { params: { expand: ['latest_invoice'] } },
    'subscription_read',
  );
  const latest = idOf(sub.latest_invoice);
  if (sub.pending_update && isStripeObjectId(latest))
    return await resolveChangeInvoice(env, ctx, subId, latest);
  const items = subscriptionItemsByCode(sub);
  const applied = items.ok && itemsMatch(target, items.items);
  if (hasFees) {
    const customerId = idOf(sub.customer);
    const fees = await findRequestFees(customerId, subId, ctx.request.id, sub.latest_invoice);
    if (fees.invoiceId) return await resolveChangeInvoice(env, ctx, subId, fees.invoiceId);
    if (applied) {
      const paid = await appliedChangeInvoice(env.admin, ctx, sub);
      if (paid) return await resolveChangeInvoice(env, ctx, subId, paid);
    }
    // The first update applied without an invoice and its fees still wait as pending items: they
    // are removed and charged on their own invoice. With no trace of the fees at all, nothing is
    // charged (below): they may have been paid on an invoice this code cannot see.
    if (applied && fees.pendingItemIds.length > 0)
      return await chargeFeesNow(env, ctx, subId, customerId, fees.pendingItemIds);
  } else if (applied) {
    // The first update applied and charged no fee: the items say so, and it is settled (with the
    // invoice it paid, when that can be told).
    const paid = await appliedChangeInvoice(env.admin, ctx, sub);
    if (paid) return await resolveChangeInvoice(env, ctx, subId, paid);
    return await settleChange(env, ctx, subId, null);
  }
  await logEvent(
    env.admin,
    'stripe.change_conflict',
    'error',
    'a package change was sent before and what it did cannot be told from Stripe; nothing more was charged',
    ctx.restaurant.id,
    { request_id: ctx.request.id, subscription: subId, latest_invoice: latest },
  );
  refuse(409, 'change_conflict');
}

/**
 * Where this request's one-time fees are at Stripe, when the request never had an invoice stored:
 *   - the invoice they are on (charged, or waiting for 3-D Secure), found by the fee items' own
 *     metadata (add_invoice_items and the fee invoice's items both carry the request); a voided
 *     one is skipped, it charged nothing;
 *   - failing that, the fee invoice before its fees were put on it (only its own metadata names
 *     the request): the subscription's latest invoice or one of its recent ones;
 *   - the fee items still pending (an update added them and no invoice took them), which must be
 *     removed before the fees are invoiced on their own.
 */
async function findRequestFees(
  customerId: string | null,
  subId: string,
  requestId: string,
  latest: unknown,
): Promise<{ invoiceId: string | null; pendingItemIds: string[] }> {
  let pendingItemIds: string[] = [];
  if (isStripeObjectId(customerId)) {
    const listed = await stripe<{ data?: unknown }>(
      'GET',
      '/v1/invoiceitems',
      { params: { customer: customerId, limit: 100 } },
      'invoice_item_list',
    );
    const mine = requestInvoiceItems(listed, requestId);
    pendingItemIds = mine.pendingIds;
    for (const id of mine.invoiceIds) {
      if (!isStripeObjectId(id)) continue;
      const inv = await stripe<Json>('GET', `/v1/invoices/${id}`, {}, 'invoice_read');
      if (inv.status !== 'void') return { invoiceId: id, pendingItemIds };
    }
  }
  if (latest && typeof latest === 'object' && invoiceTiedToRequest(latest, requestId)) {
    const l = latest as Json;
    if (l.status !== 'void' && isStripeObjectId(l.id)) return { invoiceId: l.id, pendingItemIds };
  }
  const list = await stripe<{ data?: unknown }>(
    'GET',
    '/v1/invoices',
    { params: { subscription: subId, limit: 10 } },
    'invoice_list',
  );
  for (const inv of Array.isArray(list.data) ? (list.data as Json[]) : []) {
    if (inv.status === 'void' || !isStripeObjectId(inv.id)) continue;
    if (invoiceTiedToRequest(inv, requestId)) return { invoiceId: inv.id, pendingItemIds };
  }
  return { invoiceId: null, pendingItemIds };
}

/**
 * The invoice a change is paid through, as Stripe has it now, decides what happens (§9.3, §9.4,
 * §10.1): paid -> the change is settled; draft -> it is finished and charged; open -> the merchant
 * pays on Stripe's page; uncollectible or past its 23 h window -> voided, then the request is
 * cancelled; void or gone -> the request is cancelled. The invoice (and its page) is stored on the
 * request first, so the webhook and any retry find it.
 * `subId` is the restaurant's subscription when known; the invoice's own subscription wins.
 */
async function resolveChangeInvoice(
  env: Env,
  ctx: CheckoutContext,
  subId: string | null,
  invoiceId: string,
  allowCharge = true,
): Promise<Response> {
  const res = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'GET', `/v1/invoices/${invoiceId}`);
  if (!res.ok && res.status !== 404) stripeFailed('invoice_read', res.status, res.error);
  const inv = res.ok ? res.data : null;
  const state = changeInvoiceState(inv, Date.now());
  const url =
    inv &&
    typeof inv.hosted_invoice_url === 'string' &&
    inv.hosted_invoice_url.startsWith('https://')
      ? inv.hosted_invoice_url
      : null;
  const invoiceSub = inv ? invoiceSubscriptionId(inv) : null;
  const settleSub = isStripeObjectId(invoiceSub) ? invoiceSub : subId;
  const stored = ctx.request.stripe_invoice_id === invoiceId;

  if (inv && state === 'paid') {
    // Money is in. The invoice is stored on the request BEFORE the settle, and failing to store it
    // fails the call (money-rr-4): the retry replays into this same invoice, instead of leaving a
    // paid change that nothing points to. A request replaced meanwhile is left to the settle, whose
    // refusal refunds the payment.
    if (!stored) await markAfterCharge(env.admin, ctx.request.id, invoiceId, url);
    if (!isStripeObjectId(settleSub))
      refuse(502, 'stripe_error', {
        step: 'invoice_read',
        detail: 'The paid invoice names no subscription.',
      });
    return await settleChange(env, ctx, settleSub, inv);
  }
  if (inv && state === 'draft' && allowCharge) {
    // Stored before anything is charged; a request replaced meanwhile is refused here, and its
    // draft (auto_advance off) is never charged.
    if (!stored) await markRequest(env.admin, ctx.request.id, null, invoiceId, null);
    return await chargeInvoice(env, ctx, settleSub, invoiceId);
  }
  if (inv && state === 'open' && url) {
    try {
      await markRequest(env.admin, ctx.request.id, null, invoiceId, url);
    } catch (err) {
      // Replaced or refused in another tab while this one was charging: nothing will ever apply
      // this invoice, so it is voided before anyone can pay it (SP-3), and the refusal stands.
      if (err instanceof Refusal && err.body.error === 'request_not_pending')
        await voidInvoice(env.admin, ctx.restaurant.id, invoiceId, ctx.request.id);
      throw err;
    }
    return json({ kind: 'action_required', url });
  }
  if (state === 'open' || state === 'draft') {
    await logEvent(
      env.admin,
      'stripe.change_invoice_unavailable',
      'error',
      'a package change needs payment but its invoice has no page to pay on',
      ctx.restaurant.id,
      { request_id: ctx.request.id, invoice: invoiceId, invoice_status: inv?.status ?? null },
    );
    refuse(502, 'stripe_error', {
      step: 'invoice_read',
      detail: 'Stripe returned no invoice page to pay on.',
    });
  }

  // Never going to be paid. One that still could be (open or uncollectible past its window) is
  // voided first, so it cannot be paid after its request is gone; if that fails, the request is
  // kept. A draft cannot be paid by anyone (it has no page and auto_advance is off); it is only
  // tidied away, best effort.
  if (state === 'expired' && inv) {
    if (inv.status === 'draft') await deleteDraftInvoice(invoiceId);
    else if (!(await voidInvoice(env.admin, ctx.restaurant.id, invoiceId, ctx.request.id)))
      refuse(502, 'stripe_error', {
        step: 'invoice_void',
        detail: 'The expired invoice could not be voided.',
      });
  }
  await cancelRequest(env.admin, ctx.request.id, 'Card payment not completed in time');
  await logEvent(
    env.admin,
    'stripe.change_expired',
    'info',
    'a package change was not paid in time and was cancelled',
    ctx.restaurant.id,
    { request_id: ctx.request.id, invoice: invoiceId, invoice_status: inv?.status ?? 'missing' },
  );
  refuse(409, 'payment_expired');
}

/**
 * A change's invoice finished and charged: our fee invoice gets its fees (again, under keys that
 * replay, so a draft an earlier call left half built is completed, never charged short), is
 * finalized, charged to the card on file, and resolved from a re-read.
 */
async function chargeInvoice(
  env: Env,
  ctx: CheckoutContext,
  subId: string | null,
  invoiceId: string,
): Promise<Response> {
  const inv = await stripe<Json>('GET', `/v1/invoices/${invoiceId}`, {}, 'invoice_read');
  let status = inv.status;
  if (status === 'draft') {
    if ((inv.metadata as Json | undefined)?.billing_request_id === ctx.request.id)
      await attachFees(ctx, idOf(inv.customer), invoiceId);
    const finalized = await stripe<Json>(
      'POST',
      `/v1/invoices/${invoiceId}/finalize`,
      {
        params: { auto_advance: 'false' },
        idempotencyKey: `billing_change_invoice_finalize:${invoiceId}`,
      },
      'invoice_finalize',
    );
    status = finalized.status;
  }
  if (status === 'open') {
    // A decline or 3-D Secure is not a failure here: the invoice stays open and the merchant pays
    // it on Stripe's page (invoice.paid settles the request then).
    const paid = await stripeRequest<Json>(
      STRIPE_SECRET_KEY,
      'POST',
      `/v1/invoices/${invoiceId}/pay`,
      {
        idempotencyKey: `billing_change_invoice_pay:${invoiceId}`,
      },
    );
    if (!paid.ok && isRetryableStripeFailure(paid.status))
      console.warn(
        'paying the change invoice failed; the merchant can pay it on its page',
        invoiceId,
        paid.status,
      );
  }
  return await resolveChangeInvoice(env, ctx, subId, invoiceId, false);
}

/** The request's one-time fees, each group created ON the fee invoice (money-rr-5). */
async function attachFees(ctx: CheckoutContext, customerId: string | null, invoiceId: string) {
  if (!isStripeObjectId(customerId))
    refuse(502, 'stripe_error', { step: 'invoice_read', detail: 'The invoice has no customer.' });
  const all = feeInvoiceItemParams(ctx, customerId, invoiceId);
  for (const [index, params] of all.entries()) {
    await stripe(
      'POST',
      '/v1/invoiceitems',
      { params, idempotencyKey: feeInvoiceItemIdempotencyKey(ctx.request.id, invoiceId, index) },
      'invoice_item_create',
    );
  }
}

/**
 * One-time fees with no proration invoice to ride on (money-rr-5): fees an earlier update left
 * pending are removed, then ONE invoice is made for this request, empty
 * (pending_invoice_items_behavior=exclude), stored on the request, given the fees, finalized and
 * charged now. Nothing is ever left pending for the next renewal to pick up.
 */
async function chargeFeesNow(
  env: Env,
  ctx: CheckoutContext,
  subId: string,
  customerId: string | null,
  pendingItemIds: string[],
): Promise<Response> {
  if (!isStripeObjectId(customerId))
    refuse(502, 'stripe_error', {
      step: 'subscription_read',
      detail: 'The subscription has no customer.',
    });
  // Locked before anything is sent (money-rr-1), as for a subscription update.
  await markChangeStarted(env.admin, ctx.request.id);
  for (const id of pendingItemIds) {
    const del = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'DELETE', `/v1/invoiceitems/${id}`);
    if (!del.ok && del.status !== 404) stripeFailed('invoice_item_delete', del.status, del.error);
  }
  const draft = await stripe<Json>(
    'POST',
    '/v1/invoices',
    {
      params: feeInvoiceParams(ctx, customerId, subId),
      // One per request: a retry gets this invoice back instead of invoicing the fees twice.
      idempotencyKey: changeInvoiceIdempotencyKey(ctx.request.id),
    },
    'invoice_create',
  );
  if (!isStripeObjectId(draft.id)) refuse(502, 'stripe_error', { step: 'invoice_create' });
  // Stored before a fee is put on it (a hard step): a retry resolves this invoice instead of
  // starting over, and a request replaced meanwhile is refused here with nothing charged.
  if (ctx.request.stripe_invoice_id !== draft.id)
    await markRequest(env.admin, ctx.request.id, null, draft.id, null);
  return await chargeInvoice(env, ctx, subId, draft.id);
}

/**
 * The change is paid (or nothing was due): applied, keeping the current period (D8), from the
 * subscription re-read NOW (its items, card and monthly total). Only onto the subscription the
 * restaurant is billed through today (money-rr-7): one the manual rail detached meanwhile is never
 * settled, let alone as a first purchase. A settle refused after Stripe applied the change is
 * undone: the payment refunded, the items and the customer balance put back, the request
 * cancelled, and the merchant told exactly what happened to the money (§9.5, §10.9).
 */
async function settleChange(
  env: Env,
  ctx: CheckoutContext,
  subId: string,
  invoice: Json | null,
): Promise<Response> {
  const invoiceId = invoice && isStripeObjectId(invoice.id) ? invoice.id : null;
  const sub = await stripe<Json>(
    'GET',
    `/v1/subscriptions/${subId}`,
    { params: { expand: SETTLE_EXPAND } },
    'subscription_read',
  );
  const customerId = idOf(sub.customer);
  const args = customerId ? changeSettleArgs(ctx.request.id, customerId, sub, invoiceId) : null;
  if (!args)
    refuse(502, 'stripe_error', {
      step: 'subscription_read',
      detail: 'The subscription has no customer.',
    });
  const result: SettleResult = (await isCurrentSubscription(env.admin, subId))
    ? await settle(env.admin, args)
    : { ok: false, reason: 'not_current_subscription' };
  if (result.ok === true) return json({ kind: 'applied' });

  const amountPaid =
    invoice && invoice.status === 'paid' && Number.isSafeInteger(invoice.amount_paid)
      ? Number(invoice.amount_paid)
      : 0;
  const undo = await undoPaidChange(
    env.admin,
    ctx,
    sub,
    invoice,
    amountPaid,
    result.reason ?? null,
  );
  refuse(409, changeFailureCode(amountPaid, undo.refundComplete), {
    reason: result.reason ?? null,
  });
}

/**
 * A change Stripe charged (and applied) that the database did not: refund the payment, reverse
 * what its invoice did to the customer's credit balance (a downgrade's credit, credit spent on an
 * upgrade: money-rr-8, edge-rr-2), put the subscription's items back to the package the database
 * granted (proration none), cancel the request if it is still pending, log at error level. Best
 * effort and never throws: the webhook's invoice.paid runs the same undo, under the same
 * idempotency keys, and is retried by Stripe. Answers whether the money taken is all on its way
 * back (refundOutcome).
 */
async function undoPaidChange(
  admin: SupabaseClient,
  ctx: CheckoutContext,
  sub: Json,
  invoice: Json | null,
  amountPaidCents: number,
  reason: string | null,
): Promise<{ refundComplete: boolean }> {
  const invoiceId = invoice && isStripeObjectId(invoice.id) ? invoice.id : null;
  const refunds: string[] = [];
  const failures: Json[] = [];
  let read = true;
  let reverted: boolean | string = false;
  let balance: Json | null = null;
  try {
    if (invoiceId && amountPaidCents > 0) {
      const payments = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'GET', '/v1/invoice_payments', {
        params: { invoice: invoiceId, status: 'paid', limit: 10 },
      });
      read = payments.ok;
      for (const target of payments.ok ? invoicePaymentTargets(payments.data) : []) {
        const targetId = refundTargetId(target);
        const res = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'POST', '/v1/refunds', {
          params: refundParams(target),
          idempotencyKey: refundIdempotencyKey(targetId),
        });
        if (res.ok) refunds.push(String(res.data?.id ?? ''));
        else if (isAlreadyRefunded(res.error)) refunds.push(`already:${targetId}`);
        else
          failures.push({
            target: targetId,
            status: res.status,
            code: res.error?.error?.code ?? null,
          });
      }
      if (refunds.length > 0) {
        const { error } = await admin.rpc('billing_mark_invoice_refunded', {
          p_invoice_id: invoiceId,
        });
        if (error) console.error('billing_mark_invoice_refunded failed', invoiceId, error.message);
      }
    }
    if (invoice && invoiceId) {
      balance = await reverseBalanceMovement(
        ctx.request.id,
        invoice,
        invoiceId,
        idOf(invoice.customer) ?? idOf(sub.customer),
      );
    }
    reverted = await revertItems(admin, ctx.restaurant.id, ctx.request.id, sub, invoiceId);
  } catch (err) {
    console.error('undoing a paid change failed', ctx.request.id, err);
    failures.push({ step: 'undo', error: String(err instanceof Refusal ? err.body.error : err) });
  }
  const { error: cancelErr } = await admin.rpc('billing_cancel_stripe_request', {
    p_request_id: ctx.request.id,
    p_reason: 'Card payment taken but the change could not be applied; refunded',
  });
  if (cancelErr)
    console.error('billing_cancel_stripe_request failed', ctx.request.id, cancelErr.message);

  const outcome = refundOutcome({
    amountPaidCents,
    read,
    refunded: refunds.length,
    failed: failures.filter((f) => 'target' in f).length,
  });
  await logEvent(
    admin,
    'stripe.change_refunded',
    'error',
    `a package change was charged but not applied (${reason ?? 'unknown'}); refund: ${outcome.outcome}; balance: ${balanceNote(balance)}; items put back: ${String(reverted)}`,
    ctx.restaurant.id,
    {
      request_id: ctx.request.id,
      invoice: invoiceId,
      reason,
      amount_paid: amountPaidCents,
      refund: outcome.outcome,
      refunds,
      failures,
      balance,
      reverted,
    },
  );
  return { refundComplete: outcome.complete };
}

/**
 * Undo what a change invoice did to the customer's credit balance (balanceUndoParams), once per
 * request and invoice. Null when it moved nothing; otherwise what was done, for the log.
 */
async function reverseBalanceMovement(
  requestId: string,
  invoice: Json,
  invoiceId: string,
  customerId: string | null,
): Promise<Json | null> {
  const movement = invoiceBalanceMovement(invoice);
  const params = balanceUndoParams(requestId, invoiceId, movement);
  if (!params) return null;
  if (!isStripeObjectId(customerId)) return { movement, reversed: false, reason: 'no_customer' };
  const res = await stripeRequest<Json>(
    STRIPE_SECRET_KEY,
    'POST',
    `/v1/customers/${customerId}/balance_transactions`,
    { params, idempotencyKey: balanceUndoIdempotencyKey(requestId, invoiceId) },
  );
  if (res.ok) return { movement, reversed: true, transaction: res.data?.id ?? null };
  return {
    movement,
    reversed: false,
    status: res.status,
    code: res.error?.error?.code ?? null,
  };
}

function balanceNote(balance: Json | null): string {
  if (!balance) return 'unchanged';
  return balance.reversed === true
    ? `reversed ${String(balance.movement)}`
    : `NOT reversed ${String(balance.movement)}`;
}

/**
 * Put the subscription's items back to what the database granted (the package the restaurant
 * has), so renewals do not bill a change nobody got. Returns true when a revert was sent, false
 * when nothing differed, or why it was not sent.
 */
async function revertItems(
  admin: SupabaseClient,
  restaurantId: string,
  requestId: string,
  sub: Json,
  invoiceId: string | null,
): Promise<boolean | string> {
  const subId = idOf(sub);
  if (!isStripeObjectId(subId)) return 'no_subscription';
  const granted = await readGranted(admin, restaurantId, subId);
  if (!granted) return 'granted_package_unreadable';
  const items = subscriptionItemsByCode(sub);
  if (!items.ok) return `subscription_${items.error}`;
  if (itemsMatch(granted.quantities, items.items)) return false;
  const missing: Array<{ code: MonthlyCode; cents: number }> = [];
  for (const code of MONTHLY_CODES) {
    const cents = granted.cents[code];
    if (granted.quantities[code] > 0 && !items.items[code] && cents) missing.push({ code, cents });
  }
  const prices = await ensurePrices(missing);
  await stripe(
    'POST',
    `/v1/subscriptions/${subId}`,
    {
      params: revertParams(granted.quantities, items.items, prices),
      idempotencyKey: revertIdempotencyKey(requestId, invoiceId ?? subId),
    },
    'subscription_revert',
  );
  return true;
}

/** The package the database granted, read from the row that holds this subscription. */
async function readGranted(admin: SupabaseClient, restaurantId: string, subId: string) {
  const { data: row, error } = await admin
    .from('subscriptions')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('stripe_subscription_id', subId)
    .maybeSingle();
  if (error || !row) return null;
  const { data: rows, error: itemsErr } = await admin
    .from('subscription_items')
    .select('product_code, quantity, unit_price')
    .eq('subscription_id', (row as { id: string }).id);
  if (itemsErr) return null;
  return grantedLines(rows);
}

// ---------------------------------------------------------------------------------------------
// confirm
// ---------------------------------------------------------------------------------------------

async function confirm(env: Env, body: Json): Promise<Response> {
  const sessionId = body.session_id;
  if (!isStripeObjectId(sessionId) || !sessionId.startsWith('cs_')) refuse(400, 'bad_request');
  requireKey();

  const session = await stripe<Json>(
    'GET',
    `/v1/checkout/sessions/${sessionId}`,
    { params: { expand: ['subscription', 'subscription.default_payment_method'] } },
    'session_read',
  );
  const metadata = (session.metadata ?? {}) as Json;
  const requestId = metadata.billing_request_id;
  if (!isUuid(requestId)) refuse(404, 'not_a_package_payment');

  // The caller check: the request's restaurant must be one the caller may bill. The SQL answers
  // request_not_pending only AFTER that check, so a request the webhook has settled already is
  // still the caller's; settling it again below is then answered as a duplicate.
  const { data: ctxData, error: ctxErr } = await env.userClient.rpc('billing_checkout_context', {
    p_request_id: requestId,
  });
  if (ctxErr) {
    console.error('billing_checkout_context failed', ctxErr);
    refuse(500, 'read_failed');
  }
  const parsed = parseCheckoutContext(ctxData);
  const refusal = parsed.ok ? null : parsed.error;
  if (refusal === 'forbidden') refuse(403, 'forbidden');
  // Any other refusal (not pending, a seat floor no longer met) only means the request cannot be
  // paid AGAIN; the settle below decides what this payment does.
  if (parsed.ok && metadata.restaurant_id !== parsed.ctx.restaurant.id) refuse(403, 'forbidden');
  if (refusal !== null && refusal !== 'request_not_pending' && refusal !== 'plan_limit_exceeded')
    refuse(409, 'cannot_bill', { detail: refusal });

  if (!sessionIsPaid(session)) {
    return json({
      settled: false,
      status:
        session.status === 'complete'
          ? String(session.payment_status ?? 'unpaid')
          : String(session.status ?? 'open'),
    });
  }
  const sub = await subscriptionOfSession(session);
  const args = sub ? checkoutSettleArgs(session, sub, requestId) : null;
  if (!args)
    refuse(502, 'stripe_error', {
      step: 'session_read',
      detail: 'The session has no subscription yet.',
    });
  // Shared with the webhook's checkout.session.completed: whichever comes second is a duplicate.
  const result = await settle(env.admin, args);
  if (result.ok === true) {
    const replaced = result.replaced_subscription_id;
    if (isStripeObjectId(replaced) && replaced !== args.p_stripe_subscription_id) {
      // Defence in depth (§9.2): start cancelled it before the session opened; if that did not
      // stick, it is cancelled now. A failure here is logged, never the merchant's error.
      await cancelOldSubscription(
        env.admin,
        String(metadata.restaurant_id),
        replaced,
        'replaced_on_settle',
        false,
      );
    }
    return json({ settled: true });
  }
  // Paid for something that cannot be applied (the request was replaced or refused, or the
  // package no longer fits): the webhook refunds it in full and cancels the subscription (D12,
  // §9.5). The merchant is told the money is coming back, never that nothing was charged.
  const charged = session.payment_status === 'paid';
  return json({
    settled: false,
    status: charged ? 'charged_refunded' : String(result.reason ?? 'not_settled'),
    reason: result.reason ?? null,
  });
}

async function subscriptionOfSession(session: Json): Promise<Json | null> {
  if (session.subscription && typeof session.subscription === 'object')
    return session.subscription as Json;
  const id = idOf(session.subscription);
  if (!isStripeObjectId(id)) return null;
  return await stripe<Json>(
    'GET',
    `/v1/subscriptions/${id}`,
    { params: { expand: SETTLE_EXPAND } },
    'subscription_read',
  );
}

// ---------------------------------------------------------------------------------------------
// portal
// ---------------------------------------------------------------------------------------------

async function portal(env: Env, body: Json): Promise<Response> {
  const branchId = body.branch_id;
  if (!isUuid(branchId)) refuse(400, 'bad_request');
  requireKey();
  // Not gated on the switch (§9.9): a restaurant paying by card keeps its card, invoices and
  // cancel button while new card purchases are off.

  const branch = await loadBranchContext(env.userClient, branchId);
  if (!branch.can_manage) refuse(403, 'forbidden');
  const customerId = branch.stripe_customer_id;
  if (!isStripeObjectId(customerId)) refuse(409, 'no_stripe_customer');

  // The portal is someone's card and invoices. It is opened only for a customer Stripe says is
  // this restaurant's.
  const customer = await stripeRequest<Json>(
    STRIPE_SECRET_KEY,
    'GET',
    `/v1/customers/${customerId}`,
  );
  if (!customer.ok && customer.status !== 404)
    stripeFailed('customer_read', customer.status, customer.error);
  if (!customer.ok || !customerBelongsTo(customer.data, branch.restaurant_id))
    refuse(409, 'customer_mismatch');

  const origin = adminOrigin(env.req);
  const configuration = await ensurePortalConfiguration(env.admin);
  const params: Record<string, string> = {
    customer: customerId,
    return_url: portalReturnUrl(origin, branchId),
    configuration,
  };
  const session = await stripe<{ url?: unknown }>(
    'POST',
    '/v1/billing_portal/sessions',
    // A portal session is single-use and short-lived: the key only folds a double click into one.
    {
      params,
      idempotencyKey: idempotencyKey(
        'billing_portal',
        `${customerId}:${Math.floor(Date.now() / 60_000)}`,
        params,
      ),
    },
    'portal_session',
  );
  if (typeof session.url !== 'string' || !session.url.startsWith('https://')) {
    refuse(502, 'stripe_error', {
      step: 'portal_session',
      detail: 'Stripe answered without a portal URL.',
    });
  }
  return json({ url: session.url });
}

// ---------------------------------------------------------------------------------------------
// status and set_enabled (platform admin)
// ---------------------------------------------------------------------------------------------

function requirePlatformAdmin(user: User) {
  if ((user.app_metadata as Json | undefined)?.is_platform_admin !== true)
    refuse(403, 'platform_admin_only');
}

async function buildStatus(admin: SupabaseClient): Promise<Json> {
  const settings = await readBillingSettings(admin);
  let account: ReturnType<typeof accountSummary> = null;
  let portalConfigured = false;
  let pricesReady = false;
  if (STRIPE_SECRET_KEY && STRIPE_MODE) {
    const acct = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'GET', '/v1/account');
    if (acct.ok) account = accountSummary(acct.data);
    else console.warn('status: account read failed', acct.status);
    portalConfigured =
      (await portalConfigurationState(settings.portal_configuration_id)) === 'usable';
    pricesReady = await catalogPricesReady(admin);
  }
  return {
    mode: STRIPE_MODE,
    secret_key_set: STRIPE_SECRET_KEY.length > 0,
    publishable_key_set: (Deno.env.get('STRIPE_PUBLISHABLE_KEY') ?? '').length > 0,
    webhook_secret_set: (Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '').length > 0,
    connect_webhook_secret_set: (Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET') ?? '').length > 0,
    stripe_enabled: settings.stripe_enabled === true,
    account,
    portal_configured: portalConfigured,
    prices_ready: pricesReady,
    last_event_at: await lastPlatformEventAt(admin),
    dashboard_base: account ? stripeDashboardBase(account.id, STRIPE_MODE) : null,
  };
}

async function setEnabled(env: Env, body: Json): Promise<Response> {
  requirePlatformAdmin(env.user);
  if (typeof body.enabled !== 'boolean') refuse(400, 'bad_request');
  const enabled = body.enabled;

  if (enabled) {
    const webhookSecretSet = (Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '').length > 0;
    if (!STRIPE_SECRET_KEY || !STRIPE_MODE || !webhookSecretSet) {
      // Without the webhook a paid Checkout would still settle through `confirm`, but renewals,
      // failures and cancellations would never reach the database.
      refuse(409, 'not_ready', {
        secret_key_set: STRIPE_SECRET_KEY.length > 0,
        webhook_secret_set: webhookSecretSet,
      });
    }
    const catalog = catalogMonthlyCents(await readCatalog(env.admin));
    if (!catalog) refuse(409, 'catalog_incomplete');
    await ensurePrices(catalog);
    await ensureSetupProducts([...MONTHLY_CODES]);
    await ensurePortalConfiguration(env.admin);
  }

  // Only this key is written (billing_settings_merge is one atomic `billing || patch`), so a
  // merchant's portal call storing its configuration id at the same moment cannot put back the
  // value this switch replaced (SEC-EDGE-2).
  await mergeBillingSettings(env.admin, { stripe_enabled: enabled }, env.user.id);
  await logEvent(
    env.admin,
    enabled ? 'stripe.billing_enabled' : 'stripe.billing_disabled',
    'info',
    enabled ? 'packages are charged by card' : 'card billing switched off for new purchases',
    null,
    {
      by: env.user.id,
      mode: STRIPE_MODE,
    },
  );
  return json(await buildStatus(env.admin));
}

// ---------------------------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------------------------

async function stripeEnabled(userClient: SupabaseClient): Promise<boolean> {
  // Read as the caller (EXECUTE authenticated).
  const { data, error } = await userClient.rpc('billing_stripe_enabled');
  if (error) {
    console.error('billing_stripe_enabled failed', error);
    refuse(500, 'read_failed');
  }
  return data === true;
}

async function loadCheckoutContext(
  userClient: SupabaseClient,
  requestId: string,
): Promise<CheckoutContext> {
  const { data, error } = await userClient.rpc('billing_checkout_context', {
    p_request_id: requestId,
  });
  if (error) {
    console.error('billing_checkout_context failed', error);
    refuse(500, 'read_failed');
  }
  const parsed = parseCheckoutContext(data);
  if (!parsed.ok) {
    const raw = (data ?? {}) as Json;
    // forbidden also answers an unknown request, so this says nothing about which ids exist.
    if (parsed.error === 'forbidden') refuse(403, 'forbidden');
    // Only said to someone who may bill the restaurant: the SQL checks that first.
    if (parsed.error === 'request_not_pending')
      refuse(409, 'request_not_pending', { status: raw.status ?? null });
    // The seats no longer cover the active branches: refused BEFORE anything is charged (§9.5).
    if (parsed.error === 'plan_limit_exceeded')
      refuse(409, 'plan_limit_exceeded', { detail: raw.detail ?? null });
    console.error('billing_checkout_context unusable', requestId, parsed.error);
    refuse(409, 'cannot_bill', { detail: parsed.error });
  }
  return parsed.ctx;
}

interface BranchContext {
  restaurant_id: string;
  can_manage: boolean;
  stripe_customer_id: string | null;
  stripe_managed: boolean;
}

async function loadBranchContext(
  userClient: SupabaseClient,
  branchId: string,
): Promise<BranchContext> {
  const { data, error } = await userClient.rpc('billing_branch_context', { p_branch_id: branchId });
  if (error) {
    console.error('billing_branch_context failed', error);
    refuse(500, 'read_failed');
  }
  const d = (data ?? {}) as Json;
  if (d.ok !== true) {
    if (d.error === 'branch_not_found') refuse(404, 'branch_not_found');
    refuse(403, 'forbidden');
  }
  if (!isUuid(d.restaurant_id)) refuse(403, 'forbidden');
  return {
    restaurant_id: d.restaurant_id,
    can_manage: d.can_manage === true,
    stripe_customer_id:
      typeof d.stripe_customer_id === 'string' && d.stripe_customer_id
        ? d.stripe_customer_id
        : null,
    stripe_managed: d.stripe_managed === true,
  };
}

/**
 * The request is being paid by this session or this invoice (what the webhook finds it by), and
 * the invoice's page is kept for the plan page while the change waits on it.
 */
async function markRequest(
  admin: SupabaseClient,
  requestId: string,
  sessionId: string | null,
  invoiceId: string | null,
  invoiceUrl: string | null,
) {
  const { error } = await admin.rpc('billing_mark_request_stripe', {
    p_request_id: requestId,
    p_checkout_session_id: sessionId,
    p_invoice_id: invoiceId,
    p_invoice_url: invoiceUrl,
  });
  if (error) {
    // Replaced or decided in another tab while this one was paying.
    if (/request_not_pending/.test(error.message ?? '')) refuse(409, 'request_not_pending');
    console.error('billing_mark_request_stripe failed', requestId, error);
    refuse(500, 'write_failed');
  }
}

/**
 * The same mark once the money is in (money-rr-4). A request replaced or decided meanwhile is not
 * an error here: the settle that follows refuses it and refunds the payment. Any other failure
 * fails the call, so the merchant's retry replays into this invoice (the change key, or the invoice
 * found by its fees) and stores it, instead of a paid change being left that nothing points to.
 */
async function markAfterCharge(
  admin: SupabaseClient,
  requestId: string,
  invoiceId: string,
  invoiceUrl: string | null,
) {
  const { error } = await admin.rpc('billing_mark_request_stripe', {
    p_request_id: requestId,
    p_checkout_session_id: null,
    p_invoice_id: invoiceId,
    p_invoice_url: invoiceUrl,
  });
  if (!error) return;
  if (/request_not_pending/.test(error.message ?? '')) {
    console.warn('paid change for a request no longer pending; the settle refunds it', requestId);
    return;
  }
  console.error('billing_mark_request_stripe (after charge) failed', requestId, error);
  refuse(500, 'write_failed');
}

/**
 * The request is about to be charged through Stripe (money-rr-1): billing_mark_change_started
 * locks it (payment_in_progress) BEFORE the subscription update or the fee invoice is sent, so a
 * change whose answer is lost can still not be replaced and charged a second time. A request that
 * is no longer pending is refused here, with nothing sent.
 */
async function markChangeStarted(admin: SupabaseClient, requestId: string) {
  const { error } = await admin.rpc('billing_mark_change_started', { p_request_id: requestId });
  if (!error) return;
  if (/request_not_pending/.test(error.message ?? '')) refuse(409, 'request_not_pending');
  console.error('billing_mark_change_started failed', requestId, error);
  refuse(500, 'write_failed');
}

/** Whether the restaurant's row still holds this subscription (billing_subscription_is_current). */
async function isCurrentSubscription(admin: SupabaseClient, subId: string): Promise<boolean> {
  const { data, error } = await admin.rpc('billing_subscription_is_current', {
    p_stripe_subscription_id: subId,
  });
  if (error) {
    console.error('billing_subscription_is_current failed', subId, error);
    refuse(500, 'read_failed');
  }
  return data === true;
}

async function cancelRequest(admin: SupabaseClient, requestId: string, reason: string) {
  const { error } = await admin.rpc('billing_cancel_stripe_request', {
    p_request_id: requestId,
    p_reason: reason,
  });
  if (error) {
    console.error('billing_cancel_stripe_request failed', requestId, error);
    refuse(500, 'write_failed');
  }
}

interface SettleResult {
  ok?: boolean;
  duplicate?: boolean;
  reason?: string;
  status?: string;
  detail?: string;
  /** A first purchase that took over from a different Stripe subscription: cancel that one. */
  replaced_subscription_id?: string | null;
}

async function settle(admin: SupabaseClient, args: Json): Promise<SettleResult> {
  const { data, error } = await admin.rpc('billing_settle_stripe_request', args);
  if (error) {
    // The invoice is stored on the request, so a retry (or invoice.paid) settles it without a new
    // charge.
    console.error('billing_settle_stripe_request failed', args.p_request_id, error);
    refuse(500, 'write_failed');
  }
  return (data ?? {}) as SettleResult;
}

/** platform_settings.billing: { stripe_enabled, portal_configuration_id, grace_days }. */
async function readBillingSettings(admin: SupabaseClient): Promise<Json> {
  const { data, error } = await admin
    .from('platform_settings')
    .select('billing')
    .eq('id', 1)
    .maybeSingle();
  if (error) {
    console.error('platform_settings read failed', error);
    return {};
  }
  const billing = (data as { billing?: unknown } | null)?.billing;
  return billing && typeof billing === 'object' && !Array.isArray(billing) ? (billing as Json) : {};
}

/** The only way platform_settings.billing is written: an atomic merge of these keys (§9.9). */
async function mergeBillingSettings(
  admin: SupabaseClient,
  patch: Json,
  updatedBy: string | null = null,
) {
  const { error } = await admin.rpc('billing_settings_merge', {
    p_patch: patch,
    p_updated_by: updatedBy,
  });
  if (error) {
    console.error('billing_settings_merge failed', error);
    refuse(500, 'write_failed');
  }
}

async function readCatalog(admin: SupabaseClient): Promise<unknown> {
  const { data, error } = await admin
    .from('billing_products')
    .select('code, monthly_price, is_active')
    .in('code', [...MONTHLY_CODES]);
  if (error) {
    console.error('billing_products read failed', error);
    refuse(500, 'read_failed');
  }
  return data;
}

/** When the last platform (not Connect) Stripe event arrived: the webhook is really connected. */
async function lastPlatformEventAt(admin: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin
    .from('billing_events')
    .select('created_at')
    .not('stripe_event_id', 'is', null)
    .not('type', 'like', 'account.%')
    .not('type', 'like', 'payment_intent.%')
    .not('type', 'like', 'charge.%')
    .not('type', 'like', 'refund.%')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('billing_events read failed', error);
    return null;
  }
  const row = Array.isArray(data) ? (data[0] as { created_at?: unknown } | undefined) : undefined;
  return typeof row?.created_at === 'string' ? row.created_at : null;
}

async function logEvent(
  admin: SupabaseClient,
  type: string,
  level: 'info' | 'warn' | 'error',
  note: string,
  restaurantId: string | null,
  payload: Json,
) {
  const { error } = await admin.rpc('billing_log_event', {
    p_type: type,
    p_level: level,
    p_note: note,
    p_restaurant_id: restaurantId,
    p_payload: payload,
  });
  if (error) console.error('billing_log_event failed', type, error);
}

// ---------------------------------------------------------------------------------------------
// Stripe objects this function keeps in shape
// ---------------------------------------------------------------------------------------------

/**
 * The restaurant's Stripe customer. A stored id is used only if Stripe still has it (a test-mode id
 * means nothing to a live key) AND it carries this restaurant's id; otherwise a new customer is made
 * and stored with the service role.
 */
async function ensureCustomer(admin: SupabaseClient, ctx: CheckoutContext): Promise<string> {
  const stored = ctx.restaurant.stripe_customer_id ?? ctx.subscription?.stripe_customer_id ?? null;
  let replaces: string | null = null;
  if (isStripeObjectId(stored)) {
    const res = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'GET', `/v1/customers/${stored}`);
    if (res.ok && customerBelongsTo(res.data, ctx.restaurant.id)) return stored;
    if (!res.ok && res.status !== 404) stripeFailed('customer_read', res.status, res.error);
    console.warn(
      'stored Stripe customer is not usable; making a new one',
      ctx.restaurant.id,
      stored,
    );
    replaces = stored;
  }
  const customer = await stripe<{ id?: unknown }>(
    'POST',
    '/v1/customers',
    {
      params: customerParams(ctx.restaurant),
      idempotencyKey: replaces
        ? `billing_customer:${ctx.restaurant.id}:replaces:${replaces}`
        : `billing_customer:${ctx.restaurant.id}`,
    },
    'customer',
  );
  if (!isStripeObjectId(customer.id)) refuse(502, 'stripe_error', { step: 'customer' });
  const { error } = await admin.rpc('billing_set_stripe_customer', {
    p_restaurant_id: ctx.restaurant.id,
    p_customer_id: customer.id,
  });
  if (error) {
    // The idempotency key gives the same customer back on the retry, so nothing is duplicated.
    console.error('billing_set_stripe_customer failed', ctx.restaurant.id, error);
    refuse(500, 'write_failed');
  }
  return customer.id;
}

/**
 * Cancel a Stripe subscription that must not go on billing this restaurant (§9.2): one still
 * stored on a restaurant that is buying again, or one a settle reports it replaced. Only one of
 * ours for this restaurant that Stripe has not ended (shouldCancelOldSubscription). Its open
 * invoices are voided first, so neither Smart Retries nor an old invoice link can take money for
 * it; then it is cancelled now, without proration.
 * `strict`: a Stripe failure is the answer (nothing new is sold over a live subscription); otherwise
 * it is logged at error level for a person.
 */
async function cancelOldSubscription(
  admin: SupabaseClient,
  restaurantId: string,
  subId: string,
  why: string,
  strict: boolean,
) {
  const fail = (step: string, status: number, error: unknown) => {
    if (strict)
      stripeFailed(step, status, error as { error?: { code?: string; message?: string } } | null);
    return logEvent(
      admin,
      'stripe.old_subscription_not_cancelled',
      'error',
      'a Stripe subscription that should have been cancelled could still bill the restaurant',
      restaurantId,
      { subscription: subId, why, step, status },
    );
  };
  const res = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'GET', `/v1/subscriptions/${subId}`);
  if (!res.ok) {
    if (res.status === 404) return;
    return await fail('old_subscription_read', res.status, res.error);
  }
  if (!shouldCancelOldSubscription(res.data, restaurantId)) return;

  const open = await stripeRequest<{ data?: unknown }>(STRIPE_SECRET_KEY, 'GET', '/v1/invoices', {
    params: { subscription: subId, status: 'open', limit: 100 },
  });
  if (!open.ok) return await fail('old_invoices_read', open.status, open.error);
  const voided: string[] = [];
  for (const inv of Array.isArray(open.data?.data) ? (open.data.data as Json[]) : []) {
    if (!isStripeObjectId(inv.id)) continue;
    const v = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'POST', `/v1/invoices/${inv.id}/void`);
    if (!v.ok) return await fail('old_invoice_void', v.status, v.error);
    voided.push(inv.id);
  }
  // Cancelled now; `prorate` defaults to false, so nothing is credited or charged for it.
  const cancel = await stripeRequest<Json>(
    STRIPE_SECRET_KEY,
    'DELETE',
    `/v1/subscriptions/${subId}`,
  );
  // Gone meanwhile (404) is the state wanted.
  if (!cancel.ok && cancel.status !== 404)
    return await fail('old_subscription_cancel', cancel.status, cancel.error);
  await logEvent(
    admin,
    'stripe.old_subscription_cancelled',
    'warn',
    'a Stripe subscription the restaurant no longer uses was cancelled so it cannot bill again',
    restaurantId,
    { subscription: subId, why, status: res.data.status ?? null, voided_invoices: voided },
  );
}

/** Void an open invoice nothing will apply. True when it is void (or already was). */
async function voidInvoice(
  admin: SupabaseClient,
  restaurantId: string,
  invoiceId: string,
  requestId: string,
): Promise<boolean> {
  const res = await stripeRequest<Json>(
    STRIPE_SECRET_KEY,
    'POST',
    `/v1/invoices/${invoiceId}/void`,
  );
  if (res.ok) return true;
  const again = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'GET', `/v1/invoices/${invoiceId}`);
  if (again.ok && again.data.status === 'void') return true;
  await logEvent(
    admin,
    'stripe.invoice_not_voided',
    'error',
    'an invoice no request will apply could not be voided; paying it would take money for nothing',
    restaurantId,
    {
      invoice: invoiceId,
      request_id: requestId,
      status: res.status,
      code: res.error?.error?.code ?? null,
    },
  );
  return false;
}

/**
 * A fee invoice left as a draft that will never be charged. A draft cannot be voided and nobody
 * can pay it (no page; auto_advance off), so deleting it only keeps the Dashboard tidy: best effort.
 */
async function deleteDraftInvoice(invoiceId: string) {
  const res = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'DELETE', `/v1/invoices/${invoiceId}`);
  if (!res.ok && res.status !== 404)
    console.info('an abandoned draft fee invoice was left in place', invoiceId, res.status);
}

function setupCodesOf(ctx: CheckoutContext): MonthlyCode[] {
  return MONTHLY_CODES.filter((code) =>
    ctx.charges.some((c) => c.code === code && c.net_cents > 0),
  );
}

/** The one-time products price_data lines are charged on. */
async function ensureSetupProducts(codes: MonthlyCode[]) {
  for (const code of codes) await ensureProduct(SETUP_PRODUCT_IDS[code]);
}

async function ensureProduct(productId: string) {
  const res = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'GET', `/v1/products/${productId}`);
  if (res.ok) {
    if (res.data?.active !== true) {
      await stripe(
        'POST',
        `/v1/products/${productId}`,
        { params: { active: 'true' } },
        'product_activate',
      );
    }
    return;
  }
  if (res.status !== 404) stripeFailed('product_read', res.status, res.error);
  const created = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'POST', '/v1/products', {
    params: productParams(productId),
    idempotencyKey: `billing_product:${productId}`,
  });
  // Made by a parallel request in the meantime: the explicit id is what makes that harmless.
  if (!created.ok && created.error?.error?.code !== 'resource_already_exists') {
    stripeFailed('product_create', created.status, created.error);
  }
}

/**
 * The recurring price for each (code, amount), found by its lookup key or created. A price found
 * under the key that is not exactly that amount and product is replaced (transfer_lookup_key).
 */
async function ensurePrices(needs: Array<{ code: MonthlyCode; cents: number }>): Promise<PriceIds> {
  const prices: PriceIds = {};
  if (needs.length === 0) return prices;
  const found = await stripe<{ data?: unknown }>(
    'GET',
    '/v1/prices',
    {
      params: {
        lookup_keys: needs.map((n) => priceLookupKey(n.code, n.cents)),
        active: 'true',
        limit: 10,
      },
    },
    'price_lookup',
  );
  const list = Array.isArray(found.data) ? (found.data as Json[]) : [];
  for (const need of needs) {
    const key = priceLookupKey(need.code, need.cents);
    const hit = list.find((p) => p.lookup_key === key);
    if (hit && priceMatches(hit, need.code, need.cents)) {
      prices[need.code] = String(hit.id);
      continue;
    }
    await ensureProduct(MONTHLY_PRODUCT_IDS[need.code]);
    const params = priceParams(need.code, need.cents);
    const created = await stripe<Json>(
      'POST',
      '/v1/prices',
      { params, idempotencyKey: idempotencyKey('billing_price', key, params) },
      'price_create',
    );
    if (!priceMatches(created, need.code, need.cents))
      refuse(502, 'stripe_error', { step: 'price_create', detail: key });
    prices[need.code] = String(created.id);
  }
  return prices;
}

/** Whether the catalog's current monthly prices all exist at Stripe (read only). */
async function catalogPricesReady(admin: SupabaseClient): Promise<boolean> {
  try {
    const catalog = catalogMonthlyCents(await readCatalog(admin));
    if (!catalog) return false;
    const found = await stripeRequest<{ data?: unknown }>(STRIPE_SECRET_KEY, 'GET', '/v1/prices', {
      params: {
        lookup_keys: catalog.map((c) => priceLookupKey(c.code, c.cents)),
        active: 'true',
        limit: 10,
      },
    });
    if (!found.ok) return false;
    const list = Array.isArray(found.data?.data) ? (found.data.data as Json[]) : [];
    return catalog.every((c) => list.some((p) => priceMatches(p, c.code, c.cents)));
  } catch {
    return false;
  }
}

/**
 * Whether a stored portal configuration can be reused: usable, unusable (gone, deactivated or
 * edited in the Dashboard), or unknown (Stripe did not answer). Only a definite "unusable" makes a
 * new one: a transient error must not make every merchant's portal call rewrite the settings.
 */
async function portalConfigurationState(id: unknown): Promise<'usable' | 'unusable' | 'unknown'> {
  if (!isStripeObjectId(id)) return 'unusable';
  const res = await stripeRequest<Json>(
    STRIPE_SECRET_KEY,
    'GET',
    `/v1/billing_portal/configurations/${id}`,
  );
  if (!res.ok) return isRetryableStripeFailure(res.status) ? 'unknown' : 'unusable';
  return isUsablePortalConfiguration(res.data) ? 'usable' : 'unusable';
}

/** The portal configuration (D10), kept in platform_settings.billing.portal_configuration_id. */
async function ensurePortalConfiguration(admin: SupabaseClient): Promise<string> {
  const settings = await readBillingSettings(admin);
  const stored = settings.portal_configuration_id;
  if (isStripeObjectId(stored)) {
    const state = await portalConfigurationState(stored);
    // Unknown: use it; the portal session call either works or answers the outage itself.
    if (state !== 'unusable') return stored;
  }
  const params = portalConfigurationParams();
  const created = await stripe<Json>(
    'POST',
    '/v1/billing_portal/configurations',
    {
      params,
      idempotencyKey: idempotencyKey('billing_portal_config', STRIPE_MODE ?? 'none', params),
    },
    'portal_configuration',
  );
  if (!isStripeObjectId(created.id)) refuse(502, 'stripe_error', { step: 'portal_configuration' });
  // Only this key: never the switch, whatever a merchant's call read before (SEC-EDGE-2).
  await mergeBillingSettings(admin, { portal_configuration_id: created.id });
  return created.id;
}

/** D12: one open Checkout per restaurant. A failure is logged; a stale payment is refunded anyway. */
async function expireOtherSessions(customerId: string, keepId: string) {
  const open = await stripeRequest<{ data?: unknown }>(
    STRIPE_SECRET_KEY,
    'GET',
    '/v1/checkout/sessions',
    {
      params: { customer: customerId, status: 'open', limit: 100 },
    },
  );
  if (!open.ok) {
    console.warn('listing open Checkout sessions failed', customerId, open.status);
    return;
  }
  for (const s of Array.isArray(open.data?.data) ? (open.data.data as Json[]) : []) {
    if (!isStripeObjectId(s.id) || s.id === keepId) continue;
    const res = await stripeRequest(
      STRIPE_SECRET_KEY,
      'POST',
      `/v1/checkout/sessions/${s.id}/expire`,
    );
    if (!res.ok) console.warn('expiring an old Checkout session failed', s.id, res.status);
  }
}

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

function requireKey() {
  if (!STRIPE_SECRET_KEY || !STRIPE_MODE) refuse(503, 'stripe_not_configured');
}

function adminOrigin(req: Request): string {
  const origin = resolveAdminOrigin({
    requestOrigin: req.headers.get('origin'),
    publicAdminUrl: PUBLIC_ADMIN_URL,
    extraOrigins: EXTRA_RETURN_ORIGINS,
    // Only a test key may send the merchant back to a developer's localhost admin.
    allowLocalhost: STRIPE_MODE === 'test' || IS_LOCAL_STACK,
  });
  if (!origin) {
    refuse(500, 'admin_url_not_configured', {
      detail:
        'Set the PUBLIC_ADMIN_URL secret to the merchant app origin over HTTPS so Stripe can send the merchant back.',
    });
  }
  return origin;
}

/**
 * One Stripe call that must succeed: its data, or a 502 answer (never 503: that means "off"). A
 * keyed call Stripe is still processing for another request (409 idempotency_key_in_use) is
 * answered 409 payment_in_progress: busy, try again (edge-rr-3).
 */
async function stripe<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { params?: Record<string, unknown>; idempotencyKey?: string },
  step: string,
): Promise<T> {
  const res = await stripeRequest<T>(STRIPE_SECRET_KEY, method, path, opts);
  if (!res.ok) {
    if (opts.idempotencyKey && isIdempotencyInUse(res.status, res.error))
      refuse(409, 'payment_in_progress', { step });
    stripeFailed(step, res.status, res.error);
  }
  return res.data;
}

function stripeFailed(
  step: string,
  status: number,
  error: { error?: { code?: string; message?: string } } | null,
): never {
  console.error('stripe call failed', step, status, error?.error?.code ?? null);
  refuse(502, 'stripe_error', {
    step,
    stripe_status: status,
    stripe_code: error?.error?.code ?? null,
    detail: error?.error?.message ?? null,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
