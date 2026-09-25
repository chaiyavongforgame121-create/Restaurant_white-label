// The arithmetic and parsing stripe-refund decides with, kept free of Deno, Supabase and Stripe
// so it can be tested on its own. index.ts does the I/O around it.
//
// Everything is in whole cents. payments.amount and payment_refunds.amount are numeric(10,2)
// dollars and Stripe speaks in the smallest currency unit; converting once at the edges keeps a
// 0.1 + 0.2 float from ever deciding whether a refund is "too much".

/** payments.status values under which the card was actually charged. 'refunded' stays refundable
 *  here because the Connect webhook may mark a payment refunded after a PARTIAL refund; the
 *  arithmetic below, not the label, decides whether anything is left. */
export const PAID_PAYMENT_STATUSES = ['completed', 'refunded'] as const;

/** payment_refunds rows in these states hold money back; failed and canceled ones do not. */
export const LIVE_REFUND_STATUSES = ['pending', 'succeeded'] as const;

export interface PaymentCandidate {
  id: string;
  status: string;
  method: string;
  gateway: string | null;
  gateway_charge_id: string | null;
  created_at: string | null;
}

/**
 * The Stripe card payment to refund: the newest paid one. The back office's dialog makes the same
 * choice (card-refund.ts summarizeCardPayment), so it offers to refund the payment this refunds.
 * A card row with no PaymentIntent (the pre-Connect rows, or a card taken on the counter's own
 * terminal) cannot be refunded through Stripe and is never picked.
 */
export function pickRefundablePayment<T extends PaymentCandidate>(rows: readonly T[]): T | null {
  const paid = rows
    .filter(
      (p) =>
        p.method === 'card' &&
        p.gateway === 'stripe' &&
        typeof p.gateway_charge_id === 'string' &&
        p.gateway_charge_id.startsWith('pi_') &&
        (PAID_PAYMENT_STATUSES as readonly string[]).includes(p.status),
    )
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  return paid[0] ?? null;
}

/** Dollars (number or numeric string) to whole cents, or null when it is not a whole-cent
 *  positive amount. 12.345 is refused rather than rounded: a refund is exact or it is wrong. */
export function dollarsToCents(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) return null;
  return cents;
}

/** The same conversion for money read back from our own numeric(10,2) columns, where zero and
 *  a missing value are legitimate and mean nothing. */
export function storedCents(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** The operator's free-text reason, as refund_order stores it: trimmed, at most 300 characters,
 *  control characters removed (it is echoed into Stripe metadata and the audit trail). */
export function parseReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 300) : null;
}

/** A client-made key is a random id; anything else is ignored rather than trusted. */
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;

/**
 * The Idempotency-Key sent to Stripe. Stripe keeps a key for 24 hours and answers a repeat with
 * the refund it already made, so a double click, or a retry after the answer was lost, cannot
 * refund twice.
 *
 * The back office sends a fresh random key per refund the operator means to make, and keeps it
 * across retries of that same refund. The amount is part of the key too, so an operator who
 * corrects the amount after a refusal is not answered with the refused request's error.
 *
 * Without a client key the fallback is derived from what is already refunded: the same request
 * repeated before anything was recorded maps to the same key, while a second, deliberate refund
 * of the same amount (made after the first was recorded) gets a new one.
 */
export function refundIdempotencyKey(input: {
  paymentId: string;
  clientKey: unknown;
  amountCents: number;
  alreadyRefundedCents: number;
}): string {
  const client = typeof input.clientKey === 'string' && CLIENT_KEY_RE.test(input.clientKey)
    ? input.clientKey
    : null;
  return client
    ? `favornoms-refund:${input.paymentId}:${client}:${input.amountCents}`
    : `favornoms-refund:${input.paymentId}:auto:${input.alreadyRefundedCents}:${input.amountCents}`;
}

/** acct_ followed by Stripe's id alphabet. Anything else in gateway_metadata is not used. */
const ACCOUNT_RE = /^acct_[A-Za-z0-9]{6,}$/;

