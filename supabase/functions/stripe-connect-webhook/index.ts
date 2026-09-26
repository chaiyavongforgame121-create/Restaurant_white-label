// Stripe Connect webhook: events that happen ON the branches' connected accounts.
//
// Diners pay each branch directly (docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md): the charge, its
// refunds and its disputes live in the branch's own Stripe account, so their events reach the
// platform only through a Connect endpoint ("Events from: Connected accounts"), never through
// stripe-webhook, which keeps the platform's own subscription billing.
//
// Configure in the platform's Stripe Dashboard -> Developers -> Webhooks -> Add endpoint
//   Events from:  Connected accounts
//   Endpoint URL: https://<project>.supabase.co/functions/v1/stripe-connect-webhook
//   API version:  2026-08-26.dahlia (EVENT_API_VERSION below). The Dashboard no longer offers
//                 basil for a new destination. Events arrive in this shape, while every call made
//                 here stays pinned to STRIPE_API_VERSION (basil). Every field the SQL reads from a
//                 snapshot (PaymentIntent, Refund, Charge, Dispute) is the same in both; clover and
//                 dahlia broke nothing in them. Account and refund state is re-read anyway.
//   Events (14):
//     account.updated                       account.application.deauthorized
//     payment_intent.succeeded              payment_intent.payment_failed
//     payment_intent.canceled               payment_intent.processing
//     charge.refunded                       refund.created
//     refund.updated                        refund.failed
//     charge.dispute.created                charge.dispute.updated
//     charge.dispute.closed                 charge.dispute.funds_withdrawn
//   (charge.refund.updated is handled too, but refund.updated already covers every refund.)
//   Secret: the endpoint's signing secret -> Supabase secret STRIPE_CONNECT_WEBHOOK_SECRET.
//
// Connected accounts are created with Accounts v2 (stripe-connect-onboard). Stripe still sends
// their v1 snapshot events, account.updated included, to this "Connected accounts" endpoint; the
// v2 thin events (v2.core.account[...]) go to a platform event destination and are not needed.
//
// Deploy with verify_jwt = false (Stripe sends no JWT); authenticity is the HMAC signature.
//
// Every event is checked in this order: signature (with a 5-minute replay window), mode (a
// connected account has ONE id in test and live, and a live endpoint also receives test events,
// so an event from the other mode is ignored), the connected account it came from, then
// deduplication on the event id (stripe_event_seen). A handler that throws un-marks the event
// (stripe_event_forget) and answers 500, so Stripe's retry is handled for real.
//
// Division of labour, as in stripe-webhook: this function does transport; what an event means for
// a payment, an order or a refund is decided in SQL (stripe_connect_apply_payment_intent,
// stripe_connect_record_refund, stripe_connect_apply_charge_refunded,
// stripe_connect_record_dispute), which every one of them checks against the account the payment
// was charged on. The one Stripe call made here besides reads is the refund of a payment that
// arrived after its order was closed (usually by the 30-minute expiry of unpaid card orders).
//
// Refund state is recorded from Stripe's CURRENT objects, never from an event's snapshot alone:
// events arrive out of order and retries come hours late, and a refund that succeeded can still
// fail afterwards. refund.* events re-read the refund; charge.refunded lists the charge's refunds
// (or, failing that, re-reads the charge). The SQL also only ever moves a refund forward.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  type StripeAccountLike,
  accountState,
  currentRefund,
  eventMatchesMode,
  isAccountId,
  isRetryableStripeFailure,
  readAccountState,
  readChargeRefunds,
  stripeKeyMode,
  stripeRequest,
  verifyStripeSignature,
} from '../_shared/stripe-connect.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_CONNECT_WEBHOOK_SECRET = Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET');
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');

/** The API version the endpoint is set to in the Stripe Dashboard, so the shape events arrive in. */
const EVENT_API_VERSION = '2026-08-26.dahlia';

interface StripeEvent {
  id: string;
  type: string;
  account?: string;
  livemode?: boolean;
  api_version?: string;
  data: { object: Record<string, unknown> };
}

