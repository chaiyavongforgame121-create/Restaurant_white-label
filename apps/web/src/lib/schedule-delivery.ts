import type { StorefrontStatus } from '@favornoms/database/queries';
import { asapDeliveryEnabled } from '@favornoms/shared';
import { buildScheduleDays, type ClosurePeriod, type OpeningWindow } from './schedule-slots';

/**
 * Customers order Pickup (prepared now) or Delivery, and a delivery is either ASAP or booked for
 * a day and time (docs/ASAP-AND-SCHEDULING-2026-10-25.md §1). This decides, on the server and
 * before the order-type gate or the menu picker shows anything, which of the two deliveries can
 * be offered. Delivery is offered when EITHER is possible, and disappears only when neither is.
 *
 * The two are judged separately because they fail separately. Gating all of delivery on
 * `status.delivery` (open THIS minute) once hid it outside delivery hours from exactly the diners
 * booking ahead (Brooklyn, with one Sunday window, showed no delivery six days a week); gating it
 * all on advance orders made "Accept scheduled orders" switch delivery off entirely.
 *
 * Delivery keeps its own hours (owner's report, 2026-11-16). With "Limit delivery to set hours"
 * on, the delivery windows decide on their own and may lie before opening or after closing: a
 * shop open 09:00-17:30 that delivers 08:00-09:00 and 18:00-19:00 takes deliveries then, and
 * not at noon. Off, delivery follows opening hours exactly as pickup does. The server judges both
 * with public.is_branch_open_for(branch, 'delivery', at); pickup stays on is_branch_open().
 *
 * ASAP (canDeliverNow) needs, as place-order and the orders triggers judge "now":
 * - the branch to take ASAP deliveries at all ("Accept ASAP delivery orders",
 *   settings.asap_delivery_enabled, on only when exactly true — asapDeliveryEnabled). Read here
 *   from the row on every request, never from the tenant cached for 300 s: a merchant who unticks
 *   it must not have diners sent to a box place-order now refuses;
 * - delivery open this minute (status.delivery_open_now: the branch delivers, is active, not
 *   paused, no closure, and inside delivery's own hours as above). Not is_branch_open(): a branch
 *   closed for pickup may be delivering. A database that predates the key falls back to the old
 *   reading, status.delivery (delivers, inside its delivery windows) AND is_branch_open().
 * Whether a payment method is switched on for "now" orders is the checkout's to add — it is in
 * the branch's settings, which only the checkout reads.
 *
 * A booking (canScheduleDelivery) needs, because each one otherwise sends the diner through the
 * whole checkout to a refusal:
 * - a branch that delivers at all and takes advance orders;
 * - orders not paused — the server refuses every time while paused, booked times included, so
 *   "you can still schedule a delivery" would be a promise every slot breaks;
 * - at least one bookable slot, from the same builder and the same inputs the checkout picker
 *   uses (delivery's own hours as above, booking windows, closures, lead time, horizon). Delivery
 *   hours switched on with no windows, or windows that never overlap the booking windows, leave
 *   nothing to book.
 */
export interface ScheduleDeliveryState {
  /** Delivery can be offered at all: ASAP or booked (canDeliverNow || canScheduleDelivery). */
  canDeliver: boolean;
  /** An ASAP delivery can be placed right now (before the checkout's payment-method check). */
  canDeliverNow: boolean;
  /** A delivery can be booked for a later slot. */
  canScheduleDelivery: boolean;
  /**
   * is_branch_open() right now: open for pickup. A failed read counts as open, like every other
   * caller of it on the storefront: it must not block ordering, and place-order still refuses at a
   * closed branch. It is NOT whether delivery is open (deliveryOpenNow): with delivery hours on, a
   * branch closed here may be delivering, and one open here may not be.
   */
  openNow: boolean;
  /**
   * Delivery is open this minute as far as hours go (status.delivery_open_now, or its fallback
   * on an older database): the half of canDeliverNow that is not "Accept ASAP delivery orders".
   * The checkout re-judges ASAP from it with the payment methods only it reads.
   */
  deliveryOpenNow: boolean;
  /** The kitchen paused orders (branches.settings.orders_paused). Nothing can be ordered. */
  paused: boolean;
  /**
   * This branch delivers at all (storefront_status.delivery_entitled).
   *
   * Delivery is in the plan but switched per branch (docs/PACKAGING-2026-10-24.md §3), so
   * `false` here is "this branch does not deliver" — a standing fact about the branch, not
   * "delivery is closed right now". The two must never share a sentence: a diner told the wrong one
   * comes back tomorrow for a delivery that will never be offered, or gives up on a branch
   * that would have delivered in an hour.
   *
   * A status that could not be read at all (`known: false`) reports `true` here: it is not
   * evidence of anything, and the temporary sentence is the safe one to be wrong about. It
   * never widens what is on sale — `canDeliver` is the only thing that does that.
   *
   * A branch that delivers but has unticked BOTH "Accept ASAP delivery orders" and "Accept
   * scheduled orders" also reports `false`: that is the merchant's standing choice, not a
   * closed hour. An unreadable settings row is not that choice, so it does not.
   */
  offered: boolean;
  /**
   * The branch takes ASAP deliveries at all ("Accept ASAP delivery orders",
   * settings.asap_delivery_enabled). Off, the checkout does not show the "As soon as possible"
   * box — hidden, not disabled with a reason — and every delivery is booked; place-order refuses
   * an unbooked web delivery with delivery_must_be_scheduled. A settings row that could not be
   * read counts as off: nothing is offered that cannot be proven.
   */
  asapOffered: boolean;
}

