// The pure half of delivery-gate.ts: no database, no 'server-only', so the sidebar (a client
// component) can import its types and the rules can be unit-tested without a Next.js runtime.

import { hasFeature, type Entitlements, type FeatureKey } from '@favornoms/shared';

/**
 * Work at a branch that outlives its delivery switch, one flag per screen that stays open for
 * it. Delivery is sold per branch (docs/PACKAGING-2026-09-23.md §2), and switching it off must
 * never strand what is already under way: a rider halfway to a customer still needs someone
 * watching the Live deliveries board, and a rider who finished runs here is still owed.
 *
 * Each flag is exactly the rule the screen it names locks on, so a link is shown precisely
 * while the screen behind it is open — the sidebar entry, the dashboard's tile and alerts,
 * and the page itself cannot disagree.
 */
export interface DeliveryWindDown {
  /**
   * A run the Live deliveries board still shows: a delivery in LIVE_DELIVERY_STATUSES whose
   * order is still live (the board's own two filters). Keeps the board, its sidebar entry,
   * and the dashboard's delivery tile and delivery alerts.
   */
  runsOut: boolean;
  /**
   * A rider is owed money here: a withdrawal waiting to be paid, or earnings accrued in the
   * weeks the Driver payouts page shows (PAYOUT_SUMMARY_WEEKS). Keeps Driver payouts and its
   * sidebar entry, and the dashboard's withdrawals alert.
   */
  ridersOwed: boolean;
}

/** Nothing outstanding; also what a branch that still delivers is given without asking. */
export const NO_WIND_DOWN: DeliveryWindDown = Object.freeze({ runsOut: false, ridersOwed: false });

/** A back-office nav entry, as far as the entitlement gate is concerned. */
export interface GatedEntry {
  /** Hidden unless the branch-resolved entitlements include it. */
  feature?: FeatureKey;
  /** The one exception: shown anyway while this kind of delivery work is outstanding. */
  windDown?: keyof DeliveryWindDown;
}

/**
 * Does the entitlement gate let this entry through? (The capability gate is separate.)
 *
 * Fails closed: hasFeature needs an explicit `true` on a live subscription. `entitlements` is
 * resolved for the branch in the URL, so `delivery` is this branch's answer. The only widening
 * is an entry's own windDown flag — the board for runs still out, payouts for riders still
 * owed — so an entry is shown exactly while the screen behind it stays open.
 */
export function navEntryAllowed(
  entry: GatedEntry,
  entitlements: Entitlements | null | undefined,
  windDown: DeliveryWindDown,
): boolean {
  if (!entry.feature) return true;
  if (hasFeature(entitlements, entry.feature)) return true;
  return entry.windDown !== undefined && windDown[entry.windDown] === true;
}

/**
 * How many weeks of earnings the Driver payouts page lists (get_branch_payout_summary's
 * p_weeks). Shared with the "still owed" rule, so the page never stays open for money it
 * does not show, nor locks while it shows some.
 */
export const PAYOUT_SUMMARY_WEEKS = 8;

/**
 * The first payout_period_start get_branch_payout_summary includes, as the date it compares:
 * `date_trunc('week', now())::date - (p_weeks * 7)`. date_trunc('week') is the Monday that
 * starts the week in the session time zone, which is UTC on this project, so this is the UTC
 * Monday of `now`'s week, `weeks` weeks back, as YYYY-MM-DD.
 */
export function payoutWindowStart(now: Date, weeks: number = PAYOUT_SUMMARY_WEEKS): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay: Sunday 0 … Saturday 6. Days since Monday: Monday 0 … Sunday 6.
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - sinceMonday - Math.max(weeks, 1) * 7);
  return day.toISOString().slice(0, 10);
}

/**
 * What turning delivery on at this branch costs once.
 *
 * The $59 unlock is paid once per branch, ever (docs/PACKAGING-2026-09-23.md §1): a branch
 * that switched delivery off keeps its branch_addons row, and turning it back on costs only
 * the monthly price. Quoting the catalog's $59 there — as every locked delivery screen did —
 * promised a charge the plan page and the server then do not make.
 *
 * - `catalogPrice` null (the catalog could not be read) -> null: no number rather than a
 *   guessed one.
 * - `alreadyUnlocked` true -> 0.
 * - `alreadyUnlocked` null (the unlock could not be read) -> null, for the same reason: the
 *   true answer is either $59 or $0, and the plan page prices it exactly either way.
 */
export function deliveryOneTimePrice(
  catalogPrice: number | null,
  alreadyUnlocked: boolean | null,
): number | null {
  if (catalogPrice === null) return null;
  if (alreadyUnlocked === null) return null;
  return alreadyUnlocked ? 0 : catalogPrice;
}

/**
 * The price a locked screen prints once: a positive one-time price, or nothing. A branch that
 * already paid its unlock (0) shows the monthly price alone, beside a sentence saying why.
 */
export function oneTimePriceToShow(oneTimePrice: number | null): number | undefined {
  return oneTimePrice !== null && oneTimePrice > 0 ? oneTimePrice : undefined;
}
