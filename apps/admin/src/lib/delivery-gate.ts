import 'server-only';
import {
  getEntitlementsForBranch,
  listBillingProducts,
  LIVE_DELIVERY_STATUSES,
  LIVE_ORDER_STATUSES,
} from '@favornoms/database/queries';
import { ADDON_DELIVERY, hasFeature, type BillingProduct } from '@favornoms/shared';
import type { getServerClient } from '@favornoms/database/server';
import {
  deliveryOneTimePrice,
  NO_WIND_DOWN,
  payoutWindowStart,
  type DeliveryWindDown,
} from './delivery-gate-model';

export { NO_WIND_DOWN, PAYOUT_SUMMARY_WEEKS, oneTimePriceToShow } from './delivery-gate-model';
export type { DeliveryWindDown } from './delivery-gate-model';

type ServerClient = Awaited<ReturnType<typeof getServerClient>>;

/**
 * Does THIS branch deliver, and what would it cost to turn it on?
 *
 * Delivery stopped being one restaurant-wide switch on 2026-09-23: the owner picks
 * which branches deliver, each one costs $59 once and $29/month, and a branch without
 * it must read as "this branch does not deliver" rather than "your add-on is gone"
 * (docs/PACKAGING-2026-09-23.md §2). Every delivery screen in the back office asks
 * this one question so they cannot answer it differently.
 *
 * `getEntitlementsForBranch` resolves the payload FOR the branch, so
 * `features.delivery` is this branch's answer and not the restaurant's union.
 *
 * Prices come from `billing_products` and are null when the catalog cannot be read:
 * a locked screen with no price is honest, an invented one is not.
 */
export interface DeliveryGate {
  /** Delivery is live at this branch right now. */
  delivers: boolean;
  /**
   * This branch paid its one-time delivery unlock before, so turning delivery back on costs
   * nothing once (docs §1: "A branch's $59 is paid once ever"). null when it could not be read.
   */
  alreadyUnlocked: boolean | null;
  /**
   * What turning delivery on HERE costs once: the catalog's unlock price, 0 when the branch
   * already paid it, null when either could not be read. Print it with oneTimePriceToShow.
   */
  oneTimePrice: number | null;
  /** billing_products.delivery.monthly_price — what this branch adds to the bill. */
  monthlyPrice: number | null;
  /** The plan page with this branch's delivery already picked. */
  planHref: string;
}

/**
 * billing_products.one_time_price, added by the 2026-09-23 packaging migration
 * (docs §3.1). Read through a cast so this compiles before `BillingProduct` grows the
 * field; until the migration lands it is simply absent, and the caller shows the
 * monthly price on its own instead of a made-up number.
 */
