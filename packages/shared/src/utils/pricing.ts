// Service fee — a CARD-ONLY surcharge on the food subtotal, stored per branch in
// branches.settings.service_fee_percent (jsonb).
//
// supabase/functions/place-order is the authoritative writer and mirrors this math by
// hand, because a Deno edge function cannot import this package. The two expressions
// must be edited together; pricing.test.ts pins this side of the pair.

export type OrderPaymentMethod = 'card' | 'cash' | 'transfer';

/**
 * Ceiling shared by the admin editor, the counter quote, this helper and the place-order clamp.
 *
 * 3, not the 25 it used to be: the fee is a surcharge on card payments, and the US card
 * networks cap a credit-card surcharge at 3% of the transaction (Visa and Mastercard rules;
 * some states allow less or none at all). A branch cannot be set above what a US merchant may
 * lawfully charge, and a branch stored above it (live branches were saved at 5%) is read as 3%
 * everywhere, so no card order is ever priced over the cap.
 */
export const SERVICE_FEE_MAX_PERCENT = 3;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Only a card payment (Stripe) carries the fee. Cash, QR transfer and dine-in — which
 *  the checkout submits as 'cash' because payments.method is NOT NULL — never do. */
export function serviceFeeApplies(paymentMethod: string | null | undefined): boolean {
  return paymentMethod === 'card';
}

/** Read branches.settings.service_fee_percent as a percent clamped to 0..SERVICE_FEE_MAX_PERCENT.
 *  Absent, non-numeric or negative reads as 0, so a malformed row can only undercharge. */
export function parseServiceFeePercent(
  settings: Record<string, unknown> | null | undefined,
): number {
  const stored = storedServiceFeePercent(settings);
  if (stored === null || stored < 0) return 0;
  return Math.min(SERVICE_FEE_MAX_PERCENT, stored);
}

/** The percent a branch has STORED, before any clamp, or null when it is absent or not a
 *  number. The service-fee card needs the raw figure to tell an owner whose branch was saved
 *  at 5% that card orders are now charged the 3% cap, rather than silently showing 3. */
export function storedServiceFeePercent(
  settings: Record<string, unknown> | null | undefined,
): number | null {
  const raw = ((settings ?? {}) as Record<string, unknown>).service_fee_percent;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
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
