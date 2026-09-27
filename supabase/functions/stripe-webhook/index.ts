// Stripe webhook for the PLATFORM's own account: restaurants paying the platform for their package
// (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §4.3, §9). Payments are taken by `stripe-billing`;
// this endpoint records what Stripe did afterwards: the first purchase completing, renewals paid or
// failed, cancellations, a card changed in the portal.
//
// Diners' card payments are NOT handled here. They are direct charges on each branch's connected
// account and their events go to stripe-connect-webhook (its own endpoint and signing secret).
//
// Configure in Stripe Dashboard -> Workbench -> Webhooks -> Add destination
//   Events from:  Your account
//   Endpoint URL: https://<project>.supabase.co/functions/v1/stripe-webhook
//   API version:  2026-08-26.dahlia (EVENT_API_VERSION). The Dashboard no longer offers basil for a
//                 new destination. Nothing but the event's type and ids is read from a payload:
//                 every object is re-read by id on the pinned STRIPE_API_VERSION, so the shapes
//                 this code reads are basil's whatever the endpoint sends.
//   Events (exactly these 12; NEVER invoice.created, whose non-2xx delays invoice finalization):
//     checkout.session.completed                  checkout.session.expired
//     invoice.paid                                invoice.payment_failed
//     invoice.payment_action_required
//     customer.subscription.created               customer.subscription.updated
//     customer.subscription.deleted               customer.subscription.trial_will_end
//     customer.subscription.pending_update_applied
//     customer.subscription.pending_update_expired
//     customer.updated
//   Secret: the destination's signing secret -> Supabase secret STRIPE_WEBHOOK_SECRET.
//
// Deploy with verify_jwt = false (Stripe sends no JWT); authenticity is the HMAC signature.
//
// Every event is checked in this order: signature (5-minute replay window, every v1 of a rolling
// secret), shape, the connected account it came from (an event with `account` is Connect's and is
// dropped BEFORE it is claimed, so the Connect endpoint does not see it as a repeat), the key's mode
// (a live endpoint also receives test events), then the claim on the event id (stripe_event_claim,
// in the ledger shared with Connect: event ids are global). A claim is a LEASE: an event still
// being handled after the lease (a worker killed mid-handler) can be claimed again by Stripe's
// retry, and it is marked done (stripe_event_done) only once handled (WH-5). The claim says which
// of three it is (SEC-R2-2): claimed -> handled here; handled before -> 200 "duplicate"; in flight
// (another delivery inside its lease) -> 409, so Stripe delivers it again rather than counting it
// delivered. A handler that throws releases it (stripe_event_forget) and answers 500, so Stripe's
// retry is handled for real. Every Stripe call gives up after 20 s (stripeRequest), well inside
// the lease, so a hung call fails the handler instead of holding the event.
//
// WHAT IS RETRIED. Only a 404 on a re-read is a business answer (the object is gone): logged and
// answered 200. Any other Stripe failure (401/403 after a key roll, 429, 5xx, a network error)
// throws, so the event is retried rather than silently consumed (WH-4). A refusal from SQL
// ({ok:false}) is logged and answered 200, since retrying would not change it.
//
// MONEY TAKEN BUT NOT APPLIED IS GIVEN BACK (§9.3, §9.5). A paid Checkout whose request is gone or
// cannot be applied is refunded in full and its subscription cancelled (D12); a paid change
// invoice whose request is gone or cannot be applied is refunded, what it did to the customer's
// credit balance reversed, and the subscription's items put back to the package the database
// granted. A renewal or change paid by a subscription no restaurant holds any more (the manual rail
// detached it while Stripe was still retrying) is refunded and that subscription cancelled (§10.2).
// All are logged at error level, truthfully.
//
// Paid-through only moves when money arrives (D8): subscription events change status and cancel
// flags (billing_sync_stripe_status never moves the date); invoice.paid and a settled purchase move
// it. What each event means for a restaurant is decided in SQL (billing_* functions).

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  eventMatchesMode,
  isRetryableStripeFailure,
  isStripeObjectId,
  isUuid,
  stripeKeyMode,
  stripeRequest,
  verifyStripeSignature,
} from '../_shared/stripe-connect.ts';
import {
  type MonthlyCode,
  type PriceIds,
  EVENT_API_VERSION,
  MONTHLY_CODES,
  balanceUndoIdempotencyKey,
  balanceUndoParams,
  cardOf,
  cardOnlySyncArgs,
  cardSyncIdempotencyKey,
  changeSettleArgs,
  checkoutSettleArgs,
  eventClaimState,
  grantedLines,
  idOf,
  invoiceBalanceMovement,
  invoicePaidThrough,
  invoicePaymentTargets,
  invoiceRecord,
  invoiceRequestId,
  isAlreadyRefunded,
  isStaleRefundableReason,
  isStripeManagedStatus,
  isoFromUnix,
  itemsMatch,
  mapCard,
  priceLookupKey,
  priceMatches,
  refundIdempotencyKey,
  refundOutcome,
  refundParams,
  refundTargetId,
  revertIdempotencyKey,
  revertParams,
  sessionIsPaid,
  shouldCancelOldSubscription,
  subscriptionCardNeedsSync,
  subscriptionItemsByCode,
  subscriptionMonthlyAmount,
  subscriptionOwner,
  syncStatusArgs,
} from '../_shared/stripe-billing.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

/**
 * How long a claimed event is this delivery's. Longer than any handler takes (a few Stripe calls);
 * a delivery still "handling" after it was killed, and Stripe's retry may take it over.
 */
const EVENT_LEASE_SECONDS = 300;

type Json = Record<string, unknown>;

interface StripeEvent {
  id: string;
  type: string;
  livemode?: boolean;
  api_version?: string;
  /** Set only on events from a connected account: those are stripe-connect-webhook's. */
  account?: string;
  data: { object: Json; previous_attributes?: Json };
}