/**
 * The connected account the charge lives on. The charge was made on the account the branch had
 * when the diner paid, which stripe-create-payment-intent stamps on the payment
 * (gateway_metadata.stripe_account); if the branch has reconnected since, that is still the
 * account the refund must be made on. The branch's current account is only a fallback for a
 * payment that carries no stamp. Neither is ever taken from the request.
 */
export function chargeAccount(
  gatewayMetadata: unknown,
  branchAccountId: string | null | undefined,
): string | null {
  const stamped =
    gatewayMetadata && typeof gatewayMetadata === 'object'
      ? (gatewayMetadata as Record<string, unknown>).stripe_account
      : undefined;
  if (typeof stamped === 'string' && ACCOUNT_RE.test(stamped)) return stamped;
  if (typeof branchAccountId === 'string' && ACCOUNT_RE.test(branchAccountId)) return branchAccountId;
  return null;
}

/**
 * Whether the PaymentIntent Stripe returned is the one this order's payment row points at.
 * stripe-create-payment-intent stamps metadata.order_id and metadata.payment_id on every intent
 * it makes; a stamp that names anything else is refused. An intent with no stamp at all (made by
 * hand, or before stamping) is accepted only on the branch's own current account.
 */
export function intentBelongsTo(
  intent: { metadata?: Record<string, string | undefined> | null },
  expected: { orderId: string; paymentId: string; account: string; branchAccount: string | null },
): boolean {
  const stampedOrder = intent.metadata?.order_id;
  const stampedPayment = intent.metadata?.payment_id;
  if (stampedOrder || stampedPayment) {
    return (
      (!stampedOrder || stampedOrder === expected.orderId) &&
      (!stampedPayment || stampedPayment === expected.paymentId)
    );
  }
  return expected.branchAccount !== null && expected.account === expected.branchAccount;
}

export interface RefundPlanInput {
  /** What Stripe captured on the PaymentIntent (amount_received). */
  capturedCents: number;
  /** payments.amount: what our books say the card was charged. */
  recordedCents: number;
  /** payment_refunds rows for this payment that are pending or succeeded. */
  refundedInBooksCents: number;
  /** The charge's amount_refunded at Stripe, when the charge could be read. It also counts
   *  refunds made in the branch's own Stripe Dashboard that the webhook has not recorded yet. */
  refundedAtStripeCents: number | null;
  /** The amount asked for; null means everything that is left. */
  requestedCents: number | null;
}

export type RefundPlan =
  | { ok: true; amountCents: number; remainingCents: number; alreadyRefundedCents: number }
  | {
      ok: false;
      error: 'nothing_to_refund' | 'over_refund' | 'invalid_amount';
      remainingCents: number;
      alreadyRefundedCents: number;
    };

/**
 * How much may go back. The ceiling is the smaller of what Stripe captured and what our books
 * recorded, and what has gone back already is the larger of the two tallies, so a disagreement
 * between them can only ever make the refund smaller, never larger. Stripe refuses an over-refund
 * on its own as well; this answers first, with the figure the operator can still refund.
 */
export function planRefund(input: RefundPlanInput): RefundPlan {
  const ceiling = Math.max(0, Math.min(input.capturedCents, input.recordedCents));
  const already = Math.max(0, input.refundedInBooksCents, input.refundedAtStripeCents ?? 0);
  const remaining = Math.max(0, ceiling - already);
  const base = { remainingCents: remaining, alreadyRefundedCents: already };

  if (input.requestedCents !== null) {
    if (!Number.isInteger(input.requestedCents) || input.requestedCents <= 0) {
      return { ok: false, error: 'invalid_amount', ...base };
    }
  }
  if (remaining <= 0) return { ok: false, error: 'nothing_to_refund', ...base };
  const amount = input.requestedCents ?? remaining;
  if (amount > remaining) return { ok: false, error: 'over_refund', ...base };
  return { ok: true, amountCents: amount, ...base };
}

