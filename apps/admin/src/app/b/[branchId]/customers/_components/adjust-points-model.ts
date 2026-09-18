/** The limits public.adjust_loyalty_points enforces, checked in the form first so the merchant is
 *  told before a round trip. */
export const ADJUST_MAX_POINTS = 1_000_000;
export const ADJUST_REASON_MAX = 200;

export type AdjustPointsError =
  | 'notAuthorized'
  | 'badDelta'
  | 'badReason'
  | 'notInBranch'
  | 'insufficient'
  | 'generic';

/**
 * adjust_loyalty_points raises bare codes (`bad_delta` carries the value after a colon). The
 * database text itself is never shown: it is English and names internals.
 */
export function adjustPointsErrorKey(message: string | undefined | null): AdjustPointsError {
  const m = message ?? '';
  if (/not_authorized/.test(m)) return 'notAuthorized';
  if (/bad_delta/.test(m)) return 'badDelta';
  if (/bad_reason/.test(m)) return 'badReason';
  if (/customer_not_in_branch/.test(m)) return 'notInBranch';
  if (/insufficient_points/.test(m)) return 'insufficient';
  return 'generic';
}

/** Whole points from 1 to the function's limit, else null. */
export function parseAdjustPoints(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 && n <= ADJUST_MAX_POINTS ? n : null;
}
