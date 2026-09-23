// The arithmetic and the decoding the platform console's billing screens share.
//
// Kept away from the components on purpose: every figure here is money, and money
// deserves a test rather than a glance at a rendered card. Nothing in this file is
// worded — it returns numbers, names and message keys, and the screens turn those
// into the reader's language.
//
// The 2026-09-23 packaging (docs/PACKAGING-2026-09-23.md) has TWO totals that must
// never be blended: what is paid once, and what is paid every month. Everything
// here keeps them apart.

import { describeBillingError, type BillingError } from '@favornoms/shared';

/**
 * Money as this console shows it: whole dollars, with cents ONLY when something
 * made them. Every catalog price is a whole number, so rounding to the dollar
 * looked tidy right up until a 20% code turned $198 into $158.40 and the card
 * said $158 next to a database that says otherwise.
 */
export function formatMoney(amount: number): string {
  const v = Number(amount ?? 0);
  if (!Number.isFinite(v)) return '$0';
  return Number.isInteger(v) ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

/** A branch as the platform console lists it: enough to name it and to say if it is hidden. */
export interface PlatformBranchLite {
  id: string;
  name: string;
  /** Hidden branches take no orders, but they still hold their delivery row. */
  isActive: boolean;
}

/** What a package request asks for, in the pieces a plain sentence needs. */
export interface RequestAsk {
  /** Branches paid for, never fewer than one. */
  seats: number;
  /** The branches that would deliver, named, in the order the console lists them. */
  deliveryBranchNames: string[];
  /**
   * Delivery asked for on a branch this console cannot name — deleted since the
   * request was raised, or simply not in the page's read. Counted rather than
   * dropped: silently showing "no delivery" would hide what approving switches on.
   */
  unnamedDeliveryBranches: number;
}

/**
 * Resolve a request's branch ids against the branches on hand.
 *
 * Duplicate ids collapse (the server stores a distinct array, but a request
 * written by an older client may not) and the order follows the branch list, so
 * two cards for the same restaurant read the branches in the same order.
 */
export function requestAsk(
  branchSeats: number,
  deliveryBranchIds: string[],
  branches: PlatformBranchLite[],
): RequestAsk {
  const wanted = new Set((deliveryBranchIds ?? []).filter((id) => typeof id === 'string' && id));
  const named = branches.filter((b) => wanted.has(b.id));
  return {
    seats: Math.max(1, Math.trunc(branchSeats || 1)),
    deliveryBranchNames: named.map((b) => b.name),
    unnamedDeliveryBranches: Math.max(0, wanted.size - named.length),
  };
}

/** The one-time money on a request, split the way the merchant was quoted it. */
export interface OneTimeMoney {
  /** List price, before any code. */
  gross: number;
  /** What the code took off. */
  discount: number;
  /** What is actually payable once — what billing_requests.one_time_total stores. */
  net: number;
  code: string | null;
}

/**
 * Split a request's one-time figures.
 *
 * `one_time_total` is stored ALREADY NET of `discount_amount` (see the column
 * comment on billing_requests), so the list price is the two added back together.
 * Getting this backwards would quote a discount twice.
 */
export function requestOneTime(request: {
  one_time_total: number;
  discount_amount: number;
  discount_code: string | null;
}): OneTimeMoney {
  const net = Math.max(0, Number(request.one_time_total ?? 0));
  const discount = Math.max(0, Number(request.discount_amount ?? 0));
  return {
    gross: net + discount,
    discount,
    net,
    // A code that took nothing off is not worth naming as a discount.
    code: discount > 0 ? (request.discount_code ?? null) : null,
  };
}

/**
 * The contract error behind a failed write, or null when it is not one of ours.
 *
 * Re-exported through this module so the screens have one import for "decode what
 * the database said", and so the test for it sits beside the rest of the money.
 */
export function billingErrorOf(raw: string | null | undefined): BillingError | null {
  return raw ? describeBillingError(raw) : null;
}

/**
 * The message key for a failed decision on a package request. The raw PostgREST
 * text is logged, never shown. Callers try billingErrorOf() first: these are the
 * refusals that carry no contract code.
 */
export function decisionErrorKey(raw: string | undefined): string {
  if (!raw) return 'errors.decisionFailed';
  console.error('[platform/requests] decide_billing_request failed:', raw);
  if (/request_already_decided/i.test(raw)) return 'errors.alreadyDecided';
  if (/request_not_found/i.test(raw)) return 'errors.requestNotFound';
  if (/forbidden|not[ _]authori[sz]ed|permission denied|platform[ _]admin/i.test(raw)) {
    return 'errors.permission';
  }
  if (/failed to fetch|fetch failed|networkerror|network request failed/i.test(raw)) {
    return 'errors.network';
  }
  return 'errors.decisionFailed';
}