/** What stripe_connect_apply_payment_intent answers. */
interface ApplyIntentResult {
  ok: boolean;
  error?: string;
  payment_id?: string;
  order_id?: string;
  restaurant_id?: string | null;
  status?: string;
  action?: 'refund_required' | null;
  reason?: string | null;
  refund_amount_cents?: number | null;
  /** Set when the payment was completed but a rule on the order refused its confirm. */
  order_confirm_error?: string | null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  // Both are needed before anything can be trusted: the secret to verify, the key to know which
  // mode this deployment is in and to re-read accounts. Stripe retries a 503 for three days, so
  // events sent before the owner finishes setting the secrets are not lost.
  if (!STRIPE_CONNECT_WEBHOOK_SECRET) return new Response('webhook_not_configured', { status: 503 });
  const mode = stripeKeyMode(STRIPE_SECRET_KEY);
  if (!STRIPE_SECRET_KEY || !mode) return new Response('stripe_not_configured', { status: 503 });

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing_signature', { status: 400 });

  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, sig, STRIPE_CONNECT_WEBHOOK_SECRET))) {
    return new Response('bad_signature', { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('invalid_json', { status: 400 });
  }
  if (!event?.id || !event?.type || !event?.data?.object) return new Response('invalid_event', { status: 400 });

  if (!eventMatchesMode(event.livemode, mode)) {
    return new Response('ignored_other_mode', { status: 200 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Every event this endpoint handles belongs to a connected account. One without is a platform
  // event sent to the wrong endpoint; it is not ours to apply.
  const account = event.account;
  if (!isAccountId(account)) {
    await logEvent(admin, 'stripe_connect.no_account', 'warn', 'event without a connected account ignored', null, {
      event_id: event.id,
      event_type: event.type,
    });
    return new Response('ignored_no_account', { status: 200 });
  }

  if (event.api_version && event.api_version !== EVENT_API_VERSION) {
    // Not fatal, but every field path below was checked against the endpoint's version, so this is
    // the first thing to check when a handler goes quiet (someone changed the endpoint's version).
    console.warn(`stripe api_version mismatch: event=${event.api_version} expected=${EVENT_API_VERSION} (${event.type})`);
  }

  // Idempotency. Stripe retries on any non-2xx and may deliver twice even on success.
  const { data: fresh, error: seenErr } = await admin.rpc('stripe_event_seen', {
    p_event_id: event.id,
    p_type: event.type,
  });
  if (seenErr) {
    // Fail loud: a 500 makes Stripe retry, which is the safe direction.
    console.error('stripe_event_seen failed', seenErr);
    return new Response('idempotency_check_failed', { status: 500 });
  }
  if (fresh === false) return new Response('duplicate', { status: 200 });

  try {
    await handle(admin, event, account, STRIPE_SECRET_KEY);
  } catch (err) {
    console.error('connect webhook error', event.type, event.id, err);
    // Un-mark the event, or the retry this 500 asks for would be answered "duplicate".
    const { error: forgetErr } = await admin.rpc('stripe_event_forget', { p_event_id: event.id });
    if (forgetErr) console.error('stripe_event_forget failed', event.id, forgetErr);
    return new Response('internal_error', { status: 500 });
  }
  return new Response('ok', { status: 200 });
});

async function handle(admin: SupabaseClient, event: StripeEvent, account: string, secretKey: string) {
  const obj = event.data.object;
  switch (event.type) {
    case 'account.updated':
      await syncAccount(admin, account, obj as StripeAccountLike, secretKey);
      return;

    case 'account.application.deauthorized': {
      // The restaurant disconnected the platform from its Stripe account. No charge can be made
      // on it any more, so every branch paid into it goes back to "not connected".
      const { data: rows, error } = await admin
        .from('branch_payment_accounts')
        .delete()
        .eq('stripe_account_id', account)
        .select('branch_id');
      if (error) throw new Error(`deauthorize: ${error.message}`);
      await logEvent(admin, 'stripe_connect.deauthorized', 'warn', 'a connected account disconnected from the platform', null, {
        account,
        branch_ids: (rows ?? []).map((r) => r.branch_id),
      });
      return;
    }

    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled':
    case 'payment_intent.processing': {
      const { data, error } = await admin.rpc('stripe_connect_apply_payment_intent', {
        p_account: account,
        p_intent: obj,
      });
      if (error) throw new Error(`apply_payment_intent: ${error.message}`);
      const result = (data ?? { ok: false }) as ApplyIntentResult;
      if (!result.ok) {
        // payment_not_found is normal for a charge the restaurant made outside this platform (its
        // own Dashboard or another app on the same account). account_mismatch is not.
        if (result.error === 'account_mismatch') {
          await logEvent(admin, 'stripe_connect.account_mismatch', 'error', 'a payment event came from an account the payment was not charged on', null, {
            event_id: event.id,
            account,
            payment_intent: (obj as { id?: string }).id,
          });
        }
        return;
      }
      if (result.order_confirm_error) {
        // The money is recorded, but the order is still pending: something on it (an unapproved
        // transfer row, say) refused the confirm. A person has to look; retrying would not help.
        await logEvent(admin, 'stripe_connect.order_not_confirmed', 'warn', 'a card payment went through but its order could not be confirmed', result.restaurant_id ?? null, {
          event_id: event.id,
          account,
          payment_intent: (obj as { id?: string }).id,
          payment_id: result.payment_id,
          order_id: result.order_id,
          error: result.order_confirm_error,
        });
      }
      if (result.action === 'refund_required') {
        await refundLatePayment(admin, account, obj as { id: string }, result, secretKey);
      }
      return;
    }

    case 'charge.refunded':
      await syncChargeRefunds(admin, event, account, obj as { id?: unknown }, secretKey);
      return;

    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
    case 'charge.refund.updated':
      await syncRefund(admin, event, account, obj, secretKey);
      return;

    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
    case 'charge.dispute.funds_withdrawn': {
      const { data, error } = await admin.rpc('stripe_connect_record_dispute', {
        p_account: account,
        p_dispute: obj,
        p_event_type: event.type,
      });
      if (error) throw new Error(`record_dispute: ${error.message}`);
      const result = (data ?? {}) as { ok?: boolean; error?: string; restaurant_id?: string | null };
      // A dispute on a sale the restaurant made outside this platform is its own business.
      if (result.ok !== true && result.error === 'payment_not_found') return;
      const dispute = obj as { id?: string; reason?: string; status?: string; amount?: number };
      // The restaurant answers a dispute in its own Stripe Dashboard within Stripe's deadline;
      // the platform's log is where support looks when a restaurant asks what happened.
      await logEvent(
        admin,
        event.type === 'charge.dispute.created' ? 'stripe_connect.dispute_created' : 'stripe_connect.dispute_changed',
        event.type === 'charge.dispute.created' ? 'warn' : 'info',
        `dispute ${dispute.status ?? ''}`.trim(),
        result.restaurant_id ?? null,
        { account, dispute_id: dispute.id, reason: dispute.reason, status: dispute.status, amount: (dispute.amount ?? 0) / 100, recorded: result.ok === true },
      );
      return;
    }

    default:
      // Unhandled -> 200 so Stripe does not retry.
      return;
  }
}

/**
 * account.updated: the payload is the account as it was when the event was created, and events
 * are not delivered in order, so the account is read again and the CURRENT state is stored. The
 * read is readAccountState, the same one stripe-connect-onboard uses on the owner's return, so a
 * row means the same whichever of the two wrote it. The payload is the fallback when the read
 * fails; it is the v1 shape of the same account, mapped by the same accountState.
 */
async function syncAccount(admin: SupabaseClient, account: string, payload: StripeAccountLike, secretKey: string) {
  // Most accounts that send events are linked to a branch, but one that was disconnected here
  // keeps sending them; there is nothing to update and no reason to call Stripe for it.
  const { data: linked, error: linkedErr } = await admin
    .from('branch_payment_accounts')
    .select('branch_id')
    .eq('stripe_account_id', account)
    .limit(1);
  if (linkedErr) throw new Error(`sync_account lookup: ${linkedErr.message}`);
  if (!linked || linked.length === 0) return;
  const fetched = await readAccountState(secretKey, account);
  if (!fetched.ok) console.warn('account.updated: re-read failed, using the event payload', account, fetched.status);
  const state = fetched.ok ? fetched.data : accountState(payload);
  const { error } = await admin
    .from('branch_payment_accounts')
    .update({ ...state, updated_at: new Date().toISOString() })
    .eq('stripe_account_id', account);
  if (error) throw new Error(`sync_account: ${error.message}`);
}

/**
 * charge.refunded: the event's Charge is a snapshot from when the event was sent, and a delivery
 * can come hours late (a retry) after the refund it announced has failed; its refunded: true would
 * then mark the payment refunded and let staff close the order with nothing sent back. So the
 * snapshot is never applied (readChargeRefunds in the shared module). The charge's refunds as they
 * are NOW are recorded one by one, which settles the payment from the refund rows; only when they
 * cannot be listed is the freshly re-read Charge applied. If neither can be read, a failure worth
 * retrying makes Stripe redeliver the event; any other is logged and left: the refund.* events
 * record the same refunds, and stripe-refund's cancel re-reads the charge before it trusts the books.
 */
async function syncChargeRefunds(
  admin: SupabaseClient,
  event: StripeEvent,
  account: string,
  snapshot: { id?: unknown },
  secretKey: string,
) {
  const read = await readChargeRefunds(secretKey, account, snapshot.id);
  switch (read.kind) {
    case 'no_charge':
      return;
    case 'refunds':
      for (const refund of read.refunds) await recordRefund(admin, account, refund, event.id);
      return;
    case 'charge': {
      console.warn('charge.refunded: listing refunds failed, applied the re-read charge', snapshot.id, read.refundsStatus);
      const { data, error } = await admin.rpc('stripe_connect_apply_charge_refunded', {
        p_account: account,
        p_charge: read.charge,
      });
      if (error) throw new Error(`apply_charge_refunded: ${error.message}`);
      warnMismatch(admin, event, account, data);
      return;
    }
    case 'unreadable':
      if (read.retry) throw new Error(`charge.refunded: refunds ${read.refundsStatus}, charge ${read.chargeStatus}`);
      await logEvent(admin, 'stripe_connect.charge_refunded_unread', 'warn', 'a charge.refunded could not be re-read from Stripe; its snapshot was not applied', null, {
        event_id: event.id,
        account,
        charge: snapshot.id,
        refunds_status: read.refundsStatus,
        charge_status: read.chargeStatus,
      });
      return;
  }
}

/**
 * refund.*: record the refund as Stripe has it now (currentRefund in the shared module re-reads it
 * on the connected account), not the event's snapshot, which can be older than a failure that
 * followed it. A failed re-read records the snapshot, which the SQL makes safe on its own.
 */
async function syncRefund(admin: SupabaseClient, event: StripeEvent, account: string, snapshot: Record<string, unknown>, secretKey: string) {
  const read = await currentRefund(secretKey, account, snapshot);
  if (!read.fresh) console.warn('refund event: re-read failed, recording the event payload', snapshot.id, read.status);
  await recordRefund(admin, account, read.refund, event.id);
}

async function recordRefund(admin: SupabaseClient, account: string, refund: Record<string, unknown>, eventId: string) {
  const { data, error } = await admin.rpc('stripe_connect_record_refund', {
    p_account: account,
    p_refund: refund,
  });
  if (error) throw new Error(`record_refund: ${error.message}`);
  const result = (data ?? {}) as { ok?: boolean; error?: string };
  if (result.ok !== true && result.error === 'account_mismatch') {
    await logEvent(admin, 'stripe_connect.account_mismatch', 'error', 'a refund came from an account the payment was not charged on', null, {
      event_id: eventId,
      account,
      refund: refund.id,
    });
  }
}

function warnMismatch(admin: SupabaseClient, event: StripeEvent, account: string, data: unknown) {
  const result = (data ?? {}) as { ok?: boolean; error?: string };
  if (result.ok !== true && result.error === 'account_mismatch') {
    void logEvent(admin, 'stripe_connect.account_mismatch', 'error', 'a charge event came from an account the payment was not charged on', null, {
      event_id: event.id,
      account,
    });
  }
}

/**
 * The diner paid for an order that can no longer be cooked (the 30-minute expiry, or a cancel
 * while the card was being confirmed), or paid an amount the order did not ask for. The money is
 * on the branch's account; it goes back to the diner from there. The idempotency key is per
 * PaymentIntent, so a retried event, or the payment page's own re-check, cannot refund twice.
 */
async function refundLatePayment(
  admin: SupabaseClient,
  account: string,
  intent: { id: string },
  result: ApplyIntentResult,
  secretKey: string,
) {
  const cents = Math.trunc(Number(result.refund_amount_cents ?? 0));
  if (!(cents > 0)) return;
  const reasonText =
    result.reason === 'amount_mismatch'
      ? 'The amount paid did not match the order.'
      : 'The order was closed before the card payment arrived.';
  const created = await stripeRequest<Record<string, unknown>>(secretKey, 'POST', '/v1/refunds', {
    account,
    idempotencyKey: `late_payment_refund:${intent.id}`,
    params: {
      payment_intent: intent.id,
      amount: cents,
      reason: 'requested_by_customer',
      metadata: {
        payment_id: result.payment_id,
        order_id: result.order_id,
        reason: result.reason === 'amount_mismatch' ? 'amount_mismatch' : 'order_closed_before_payment',
      },
    },
  });
  if (!created.ok) {
    await logEvent(admin, 'stripe_connect.late_refund_failed', 'error', 'could not refund a payment that arrived after its order closed', result.restaurant_id ?? null, {
      account,
      payment_intent: intent.id,
      payment_id: result.payment_id,
      order_id: result.order_id,
      amount: cents / 100,
      stripe_status: created.status,
      stripe_error: created.error?.error?.message ?? null,
    });
    // Stripe unreachable or failing: let Stripe redeliver the event and try again. A 4xx (already
    // refunded, disputed, ...) will not get better by retrying; it is logged for a person.
    if (isRetryableStripeFailure(created.status)) throw new Error(`late refund: ${created.status}`);
    return;
  }
  const { error } = await admin.rpc('stripe_connect_record_refund', {
    p_account: account,
    p_refund: created.data,
    p_reason: reasonText,
  });
  if (error) throw new Error(`record late refund: ${error.message}`);
  await logEvent(admin, 'stripe_connect.late_payment_refunded', 'warn', reasonText, result.restaurant_id ?? null, {
    account,
    payment_intent: intent.id,
    payment_id: result.payment_id,
    order_id: result.order_id,
    amount: cents / 100,
    refund: created.data.id,
  });
}

async function logEvent(
  admin: SupabaseClient,
  type: string,
  level: 'info' | 'warn' | 'error',
  note: string,
  restaurantId: string | null,
  payload: Record<string, unknown>,
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
