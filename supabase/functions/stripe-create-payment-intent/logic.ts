// The decisions stripe-create-payment-intent makes, with no I/O, so they can be unit-tested.
//
// This file imports nothing on purpose. The edge function (Deno) imports it as './logic.ts', and
// apps/web/src/lib/card-payment-edge.test.ts imports it from Node to pin every rule below. A
// Deno-only import here would make it untestable; a Node-only one would break the deploy.

/**
 * How long an unpaid card order may wait for its payment before it is cancelled.
 *
 * private.expire_unpaid_card_orders (20260925100000_stripe_connect_payments, pg_cron every minute)
 * cancels an unpaid card order at 30 minutes; this function stops handing out a payment form a
 * little before that, so a diner is never sent into a card form for an order the job is about to
 * cancel under them. The storefront's order page counts down to that cut-off, not to the expiry
 * (CARD_PAYMENT_TIME_TO_PAY_MINUTES in apps/web/src/lib/card-payment.ts; card-payment-edge.test.ts
 * pins both figures), so the diner never sees time left that this function would refuse. A payment
 * that still lands after the cut is refunded by the Connect webhook
 * (stripe_connect_apply_payment_intent answers refund_required).
 */
export const CARD_PAYMENT_WINDOW_MINUTES = 30;

/** The last minutes of the window in which no NEW payment attempt is started. */
export const CARD_PAYMENT_CUTOFF_MARGIN_MINUTES = 2;

/** Stripe's smallest USD charge: 50 cents. A smaller PaymentIntent is refused by the API. */
export const STRIPE_MIN_CHARGE_CENTS = 50;

/**
 * The only payment method a diner's PaymentIntent accepts: a card, which includes Apple Pay and
 * Google Pay (Stripe runs both as the 'card' type).
 *
 * Listed on purpose instead of letting Stripe pick (automatic_payment_methods). On a direct
 * charge the connected account's own settings decide what Stripe offers, and a branch with the
 * full Stripe Dashboard can switch on bank debits such as ACH itself. A bank debit stays
 * 'processing' for up to four business days, and a food order cannot wait that long: it would
 * hold its stock the whole time and reach the kitchen days later as new work. A card answers
 * within seconds, succeeded or declined, which is what the 30-minute window is built on.
 *
 * The storefront's Payment Element lists the same types (CARD_PAYMENT_METHOD_TYPES in
 * apps/web/src/lib/card-payment.ts; card-payment-edge.test.ts pins the two together), because
 * Stripe refuses to confirm a PaymentIntent whose types differ from the ones the form collected.
 */
export const CARD_PAYMENT_METHOD_TYPES = ['card'] as const;

/** A connected account id as Stripe issues them. Anything else is never sent as Stripe-Account. */
export const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;

/** A PaymentIntent id as Stripe issues them. */
export const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]+$/;

/**
 * A money amount (numeric(10,2) from PostgREST: a number, or a string for large values) as whole
 * cents. Null when it is not a finite, non-negative amount, so a malformed total can never become
 * a charge. Rounded, because 19.99 * 100 is 1998.9999999999998 in floating point.
 */
