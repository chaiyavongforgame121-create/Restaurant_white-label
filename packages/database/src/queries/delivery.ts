import type { FavornomsClient } from '../client-type';
import type { Database } from '../types';

type DeliveryStatus = Database['public']['Enums']['delivery_status'];
type OrderStatus = Database['public']['Enums']['order_status'];

// Delivery quoting. The quote_delivery RPC is server-authoritative: the same
// formula runs inside place-order, so what the customer sees at checkout is
// exactly what the order records.

export type DeliveryQuote =
  | {
      deliverable: true;
      distance_km: number;
      fee: number;
      eta_min: number;
      surge: number;
    }
  | {
      deliverable: false;
      // 'delivery_not_entitled' is returned when the branch has no delivery add-on. It was
      // missing here, so checkout treated it like "no coordinates yet", quoted the legacy
      // flat fee, and place-order then 403'd at submit — the diner saw a price for something
      // that was never for sale.
      reason:
        | 'invalid_coordinates'
        | 'branch_unavailable'
        | 'delivery_not_entitled'
        | 'out_of_range';
      distance_km?: number;
      radius_km?: number;
    };

export async function quoteDelivery(
  supabase: FavornomsClient,
  branchId: string,
  lat: number,
  lng: number,
): Promise<DeliveryQuote | null> {
  const { data, error } = await supabase.rpc('quote_delivery', {
    p_branch_id: branchId,
    p_lat: lat,
    p_lng: lng,
  } as never);
  if (error || data == null) return null;
  return data as unknown as DeliveryQuote;
}

// ---------------------------------------------------------------------------------------
// Live deliveries board (admin). Two reads: the branch's in-flight deliveries with the
// order and rider embedded, and the riders approved for the branch with their last known
// position. The second one is an RPC because drivers.current_location is a PostGIS
// geography (PostgREST hands it back as WKB hex) and drivers is not in the realtime
// publication, so the board polls it rather than subscribing.

export type LiveDeliveryStatus = Extract<
  DeliveryStatus,
  'pending' | 'dispatching' | 'assigned' | 'picked_up' | 'in_transit' | 'failed'
>;

/** Delivery rows the board shows: everything not yet delivered or cancelled. */
export const LIVE_DELIVERY_STATUSES: readonly LiveDeliveryStatus[] = [
  'pending',
  'dispatching',
  'assigned',
  'picked_up',
  'in_transit',
  'failed',
];

/**
 * Order statuses a live delivery can legitimately belong to. cancel_order and the refund
 * path only touched orders, so a delivery could sit at `dispatching` for ever under an
 * order cancelled weeks ago. Joining through the order and filtering here hides those even
 * before the orders→deliveries sync trigger has been applied.
 */
export const LIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
];

export interface LiveDeliveryOrder {
  id: string;
  order_number: string;
  status: OrderStatus;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: { line1?: string; line2?: string; city?: string; notes?: string } | null;
}

export interface LiveDeliveryRider {
  id: string;
  full_name: string;
  phone: string | null;
  vehicle_type: string;
}

export interface LiveDelivery {
  id: string;
  status: LiveDeliveryStatus;
  driver_id: string | null;
  driver_lat: number | null;
  driver_lng: number | null;
  driver_location_updated_at: string | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  current_eta_min: number | null;
  estimated_duration_min: number | null;
  arriving_at: string | null;
  offered_at: string | null;
  offer_expires_at: string | null;
  accepted_at: string | null;
  picked_up_at: string | null;
  created_at: string;
  failed_reason: string | null;
  dispatch_attempts: number;
  order: LiveDeliveryOrder | null;
  driver: LiveDeliveryRider | null;
}

// The embed is named `orders`, never aliased to `order`: PostgREST reads `order=` as the
// ordering parameter, and an embedded filter (`orders.status`) needs the resource name.
// `!inner` is what makes that filter prune parent rows instead of nulling the embed.
const LIVE_DELIVERY_SELECT =
  'id, status, driver_id, driver_lat, driver_lng, driver_location_updated_at, dropoff_lat, dropoff_lng, ' +
  'current_eta_min, estimated_duration_min, arriving_at, offered_at, offer_expires_at, accepted_at, ' +
  'picked_up_at, created_at, failed_reason, dispatch_attempts, ' +
  'orders!inner(id, order_number, status, customer_name, customer_phone, delivery_address), ' +
  'driver:drivers(id, full_name, phone, vehicle_type)';

type RawLiveDelivery = Omit<LiveDelivery, 'order' | 'driver'> & {
  orders: LiveDeliveryOrder | LiveDeliveryOrder[] | null;
  driver: LiveDeliveryRider | LiveDeliveryRider[] | null;
};

function firstOf<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** PostgREST returns a to-one embed as an object, older shapes as a one-element array. */
export function normalizeLiveDelivery(raw: RawLiveDelivery): LiveDelivery {
  const { orders, driver, ...rest } = raw;
  return {
    ...rest,
    dispatch_attempts: Number(rest.dispatch_attempts ?? 0),
    order: firstOf(orders),
    driver: firstOf(driver),
  };
}

/**
 * Every in-flight delivery of one branch, oldest first, so the row that has waited longest
 * is the one at the top. Throws when the read fails: "nothing in flight" and "could not
 * ask" must not look the same on a screen whose whole job is to say what is happening.
 */
export async function listLiveDeliveries(
  supabase: FavornomsClient,
  branchId: string,
): Promise<LiveDelivery[]> {
  const { data, error } = await supabase
    .from('deliveries')
    .select(LIVE_DELIVERY_SELECT)
    .eq('branch_id', branchId)
    .in('status', [...LIVE_DELIVERY_STATUSES])
    .in('orders.status', [...LIVE_ORDER_STATUSES])
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw new Error(`live_deliveries_read_failed: ${error.message}`);
  return ((data ?? []) as unknown as RawLiveDelivery[]).map(normalizeLiveDelivery);
}

/** One row per rider approved for the branch, from public.list_branch_riders. */
export interface BranchRider {
  driver_id: string;
  full_name: string;
  phone: string | null;
  vehicle_type: string;
  /** driver_branch_availability.is_online for THIS branch — sticky until the rider toggles. */
  online: boolean;
  kyc_verified: boolean;
  cooling_down: boolean;
  lat: number | null;
  lng: number | null;
  location_updated_at: string | null;
  battery_level: number | null;
  /** The delivery this rider currently holds (assigned/picked_up/in_transit), if any. */
  active_delivery_id: string | null;
}

/**
 * Riders approved for a branch with their last GPS fix, per-branch online flag and current
 * job. Guarded server-side by delivery.manage. Throws on failure for the same reason as
 * listLiveDeliveries.
 */
export async function listBranchRiders(
  supabase: FavornomsClient,
  branchId: string,
): Promise<BranchRider[]> {
  const { data, error } = await supabase.rpc('list_branch_riders', {
    p_branch_id: branchId,
  } as never);
  if (error) throw new Error(`branch_riders_read_failed: ${error.message}`);
  return ((data ?? []) as unknown as BranchRider[]).map((r) => ({
    ...r,
    lat: r.lat == null ? null : Number(r.lat),
    lng: r.lng == null ? null : Number(r.lng),
    battery_level: r.battery_level == null ? null : Number(r.battery_level),
  }));
}
