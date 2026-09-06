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
      if (mateOrder) batchMate = { ...(mate as Record<string, unknown>), order: mateOrder };
    }
  }
  return { ...data, order, batch_mate: batchMate };
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
