// Card refunds for the back office.
//
// Since 2026-09-24 a diner's card payment is a direct charge on the branch's own Stripe account
// (docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md). Refunding one is no longer only a status change:
// the money has to go back through Stripe, from that account, before the order may say it was
// refunded. The stripe-refund edge function does that and records the refund in payment_refunds
// with the status Stripe gave it ('succeeded' at once for most cards, 'pending' while Stripe
// works on it); the Connect webhook moves a pending one on, to 'succeeded' or 'failed'.
//
// Everything here is pure, so the rules that decide what an operator is offered (how much can
// still go back, which refunds are waiting on Stripe, which sentence a refusal becomes) are
// pinned by card-refund.test.ts. The two browser calls live in card-refund-client.ts.

/** payment_refunds.status. Anything else a newer webhook writes is shown as it is. */
export type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';

/** The payments columns this module reads. Money arrives as a string over PostgREST. */
export interface CardPaymentRow {
  id: string;
  order_id: string;
  amount: number | string;
  status: string;
  method: string;
  gateway: string | null;
  gateway_charge_id: string | null;
  created_at?: string | null;
  /** gateway_metadata.dispute_status, read on its own (PostgREST `gateway_metadata->>dispute_status`)
   *  so the rest of the metadata never reaches the browser. Written by the Connect webhook. */
  dispute_status?: string | null;
}

/** The payment_refunds columns this module reads. */
export interface PaymentRefundRow {
  id: string;
  payment_id: string;
  order_id: string;
  amount: number | string;
  status: string;
  reason?: string | null;
  created_at: string;
}

export interface CardRefundLine {
  id: string;
  amount: number;
  status: string;
  reason: string | null;
  createdAt: string;
}

/** What the back office needs to know about an order's Stripe card payment. */
export interface CardPaymentState {
  paymentId: string;
  /** The card was charged: payments.status is 'completed', or 'refunded' in part or whole. */
  paid: boolean;
  /** What the card was charged. */
  amount: number;
  /** Refunds Stripe has confirmed. */
  refunded: number;
  /** Refunds sent to Stripe and not confirmed yet. Held back from what can still be refunded, so
   *  a second refund cannot be stacked on one Stripe is still processing. */
  refundPending: number;
  /** What can still go back to the card: amount - refunded - pending, never below zero, and zero
   *  while a formal dispute has the money (see `disputed`). */
  refundable: number;
  /** The diner disputed the payment with their bank and the bank has taken the money back
   *  (DISPUTE_STATUSES_MONEY_TAKEN). Nothing can be refunded then: Stripe refuses it, and the
   *  restaurant answers the dispute in its own Stripe Dashboard instead. */
  disputed: boolean;
  /** Oldest first, failed and canceled ones included: staff need to see that one failed. */
  refunds: CardRefundLine[];
}

/** The part of CardPaymentState the orders list hands each row (no refund lines). */
export type CardPaymentSummary = Omit<CardPaymentState, 'refunds'>;

/** payments.status values under which money was actually taken from the card. */
const PAID_STATUSES = new Set(['completed', 'refunded']);

/**
 * Stripe dispute statuses under which the cardholder's bank has already taken the money back: a
 * chargeback waiting on the restaurant, one under review, and one the restaurant lost. The same
 * list as DISPUTE_STATUSES_MONEY_TAKEN in supabase/functions/stripe-refund/refund-plan.ts and
 * private.order_card_refund_due (stripe-refund-edge.test.ts pins all three together). An inquiry
 * (warning_*) or a won dispute leaves the money with the restaurant, so it stays refundable.
 */
export const DISPUTE_STATUSES_MONEY_TAKEN = ['needs_response', 'under_review', 'lost'] as const;

/** Whether a dispute status means the bank has taken the payment back. */
export function disputeTookTheMoney(disputeStatus: string | null | undefined): boolean {
  return typeof disputeStatus === 'string' && (DISPUTE_STATUSES_MONEY_TAKEN as readonly string[]).includes(disputeStatus);
}

/** Whole cents. numeric(10,2) columns never carry a third decimal, so rounding only absorbs
 *  float noise such as 12.34 * 100 = 1233.9999999999998. */
const cents = (value: number | string) => Math.round(Number(value) * 100);

/**
 * A card payment that went through Stripe: method 'card', gateway 'stripe' and a PaymentIntent
 * id. The ten card rows left from before Stripe Connect have gateway 'stripe' but no intent,
 * and a card taken on the counter's own terminal has no gateway at all; neither can be refunded
 * through Stripe, so both keep today's record-only refund.
 */
export function isStripeCardPayment(p: CardPaymentRow): boolean {
  return (
    p.method === 'card' &&
    p.gateway === 'stripe' &&
    typeof p.gateway_charge_id === 'string' &&
    p.gateway_charge_id.trim() !== ''
  );
}

/**
 * The order's Stripe card payment and its refunds, or null when it has none (cash, transfer,
 * a counter card sale, or a pre-Connect card row) and the old refund path applies.
 */
