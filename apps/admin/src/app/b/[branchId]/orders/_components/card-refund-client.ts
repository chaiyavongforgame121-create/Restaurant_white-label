// The browser side of card refunds: the stripe-refund call and the read of an order's card
// payment. The rules both depend on are in card-refund.ts, where they are tested.

import { getBrowserClient } from '@favornoms/database/client';
import { getSupabaseEnv } from '@favornoms/database/env';
import {
  cancelOutcomeFromRefund,
  isStripeCardPayment,
  needsCardRefund,
  summarizeCardPayment,
  type CancelOutcome,
  type CancelRefundSuccess,
  type CardPaymentRow,
  type CardPaymentState,
  type CardRefundErrorBody,
  type PaymentRefundRow,
} from './card-refund';

/** What stripe-refund answers when the refund was created on Stripe. */
export interface CardRefundSuccess {
  ok: true;
  refund_id: string;
  /** Dollars. */
  amount: number;
  /** Stripe's status for the new refund: 'succeeded' for most cards, 'pending' otherwise. */
  stripe_status: string;
  /** False when Stripe made the refund but the payment_refunds row could not be written. The
   *  Connect webhook records it anyway; the money has moved either way. */
  recorded: boolean;
}

export type CardRefundResponse =
  | { ok: true; data: CardRefundSuccess }
  | { ok: false; status: number | null; body: CardRefundErrorBody | null };

/** A key for one refund the operator means to make; see keepIdempotencyKey. */
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** One POST to stripe-refund as the signed-in operator. Never throws: a network failure is
 *  { ok: false, status: null }. */
async function postStripeRefund<T extends { ok: true }>(
  payload: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; status: number | null; body: CardRefundErrorBody | null }> {
  try {
    const supabase = getBrowserClient();
    const { data: session } = await supabase.auth.getSession();
    const accessToken = session.session?.access_token;
    if (!accessToken) return { ok: false, status: 401, body: { error: 'auth_required' } };
    const { url, publishableKey } = getSupabaseEnv();
    const res = await fetch(`${url}/functions/v1/stripe-refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => null)) as (T & CardRefundErrorBody) | null;
    if (res.ok && body?.ok === true) return { ok: true, data: body };
    console.error('[orders] stripe-refund refused', res.status, body);
    return { ok: false, status: res.status, body };
  } catch (err) {
    console.error('[orders] stripe-refund unreachable', err);
    return { ok: false, status: null, body: null };
  }
}

/** Calls stripe-refund. Never throws: a network failure is { ok: false, status: null }. */
export function requestCardRefund(input: {
  orderId: string;
  /** Dollars. Left out, the whole of what can still be refunded goes back. */
  amount?: number;
  reason?: string | null;
  idempotencyKey: string;
}): Promise<CardRefundResponse> {
  return postStripeRefund<CardRefundSuccess>({
    order_id: input.orderId,
    ...(input.amount !== undefined ? { amount: Math.round(input.amount * 100) / 100 } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    idempotency_key: input.idempotencyKey,
  });
}

/**
 * Cancel an order the way every staff screen must since card payments went online: cancel_order
 * first, and only if the database answers that the diner's card has to be refunded first
 * (card_refund_required), stripe-refund with cancel: true, which refunds the rest of the card
 * payment on the branch's Stripe account and then cancels as this same operator. See
 * cancelOutcomeFromRefund in card-refund.ts for what each outcome means.
 *
 * `reason` is written to orders.cancellation_reason (the diner's order page shows it) and to the
 * refund, so it is stored English, as every cancel reason is. `idempotencyKey` is made once per
 * cancel the operator means to do and kept across retries of it while the outcome is unknown
 * (keepIdempotencyKey), so a second press after a lost answer gets Stripe's first refund back.
 */
export async function cancelOrderWithCardRefund(input: {
  orderId: string;
  reason: string;
  idempotencyKey: string;
}): Promise<CancelOutcome> {
  const supabase = getBrowserClient();
  const { error } = await supabase.rpc('cancel_order', { p_order_id: input.orderId, p_reason: input.reason });
  if (!error) return { ok: true, refunded: null };
  if (!needsCardRefund(error.message)) return { ok: false, stage: 'cancel', code: error.message };
  const res = await postStripeRefund<CancelRefundSuccess>({
    order_id: input.orderId,
    cancel: true,
    reason: input.reason,
    idempotency_key: input.idempotencyKey,
  });
  return cancelOutcomeFromRefund(res);
}

/**
 * Read the order's card payment and refunds as the signed-in operator (payments.view). `error`
 * is set when the answer cannot be trusted: offering a cancel without the refund it owes, or a
 * refund larger than what is left, is worse than asking the operator to try again.
 */
export async function loadCardPayment(
  orderId: string,
): Promise<{ state: CardPaymentState | null; error: boolean }> {
  const supabase = getBrowserClient();
  // dispute_status alone, not all of gateway_metadata: a disputed charge has nothing to refund.
  const { data: payments, error: payErr } = await supabase
    .from('payments')
    .select(
      'id, order_id, amount, status, method, gateway, gateway_charge_id, created_at, dispute_status:gateway_metadata->>dispute_status',
    )
    .eq('order_id', orderId)
    .eq('method', 'card');
  if (payErr) {
    console.error('[orders] card payment read failed', payErr.message);
    return { state: null, error: true };
  }
  const rows = (payments ?? []) as CardPaymentRow[];
  // No Stripe payment: nothing to read in payment_refunds, and the old path applies.
  if (!rows.some(isStripeCardPayment)) return { state: null, error: false };
  const { data: refunds, error: refundErr } = await supabase
    .from('payment_refunds')
    .select('id, payment_id, order_id, amount, status, reason, created_at')
    .eq('order_id', orderId);
  if (refundErr) {
    console.error('[orders] card refunds read failed', refundErr.message);
    return { state: null, error: true };
  }
  return { state: summarizeCardPayment(rows, (refunds ?? []) as PaymentRefundRow[]), error: false };
}