function oneTimePriceOf(product: BillingProduct | undefined): number | null {
  const raw = (product as unknown as Record<string, unknown> | undefined)?.one_time_price;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function positive(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** The plan page, with this branch's Delivery switch pre-selected. */
export function deliveryPlanHref(branchId: string): string {
  return `/b/${branchId}/settings/plan?add=${ADDON_DELIVERY}&branch=${encodeURIComponent(branchId)}`;
}

/**
 * Has this branch paid its one-time delivery unlock before?
 *
 * The same test as private.branch_delivery_unlocked (what billing_paid_state and the plan
 * page read), taken the one way a merchant's session can: a branch_addons row for the branch,
 * switched on or off. The row is never deleted while the branch exists — switching delivery
 * off only flips `active` — so "a row exists" is "the $59 was paid", or the branch was
 * granted or grandfathered without a charge, which the plan page counts the same way. The
 * other half of the SQL test, a PAID billing_charges row, is not readable from here (that
 * table is platform-admin only), and adds nothing: decide_billing_request applies the
 * selection, which writes the row, in the same transaction that marks the charge paid.
 *
 * RLS lets any staff member of the branch read its row, so a manager on a locked screen gets
 * the same answer as the owner. A failed read is null, never a guess.
 */
async function deliveryUnlockedHere(supabase: ServerClient, branchId: string): Promise<boolean | null> {
  const { data, error } = await supabase
    .from('branch_addons')
    .select('branch_id')
    .eq('branch_id', branchId)
    .eq('code', ADDON_DELIVERY)
    .maybeSingle();
  if (error) return null;
  return data !== null;
}

/**
 * Runs the Live deliveries board still shows at this branch: the board's own two filters
 * (listLiveDeliveries — the delivery's status AND its order's status), so "the board stays
 * open" and "the board has something on it" are one question. A delivery row whose order was
 * closed some other way is not a run anyone is on, and must not hold a switched-off branch's
 * board open for ever.
 */
export async function hasRunsOut(supabase: ServerClient, branchId: string): Promise<boolean> {
  // One row, not a head count: the embedded !inner filter is the exact shape
  // listLiveDeliveries already runs in production, so the two cannot drift apart.
  const { data, error } = await supabase
    .from('deliveries')
    .select('id, orders!inner(status)')
    .eq('branch_id', branchId)
    .in('status', [...LIVE_DELIVERY_STATUSES])
    .in('orders.status', [...LIVE_ORDER_STATUSES])
    .limit(1);
  return !error && (data?.length ?? 0) > 0;
}

/**
 * Is a rider owed money at this branch? A withdrawal waiting to be paid, or earnings accrued in
 * the weeks the Driver payouts page lists — the page's own "still owed" test, so the page never
 * stays open for money it does not show.
 *
 * The ledger is readable only with drivers.manage (ledger_branch_staff_read), the capability
 * the Driver payouts entry already requires, so a viewer without it sees nothing owed and loses
 * nothing: the entry was never theirs.
 */
export async function hasRidersOwed(
  supabase: ServerClient,
  branchId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [withdrawals, accrued] = await Promise.all([
    supabase
      .from('driver_withdrawals')
      .select('id', { count: 'exact', head: true })
      .eq('branch_id', branchId)
      .eq('status', 'pending'),
    supabase
      .from('driver_earnings_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('branch_id', branchId)
      .eq('status', 'accrued')
      // The page's test is a driver-week whose accrued sum is above zero; totals are never
      // negative, so "some accrued row above zero" is the same answer without the sum.
      .gt('total', 0)
      .gte('payout_period_start', payoutWindowStart(now)),
  ]);
  const pending = withdrawals.error ? 0 : (withdrawals.count ?? 0);
  const owed = accrued.error ? 0 : (accrued.count ?? 0);
  return pending > 0 || owed > 0;
}

/**
 * What outlives this branch's delivery switch (see DeliveryWindDown). Asked only when delivery
 * is already OFF here — a branch that delivers keeps every screen anyway — so the common path
 * pays nothing.
 *
 * Fails closed-ish: an unreadable count is "nothing outstanding", which only ever hides a link
 * or locks a screen for one render, never opens one to a branch that has nothing to finish.
 */
export async function resolveDeliveryWindDown(
  supabase: ServerClient,
  branchId: string,
  delivers: boolean,
): Promise<DeliveryWindDown> {
  if (delivers) return NO_WIND_DOWN;
  const [runsOut, ridersOwed] = await Promise.all([
    hasRunsOut(supabase, branchId),
    hasRidersOwed(supabase, branchId),
  ]);
  return { runsOut, ridersOwed };
}

export async function resolveDeliveryGate(supabase: ServerClient, branchId: string): Promise<DeliveryGate> {
  // The catalog is a public read, the entitlements RPC is per branch and the unlock is one
  // row; none depends on another, and this sits in front of pages that load plenty already.
  const [entitlements, catalog, alreadyUnlocked] = await Promise.all([
    getEntitlementsForBranch(supabase, branchId),
    listBillingProducts(supabase),
    deliveryUnlockedHere(supabase, branchId),
  ]);
  const delivery = catalog.find((p) => p.code === ADDON_DELIVERY);
  return {
    // hasFeature on a branch-resolved payload IS the branch question (packaging §7.1
    // calls it deliversHere). It fails closed, so a failed read locks the screen.
    delivers: hasFeature(entitlements, 'delivery'),
    alreadyUnlocked,
    oneTimePrice: deliveryOneTimePrice(oneTimePriceOf(delivery), alreadyUnlocked),
    monthlyPrice: positive(delivery?.monthly_price),
    planHref: deliveryPlanHref(branchId),
  };
}
