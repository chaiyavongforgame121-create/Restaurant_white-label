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

/** deliveries.dispatch_state — see LiveDelivery.dispatch_state. */
export type DeliveryDispatchState = 'searching' | 'waiting' | 'no_rider_found';

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
  /**
   * Where the server's dispatch round stands (docs/DISPATCH-FIXES-2026-10-05.md D2/D7):
   * `searching` while riders are being offered it one by one, `waiting` once every eligible
   * rider has been asked and the sweep is waiting for a new one, `no_rider_found` when the
   * search window ran out. Null outside a round. The boards print this instead of guessing
   * from a clock, which is how "No rider found" used to appear while nothing was running.
   * Optional because rows built by hand (tests, realtime payloads) may not carry it.
   */
  dispatch_state?: DeliveryDispatchState | null;
  /** When the current round started: the ready trigger, or a staff "Find rider again". */
  dispatch_round_started_at?: string | null;
  /** The per-offer log (offered / rejected / offer_expired / withdrawn / waiting / no_rider_found). */
  dispatch_history?: unknown;
  /** Set on both stops of a stacked offer (one rider, two orders). */
  batch_id?: string | null;
  batch_seq?: number | null;
  order: LiveDeliveryOrder | null;
  driver: LiveDeliveryRider | null;
}

// The embed is named `orders`, never aliased to `order`: PostgREST reads `order=` as the
// ordering parameter, and an embedded filter (`orders.status`) needs the resource name.
// `!inner` is what makes that filter prune parent rows instead of nulling the embed.
const LIVE_DELIVERY_SELECT =
  'id, status, driver_id, driver_lat, driver_lng, driver_location_updated_at, dropoff_lat, dropoff_lng, ' +
  'current_eta_min, estimated_duration_min, arriving_at, offered_at, offer_expires_at, accepted_at, ' +
  'picked_up_at, created_at, failed_reason, dispatch_attempts, dispatch_state, dispatch_round_started_at, ' +
  'dispatch_history, batch_id, batch_seq, ' +
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
    dispatch_state: rest.dispatch_state ?? null,
    dispatch_round_started_at: rest.dispatch_round_started_at ?? null,
    dispatch_history: rest.dispatch_history ?? null,
    batch_id: rest.batch_id ?? null,
    batch_seq: rest.batch_seq == null ? null : Number(rest.batch_seq),
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
  /**
   * drivers.cooldown_until: set by the strike rule (2 missed or declined offers in 24 h), or for
   * 10 minutes when a rider cancels a job they had accepted, and lifted early only by
   * lift_driver_cooldown. The cooldown is the rider's, not the branch's, so
   * it stops offers at every branch they ride for. Null when not cooling down, and on a database
   * whose list_branch_riders predates the column.
   */
  cooldown_until: string | null;
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
    cooldown_until: r.cooldown_until ?? null,
    lat: r.lat == null ? null : Number(r.lat),
    lng: r.lng == null ? null : Number(r.lng),
    battery_level: r.battery_level == null ? null : Number(r.battery_level),
  }));
}

// ---------------------------------------------------------------------------------------
// Staff dispatch. The kitchen board and Live deliveries ask the dispatch-driver edge function
// (a thin authenticated wrapper over public.staff_dispatch_delivery) for a rider. Both read
// the answer the same way, so the call lives here once.

/** What dispatch-driver answered: its HTTP status and JSON body, exactly as sent. */
export interface DispatchDriverReply {
  /** Null when no answer came back at all (offline, the request was cut off). */
  status: number | null;
  /** The parsed JSON body, or null when there was none or it was not JSON. */
  body: unknown;
}

/**
 * Ask the server for a rider for one delivery. `restart: false` continues the current round
 * (or starts one when none is running); `restart: true` is "Find rider again": a new round in
 * which every rider may be asked again, refused with 409 already_accepted once a rider has
 * accepted (docs/DISPATCH-FIXES-2026-10-05.md D6). Never throws: supabase-js hides a non-2xx
 * body behind error.context, and that body (why no rider was found) is the whole point.
 */
export async function invokeDispatchDriver(
  supabase: FavornomsClient,
  target: { deliveryId: string } | { orderId: string },
  restart = false,
): Promise<DispatchDriverReply> {
  const base = 'deliveryId' in target ? { delivery_id: target.deliveryId } : { order_id: target.orderId };
  try {
    const result = await supabase.functions.invoke('dispatch-driver', {
      body: restart ? { ...base, reset: true } : base,
    });
    const { data, error } = result;
    // 200 is an offer, 202 a round still waiting for a free rider: both arrive as success.
    if (!error) {
      const res = (result as { response?: Response }).response;
      return { status: typeof res?.status === 'number' ? res.status : 200, body: data ?? null };
    }
    const ctx = (error as unknown as { context?: unknown }).context;
    if (ctx && typeof (ctx as Response).json === 'function') {
      const res = ctx as Response;
      const body = await res.json().catch(() => null);
      return { status: typeof res.status === 'number' ? res.status : null, body };
    }
    return { status: null, body: null };
  } catch {
    return { status: null, body: null };
  }
}

// ---------------------------------------------------------------------------------------
// Rider cooldown. Two missed or declined offers in 24 hours, or cancelling a job already accepted,
// put a rider on a cooldown (drivers.cooldown_until) that stops every offer at every branch they
// ride for. The column does not say which, so no screen may name the cause. Staff can
// lift it early through public.lift_driver_cooldown (D8): a platform admin, or a manager with
// drivers.manage at EVERY branch where the rider is not rejected — the same rule as KYC,
// because the cooldown is one value for all of them.

/** Why a lift did not happen, as a key under drivers.cooldown. */
export type LiftCooldownFailure = 'alreadyOver' | 'forbidden' | 'sharedForbidden' | 'failed';

export type LiftCooldownOutcome =
  | { ok: true; /** The cooldown end that was cleared. */ wasUntil: string }
  | { ok: false; reason: LiftCooldownFailure; /** The database's words, for the log only. */ message?: string };

/**
 * The exception lift_driver_cooldown raised, as the rule it stands for. The shared case is
 * tested first: its message ('forbidden: cooldown_shared_with_other_branch') contains
 * 'forbidden' too. Anything unrecognised (a dropped connection, a missing function before the
 * migration ran) is 'failed', and the caller logs the raw message.
 */
export function liftCooldownFailure(message: string): Exclude<LiftCooldownFailure, 'alreadyOver'> {
  if (/shared_with_other_branch/i.test(message)) return 'sharedForbidden';
  if (/\bforbidden\b/i.test(message)) return 'forbidden';
  return 'failed';
}

/**
 * Lift one rider's cooldown. The function returns the cleared end time, or null when there was
 * nothing to lift (it ended on its own, or someone else lifted it first) — which is not an
 * error, but the merchant should be told rather than shown a success for nothing.
 */
export async function liftDriverCooldown(
  supabase: FavornomsClient,
  driverId: string,
  branchId: string,
  note?: string | null,
): Promise<LiftCooldownOutcome> {
  const trimmed = note?.trim() ?? '';
  const { data, error } = await supabase.rpc('lift_driver_cooldown', {
    p_driver_id: driverId,
    p_branch_id: branchId,
    p_note: trimmed === '' ? null : trimmed,
  } as never);
  if (error) return { ok: false, reason: liftCooldownFailure(error.message), message: error.message };
  if (data == null) return { ok: false, reason: 'alreadyOver' };
  return { ok: true, wasUntil: String(data) };
}
