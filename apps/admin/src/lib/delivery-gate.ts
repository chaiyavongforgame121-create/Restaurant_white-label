import 'server-only';
import {
  getBranchDeliveryEnabled,
  getEntitlementsForBranch,
  LIVE_DELIVERY_STATUSES,
  LIVE_ORDER_STATUSES,
} from '@favornoms/database/queries';
import { hasFeature, type Entitlements } from '@favornoms/shared';
import type { getServerClient } from '@favornoms/database/server';
import {
  deliveryGateFrom,
  NO_WIND_DOWN,
  payoutWindowStart,
  type DeliveryGate,
  type DeliveryWindDown,
} from './delivery-gate-model';

export { NO_WIND_DOWN, PAYOUT_SUMMARY_WEEKS, deliverySettingsHref } from './delivery-gate-model';
export type { DeliveryGate, DeliveryOffReason, DeliveryWindDown } from './delivery-gate-model';

type ServerClient = Awaited<ReturnType<typeof getServerClient>>;

/**
 * The branch's "Delivery at this branch" switch, or null when it could not be read.
 * getBranchDeliveryEnabled throws on a failed read rather than guess; here an unknown switch
 * only decides which sentence a locked screen shows (deliveryOffReason), so it is not worth
 * failing the page over.
 */
async function readDeliverySwitch(supabase: ServerClient, branchId: string): Promise<boolean | null> {
  try {
    return await getBranchDeliveryEnabled(supabase, branchId);
  } catch {
    return null;
  }
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

/**
 * Does THIS branch deliver, and if not, why (see DeliveryOffReason)?
 *
 * Delivery is part of the plan at every branch, behind a free per-branch switch in branch
 * settings (docs/PACKAGING-2026-10-24.md §3). Every delivery screen in the back office asks
 * this one question so they cannot answer it differently, and none of them quotes a price or
 * points at the plan page for it any more.
 *
 * `getEntitlementsForBranch` resolves the payload FOR the branch, so `features.delivery` is
 * this branch's answer (private.branch_feature_granted) and not the restaurant's. A page that
 * already read that payload passes it as `entitlements`, so it is not read twice. The switch
 * itself is read only when the answer is no — to tell the two reasons apart — so a branch that
 * delivers, which is nearly every branch, pays for one read at most.
 */
export async function resolveDeliveryGate(
  supabase: ServerClient,
  branchId: string,
  entitlements?: Entitlements,
): Promise<DeliveryGate> {
  const ent = entitlements ?? (await getEntitlementsForBranch(supabase, branchId));
  // hasFeature on a branch-resolved payload IS the branch question. It fails closed, so a
  // failed read locks the screen (with the 'notAvailable' words: entitled is false then).
  const delivers = hasFeature(ent, 'delivery');
  const switchOn = delivers ? true : await readDeliverySwitch(supabase, branchId);
  return deliveryGateFrom(branchId, delivers, ent.entitled, switchOn);
}