/** Read the way is_branch_open() reads it: `(settings->>'orders_paused')::boolean`. */
export function ordersPaused(settings: Record<string, unknown> | null | undefined): boolean {
  const v = settings?.orders_paused;
  if (v === true) return true;
  if (typeof v !== 'string') return false;
  return ['true', 't', 'yes', 'y', 'on', '1'].includes(v.trim().toLowerCase());
}

type StorefrontReads = {
  from: (table: 'branches') => {
    select: (columns: 'settings') => {
      eq: (column: 'id', value: string) => {
        maybeSingle: () => PromiseLike<{ data: { settings: unknown } | null }>;
      };
    };
  };
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown }>;
};

export async function resolveScheduleDelivery(
  supabase: unknown,
  branchId: string,
  status: StorefrontStatus,
  now: Date = new Date(),
): Promise<ScheduleDeliveryState> {
  const client = supabase as StorefrontReads;
  const [{ data: branchRow }, { data: policy }, { data: open }] = await Promise.all([
    client.from('branches').select('settings').eq('id', branchId).maybeSingle(),
    client.rpc('branch_schedule_policy', { p_branch_id: branchId }),
    client.rpc('is_branch_open', { p_branch_id: branchId }),
  ]);
  const settings = branchRow?.settings ?? null;
  const paused = ordersPaused(settings as Record<string, unknown> | null);
  const asapOffered = asapDeliveryEnabled(settings);
  const openNow = open !== false;
  // storefront_status is keyed by branch, so delivery_entitled is this branch's answer —
  // when there IS an answer. getStorefrontStatus returns STOREFRONT_UNKNOWN after two failed
  // RPC attempts, and that constant sets delivery_entitled:false on purpose (it must not
  // offer a delivery it cannot prove). Reading that `false` as a fact told the diners of a
  // branch that does deliver "Delivery is not offered at this branch" every time the database
  // was cold — the permanent sentence, over a transient failure, on a branch of a paying
  // tenant. `known` is the one field that distinguishes the two, so an unknown status falls
  // back to the softer "cannot be booked right now" — which is exactly what the callers'
  // `deliveryOffered = true` defaults were already written to do.
  //
  // This only changes the WORDS: canDeliver is false either way, because STOREFRONT_UNKNOWN
  // also carries delivery:false, delivery_open_now:false and scheduling_enabled:false.
  //
  // Both switches unticked ("Accept ASAP delivery orders" and "Accept scheduled orders") is the
  // same standing fact as an unsold branch — no delivery is ever taken here online — so it gets
  // the permanent sentence too. A settings row that could not be read (branchRow null) reads as
  // ASAP off only to stay closed; it is not the merchant's choice, so it keeps the softer one.
  // Words only again: with both off, canDeliver is false whatever `offered` says.
  const takesDelivery = asapOffered || status.scheduling_enabled === true || branchRow == null;
  const offered = status.known === false || (status.delivery_entitled === true && takesDelivery);
  // delivery_open_now is the server's own judge of delivery "now" (is_branch_open_for), which is
  // the only reading that lets delivery hours outside opening hours sell. Without the key, the old
  // reading: inside the delivery windows AND open for pickup, which is the same answer for every
  // branch with delivery hours off. The explicit checks keep a paused or unsold branch out even if
  // either field were ever widened.
  const deliveryOpenNow =
    typeof status.delivery_open_now === 'boolean'
      ? status.delivery_open_now
      : status.delivery === true && openNow;
  const canDeliverNow = asapOffered && !paused && offered && deliveryOpenNow;
  const result = (canScheduleDelivery: boolean): ScheduleDeliveryState => ({
    canDeliver: canDeliverNow || canScheduleDelivery,
    canDeliverNow,
    canScheduleDelivery,
    openNow,
    deliveryOpenNow,
    paused,
    offered,
    asapOffered,
  });
  // Scheduling off ("Accept scheduled orders" unticked) takes away bookings only — ASAP stays
  // where it is ticked.
  if (paused || !offered || !status.scheduling_enabled) return result(false);
  // Same parsing as the checkout picker: a failed policy read means delivery's own hours alone
  // decide, and `windows: null` (never armed) is not the same statement as an empty list.
  // deliveryWindows only while delivery hours are on: null is "follow opening hours".
  const d = (policy ?? {}) as Record<string, unknown>;
  const days = buildScheduleDays({
    timezone: status.timezone,
    openingHours: status.opening_hours,
    scheduleWindows:
      d.schedule_hours_enabled === true && Array.isArray(d.schedule_windows)
        ? (d.schedule_windows as OpeningWindow[])
        : null,
    closures: Array.isArray(d.closures) ? (d.closures as ClosurePeriod[]) : [],
    deliveryWindows: status.delivery_hours_on ? status.delivery_windows : null,
    minLeadMinutes: status.schedule_min_lead_min,
    maxDays: status.schedule_max_days,
    slotMinutes: status.schedule_slot_minutes,
    now,
  });
  return result(days.length > 0);
}