/** The subscription as the handlers read it: the card on it and on its customer, expanded. */
const SUBSCRIPTION_EXPAND = [
  'default_payment_method',
  'customer.invoice_settings.default_payment_method',
];

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  // Stripe retries a 503 for three days, so events sent before the secrets are set are not lost.
  if (!STRIPE_WEBHOOK_SECRET) return new Response('webhook_not_configured', { status: 503 });
  const mode = stripeKeyMode(STRIPE_SECRET_KEY);
  if (!STRIPE_SECRET_KEY || !mode) return new Response('stripe_not_configured', { status: 503 });

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing_signature', { status: 400 });
  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, sig, STRIPE_WEBHOOK_SECRET))) {
    return new Response('bad_signature', { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('invalid_json', { status: 400 });
  }
  if (!event?.id || !event?.type || !event?.data?.object)
    return new Response('invalid_event', { status: 400 });

  // An event from a branch's connected account belongs to stripe-connect-webhook. It can only get
  // here if this destination also listens to connected accounts, and it must then be ignored:
  // a restaurant's own Stripe Billing would otherwise be read as the platform's, and claiming it
  // here would make the Connect endpoint drop it as a repeat. 200, so Stripe does not retry.
  if (event.account) {
    console.warn(`stripe-webhook: ignored ${event.type} from connected account ${event.account}`);
    return new Response('connected_account_event_ignored', { status: 200 });
  }
  if (!eventMatchesMode(event.livemode, mode))
    return new Response('ignored_other_mode', { status: 200 });

  if (event.api_version && event.api_version !== EVENT_API_VERSION) {
    // Not fatal: only ids are read from the payload. But someone changed the destination's version.
    console.warn(
      `stripe api_version mismatch: event=${event.api_version} expected=${EVENT_API_VERSION} (${event.type})`,
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Idempotency with a lease. Stripe retries on any non-2xx and may deliver twice even on success.
  const { data: claim, error: claimErr } = await admin.rpc('stripe_event_claim', {
    p_event_id: event.id,
    p_type: event.type,
    p_lease_seconds: EVENT_LEASE_SECONDS,
  });
  if (claimErr) {
    // Fail loud: a 500 makes Stripe retry, which is the safe direction.
    console.error('stripe_event_claim failed', claimErr);
    return new Response('idempotency_check_failed', { status: 500 });
  }
  const claimState = eventClaimState(claim);
  // Handled before: a 2xx ends Stripe's retries, which is what is wanted.
  if (claimState === 'handled') return new Response('duplicate', { status: 200 });
  // Another delivery holds a live lease (it may yet die or hang). A 2xx here would end Stripe's
  // retries for an event nobody may finish, so this answers a retryable status; a retry after the
  // lease reclaims it if that delivery never marked it done (SEC-R2-2).
  if (claimState === 'in_flight') return new Response('in_flight', { status: 409 });

  try {
    await handle(admin, event);
  } catch (err) {
    console.error('stripe-webhook error', event.type, event.id, err);
    // Released, or the retry this 500 asks for would be answered "duplicate" until the lease ends.
    const { error: forgetErr } = await admin.rpc('stripe_event_forget', { p_event_id: event.id });
    if (forgetErr) console.error('stripe_event_forget failed', event.id, forgetErr);
    return new Response('internal_error', { status: 500 });
  }
  const { error: doneErr } = await admin.rpc('stripe_event_done', { p_event_id: event.id });
  // Handled either way; at worst a redelivery after the lease runs the (idempotent) handler again.
  if (doneErr) console.error('stripe_event_done failed', event.id, doneErr);
  return new Response('ok', { status: 200 });
});

async function handle(admin: SupabaseClient, event: StripeEvent) {
  const objectId = idOf(event.data.object);
  switch (event.type) {
    case 'checkout.session.completed':
      return await checkoutCompleted(admin, event, objectId);
    case 'checkout.session.expired':
      return await checkoutExpired(admin, event, objectId);
    case 'invoice.paid':
      return await invoicePaid(admin, event, objectId);
    case 'invoice.payment_failed':
    case 'invoice.payment_action_required':
      return await invoiceFailed(admin, event, objectId);
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.pending_update_applied':
      return await syncSubscription(admin, event, objectId);
    case 'customer.subscription.pending_update_expired':
      return await pendingUpdateExpired(admin, event, objectId);
    case 'customer.subscription.created':
    case 'customer.subscription.trial_will_end':
      return await logSubscriptionEvent(admin, event, objectId);
    case 'customer.updated':
      return await customerUpdated(admin, event, objectId);
    default:
      // Unhandled -> 200 so Stripe does not retry.
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------------------------

/**
 * The first card purchase finished. The session is re-read (with its subscription and the card
 * on it) and the request in its metadata settled: the package applied, charges paid, the code
 * redeemed. `confirm` in stripe-billing may have settled it already; this is then a duplicate.
 * A payment that settles nothing (the request is gone, or the package no longer fits) is refunded
 * in full and its subscription cancelled (D12, §9.5).
 */
async function checkoutCompleted(
  admin: SupabaseClient,
  event: StripeEvent,
  sessionId: string | null,
) {
  if (!isStripeObjectId(sessionId) || !sessionId.startsWith('cs_')) return;
  const session = await read<Json>(`/v1/checkout/sessions/${sessionId}`, {
    expand: ['subscription', 'subscription.default_payment_method'],
  });
  if (!session) {
    await logEvent(
      admin,
      'stripe.checkout_unreadable',
      'error',
      'a completed checkout no longer exists at Stripe',
      null,
      { event_id: event.id, session: sessionId },
    );
    return;
  }
  if (session.mode !== 'subscription') return;
  const metadata = (session.metadata ?? {}) as Json;
  const requestId = metadata.billing_request_id;
  const restaurantId = isUuid(metadata.restaurant_id) ? metadata.restaurant_id : null;
  if (!isUuid(requestId)) {
    await logEvent(
      admin,
      'stripe.checkout_without_request',
      'warn',
      'a completed checkout names no package request',
      restaurantId,
      { event_id: event.id, session: sessionId },
    );
    return;
  }
  if (!sessionIsPaid(session)) {
    await logEvent(
      admin,
      'stripe.checkout_unpaid',
      'warn',
      'a checkout completed without its payment',
      restaurantId,
      {
        session: sessionId,
        request_id: requestId,
        payment_status: session.payment_status ?? null,
      },
    );
    return;
  }

  const sub = await subscriptionOf(session);
  const args = sub ? checkoutSettleArgs(session, sub, requestId) : null;
  if (!sub || !args) {
    // Money was taken and nothing can be settled from what Stripe returns: a person must look.
    await logEvent(
      admin,
      'stripe.checkout_unsettleable',
      'error',
      'a paid checkout has no readable subscription',
      restaurantId,
      { session: sessionId, request_id: requestId },
    );
    return;
  }

  const result = await settle(admin, args);
  if (result.ok === true) {
    // One live subscription per restaurant (§9.2, WH-1): whatever else of ours still bills this
    // restaurant is cancelled, the subscription a settle reports it replaced included (it can be
    // on an older customer). Checked on a duplicate too, so a retry finishes what a failure left;
    // but only while this is still the subscription the restaurant is billed through, so a late
    // redelivery of an old purchase cannot touch a newer one's subscription or card.
    const { data: current, error: currentErr } = await admin
      .from('subscriptions')
      .select('restaurant_id')
      .eq('stripe_subscription_id', args.p_stripe_subscription_id as string)
      .maybeSingle();
    if (currentErr) throw new Error(`subscriptions lookup: ${currentErr.message}`);
    if (!current) return;
    if (restaurantId) {
      const replaced = result.replaced_subscription_id;
      if (isStripeObjectId(replaced) && replaced !== args.p_stripe_subscription_id)
        await cancelSubscriptionOfOurs(admin, restaurantId, replaced, 'replaced_on_settle');
      await cancelOtherSubscriptions(admin, restaurantId, sub, 'second_subscription');
    }
    await moveCardToCustomer(admin, sub, restaurantId);
    return;
  }

  // Nothing was applied, so the payment bought nothing: refunded in full and the subscription it
  // created cancelled, whatever the reason (request_not_pending: a stale tab or a second
  // subscription; settle_failed: the package no longer fits, ME-3). The request is cancelled when
  // it is still pending, so the plan page asks for a new one instead of offering to pay again.
  await refundStaleCheckout(admin, session, sub, requestId, restaurantId, {
    reason: result.reason ?? null,
    status: result.status ?? null,
    detail: result.detail ?? null,
  });
  if (result.reason !== 'request_not_pending') {
    const { error } = await admin.rpc('billing_cancel_stripe_request', {
      p_request_id: requestId,
      p_reason: 'Card payment refunded: the package could not be applied',
    });
    if (error) throw new Error(`cancel_stripe_request: ${error.message}`);
  }
}

/**
 * Checkout stores the card on the subscription, but the portal's "update card" writes the
 * CUSTOMER's default, and Stripe charges the subscription's own default first. So the card is made
 * the customer's default, and the subscription's own default is cleared with an empty value.
 *
 * The clear is BEST EFFORT (SP-1): Stripe documents '' as the way to unset an optional field, but
 * its OpenAPI types do not mark this one as unsettable, so it may be refused. Either way a card
 * replaced in the portal reaches renewals: customer.updated makes the subscription's own default
 * follow the customer's new one (customerUpdated), which a non-empty value always does.
 */
async function moveCardToCustomer(admin: SupabaseClient, sub: Json, restaurantId: string | null) {
  const pm = idOf(sub.default_payment_method);
  const customer = idOf(sub.customer);
  const subId = idOf(sub);
  if (!pm || !customer || !subId) return;
  const setDefault = await stripeRequest(STRIPE_SECRET_KEY, 'POST', `/v1/customers/${customer}`, {
    params: { 'invoice_settings[default_payment_method]': pm },
    idempotencyKey: `billing_card_default:${customer}:${pm}`,
  });
  if (!setDefault.ok) {
    if (isRetryableStripeFailure(setDefault.status))
      throw new Error(`customer default card: ${setDefault.status}`);
    await logEvent(
      admin,
      'stripe.card_move_failed',
      'warn',
      'the card could not be made the customer default',
      restaurantId,
      { customer, subscription: subId, status: setDefault.status },
    );
    return;
  }
  const clear = await stripeRequest(STRIPE_SECRET_KEY, 'POST', `/v1/subscriptions/${subId}`, {
    params: { default_payment_method: '' },
    idempotencyKey: `billing_card_clear:${subId}:${pm}`,
  });
  if (!clear.ok) {
    console.info(
      'clearing the subscription card was refused; customer.updated keeps it in step instead',
      subId,
      clear.status,
      clear.error?.error?.code ?? null,
    );
  }
}

/**
 * D12. The payment arrived for a request that is no longer pending (a stale Checkout tab paid after
 * the merchant changed or replaced their package), for a restaurant another subscription already
 * bills (detail another_subscription), or for a package that could not be applied (settle_failed).
 * Nobody pays for what they did not end up buying: the invoice's payments are refunded in full, the
 * invoice is marked refunded (so it is never shown as the restaurant's last payment, WH-6) and the
 * subscription cancelled now. The log says what really happened (WH-7).
 */
async function refundStaleCheckout(
  admin: SupabaseClient,
  session: Json,
  sub: Json,
  requestId: string,
  restaurantId: string | null,
  refusal: { reason: unknown; status: unknown; detail: unknown },
) {
  const subId = idOf(sub);
  if (!subId) return;
  // Never the restaurant's live subscription: that one was settled, so it cannot be stale.
  const { data: current, error } = await admin
    .from('subscriptions')
    .select('restaurant_id')
    .eq('stripe_subscription_id', subId)
    .maybeSingle();
  if (error) throw new Error(`subscriptions lookup: ${error.message}`);
  if (current) {
    await logEvent(
      admin,
      'stripe.stale_checkout_is_current',
      'error',
      "a refused checkout is the restaurant's current subscription; nothing was refunded",
      restaurantId,
      {
        session: session.id,
        subscription: subId,
        request_id: requestId,
      },
    );
    return;
  }

  const invoiceId = idOf(session.invoice) ?? idOf(sub.latest_invoice);
  const refund = isStripeObjectId(invoiceId)
    ? await refundInvoice(admin, invoiceId)
    : { amountPaid: Number(session.amount_total) || 0, read: false, refunds: [], failures: [] };

  const failures: Json[] = [...refund.failures];
  const cancel = await stripeRequest(STRIPE_SECRET_KEY, 'DELETE', `/v1/subscriptions/${subId}`);
  if (!cancel.ok) {
    if (isRetryableStripeFailure(cancel.status))
      throw new Error(`stale subscription cancel: ${cancel.status}`);
    // Already cancelled (404) is the state wanted; anything else is in the payload for a person.
    if (cancel.status !== 404)
      failures.push({
        cancel: subId,
        status: cancel.status,
        code: cancel.error?.error?.code ?? null,
      });
  }

  const outcome = refundOutcome({
    amountPaidCents: refund.amountPaid,
    read: refund.read,
    refunded: refund.refunds.length,
    failed: refund.failures.length,
  });
  const cancelled = failures.every((f) => !('cancel' in f));
  await logEvent(
    admin,
    'stripe.stale_checkout_refunded',
    outcome.complete && cancelled && refusal.reason === 'request_not_pending' ? 'warn' : 'error',
    `a paid checkout bought nothing (${String(refusal.reason ?? 'unknown')}); refund: ${outcome.outcome}; subscription ${cancelled ? 'cancelled' : 'NOT cancelled'}`,
    restaurantId,
    {
      session: session.id,
      subscription: subId,
      invoice: invoiceId,
      request_id: requestId,
      reason: refusal.reason,
      request_status: refusal.status,
      detail: refusal.detail,
      amount_paid: refund.amountPaid,
      refund: outcome.outcome,
      refunds: refund.refunds,
      failures,
    },
  );
}

/** The request stays pending: the merchant can continue to payment or change it. Logged only. */
async function checkoutExpired(
  admin: SupabaseClient,
  event: StripeEvent,
  sessionId: string | null,
) {
  if (!isStripeObjectId(sessionId) || !sessionId.startsWith('cs_')) return;
  const session = await read<Json>(`/v1/checkout/sessions/${sessionId}`);
  const metadata = (session?.metadata ?? {}) as Json;
  if (!isUuid(metadata.billing_request_id)) return;
  await logEvent(
    admin,
    'stripe.checkout_expired',
    'info',
    'a package checkout expired unpaid',
    isUuid(metadata.restaurant_id) ? metadata.restaurant_id : null,
    {
      event_id: event.id,
      session: sessionId,
      request_id: metadata.billing_request_id,
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------

/**
 * Money arrived: the invoice is recorded and, when it paid for a period (the first invoice or a
 * renewal), the restaurant is paid through that period (invoicePaidThrough: the invoice's own
 * subscription lines, capped at the subscription's items). A change's invoice moves no date.
 *
 * If a package request was waiting on this invoice (3-D Secure, a declined card paid later), it is
 * settled now. billing_request_for_invoice finds that request WHATEVER its status; when the request
 * never had the invoice stored (the function stopped between the charge and the mark), the change
 * invoice itself names it (invoiceRequestId, money-rr-4). A request that was replaced, refused or
 * cannot be applied any more bought nothing with this payment, so the payment is refunded and the
 * subscription's items put back (§9.3, WH-2, ME-1, ME-6). A change is only ever settled onto the
 * subscription a restaurant holds (money-rr-7).
 *
 * A renewal or change paid by a subscription no restaurant holds (money-rr-2) is refunded and the
 * subscription cancelled; a first invoice (subscription_create) is checkout.session.completed's.
 */
async function invoicePaid(admin: SupabaseClient, event: StripeEvent, invoiceId: string | null) {
  if (!isStripeObjectId(invoiceId) || !invoiceId.startsWith('in_')) return;
  const inv = await read<Json>(`/v1/invoices/${invoiceId}`);
  const record = invoiceRecord(inv);
  if (!inv || !record) {
    await logEvent(
      admin,
      'stripe.invoice_unreadable',
      'warn',
      'a paid invoice no longer exists at Stripe',
      null,
      {
        event_id: event.id,
        invoice: invoiceId,
      },
    );
    return;
  }
  let sub = isStripeObjectId(record.subscription)
    ? await read<Json>(`/v1/subscriptions/${record.subscription}`, { expand: SUBSCRIPTION_EXPAND })
    : null;
  const periodPaidThrough =
    sub && record.status === 'paid' ? isoFromUnix(invoicePaidThrough(inv, sub)) : null;

  const { data, error } = await admin.rpc('billing_record_stripe_invoice', {
    p_invoice: record,
    p_paid_through: periodPaidThrough,
  });
  if (error) throw new Error(`record_stripe_invoice: ${error.message}`);
  const recorded = (data ?? {}) as Json;
  if (recorded.ok !== true)
    console.info('invoice not recorded', invoiceId, recorded.reason ?? recorded.error ?? null);
  const restaurantId = isUuid(recorded.restaurant_id) ? recorded.restaurant_id : null;

  if (record.status !== 'paid') return;
  const { data: storedRequest, error: reqErr } = await admin.rpc('billing_request_for_invoice', {
    p_invoice_id: invoiceId,
  });
  if (reqErr) throw new Error(`request_for_invoice: ${reqErr.message}`);
  const requestId = isUuid(storedRequest) ? storedRequest : invoiceRequestId(inv);
  const isFirstInvoice = record.billing_reason === 'subscription_create';
  // A change's fee invoice that does not name its subscription is the restaurant's current one:
  // settled onto it, never refunded for want of a subscription to read.
  if (!sub && requestId && restaurantId) sub = await restaurantSubscription(admin, restaurantId);
  const subId = sub ? idOf(sub) : null;
  const current = isStripeObjectId(subId) ? await isCurrentSubscription(admin, subId) : false;

  if (requestId) {
    const customerId = record.customer ?? (sub ? idOf(sub.customer) : null);
    const args = sub && customerId ? changeSettleArgs(requestId, customerId, sub, invoiceId) : null;
    const result: SettleResult = !args
      ? { ok: false, reason: 'no_subscription' }
      : !current && !isFirstInvoice
        ? { ok: false, reason: 'not_current_subscription' }
        : await settle(admin, args);
    if (result.ok !== true)
      await undoPaidInvoice(admin, inv, sub, requestId, restaurantId, result.reason ?? null);
  }

  if (
    sub &&
    isStripeObjectId(subId) &&
    !current &&
    !isFirstInvoice &&
    (requestId !== null || isStaleRefundableReason(record.billing_reason))
  ) {
    await refundStaleSubscription(admin, inv, sub, subId, requestId, restaurantId);
  }
}

/**
 * money-rr-2. A subscription no restaurant holds took money for a renewal or a change: most likely
 * one the manual rail detached while Stripe was still retrying it, which would otherwise bill the
 * card every month with nothing granted. Only one provably ours (subscriptionOwner): the invoice is
 * refunded in full (unless its request's undo already did), the subscription's other open invoices
 * voided and the subscription cancelled now without proration (cancelSubscriptionOfOurs).
 */
async function refundStaleSubscription(
  admin: SupabaseClient,
  inv: Json,
  sub: Json,
  subId: string,
  requestId: string | null,
  recordedRestaurantId: string | null,
) {
  const invoiceId = String(inv.id);
  const owner = subscriptionOwner(sub);
  if (!owner) {
    await logEvent(
      admin,
      'stripe.stale_subscription_not_ours',
      'warn',
      'a subscription no restaurant holds was paid, and it is not provably ours; nothing was done',
      recordedRestaurantId,
      { invoice: invoiceId, subscription: subId, billing_reason: inv.billing_reason ?? null },
    );
    return;
  }
  const refund = requestId ? null : await refundInvoice(admin, invoiceId);
  const cancelled = await cancelSubscriptionOfOurs(admin, owner, subId, 'stale_subscription_paid');
  const outcome = refund
    ? refundOutcome({
        amountPaidCents: refund.amountPaid,
        read: refund.read,
        refunded: refund.refunds.length,
        failed: refund.failures.length,
      }).outcome
    : 'with_its_request';
  await logEvent(
    admin,
    'stripe.stale_subscription_refunded',
    'error',
    `a subscription no restaurant holds was paid (${String(inv.billing_reason ?? 'unknown')}); refund: ${outcome}; subscription: ${cancelled}`,
    owner,
    {
      invoice: invoiceId,
      subscription: subId,
      billing_reason: inv.billing_reason ?? null,
      request_id: requestId,
      subscription_cancel: cancelled,
      amount_paid: refund?.amountPaid ?? null,
      refund: outcome,
      refunds: refund?.refunds ?? [],
      failures: refund?.failures ?? [],
    },
  );
}

/**
 * A change invoice was paid for a request that did not apply it. Refund every payment on it, put
 * the subscription's items back to what the database granted when it is the restaurant's current
 * subscription (a paid pending update applied them at Stripe), cancel the request if it is still
 * pending, and log it at error level. Every step is idempotent (the refund and revert keys are the
 * edge function's too), so a retry after a failure finishes the job.
 */
async function undoPaidInvoice(
  admin: SupabaseClient,
  inv: Json,
  sub: Json | null,
  requestId: string,
  restaurantId: string | null,
  reason: string | null,
) {
  const invoiceId = String(inv.id);
  const refund = await refundInvoice(admin, invoiceId);
  const balance = await reverseBalanceMovement(
    requestId,
    inv,
    invoiceId,
    idOf(inv.customer) ?? (sub ? idOf(sub.customer) : null),
  );
  const reverted = sub ? await revertItems(admin, sub, requestId, invoiceId) : 'no_subscription';

  const { error: cancelErr } = await admin.rpc('billing_cancel_stripe_request', {
    p_request_id: requestId,
    p_reason: 'Card payment refunded: the change could not be applied',
  });
  if (cancelErr) throw new Error(`cancel_stripe_request: ${cancelErr.message}`);

  const outcome = refundOutcome({
    amountPaidCents: refund.amountPaid,
    read: refund.read,
    refunded: refund.refunds.length,
    failed: refund.failures.length,
  });
  const balanceNote = !balance
    ? 'unchanged'
    : `${balance.reversed === true ? 'reversed' : 'NOT reversed'} ${String(balance.movement)}`;
  await logEvent(
    admin,
    'stripe.stale_invoice_refunded',
    'error',
    `a paid change invoice was not applied (${reason ?? 'unknown'}); refund: ${outcome.outcome}; balance: ${balanceNote}; items put back: ${String(reverted)}`,
    restaurantId,
    {
      invoice: invoiceId,
      subscription: sub ? idOf(sub) : null,
      request_id: requestId,
      reason,
      amount_paid: refund.amountPaid,
      refund: outcome.outcome,
      refunds: refund.refunds,
      failures: refund.failures,
      balance,
      reverted,
    },
  );
}

/**
 * Undo what a change invoice did to the customer's credit balance (money-rr-8, edge-rr-2): a
 * downgrade's credit taken back, credit spent on an upgrade given back. The same body and key as
 * the edge function's undo, so the balance moves once whoever gets there first. Null when the
 * invoice moved nothing. A failure a retry can fix throws (the event is retried).
 */
async function reverseBalanceMovement(
  requestId: string,
  inv: Json,
  invoiceId: string,
  customerId: string | null,
): Promise<Json | null> {
  const movement = invoiceBalanceMovement(inv);
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
  if (isRetryableStripeFailure(res.status)) throw new Error(`balance undo: ${res.status}`);
  return { movement, reversed: false, status: res.status, code: res.error?.error?.code ?? null };
}

/**
 * Refund every payment of a paid invoice in full and mark the invoice refunded. Stripe failures
 * that a retry can fix throw (the event is retried); a refusal is returned in `failures`.
 */
async function refundInvoice(
  admin: SupabaseClient,
  invoiceId: string,
): Promise<{ amountPaid: number; read: boolean; refunds: string[]; failures: Json[] }> {
  const inv = await read<Json>(`/v1/invoices/${invoiceId}`);
  const amountPaid = inv && Number.isSafeInteger(inv.amount_paid) ? Number(inv.amount_paid) : 0;
  const refunds: string[] = [];
  const failures: Json[] = [];
  if (!inv || amountPaid <= 0) return { amountPaid, read: inv !== null, refunds, failures };

  const payments = await read<Json>('/v1/invoice_payments', {
    invoice: invoiceId,
    status: 'paid',
    limit: 10,
  });
  for (const target of invoicePaymentTargets(payments)) {
    const targetId = refundTargetId(target);
    const res = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'POST', '/v1/refunds', {
      params: refundParams(target),
      idempotencyKey: refundIdempotencyKey(targetId),
    });
    if (res.ok) {
      refunds.push(String(res.data?.id ?? ''));
    } else if (isAlreadyRefunded(res.error)) {
      refunds.push(`already:${targetId}`);
    } else {
      if (isRetryableStripeFailure(res.status)) throw new Error(`refund: ${res.status}`);
      failures.push({ target: targetId, status: res.status, code: res.error?.error?.code ?? null });
    }
  }
  if (refunds.length > 0) {
    const { error } = await admin.rpc('billing_mark_invoice_refunded', { p_invoice_id: invoiceId });
    if (error) throw new Error(`mark_invoice_refunded: ${error.message}`);
  }
  return { amountPaid, read: payments !== null, refunds, failures };
}

/**
 * Put a subscription's items back to the package the database granted, when it is the
 * restaurant's current subscription and they differ. Returns true when a revert was sent, false
 * when nothing differed, or why it was not sent.
 */
async function revertItems(
  admin: SupabaseClient,
  sub: Json,
  requestId: string,
  invoiceId: string,
): Promise<boolean | string> {
  const subId = idOf(sub);
  if (!isStripeObjectId(subId)) return 'no_subscription';
  const { data: row, error } = await admin
    .from('subscriptions')
    .select('id')
    .eq('stripe_subscription_id', subId)
    .maybeSingle();
  if (error) throw new Error(`subscriptions lookup: ${error.message}`);
  if (!row) return 'not_current_subscription';
  const { data: rows, error: itemsErr } = await admin
    .from('subscription_items')
    .select('product_code, quantity, unit_price')
    .eq('subscription_id', (row as { id: string }).id);
  if (itemsErr) throw new Error(`subscription_items lookup: ${itemsErr.message}`);
  const granted = grantedLines(rows);
  if (!granted) return 'granted_package_unreadable';
  if (!isStripeManagedStatus(sub.status)) return `subscription_${String(sub.status)}`;
  const items = subscriptionItemsByCode(sub);
  if (!items.ok) return `subscription_${items.error}`;
  if (itemsMatch(granted.quantities, items.items)) return false;

  // A product the change removed is added back at the price the restaurant paid for it, which
  // exists at Stripe under its lookup key (it was on this subscription).
  const prices: PriceIds = {};
  const missing = MONTHLY_CODES.filter(
    (code) => granted.quantities[code] > 0 && !items.items[code],
  );
  if (missing.length > 0) {
    const want = missing.map((code) => ({ code, cents: granted.cents[code] ?? 0 }));
    const found = await read<{ data?: unknown }>('/v1/prices', {
      lookup_keys: want.map((w) => priceLookupKey(w.code, w.cents)),
      active: 'true',
      limit: 10,
    });
    const list = Array.isArray(found?.data) ? (found.data as Json[]) : [];
    for (const w of want) {
      const hit = list.find((p) => priceMatches(p, w.code as MonthlyCode, w.cents));
      if (!hit) return `price_missing:${w.code}`;
      prices[w.code] = String(hit.id);
    }
  }
  const res = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'POST', `/v1/subscriptions/${subId}`, {
    params: revertParams(granted.quantities, items.items, prices),
    idempotencyKey: revertIdempotencyKey(requestId, invoiceId),
  });
  if (!res.ok) {
    if (isRetryableStripeFailure(res.status)) throw new Error(`revert: ${res.status}`);
    return `revert_refused:${res.error?.error?.code ?? res.status}`;
  }
  return true;
}

/** A renewal or a change could not be charged: past due, with the grace period (D9). */
async function invoiceFailed(admin: SupabaseClient, event: StripeEvent, invoiceId: string | null) {
  if (!isStripeObjectId(invoiceId) || !invoiceId.startsWith('in_')) return;
  const record = invoiceRecord(await read<Json>(`/v1/invoices/${invoiceId}`));
  if (!record) return;
  const { data, error } = await admin.rpc('billing_record_stripe_invoice_failed', {
    p_invoice: record,
  });
  if (error) throw new Error(`record_stripe_invoice_failed: ${error.message}`);
  const result = (data ?? {}) as Json;
  if (result.ok !== true)
    console.info(
      'failed invoice not recorded',
      event.type,
      invoiceId,
      result.reason ?? result.error ?? null,
    );
}

// ---------------------------------------------------------------------------------------------
// Subscriptions and customers
// ---------------------------------------------------------------------------------------------

/**
 * Status, cancel flags, card and Stripe's monthly total from the subscription as Stripe has it now
 * (events arrive out of order, so the payload is never applied). The paid-through date is not
 * touched (D8). A subscription the database does not hold (a stale one, or the first events before
 * the purchase is settled) is answered unknown_subscription and left.
 */
async function syncSubscription(admin: SupabaseClient, event: StripeEvent, subId: string | null) {
  if (!isStripeObjectId(subId) || !subId.startsWith('sub_')) return;
  const sub = await read<Json>(`/v1/subscriptions/${subId}`, { expand: SUBSCRIPTION_EXPAND });
  const args = syncStatusArgs(sub, cardOf(sub));
  if (!args) return;
  const { data, error } = await admin.rpc('billing_sync_stripe_status', args);
  if (error) throw new Error(`sync_stripe_status: ${error.message}`);
  const result = (data ?? {}) as Json;
  if (result.ok !== true && result.reason !== 'unknown_subscription') {
    await logEvent(
      admin,
      'stripe.sync_refused',
      'warn',
      'a subscription change was not applied',
      null,
      {
        event_id: event.id,
        subscription: subId,
        reason: result.reason ?? result.error ?? null,
      },
    );
  }
}

/**
 * A change waiting for payment was never paid (about 23 hours). Only the request that waited on
 * THIS event's invoice is cancelled (the subscription is not re-read for a newer invoice, which
 * could be the next request's, WH-3), and only once that invoice will never be paid: void already,
 * or voided here if Stripe left it open. Cancelling voids the request's charges and gives back its
 * discount code.
 */
async function pendingUpdateExpired(
  admin: SupabaseClient,
  event: StripeEvent,
  subId: string | null,
) {
  if (!isStripeObjectId(subId) || !subId.startsWith('sub_')) return;
  const invoiceId = idOf(event.data.object.latest_invoice);
  if (!isStripeObjectId(invoiceId) || !invoiceId.startsWith('in_')) return;
  const { data: requestId, error } = await admin.rpc('billing_request_for_invoice', {
    p_invoice_id: invoiceId,
  });
  if (error) throw new Error(`request_for_invoice: ${error.message}`);
  if (!isUuid(requestId)) return;

  const inv = await read<Json>(`/v1/invoices/${invoiceId}`);
  if (inv?.status === 'paid') return; // paid after all: invoice.paid settles (or refunds) it
  if (inv?.status === 'open') {
    const voided = await stripeRequest<Json>(
      STRIPE_SECRET_KEY,
      'POST',
      `/v1/invoices/${invoiceId}/void`,
    );
    if (!voided.ok) {
      if (isRetryableStripeFailure(voided.status))
        throw new Error(`invoice void: ${voided.status}`);
      const again = await read<Json>(`/v1/invoices/${invoiceId}`);
      if (again?.status !== 'void') {
        // Still payable: the request is kept, so a payment still has something to settle.
        await logEvent(
          admin,
          'stripe.invoice_not_voided',
          'error',
          'an expired change invoice could not be voided; its request was kept',
          null,
          {
            event_id: event.id,
            invoice: invoiceId,
            request_id: requestId,
            status: again?.status ?? null,
          },
        );
        return;
      }
    }
  }
  const { error: cancelErr } = await admin.rpc('billing_cancel_stripe_request', {
    p_request_id: requestId,
    p_reason: 'pending_update_expired',
  });
  if (cancelErr) throw new Error(`cancel_stripe_request: ${cancelErr.message}`);
  await logEvent(
    admin,
    'stripe.change_expired',
    'info',
    'a package change was not paid in time and was cancelled',
    null,
    {
      event_id: event.id,
      subscription: subId,
      invoice: invoiceId,
      request_id: requestId,
    },
  );
}

/**
 * The customer's default card changed (the portal writes the customer's invoice default). For each
 * live subscription of ours on this customer: its own default card is made to follow (Stripe
 * charges a subscription's own default first, SP-1), and the card is stored with a CARD-ONLY sync
 * (p_status null), so this event can never relabel a restaurant's status or move a date (WH-8).
 * Subscriptions come from Stripe (canceled ones are not listed), not from our rows, so a dead
 * subscription id still stored on a restaurant is never touched.
 */
async function customerUpdated(
  admin: SupabaseClient,
  event: StripeEvent,
  customerId: string | null,
) {
  if (!isStripeObjectId(customerId) || !customerId.startsWith('cus_')) return;
  // Only a change of the default card matters; previous_attributes only decides whether to look.
  const previous = event.data.previous_attributes;
  if (previous && typeof previous === 'object' && !('invoice_settings' in previous)) return;

  const customer = await read<Json>(`/v1/customers/${customerId}`, {
    expand: ['invoice_settings.default_payment_method'],
  });
  const restaurantId = (customer?.metadata as Json | undefined)?.restaurant_id;
  if (!customer || customer.deleted === true || !isUuid(restaurantId)) return;
  const defaultPm = (customer.invoice_settings as Json | undefined)?.default_payment_method ?? null;
  const defaultPmId = idOf(defaultPm);

  const list = await read<{ data?: unknown }>('/v1/subscriptions', {
    customer: customerId,
    limit: 10,
    expand: ['data.default_payment_method'],
  });
  for (const sub of Array.isArray(list?.data) ? (list.data as Json[]) : []) {
    const subId = idOf(sub);
    if (!isStripeObjectId(subId) || !isStripeManagedStatus(sub.status)) continue;
    if ((sub.metadata as Json | undefined)?.restaurant_id !== restaurantId) continue;

    let card = cardOf({ default_payment_method: sub.default_payment_method, customer });
    if (defaultPmId && subscriptionCardNeedsSync(sub, defaultPmId)) {
      const res = await stripeRequest(STRIPE_SECRET_KEY, 'POST', `/v1/subscriptions/${subId}`, {
        params: { default_payment_method: defaultPmId },
        idempotencyKey: cardSyncIdempotencyKey(subId, defaultPmId, event.id),
      });
      if (res.ok) {
        card = mapCard(defaultPm);
      } else {
        if (isRetryableStripeFailure(res.status))
          throw new Error(`subscription card sync: ${res.status}`);
        await logEvent(
          admin,
          'stripe.card_sync_failed',
          'warn',
          "the new card could not be made the subscription's own default; renewals may use the old card",
          restaurantId,
          {
            customer: customerId,
            subscription: subId,
            status: res.status,
            code: res.error?.error?.code ?? null,
          },
        );
      }
    }
    const { error } = await admin.rpc(
      'billing_sync_stripe_status',
      cardOnlySyncArgs(subId, card, subscriptionMonthlyAmount(sub)),
    );
    if (error) throw new Error(`sync_stripe_status (card): ${error.message}`);
  }
}

async function logSubscriptionEvent(
  admin: SupabaseClient,
  event: StripeEvent,
  subId: string | null,
) {
  if (!isStripeObjectId(subId)) return;
  const { data } = await admin
    .from('subscriptions')
    .select('restaurant_id')
    .eq('stripe_subscription_id', subId)
    .maybeSingle();
  const restaurantId = (data as { restaurant_id?: unknown } | null)?.restaurant_id;
  await logEvent(
    admin,
    event.type === 'customer.subscription.trial_will_end'
      ? 'stripe.trial_will_end'
      : 'stripe.subscription_created',
    'info',
    event.type === 'customer.subscription.trial_will_end'
      ? 'the first monthly charge is in 3 days'
      : 'a subscription was created',
    isUuid(restaurantId) ? restaurantId : null,
    { event_id: event.id, subscription: subId },
  );
}

// ---------------------------------------------------------------------------------------------
// One live subscription per restaurant (§9.2)
// ---------------------------------------------------------------------------------------------

/**
 * Every other live subscription of ours for this restaurant on the settled one's customer is
 * cancelled: a second Checkout must never leave the first subscription billing (WH-1, ME-2).
 */
async function cancelOtherSubscriptions(
  admin: SupabaseClient,
  restaurantId: string,
  keep: Json,
  why: string,
) {
  const keepId = idOf(keep);
  const customer = idOf(keep.customer);
  if (!keepId || !isStripeObjectId(customer)) return;
  // Canceled subscriptions are not listed by default; incomplete and past_due ones are.
  const list = await read<{ data?: unknown }>('/v1/subscriptions', { customer, limit: 20 });
  for (const s of Array.isArray(list?.data) ? (list.data as Json[]) : []) {
    const id = idOf(s);
    if (!isStripeObjectId(id) || id === keepId) continue;
    if (!shouldCancelOldSubscription(s, restaurantId)) continue;
    await cancelSubscriptionOfOurs(admin, restaurantId, id, why);
  }
}

/**
 * Cancel one subscription of ours for this restaurant now (no proration), after voiding its open
 * invoices so neither Smart Retries nor an old invoice link can take money for it. Retryable
 * failures throw (the event is retried and this runs again). Answers what happened, for the log:
 * cancelled, not_cancelled (a refusal, logged at error level), or skipped (already ended, not
 * ours, or a restaurant's current subscription).
 */
async function cancelSubscriptionOfOurs(
  admin: SupabaseClient,
  restaurantId: string,
  subId: string,
  why: string,
): Promise<'cancelled' | 'not_cancelled' | 'skipped'> {
  const sub = await read<Json>(`/v1/subscriptions/${subId}`);
  if (!sub || !shouldCancelOldSubscription(sub, restaurantId)) return 'skipped';
  // Never the one a restaurant is billed through today.
  if (await isCurrentSubscription(admin, subId)) return 'skipped';

  const open = await read<{ data?: unknown }>('/v1/invoices', {
    subscription: subId,
    status: 'open',
    limit: 100,
  });
  const failures: Json[] = [];
  for (const inv of Array.isArray(open?.data) ? (open.data as Json[]) : []) {
    if (!isStripeObjectId(inv.id)) continue;
    const v = await stripeRequest<Json>(STRIPE_SECRET_KEY, 'POST', `/v1/invoices/${inv.id}/void`);
    if (!v.ok) {
      if (isRetryableStripeFailure(v.status)) throw new Error(`invoice void: ${v.status}`);
      failures.push({ invoice: inv.id, status: v.status, code: v.error?.error?.code ?? null });
    }
  }
  const cancel = await stripeRequest(STRIPE_SECRET_KEY, 'DELETE', `/v1/subscriptions/${subId}`);
  if (!cancel.ok) {
    if (isRetryableStripeFailure(cancel.status))
      throw new Error(`subscription cancel: ${cancel.status}`);
    if (cancel.status !== 404)
      failures.push({
        cancel: subId,
        status: cancel.status,
        code: cancel.error?.error?.code ?? null,
      });
  }
  await logEvent(
    admin,
    failures.length > 0
      ? 'stripe.old_subscription_not_cancelled'
      : 'stripe.old_subscription_cancelled',
    failures.length > 0 ? 'error' : 'warn',
    failures.length > 0
      ? 'a Stripe subscription the restaurant no longer uses could not be fully cancelled'
      : 'a Stripe subscription the restaurant no longer uses was cancelled so it cannot bill again',
    restaurantId,
    { subscription: subId, why, stripe_status: sub.status ?? null, failures },
  );
  return failures.length > 0 ? 'not_cancelled' : 'cancelled';
}

/** The Stripe subscription a restaurant's row holds, re-read (as the handlers read it), or null. */
async function restaurantSubscription(
  admin: SupabaseClient,
  restaurantId: string,
): Promise<Json | null> {
  const { data, error } = await admin
    .from('subscriptions')
    .select('stripe_subscription_id')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
  if (error) throw new Error(`subscriptions lookup: ${error.message}`);
  const subId = (data as { stripe_subscription_id?: unknown } | null)?.stripe_subscription_id;
  return isStripeObjectId(subId)
    ? await read<Json>(`/v1/subscriptions/${subId}`, { expand: SUBSCRIPTION_EXPAND })
    : null;
}

/** Whether a restaurant row holds this subscription, any status (billing_subscription_is_current). */
async function isCurrentSubscription(admin: SupabaseClient, subId: string): Promise<boolean> {
  const { data, error } = await admin.rpc('billing_subscription_is_current', {
    p_stripe_subscription_id: subId,
  });
  if (error) throw new Error(`subscription_is_current: ${error.message}`);
  return data === true;
}

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

/**
 * Re-read one object on the pinned version. Only a 404 (the object is gone) is null, for the
 * handler to log and leave. Anything else throws, so the event is retried rather than consumed:
 * a 401/403 after a key roll must not silently drop renewals (WH-4).
 */
async function read<T>(path: string, params?: Record<string, unknown>): Promise<T | null> {
  const res = await stripeRequest<T>(STRIPE_SECRET_KEY, 'GET', path, params ? { params } : {});
  if (res.ok) return res.data;
  if (res.status === 404) {
    console.warn('stripe-webhook: re-read found nothing', path, res.error?.error?.code ?? null);
    return null;
  }
  throw new Error(`GET ${path}: ${res.status} ${res.error?.error?.code ?? ''}`.trim());
}

/** Read the session's subscription: expanded on the session, or re-read by its id. */
async function subscriptionOf(session: Json): Promise<Json | null> {
  if (session.subscription && typeof session.subscription === 'object')
    return session.subscription as Json;
  const id = idOf(session.subscription);
  return isStripeObjectId(id)
    ? await read<Json>(`/v1/subscriptions/${id}`, { expand: ['default_payment_method'] })
    : null;
}

interface SettleResult {
  ok?: boolean;
  duplicate?: boolean;
  /** request_not_pending (refund it, D12) | settle_failed (logged by the SQL) | request_not_found | invalid_arguments */
  reason?: string;
  status?: string;
  /** another_subscription: the restaurant is already billed by a different subscription. */
  detail?: string;
  /** A first purchase that took over from a different Stripe subscription: cancel that one. */
  replaced_subscription_id?: string | null;
}

async function settle(admin: SupabaseClient, args: Json): Promise<SettleResult> {
  const { data, error } = await admin.rpc('billing_settle_stripe_request', args);
  // A database failure is retried (the settle is idempotent); a refusal comes back as ok:false.
  if (error) throw new Error(`settle_stripe_request: ${error.message}`);
  return (data ?? {}) as SettleResult;
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
