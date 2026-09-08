import type { DriverLedgerEntry, EarningsBranchRef } from '@favornoms/shared';
import type { FavornomsClient } from '../client-type';
import type { Database } from '../types';

export type DriverRow = Database['public']['Tables']['drivers']['Row'];
export type DeliveryRow = Database['public']['Tables']['deliveries']['Row'];
export type DeliveryStatus = Database['public']['Enums']['delivery_status'];
export type DriverApprovalStatus = Database['public']['Enums']['driver_approval_status'];

export interface DriverApproval {
  /** driver_approvals.id — the rider needs it to address their own application row. */
  id: string;
  status: DriverApprovalStatus;
  branch_id: string;
  applied_at: string;
  reviewed_at: string | null;
  /**
   * The merchant's reason, typed into the reject textarea in the admin app, whose
   * placeholder promises it is "Shown to the rider in their app". It never was, because
   * this column was never selected. Null unless a reason was actually given.
   */
  notes: string | null;
  /** Null once the branch is deactivated — branches_public_read only exposes is_active. */
  branch: { id: string; name: string; restaurant: { name: string } | null } | null;
}

export interface DriverWithApproval extends DriverRow {
  approvals: DriverApproval[];
}

export interface BranchAvailability {
  branch_id: string;
  is_online: boolean;
  mode: 'manual' | 'scheduled';
}

/**
 * Fetch the drivers row that belongs to the currently-signed-in user.
 *
 * Null means one thing only: this user has no rider row. A failed read throws, the same way
 * `getActiveDelivery` below does and for the same reason — the driver app used to sign a rider
 * out on that null, so a PostgREST 5xx, an expired JWT or a dead spot ejected them from the
 * installed app as convincingly as a missing profile did.
 *
 * Pass `userId` when the caller has already resolved it; otherwise this makes a live
 * /auth/v1/user round trip, which is one more thing to fail in a tunnel.
 */
export async function getMyDriver(
  supabase: FavornomsClient,
  userId?: string,
): Promise<DriverWithApproval | null> {
  let id = userId;
  if (!id) {
    const { data: userData } = await supabase.auth.getUser();
    id = userData.user?.id;
  }
  if (!id) return null;

  const { data, error } = await supabase
    .from('drivers')
    .select(
      `*, approvals:driver_approvals(id, status, branch_id, applied_at, reviewed_at, notes, branch:branches(id, name, restaurant:restaurants(name)))`,
    )
    .eq('user_id', id)
    .maybeSingle();

  if (error) throw new Error('driver_read_failed:' + error.message);
  return (data as unknown as DriverWithApproval | null) ?? null;
}

/**
 * Push the driver's current GPS position.
 *
 * One RPC does three things, which is why it is worth knowing what a call costs: it stamps
 * drivers.current_location + location_updated_at (dispatch refuses anyone whose fix is older
 * than dispatch_max_gps_age_min), and it mirrors the position onto whichever delivery this
 * rider is carrying — driver_lat/lng, driver_location_updated_at, a recomputed
 * current_eta_min for the WHOLE remaining trip, and a one-shot arriving_at inside the 300 m
 * geofence. That mirror is what the customer's tracking map subscribes to, so every call
 * here wakes their page.
 *
 * Note the argument order: lng before lat. Defined in
 * 20260904150000_driver_gps_freshness_and_customer_tracking.sql (the original
 * 20260526000005_driver_location_rpc.sql pre-dates this repo and is not in git).
 *
 * Errors are worth reading: 'auth_required', 'driver_not_found', 'forbidden' (the driver row
 * belongs to another user). Callers that treat a failed write as a successful fix will tell
 * the rider they are visible when they are not.
 */
export async function updateDriverLocation(
  supabase: FavornomsClient,
  driverId: string,
  coords: { lat: number; lng: number; battery?: number },
) {
  return supabase.rpc('set_driver_location', {
    p_driver_id: driverId,
    p_lng: coords.lng,
    p_lat: coords.lat,
    p_battery: coords.battery ?? null,
  });
}

/** The rider's current turn at one delivery — the key the chat thread hangs off. */
export interface DriverAssignment {
  id: string;
  seq: number;
  status: string;
  offered_at: string;
  accepted_at: string | null;
}

/**
 * The open delivery_assignments row for this delivery, or null.
 *
 * Deliberately best-effort. A delivery in pending/dispatching has no live turn by design —
 * there is no rider to talk to — and a failed read must cost the rider their Chat button, not
 * the job they are carrying.
 */
