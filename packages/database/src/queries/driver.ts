import type { FavornomsClient } from '../client-type';
import type { Database } from '../types';

export type DriverRow = Database['public']['Tables']['drivers']['Row'];
export type DeliveryRow = Database['public']['Tables']['deliveries']['Row'];
export type DeliveryStatus = Database['public']['Enums']['delivery_status'];
export type DriverApprovalStatus = Database['public']['Enums']['driver_approval_status'];

export interface DriverApproval {
  status: DriverApprovalStatus;
  branch_id: string;
  branch: { id: string; name: string } | null;
}

export interface DriverWithApproval extends DriverRow {
  approvals: DriverApproval[];
}

export interface BranchAvailability {
  branch_id: string;
  is_online: boolean;
  mode: 'manual' | 'scheduled';
}

/** Fetch the drivers row that belongs to the currently-signed-in user. */
export async function getMyDriver(
  supabase: FavornomsClient,
): Promise<DriverWithApproval | null> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase
    .from('drivers')
    .select(
      `*, approvals:driver_approvals(status, branch_id, branch:branches(id, name))`,
    )
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) return null;
  return data as unknown as DriverWithApproval;
}

/**
 * Push the driver's current GPS position. We use PostGIS POINT via the
 * `ST_SetSRID(ST_MakePoint(lng, lat), 4326)` RPC, but to keep clients simple
 * we cast through a small RPC `set_driver_location(driver_id, lng, lat)` —
 * see migration 20260526000005_driver_location_rpc.sql.
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
  const { data } = await supabase
    .from('deliveries')
    .select(`*, branch:branches(id, name, address, geo_location, geo_lat, geo_lng)`)
    .eq('driver_id', driverId)
    .in('status', ['assigned', 'picked_up', 'in_transit'])
    .order('batch_seq', { ascending: true, nullsFirst: false })
    .order('assigned_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const row = data as { id: string; batch_id: string | null };
  const { data: order } = await supabase.rpc('get_driver_order', {
    p_delivery_id: row.id,
  });
  // Non-atomic gap: the delivery can be reassigned/expired between the select and
  // the RPC. A null order means it's no longer this driver's — treat as no active
  // delivery rather than dereferencing null downstream. The next realtime tick refetches.
  if (!order) return null;

  let batchMate: Record<string, unknown> | null = null;
  if (row.batch_id) {
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
