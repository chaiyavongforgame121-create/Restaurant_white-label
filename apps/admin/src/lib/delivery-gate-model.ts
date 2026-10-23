// The pure half of delivery-gate.ts: no database, no 'server-only', so the sidebar and the
// reports view (client components) can import its types and the rules can be unit-tested
// without a Next.js runtime.

import { hasFeature, type Entitlements, type FeatureKey } from '@favornoms/shared';

/**
 * Why a branch does not deliver, when it does not. Delivery is part of the plan at every
 * branch (docs/PACKAGING-2026-10-24.md §3), so there are exactly two reasons, and they need
 * different words because only one of them is the merchant's to undo:
 *
 * - 'switchedOff': the "Delivery at this branch" switch in branch settings is off. The
 *   screen says so and points there.
 * - 'notAvailable': delivery is off for the whole restaurant — its access lapsed, or the
 *   platform switched delivery off (restaurants.feature_overrides). Nothing in branch
 *   settings changes that, so there is no link and no price: the merchant contacts FavorNoms.
 */
export type DeliveryOffReason = 'switchedOff' | 'notAvailable';

/** Every back-office delivery screen's one question, answered once (resolveDeliveryGate). */
export interface DeliveryGate {
  /** Delivery is live at this branch right now: the branch-resolved `features.delivery`. */
  delivers: boolean;
  /** Why not, when `delivers` is false; null when it delivers. */
  reason: DeliveryOffReason | null;
  /**
   * Where the switch is (branch settings, at its card), only for 'switchedOff'. Whether the
   * viewer may open it is the caller's capability check, not the gate's.
   */
  settingsHref: string | null;
}

/** Branch settings, scrolled to the "Delivery at this branch" card (DeliverySwitchCard's id). */
export function deliverySettingsHref(branchId: string): string {
  return `/b/${branchId}/branch#delivery-switch`;
}

/**
 * The reason, from the three facts the server gives.
 *
 * - `delivers`: the branch payload's answer (private.branch_feature_granted: paid up, delivery
 *   granted restaurant-wide, not switched off here).
 * - `entitled`: the restaurant is paid up. A lapsed restaurant is 'notAvailable' whatever its
 *   switch says: turning the switch on would not bring delivery back, and the plan page (not
 *   this screen) is where a lapse is fixed.
 * - `switchOn`: the branch's switch (getBranchDeliveryEnabled), null when it could not be read.
 *   Only a switch read as off is 'switchedOff'. A switch that is on while the branch still does
 *   not deliver leaves the restaurant-wide grant as the cause; an unread one claims nothing
 *   about the branch and falls to the same answer.
 *
 * The one case this cannot tell apart is a paid-up restaurant whose delivery the platform
 * switched off AND whose branch switch is off as well: it reads 'switchedOff', and turning the
 * switch on then shows 'notAvailable'. The branch payload carries only the combined answer.
 */
export function deliveryOffReason(
  delivers: boolean,
  entitled: boolean,
  switchOn: boolean | null,
): DeliveryOffReason | null {
  if (delivers) return null;
  if (!entitled) return 'notAvailable';
  return switchOn === false ? 'switchedOff' : 'notAvailable';
}

/** The gate for one branch from those facts (resolveDeliveryGate reads them). */
export function deliveryGateFrom(
  branchId: string,
  delivers: boolean,
  entitled: boolean,
  switchOn: boolean | null,
): DeliveryGate {
  const reason = deliveryOffReason(delivers, entitled, switchOn);
  return {
    delivers,
    reason,
    settingsHref: reason === 'switchedOff' ? deliverySettingsHref(branchId) : null,
  };
}

/**
 * Work at a branch that outlives its delivery switch, one flag per screen that stays open for
 * it. Switching delivery off at a branch (or the restaurant losing it) must never strand what
 * is already under way (docs/PACKAGING-2026-10-24.md §3): a rider halfway to a customer still
 * needs someone watching the Live deliveries board, and a rider who finished runs here is
 * still owed.
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
 * resolved for the branch in the URL, so `delivery` is this branch's answer — true unless its
 * switch is off or the restaurant does not have delivery right now. The only widening is an
 * entry's own windDown flag — the board for runs still out, payouts for riders still owed — so
 * an entry is shown exactly while the screen behind it stays open.
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