async function getLiveAssignment(
  supabase: FavornomsClient,
  deliveryId: string,
): Promise<DriverAssignment | null> {
  const { data } = await supabase
    .from('delivery_assignments')
    .select('id, seq, status, offered_at, accepted_at')
    .eq('delivery_id', deliveryId)
    .is('ended_at', null)
    .maybeSingle();
  return (data ?? null) as unknown as DriverAssignment | null;
}

/**
 * Fetch driver's active delivery (any status that means "in flight").
 * Returns null when driver has nothing on their plate.
 *
 * Throws when the read itself failed. "No job" and "could not ask" used to be the same
 * `null`, so a dead spot or an expired JWT wiped the rider's live job off the screen as
 * convincingly as a completed drop-off. Callers are expected to keep what they already
 * have on a throw and let the next refetch settle it.
 */
export async function getActiveDelivery(
  supabase: FavornomsClient,
  driverId: string,
) {
  // The order is fetched via the SECURITY DEFINER RPC get_driver_order (curated,
  // non-financial columns only) — NOT a direct orders embed — so a driver can never
  // read orders.tip_amount / total and reverse-engineer the restaurant's tip cut.
  // net_tip / tip_visible_total live on the deliveries row (`*`) and are safe: net_tip
  // is the driver's own cut, tip_visible_total is null unless platform tips.mode=transparent.
  // Batched jobs: batch_seq orders the legs (1 delivers first), so the queue is
  // served seq1 → seq2; the other live leg rides along as `batch_mate`.
  const { data, error } = await supabase
    .from('deliveries')
    .select(`*, branch:branches(id, name, address, geo_location, geo_lat, geo_lng)`)
    .eq('driver_id', driverId)
    .in('status', ['assigned', 'picked_up', 'in_transit'])
    .order('batch_seq', { ascending: true, nullsFirst: false })
    .order('assigned_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { id: string; batch_id: string | null };
  const { data: order, error: orderError } = await supabase.rpc('get_driver_order', {
    p_delivery_id: row.id,
  });
  if (orderError) throw orderError;
  // Non-atomic gap: the delivery can be reassigned/expired between the select and
  // the RPC. A null order means it's no longer this driver's — treat as no active
  // delivery rather than dereferencing null downstream. The next realtime tick refetches.
  if (!order) return null;

  let batchMate: Record<string, unknown> | null = null;
  if (row.batch_id) {
    // Best-effort, unlike the two reads above: the mate is a preview of the *other* leg,
    // so losing it is worth a missing card, never worth throwing away the job the rider
    // is currently on.
    const { data: mate } = await supabase
      .from('deliveries')
      .select(`*, branch:branches(id, name, address, geo_location, geo_lat, geo_lng)`)
      .eq('batch_id', row.batch_id)
      .eq('driver_id', driverId)
      .neq('id', row.id)
      .in('status', ['assigned', 'picked_up', 'in_transit'])
      .maybeSingle();
    if (mate) {
      const { data: mateOrder } = await supabase.rpc('get_driver_order', {
        p_delivery_id: (mate as { id: string }).id,
      });
      if (mateOrder) {
        batchMate = {
          ...(mate as Record<string, unknown>),
          order: mateOrder,
          assignment: await getLiveAssignment(supabase, (mate as { id: string }).id),
        };
      }
    }
  }
  return {
    ...data,
    order,
    assignment: await getLiveAssignment(supabase, row.id),
    batch_mate: batchMate,
  };
}

/** Driver accepts the dispatch offer. Single round-trip RPC for atomicity. */
export async function acceptDispatch(
  supabase: FavornomsClient,
  deliveryId: string,
) {
  return supabase.rpc('accept_dispatch', { p_delivery_id: deliveryId });
}

/**
 * Driver rejects the dispatch. Clears driver_id, status reverts to
 * `dispatching`, increments driver.reject_streak. Single round-trip via
 * the `reject_dispatch` RPC for atomicity.
 */
export async function rejectDispatch(
  supabase: FavornomsClient,
  deliveryId: string,
  _driverId: string,
  reason: 'timeout' | 'declined' = 'declined',
) {
  void _driverId;
  return supabase.rpc('reject_dispatch', {
    p_delivery_id: deliveryId,
    p_reason: reason,
  });
}

/**
 * Driver cancels the delivery. Pre-pickup → released back to dispatch with a
 * 10-min driver cooldown; post-pickup → marked failed + staff alerted.
 */
export async function cancelDelivery(
  supabase: FavornomsClient,
  deliveryId: string,
  reason: string,
) {
  return supabase.rpc('driver_cancel_delivery', {
    p_delivery_id: deliveryId,
    p_reason: reason,
  } as never);
}

/** Driver can't complete the dropoff (customer unreachable, wrong address…). */
export async function failDelivery(
  supabase: FavornomsClient,
  deliveryId: string,
  reason: string,
  photoUrl?: string | null,
) {
  return supabase.rpc('fail_delivery', {
    p_delivery_id: deliveryId,
    p_reason: reason,
    p_photo_url: photoUrl ?? null,
  } as never);
}

// New RPCs (progress_delivery, mark_delivery_arriving) aren't in the generated
// Database types yet — call them through a thin typed escape hatch.
type UntypedRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

/**
 * Advance a delivery through its stages (driver taps "Picked up" / "Mark delivered").
 * Goes through the guarded `progress_delivery` RPC, which validates the state machine
 * server-side (assigned → picked_up → in_transit → delivered, no skips) and stamps the
 * picked_up_at / delivered_at timestamps. Replaces the old unguarded table UPDATE.
 */
export async function progressDelivery(
  supabase: FavornomsClient,
  deliveryId: string,
  toStatus: DeliveryStatus,
) {
  return (supabase as unknown as { rpc: UntypedRpc }).rpc('progress_delivery', {
    p_delivery_id: deliveryId,
    p_next: toStatus,
  });
}

/**
 * Persist the driver's "I've arrived at the customer" tap — sets arriving_at, which fans out
 * the customer "arriving now" push + map badge even when GPS geofencing didn't fire. Idempotent.
 */
export async function markDeliveryArriving(
  supabase: FavornomsClient,
  deliveryId: string,
) {
  return (supabase as unknown as { rpc: UntypedRpc }).rpc('mark_delivery_arriving', {
    p_delivery_id: deliveryId,
  });
}

// ---- Per-branch availability (D1 multi-homing) ----------------------------

/** Read the driver's per-branch online state. RLS restricts to their own rows. */
export async function getDriverBranchAvailability(
  supabase: FavornomsClient,
  driverId: string,
): Promise<BranchAvailability[]> {
  const { data } = await supabase
    .from('driver_branch_availability')
    .select('branch_id, is_online, mode')
    .eq('driver_id', driverId);
  return (data ?? []) as BranchAvailability[];
}

/** Toggle online/offline for ONE approved branch (guarded RPC — refuses under cooldown). */
export async function setDriverBranchOnline(
  supabase: FavornomsClient,
  branchId: string,
  online: boolean,
) {
  return supabase.rpc('driver_set_branch_online', {
    p_branch_id: branchId,
    p_online: online,
  });
}

/** Master toggle (the big Power button): online/offline for ALL approved branches. */
export async function setDriverAllBranchesOnline(
  supabase: FavornomsClient,
  online: boolean,
) {
  return supabase.rpc('driver_set_all_branches_online', { p_online: online });
}

// ---- Self-service schedules (auto-online windows) -------------------------
// The driver sets open/close windows per approved branch; the pg_cron job
// `apply_driver_schedules` flips driver_branch_availability(mode='scheduled')
// on at start_at and off at end_at. RLS `driver_schedules_driver_self` lets the
// driver read/write only their own rows, so these go straight to the table.

export interface DriverScheduleRow {
  id: string;
  branch_id: string;
  start_at: string;
  end_at: string;
  status: string;
  notes: string | null;
}

/** Upcoming windows for the driver (own rows via RLS); only those not yet ended. */
export async function getDriverSchedules(
  supabase: FavornomsClient,
  driverId: string,
): Promise<DriverScheduleRow[]> {
  const { data } = await supabase
    .from('driver_schedules')
    .select('id, branch_id, start_at, end_at, status, notes')
    .eq('driver_id', driverId)
    .gte('end_at', new Date().toISOString())
    .order('start_at', { ascending: true })
    .limit(200);
  return (data ?? []) as DriverScheduleRow[];
}

/** Insert one or more availability windows in a single call. */
export async function createDriverSchedules(
  supabase: FavornomsClient,
  rows: Array<{ driver_id: string; branch_id: string; start_at: string; end_at: string }>,
) {
  return supabase.from('driver_schedules').insert(rows);
}

/** Remove one upcoming window (RLS restricts deletes to the driver's own rows). */
export async function deleteDriverSchedule(supabase: FavornomsClient, id: string) {
  return supabase.from('driver_schedules').delete().eq('id', id);
}

// ---- Coverage map (rider vs. applied-restaurant dispatch radius) ----------
// Dispatch (find_dispatch_candidates, via dispatch-driver) only offers a branch's
// work to drivers within `settings.driver_search_radius_km` of the branch (default
// 3 miles). The rider coverage map draws the SAME radius so a rider can see whether
// they've drifted out of range.

// 3 miles in km — matches dispatch-driver's default when the setting is unset.
const DEFAULT_DISPATCH_RADIUS_KM = 3 * 1.609344;

export interface BranchLocation {
  branch_id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  dispatchRadiusKm: number;
}

/** Location + dispatch radius for a set of branches (the driver's approved ones). */
export async function getBranchLocations(
  supabase: FavornomsClient,
  branchIds: string[],
): Promise<BranchLocation[]> {
  if (branchIds.length === 0) return [];
  const { data } = await supabase
    .from('branches')
    .select('id, name, geo_lat, geo_lng, settings')
    .in('id', branchIds);
  return (data ?? []).map((b) => {
    const s = (b.settings ?? {}) as Record<string, unknown>;
    const r = Number(s.driver_search_radius_km);
    return {
      branch_id: b.id,
      name: b.name,
      lat: b.geo_lat ?? null,
      lng: b.geo_lng ?? null,
      dispatchRadiusKm: Number.isFinite(r) && r > 0 ? r : DEFAULT_DISPATCH_RADIUS_KM,
    };
  });
}

// ---- Restaurant applications (driver_approvals) ---------------------------
// A rider's application to one branch. The row is created by the rider, decided by the
// merchant (apps/admin .../drivers), and read back by the rider on /app/apply.

/** Create a pending application. UNIQUE (driver_id, branch_id) makes a repeat a duplicate. */
export async function applyToBranch(
  supabase: FavornomsClient,
  driverId: string,
  branchId: string,
) {
  // applied_at is deliberately not sent: the column defaults to now(), and the merchant's
  // queue orders by it — an audit timestamp must not come from an unsynced phone clock.
  return supabase
    .from('driver_approvals')
    .insert({ driver_id: driverId, branch_id: branchId, status: 'pending' })
    .select('id');
}

/**
 * Withdraw a still-pending application. The `driver_approvals_driver_withdraw` policy
 * restricts the delete to the rider's own PENDING rows, so a row the merchant has just
 * decided matches zero rows rather than erroring — hence `.select('id')`, the same shape
 * the admin's approve-button uses to tell "saved" from "RLS matched nothing".
 */
export async function withdrawDriverApplication(supabase: FavornomsClient, approvalId: string) {
  return supabase.from('driver_approvals').delete().eq('id', approvalId).select('id');
}

/**
 * Apply again after a rejection. A guarded RPC rather than an update: UNIQUE
 * (driver_id, branch_id) means the rejected row is in the way of a second insert, and an
 * RLS update policy could pin the new status but not stop the same statement rewriting
 * `notes` — a rider could erase the reason they were turned down. Raises `no_application`,
 * `not_rejected` or `reapply_too_soon`.
 */
export async function reapplyToBranch(supabase: FavornomsClient, branchId: string) {
  return (supabase as unknown as { rpc: UntypedRpc }).rpc('driver_reapply_to_branch', {
    p_branch_id: branchId,
  });
}

// ---- Earnings, per restaurant ---------------------------------------------
// A rider is approved branch by branch and paid branch by branch: request_driver_withdrawal
// tags only the accrued, untagged driver_earnings_ledger rows of the branch it is given and
// pays the sum of exactly those. Every rider screen that shows money therefore has to name
// the restaurant beside it, which is what the shared branch embed below is for. Fold the rows
// with summariseDriverEarnings from @favornoms/shared.

/**
 * The branch name is the shop ("Hamburger"); the restaurant name is the brand the rider
 * applied to ("Coastal Grill"). Screens lead with the brand, so both travel together.
 */
const EARNINGS_BRANCH_EMBED = 'branch:branches(name, restaurant:restaurants(name))';

export interface DriverLedgerRow extends DriverLedgerEntry {
  id: string;
  delivered_at: string;
}

export interface DriverWithdrawalRow {
  id: string;
  branch_id: string;
  amount: number;
  status: string;
  bank_name: string;
  account_number: string;
  account_name: string;
  rejection_reason: string | null;
  receipt_number: string | null;
  paid_at: string | null;
  created_at: string;
  branch: EarningsBranchRef | null;
}

/**
 * The rider's settlement ledger — the source of truth for what each restaurant owes and has
 * paid. `withdrawal_id` is selected because it is the difference between money a rider can
 * still request and money already sitting inside an open request.
 *
 * Throws when the read fails: an empty array would tell a rider they have earned nothing,
 * which is the one answer a dead spot must never be allowed to give.
 */
export async function listDriverEarnings(
  supabase: FavornomsClient,
  driverId: string,
  opts: { since?: string; limit?: number } = {},
): Promise<DriverLedgerRow[]> {
  let query = supabase
    .from('driver_earnings_ledger')
    .select(
      `id, delivered_at, branch_id, base_pay, distance_pay, tip_net, total, status, withdrawal_id, ${EARNINGS_BRANCH_EMBED}`,
    )
    .eq('driver_id', driverId)
    .order('delivered_at', { ascending: false });
  if (opts.since) query = query.gte('delivered_at', opts.since);
  if (opts.limit) query = query.limit(opts.limit);

  const { data, error } = await query;
  if (error) throw new Error('driver_earnings_read_failed:' + error.message);
  return (data ?? []) as unknown as DriverLedgerRow[];
}

/**
 * One row per job the rider has HELD — delivered, cancelled, failed, declined or expired —
 * with the reason it ended.
 *
 * Not the ledger. driver_earnings_ledger only ever gets a row on a successful drop-off
 * (accrue_driver_earnings returns early for every other status), which is why the History
 * screen could only say "no completed deliveries" about a cancelled job. Not `deliveries`
 * either: deliveries_driver_assigned scopes a rider to `driver_id = private.driver_id_for_user()`
 * and every cancel path moves driver_id away, so the row a rider wants to look back at is
 * exactly the one they may no longer read. delivery_assignments keeps driver_id for ever.
 *
 * Throws when the read fails, for the same reason listDriverEarnings does.
 */
export interface DriverJobHistoryRow {
  assignment_id: string;
  delivery_id: string;
  order_number: string;
  branch_id: string;
  branch_name: string;
  restaurant_name: string | null;
  status: string;
  end_kind: string | null;
  end_reason: string | null;
  offered_at: string;
  accepted_at: string | null;
  ended_at: string | null;
  /** driver_earnings_ledger.total for the delivered ones; null for every job that paid nothing. */
  earned: number | string | null;
  ledger_status: string | null;
}

export async function listDriverJobHistory(
  supabase: FavornomsClient,
  opts: { since?: string; limit?: number } = {},
): Promise<DriverJobHistoryRow[]> {
  const { data, error } = await supabase.rpc('driver_job_history', {
    p_since: opts.since ?? null,
    p_limit: opts.limit ?? 100,
  } as never);
  if (error) throw new Error('driver_job_history_read_failed:' + error.message);
  return (data ?? []) as unknown as DriverJobHistoryRow[];
}

/** The rider's withdrawal requests, newest first. One request settles one restaurant. */
export async function listDriverWithdrawals(
  supabase: FavornomsClient,
  driverId: string,
  limit = 20,
): Promise<DriverWithdrawalRow[]> {
  const { data, error } = await supabase
    .from('driver_withdrawals')
    .select(
      `id, branch_id, amount, status, bank_name, account_number, account_name, rejection_reason, receipt_number, paid_at, created_at, ${EARNINGS_BRANCH_EMBED}`,
    )
    .eq('driver_id', driverId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error('driver_withdrawals_read_failed:' + error.message);
  return (data ?? []) as unknown as DriverWithdrawalRow[];
}

/** One request, for the receipt. RLS already scopes to the rider; the filter is belt-and-braces. */
export async function getDriverWithdrawal(
  supabase: FavornomsClient,
  driverId: string,
  withdrawalId: string,
): Promise<DriverWithdrawalRow | null> {
  const { data, error } = await supabase
    .from('driver_withdrawals')
    .select(
      `id, branch_id, amount, status, bank_name, account_number, account_name, rejection_reason, receipt_number, paid_at, created_at, ${EARNINGS_BRANCH_EMBED}`,
    )
    .eq('id', withdrawalId)
    .eq('driver_id', driverId)
    .maybeSingle();
  if (error) throw new Error('driver_withdrawal_read_failed:' + error.message);
  return (data ?? null) as unknown as DriverWithdrawalRow | null;
}

/**
 * Open a withdrawal request against ONE restaurant. The RPC re-derives the amount server-side
 * from that branch's accrued, untagged rows, so what the rider is shown before tapping is a
 * preview of the same sum and never becomes the amount itself. Raises `bank_details_required`,
 * `withdrawal_already_pending` (one open request per restaurant) or `nothing_to_withdraw`.
 */
export async function requestDriverWithdrawal(
  supabase: FavornomsClient,
  branchId: string,
  bank: { bankName: string; accountNumber: string; accountName: string },
) {
  return supabase.rpc('request_driver_withdrawal', {
    p_branch_id: branchId,
    p_bank_name: bank.bankName,
    p_account_number: bank.accountNumber,
    p_account_name: bank.accountName,
  });
}
