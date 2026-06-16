import type { FavornomsClient } from '../client-type';
import type { Database } from '../types';

export type DriverRow = Database['public']['Tables']['drivers']['Row'];
export type DeliveryRow = Database['public']['Tables']['deliveries']['Row'];
export type DeliveryStatus = Database['public']['Enums']['delivery_status'];
export type DriverApprovalStatus = Database['public']['Enums']['driver_approval_status'];

export interface DriverWithApproval extends DriverRow {
  approvals: { status: DriverApprovalStatus; branch_id: string }[];
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
      `*, approvals:driver_approvals(status, branch_id)`,
    )
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) return null;
  return data as unknown as DriverWithApproval;
}

/** Update is_online flag. Call when driver toggles power button. */
export async function setDriverOnline(
  supabase: FavornomsClient,
  driverId: string,
  isOnline: boolean,
) {
  return supabase
    .from('drivers')
    .update({ is_online: isOnline, location_updated_at: new Date().toISOString() })
    .eq('id', driverId);
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
  const { data } = await supabase
    .from('deliveries')
    .select(
      `*, order:orders(id, order_number, customer_name, customer_phone,
        delivery_address, customer_notes, subtotal, total,
        order_items(id, item_name, quantity, unit_price)),
       branch:branches(id, name, address, geo_location, geo_lat, geo_lng)`,
    )
    .eq('driver_id', driverId)
    .in('status', ['assigned', 'picked_up', 'in_transit'])
    .order('assigned_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
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