export function toCents(amount: unknown): number | null {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export interface GateOrder {
  status: string;
  awaiting_payment: boolean | null;
  created_at: string;
  total: number | string;
}

export interface GatePayment {
  method: string;
  status: string;
  gateway: string | null;
}

export interface GateAccount {
  stripe_account_id: string | null;
  charges_enabled: boolean | null;
}

export type GateRefusal =
  | 'already_paid'
  | 'order_not_payable'
  | 'not_awaiting_card_payment'
  | 'payment_window_expired'
  | 'card_not_ready'
  | 'amount_too_small';

/** The HTTP status each refusal is answered with. */
export const GATE_STATUS: Record<GateRefusal, number> = {
  already_paid: 409,
  order_not_payable: 409,
  not_awaiting_card_payment: 409,
  payment_window_expired: 409,
  card_not_ready: 409,
  amount_too_small: 400,
};

/** Payment statuses a new card attempt may start from. 'failed' is a declined attempt, which a
 *  PaymentIntent allows the diner to retry with another card; everything else is final. */
const RETRYABLE_PAYMENT_STATUSES = ['pending', 'failed'];

/** Whether the order is still inside the window in which a new payment attempt may start. */
export function withinPaymentWindow(createdAt: string, nowMs: number): boolean {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  const limitMs = (CARD_PAYMENT_WINDOW_MINUTES - CARD_PAYMENT_CUTOFF_MARGIN_MINUTES) * 60_000;
  return nowMs - created < limitMs;
}

/**
 * Why a PaymentIntent must NOT be created (or handed out again) for this order, or null when it
 * may. The order of the checks is the order of what the diner most needs to hear: an order that
 * is already paid says so before anything else, and "this shop cannot take cards" comes after
 * the checks that are about the order itself.
 */
export function cardPaymentRefusal(input: {
  order: GateOrder;
  payment: GatePayment | null;
  account: GateAccount | null;
  nowMs: number;
}): GateRefusal | null {
  const { order, payment, account, nowMs } = input;
  if (payment?.status === 'completed') return 'already_paid';
  // Only an order nobody has started. Staff cannot move an unpaid card order out of 'pending'
  // (the awaiting-payment guard), so any other status is a cancelled, refunded or finished one.
  if (order.status !== 'pending') return 'order_not_payable';
  if (
    !payment ||
    payment.method !== 'card' ||
    payment.gateway !== 'stripe' ||
    !RETRYABLE_PAYMENT_STATUSES.includes(payment.status)
  ) {
    return 'not_awaiting_card_payment';
  }
  if (order.awaiting_payment !== true) return 'not_awaiting_card_payment';
  if (!withinPaymentWindow(order.created_at, nowMs)) return 'payment_window_expired';
  if (!accountReady(account)) return 'card_not_ready';
  const cents = toCents(order.total);
  if (cents === null || cents < STRIPE_MIN_CHARGE_CENTS) return 'amount_too_small';
  return null;
}

/** The branch has a connected account that Stripe lets take charges. */
export function accountReady(account: GateAccount | null): account is { stripe_account_id: string; charges_enabled: true } {
  return (
    !!account &&
    account.charges_enabled === true &&
    typeof account.stripe_account_id === 'string' &&
    STRIPE_ACCOUNT_ID.test(account.stripe_account_id)
  );
}

/**
 * The Idempotency-Key for creating this payment's PaymentIntent.
 *
 * One payment on one account is one PaymentIntent: two tabs, a double tap or a retry after a
 * dropped response all get the same intent back from Stripe. The account is part of the key so a
 * branch that reconnected a different account never reuses a key minted for the old one.
 */
export function paymentIntentIdempotencyKey(paymentId: string, stripeAccount: string): string {
  return `favornoms-pi:${paymentId}:${stripeAccount}`;
}

/** The parts of a PaymentIntent these decisions read. */
export interface IntentSnapshot {
  id: string;
  status: string;
  amount: number;
  currency: string;
  metadata?: Record<string, string | undefined> | null;
  last_payment_error?: { code?: string | null; decline_code?: string | null; type?: string | null } | null;
}

export interface ExpectedCharge {
  cents: number;
  orderId: string;
  paymentId: string;
}

/** The intent was made by this function for exactly this payment: same order, same payment row,
 *  same amount, in dollars. Nothing is recorded as paid unless all four hold. */
export function intentMatches(pi: IntentSnapshot, expected: ExpectedCharge): boolean {
  return (
    pi.amount === expected.cents &&
    pi.currency === 'usd' &&
    pi.metadata?.order_id === expected.orderId &&
    pi.metadata?.payment_id === expected.paymentId
  );
}

/**
 * What to do with the PaymentIntent a payment row already points at.
 *
 * A payment has ONE intent for its whole life; nothing here ever makes a second. Replacing one
 * (cancel the old, create a new) was considered and left out on purpose: the old intent's
 * `payment_intent.canceled` event voids the payment (stripe_connect_apply_payment_intent), and if
 * it lands before the new id is stored the new intent belongs to no payment — money nobody
 * records. So a cancelled intent means the payment is over (the webhook voids it), and an intent
 * that does not match its payment is refused for a person to look at, never worked around.
 */
export type ExistingIntentDecision =
  /** Hand its client secret out again; the diner confirms the same intent. */
  | 'reuse'
  /** Stripe already took the money: record it, never charge again. */
  | 'succeeded'
  /** A payment is in flight (a card Stripe is still settling). Wait for it; never start another. */
  | 'processing'
  /** Cancelled at Stripe (the branch's Dashboard): the payment is void, the order cannot be paid. */
  | 'canceled'
  /** Not this payment's intent (amount, currency, order or payment differ). Refuse, do not guess. */
  | 'mismatch';

const CONFIRMABLE = ['requires_payment_method', 'requires_confirmation', 'requires_action'];

export function decideExistingIntent(pi: IntentSnapshot, expected: ExpectedCharge): ExistingIntentDecision {
  if (pi.status === 'canceled') return 'canceled';
  if (!intentMatches(pi, expected)) return 'mismatch';
  if (pi.status === 'succeeded') return 'succeeded';
  if (pi.status === 'processing' || pi.status === 'requires_capture') return 'processing';
  if (CONFIRMABLE.includes(pi.status)) return 'reuse';
  return 'mismatch';
}

/** What stripe_connect_apply_payment_intent answers (the parts read here). */
export interface AppliedIntent {
  ok: boolean;
  error?: string;
  /** The payment's status after applying: completed, failed, voided, pending, refunded. */
  status?: string;
  order_status?: string;
  /** 'refund_required' when money arrived for an order that can no longer be cooked. */
  action?: string | null;
}

/**
 * The diner's answer after a PaymentIntent was re-read and applied. Paid only once the payment row
 * says completed — the kitchen sees the order from that moment — so a success the database could
 * not record yet reads as processing, and the page asks again (the webhook records it meanwhile).
 */
export function dinerStateAfterApply(
  pi: Pick<IntentSnapshot, 'status' | 'last_payment_error'>,
  applied: AppliedIntent | null,
): DinerPaymentState {
  // Money arrived that the payment did not ask for (wrong amount), or for an order that closed
  // first (the 30-minute expiry): it goes back — the webhook refunds it — so it is not a payment
  // for this order, even though the row now says completed.
  if (applied?.ok && applied.action === 'refund_required') return 'canceled';
  if (applied?.ok && (applied.status === 'completed' || applied.status === 'refunded')) return 'paid';
  // Stripe has it but the database could not record it yet: the page asks again.
  if (pi.status === 'succeeded') return 'processing';
  return dinerPaymentState(pi);
}

/** What the diner is told about a PaymentIntent, in this app's words rather than Stripe's. */
export type DinerPaymentState = 'paid' | 'processing' | 'failed' | 'awaiting' | 'canceled';

export function dinerPaymentState(pi: Pick<IntentSnapshot, 'status' | 'last_payment_error'>): DinerPaymentState {
  switch (pi.status) {
    case 'succeeded':
      return 'paid';
    case 'processing':
    case 'requires_capture':
      return 'processing';
    case 'canceled':
      return 'canceled';
    case 'requires_payment_method':
      // A fresh intent also sits at requires_payment_method; only an attempt that failed carries
      // last_payment_error, and that is the one the diner must be told about.
      return pi.last_payment_error ? 'failed' : 'awaiting';
    default:
      return 'awaiting';
  }
}

/**
 * The reason a failed attempt is shown with: the card network's decline code when there is one
 * (insufficient_funds, lost_card…), else Stripe's error code (card_declined, expired_card…).
 * Codes only, never Stripe's English message: the storefront words them in the diner's language.
 */
export function failureCode(pi: Pick<IntentSnapshot, 'last_payment_error'>): string | null {
  const err = pi.last_payment_error;
  if (!err) return null;
  return err.decline_code || err.code || err.type || null;
}

/** application/x-www-form-urlencoded body for the Stripe API, with its bracket notation. */
export function stripeForm(params: Record<string, string | number | boolean | null | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    body.append(key, String(value));
  }
  return body;
}

