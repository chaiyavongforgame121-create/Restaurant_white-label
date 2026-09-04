// Service fee — a CARD-ONLY surcharge on the food subtotal, stored per branch in
// branches.settings.service_fee_percent (jsonb).
//
// supabase/functions/place-order is the authoritative writer and mirrors this math by
// hand, because a Deno edge function cannot import this package. The two expressions
// must be edited together; pricing.test.ts pins this side of the pair.

export type OrderPaymentMethod = 'card' | 'cash' | 'transfer';

/** Ceiling shared by the admin editor, this helper and the place-order clamp. */
export const SERVICE_FEE_MAX_PERCENT = 25;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Only a card payment (Stripe) carries the fee. Cash, QR transfer and dine-in — which
 *  the checkout submits as 'cash' because payments.method is NOT NULL — never do. */
export function serviceFeeApplies(paymentMethod: string | null | undefined): boolean {
  return paymentMethod === 'card';
}

/** Read branches.settings.service_fee_percent as a whole percent clamped to 0..25.
 *  Absent, non-numeric or negative reads as 0, so a malformed row can only undercharge. */
export function parseServiceFeePercent(
  settings: Record<string, unknown> | null | undefined,
): number {
  const raw = ((settings ?? {}) as Record<string, unknown>).service_fee_percent;
  const n = typeof raw === 'string' ? Number(raw) : (raw as number);
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return Math.min(SERVICE_FEE_MAX_PERCENT, n);
}

/** Fee on the food subtotal for the method the order will actually be placed with.
 *  Charged on the subtotal alone — never on tax, tips or the delivery fee. */
export function computeServiceFee(
  subtotal: number,
  serviceFeePercent: number,
  paymentMethod: string | null | undefined,
): number {
  if (!serviceFeeApplies(paymentMethod)) return 0;
  const pct = Math.max(0, Math.min(SERVICE_FEE_MAX_PERCENT, Number(serviceFeePercent) || 0));
  return round2(Math.max(0, subtotal) * (pct / 100));
}