/**
 * Who may ask for a cancel with its refund (cancel: true): exactly who cancel_order lets cancel,
 * so the kitchen's Reject works for a cook who holds kitchen.access and not orders.refund. The
 * refund in that mode is never an amount the caller picks: it is the whole of what is left, and
 * it is followed by the cancel, so it cannot be used to hand out partial refunds.
 */
export const CANCEL_CAPABILITIES = ['orders.cancel', 'kitchen.access'] as const;

/** The capabilities a plain refund needs: the right refund_order asks for. */
export const REFUND_CAPABILITIES = ['orders.refund'] as const;

/** Whether the caller's capability list at the branch allows this request. */
export function mayRequest(capabilities: readonly unknown[], cancel: boolean): boolean {
  const needed: readonly string[] = cancel ? CANCEL_CAPABILITIES : REFUND_CAPABILITIES;
  return capabilities.some((c) => typeof c === 'string' && needed.includes(c));
}

/**
 * The body's cancel flag. Only a literal true switches the mode: a request that reaches this
 * function with "cancel": "yes" is malformed, and reading it as a plain refund is the safe way
 * to be wrong, because a plain refund never closes the order.
 */
export function wantsCancel(raw: unknown): boolean {
  return raw === true;
}

/** Order statuses cancel_order refuses to leave. A cancel is not tried on them, and neither is
 *  the refund that would have gone with it. */
export const CLOSED_ORDER_STATUSES = ['completed', 'cancelled', 'refunded'] as const;

/**
 * Stripe dispute statuses under which the disputed amount has already been taken out of the
 * branch's balance and given back to the cardholder by their bank: a formal chargeback waiting on
 * the restaurant, one under review, and one the restaurant lost. Stripe refuses a refund of such a
 * charge (charge_disputed), so a cancel skips the refund, and the database lets the order close
 * (private.order_card_refund_due in 20260925120000_card_refund_followups.sql names the same three).
 * An inquiry (warning_*) or a won dispute leaves the money with the restaurant, and a cancel then
 * refunds it as usual.
 */
export const DISPUTE_STATUSES_MONEY_TAKEN = ['needs_response', 'under_review', 'lost'] as const;

/** Whether the payment's recorded dispute (gateway_metadata.dispute_status, written by the
 *  Connect webhook) means the bank has already taken the money back. */
export function disputeTookTheMoney(gatewayMetadata: unknown): boolean {
  const status =
    gatewayMetadata && typeof gatewayMetadata === 'object'
      ? (gatewayMetadata as Record<string, unknown>).dispute_status
      : undefined;
  return typeof status === 'string' && (DISPUTE_STATUSES_MONEY_TAKEN as readonly string[]).includes(status);
}

/**
 * Whether our books may be behind Stripe on this payment: Stripe reports more refunded than
 * payment_refunds holds (a refund made in the branch's Dashboard whose webhook has not landed, or
 * one this function made and could not record). The function then lists the charge's refunds from
 * Stripe and records them, whether it made a new refund or found nothing left to refund, because
 * cancel_order and refund_order check payment_refunds, not Stripe.
 */
export function booksBehindStripe(refundedInBooksCents: number, refundedAtStripeCents: number | null): boolean {
  return refundedAtStripeCents !== null && refundedAtStripeCents > refundedInBooksCents;
}

/** What a Stripe error means for the caller: refused for good, or an outcome we cannot know. */
export function classifyStripeFailure(httpStatus: number, errorType: string | null | undefined):
  | 'refused'
  | 'unknown' {
  // 429 (rate or lock) and 5xx: Stripe may or may not have acted. The caller keeps its key and
  // retries, and Stripe's idempotency answers with the refund if one was made.
  if (httpStatus === 429 || httpStatus >= 500) return 'unknown';
  if (errorType === 'api_error') return 'unknown';
  return 'refused';
}