/**
 * The PaymentIntent parameters for a direct charge on the branch's connected account.
 *
 * There is no application_fee_amount, transfer_data or on_behalf_of: the charge, its Stripe fee,
 * its payout and any dispute belong to the branch's own account and the platform takes nothing
 * (docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md §2). The connected account itself is not a
 * parameter; it is the Stripe-Account header, set by the caller from the database only.
 *
 * The payment methods are listed (CARD_PAYMENT_METHOD_TYPES), not left to the account's own
 * settings, so a bank debit can never be offered for an order that must be paid in minutes.
 */
export function paymentIntentParams(input: {
  cents: number;
  orderId: string;
  orderNumber: string;
  paymentId: string;
  branchId: string;
}): URLSearchParams {
  const methodTypes: Record<string, string> = {};
  CARD_PAYMENT_METHOD_TYPES.forEach((type, i) => {
    methodTypes[`payment_method_types[${i}]`] = type;
  });
  return stripeForm({
    amount: input.cents,
    currency: 'usd',
    ...methodTypes,
    description: `Order ${input.orderNumber}`,
    'metadata[order_id]': input.orderId,
    'metadata[order_number]': input.orderNumber,
    'metadata[payment_id]': input.paymentId,
    'metadata[branch_id]': input.branchId,
  });
}