export function summarizeCardPayment(
  payments: readonly CardPaymentRow[],
  refunds: readonly PaymentRefundRow[],
): CardPaymentState | null {
  const stripe = payments.filter(isStripeCardPayment);
  if (stripe.length === 0) return null;
  // The paid attempt wins. Without one, the newest: a diner whose first card was declined and
  // who is still trying has one pending row per attempt, and the latest is the live one. Newest
  // first in both cases, the same choice stripe-refund makes, so the dialog offers to refund the
  // payment the function will actually refund.
  const newestFirst = [...stripe].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const payment = newestFirst.find((p) => PAID_STATUSES.has(p.status)) ?? newestFirst[0]!;

  const mine = refunds
    .filter((r) => r.payment_id === payment.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const sumOf = (status: string) =>
    mine.filter((r) => r.status === status).reduce((sum, r) => sum + cents(r.amount), 0);

  const paid = PAID_STATUSES.has(payment.status);
  const amountC = cents(payment.amount);
  const refundedC = sumOf('succeeded');
  const pendingC = sumOf('pending');
  // Under a chargeback the money is already back with the cardholder's bank. Offering a refund
  // (the row's "Card not refunded" pill, the Refund card payment action) would be offering what
  // Stripe refuses, and the pill would never go away for a lost dispute. The cancel path skips the
  // refund for the same reason (stripe-refund, private.order_card_refund_due).
  const disputed = paid && disputeTookTheMoney(payment.dispute_status);
  const refundableC = paid && !disputed ? Math.max(0, amountC - refundedC - pendingC) : 0;

  return {
    paymentId: payment.id,
    paid,
    amount: amountC / 100,
    refunded: refundedC / 100,
    refundPending: pendingC / 100,
    refundable: refundableC / 100,
    disputed,
    refunds: mine.map((r) => ({
      id: r.id,
      amount: cents(r.amount) / 100,
      status: r.status,
      reason: r.reason ?? null,
      createdAt: r.created_at,
    })),
  };
}

/** One summary per order for the orders list, keyed by order id. */
export function summarizeCardPaymentsByOrder(
  payments: readonly CardPaymentRow[],
  refunds: readonly PaymentRefundRow[],
): Record<string, CardPaymentSummary> {
  const byOrder = new Map<string, CardPaymentRow[]>();
  for (const p of payments) {
    const list = byOrder.get(p.order_id) ?? [];
    list.push(p);
    byOrder.set(p.order_id, list);
  }
  const out: Record<string, CardPaymentSummary> = {};
  for (const [orderId, rows] of byOrder) {
    const state = summarizeCardPayment(
      rows,
      refunds.filter((r) => r.order_id === orderId),
    );
    if (!state) continue;
    // Only the figures: the row needs no refund lines, and this is serialised into the page.
    out[orderId] = {
      paymentId: state.paymentId,
      paid: state.paid,
      amount: state.amount,
      refunded: state.refunded,
      refundPending: state.refundPending,
      refundable: state.refundable,
      disputed: state.disputed,
    };
  }
  return out;
}

/** Why an amount typed into the Refund dialog cannot be sent, or null when it can. */
export function checkRefundAmount(amount: number, max: number): 'amountZero' | 'amountTooHigh' | null {
  const c = cents(amount);
  if (!Number.isFinite(c) || c <= 0) return 'amountZero';
  if (c > cents(max)) return 'amountTooHigh';
  return null;
}

/** Keys under orders.cardRefund.errors. */
export type CardRefundErrorKey =
  | 'generic'
  | 'authRequired'
  | 'notConfigured'
  | 'notAuthorized'
  | 'orderNotFound'
  | 'notPaid'
  | 'nothingToRefund'
  | 'overRefund'
  | 'invalidAmount'
  | 'noAccount'
  | 'mismatch'
  | 'stripeRefused'
  | 'stripeDisputed'
  | 'stripeAlreadyRefunded'
  | 'stripeInsufficientFunds'
  | 'unreachable';

/** The body stripe-refund answers with when it refuses. */
export interface CardRefundErrorBody {
  error?: string;
  /** Stripe's own error code, when Stripe is the one that refused. */
  stripe_code?: string | null;
  /** Dollars that could still be refunded, on over_refund. */
  refundable?: number;
  /** cancel: true only. cancel_failed carries cancel_order's own code here. */
  cancel_error?: string;
  /** cancel: true only. Dollars refunded by this request before the cancel failed. */
  amount?: number;
  /** cancel: true only. The order's status, on cannot_cancel_status. */
  status?: string;
}

// Cancelling a paid card order.
//
// Since 20260925120000_card_refund_followups the database refuses to cancel (or mark refunded) an
// order whose online card payment has not been given back, with 'card_refund_required'. Every
// place staff cancel from (Orders, the kitchen's Reject, Live deliveries) therefore does the same
// two steps: ask cancel_order, and when that is the answer, ask stripe-refund with cancel: true,
// which refunds whatever is left on the branch's Stripe account, records it, and cancels as the
// same operator. The second call is made only when the database says it is needed, so a cash or
// transfer order never waits on Stripe and works with no Stripe keys set at all.

/** Whether an order RPC or status write was refused because the card must be refunded first. */
export function needsCardRefund(message: string | null | undefined): boolean {
  const raw = (message ?? '').trim();
  return raw === 'card_refund_required' || raw.startsWith('card_refund_required:');
}

/** What stripe-refund answers with cancel: true when the order was cancelled. */
export interface CancelRefundSuccess {
  ok: true;
  cancelled: true;
  refund_id: string | null;
  /** Dollars refunded by this request; 0 when nothing was left to refund. */
  amount: number;
  stripe_status: string | null;
  recorded: boolean;
}

/** How a cancel ended, for the screen to word. */
export type CancelOutcome =
  /** Cancelled. `refunded` is what went back to the card as part of it, if anything did. */
  | { ok: true; refunded: { amount: number; stripeStatus: string } | null }
  /** cancel_order said no, and no money moved. `code` is its raw code for orderErrorKey. */
  | { ok: false; stage: 'cancel'; code: string }
  /** The card could not be refunded, so nothing was cancelled. Worded by cardRefundErrorKey. */
  | { ok: false; stage: 'refund'; status: number | null; body: CardRefundErrorBody | null }
  /** The card was refunded (`amount` dollars), then cancel_order said no: the order is still open.
   *  Asking again only retries the cancel, because nothing is left to refund. */
  | { ok: false; stage: 'cancelAfterRefund'; code: string; amount: number };

/** The outcome of stripe-refund's cancel: true call, from its answer. */
export function cancelOutcomeFromRefund(
  res:
    | { ok: true; data: CancelRefundSuccess }
    | { ok: false; status: number | null; body: CardRefundErrorBody | null },
): CancelOutcome {
  if (res.ok) {
    const amount = Number(res.data.amount) || 0;
    return {
      ok: true,
      refunded: amount > 0 ? { amount, stripeStatus: res.data.stripe_status ?? 'pending' } : null,
    };
  }
  const body = res.body;
  // Refused before any refund: the order had closed in the meantime.
  if (body?.error === 'cannot_cancel_status') {
    return { ok: false, stage: 'cancel', code: `cannot_cancel_status:${body.status ?? ''}` };
  }
  if (body?.error === 'cancel_failed') {
    const code = body.cancel_error ?? 'cancel_failed';
    const amount = Number(body.amount) || 0;
    return amount > 0 ? { ok: false, stage: 'cancelAfterRefund', code, amount } : { ok: false, stage: 'cancel', code };
  }
  return { ok: false, stage: 'refund', status: res.status, body };
}

/**
 * The sentence a refusal becomes. Stripe's own message is English and written for developers,
 * so it goes to the console; the operator reads what it means for them, in their language, and
 * every one of these says plainly whether money moved: it did not, except for 'unreachable',
 * where it may have, and the sentence says that pressing the button again cannot refund twice.
 */
export function cardRefundErrorKey(
  status: number | null,
  body: CardRefundErrorBody | null,
): CardRefundErrorKey {
  const code = body?.error ?? '';
  switch (code) {
    case 'auth_required':
    case 'invalid_token':
      return 'authRequired';
    case 'stripe_not_configured':
      return 'notConfigured';
    case 'not_authorized':
      return 'notAuthorized';
    case 'order_not_found':
      return 'orderNotFound';
    case 'not_paid_by_card':
    case 'payment_not_settled':
      return 'notPaid';
    case 'nothing_to_refund':
      return 'nothingToRefund';
    case 'over_refund':
      return 'overRefund';
    case 'invalid_amount':
      return 'invalidAmount';
    case 'no_stripe_account':
      return 'noAccount';
    case 'payment_mismatch':
      return 'mismatch';
    // stripe-refund's own refusal of a charge a dispute has taken, before asking Stripe: the same
    // sentence as Stripe's charge_disputed, since it means the same thing to the operator.
    case 'disputed':
      return 'stripeDisputed';
    case 'stripe_unreachable':
      return 'unreachable';
    case 'stripe_refused':
      switch (body?.stripe_code) {
        case 'charge_disputed':
          return 'stripeDisputed';
        case 'charge_already_refunded':
          return 'stripeAlreadyRefunded';
        case 'balance_insufficient':
        case 'insufficient_funds':
          return 'stripeInsufficientFunds';
        default:
          return 'stripeRefused';
      }
  }
  if (status === 401) return 'authRequired';
  if (status === 403) return 'notAuthorized';
  if (status === 503) return 'notConfigured';
  // No answer, or the function fell over: the refund may have been made. The sentence for this
  // says so, and that pressing the button again is safe (same idempotency key, no second refund).
  if (keepIdempotencyKey(status)) return 'unreachable';
  return 'generic';
}

/**
 * Whether a failed call may be retried with the SAME idempotency key. Only when the outcome is
 * unknown (the request never answered, or the function fell over mid-way): Stripe then returns
 * the refund it already made instead of making a second one. A definite refusal gets a fresh key,
 * because Stripe remembers a refused request under its key and would refuse a corrected one too.
 */
export function keepIdempotencyKey(status: number | null): boolean {
  return status === null || status === 500 || status === 502 || status === 504;
}
