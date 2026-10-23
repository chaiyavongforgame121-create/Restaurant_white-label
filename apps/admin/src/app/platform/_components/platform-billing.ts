// The arithmetic and the decoding the platform console's billing screens share.
//
// Kept away from the components on purpose: every figure here is money, and money
// deserves a test rather than a glance at a rendered card. Nothing in this file is
// worded — it returns numbers, names and message keys, and the screens turn those
// into the reader's language.
//
// The packaging of 2026-10-24 (docs/PACKAGING-2026-10-24.md) is one plan with TWO
// totals that must never be blended: what is paid once (the first-time setup, then a
// setup fee per additional branch) and what is paid every month (the same price per
// branch). Everything here keeps them apart.

import {
  FEATURE_KEYS,
  describeBillingError,
  packageMonthlyTotal,
  type BillingError,
  type BillingProduct,
  type FeatureKey,
  type PackageSelection,
} from '@favornoms/shared';

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
  /**
   * Hidden branches take no orders, but they are still listed: a one-time charge raised for
   * one before it was hidden (the old per-branch delivery unlock) must still be named.
   */
  isActive: boolean;
}

/**
 * The branches a package request pays for, never fewer than one. That is the whole ask now:
 * the plan includes every feature, delivery at every branch included, so a request no longer
 * names branches that deliver. An old request's delivery_branch_ids is history and is ignored.
 */
export function requestSeats(branchSeats: number): number {
  return Math.max(1, Math.trunc(branchSeats || 1));
}

/**
 * Feature keys nothing sells any more (docs/PACKAGING-2026-10-24.md §2: "nothing extra"). No
 * product grants them, so a catalog editor that offered them as a plain checkbox was one stray
 * click from handing an AI edge function to every restaurant on a plan. FEATURE_KEYS keeps them
 * so old rows and per-restaurant overrides still parse; this list is what the console refuses
 * to grant by accident.
 */
export const WITHDRAWN_FEATURES: readonly FeatureKey[] = Object.freeze([
  'ai_suite',
  'ai_voice',
  'digital_signage',
  'ai_menu_import',
]);

/** True for a key on WITHDRAWN_FEATURES. Unknown keys are not withdrawn: they were never sold. */
export function isWithdrawnFeature(key: string): boolean {
  return (WITHDRAWN_FEATURES as readonly string[]).includes(key);
}

/** The keys a product may still grant: FEATURE_KEYS without the withdrawn ones. */
export const SOLD_FEATURES: readonly FeatureKey[] = Object.freeze(
  FEATURE_KEYS.filter((k) => !isWithdrawnFeature(k)),
);

/**
 * The products that may put money on a quote: the active ones.
 *
 * A screen that reads the full catalog (to name a product an old request or charge still
 * refers to) must never price from it, or a withdrawn row with a price left on it — Delivery at
 * $30 a month, say — adds money to a total nobody is charged.
 */
export function sellableCatalog(catalog: BillingProduct[]): BillingProduct[] {
  return catalog.filter((p) => p.is_active);
}

/**
 * What a selection costs every month, priced from the ACTIVE products only, or null when no
 * active product is on hand to price it from (a failed catalog read must not quote $0).
 */
export function sellableMonthlyTotal(sel: PackageSelection, catalog: BillingProduct[]): number | null {
  const sellable = sellableCatalog(catalog);
  return sellable.length > 0 ? packageMonthlyTotal(sel, sellable) : null;
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
