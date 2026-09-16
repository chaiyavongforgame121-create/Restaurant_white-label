import type { StorefrontStatus } from '@favornoms/database/queries';
import { buildScheduleDays, type ClosurePeriod, type OpeningWindow } from './schedule-slots';

/**
 * Customers order one of two ways: Pickup, prepared now, or Schedule Delivery, booked for a day
 * and time. This decides whether the second can be offered at all, on the server, before the
 * order-type gate or the menu picker shows it.
 *
 * It is deliberately NOT `status.delivery`, which also requires delivery to be open THIS minute:
 * gating on that hid delivery outside delivery hours from exactly the diners booking ahead
 * (Brooklyn, with one Sunday window, showed no delivery six days a week) and made the cart store
 * wipe a delivery choice the diner had already made.
 *
 * What it does require, because each one otherwise sends the diner through the whole checkout
 * to a refusal:
 * - the delivery add-on and a branch taking advance orders;
 * - orders not paused — is_branch_open() refuses every time while paused, booked times included,
 *   so "you can still schedule a delivery" would be a promise every slot breaks;
 * - at least one bookable slot, from the same builder and the same inputs the checkout picker
 *   uses (opening hours, booking windows, closures, delivery hours, lead time, horizon). Delivery
 *   hours switched on with no windows, or windows that never overlap the booking windows, leave
 *   nothing to book.
 */
export interface ScheduleDeliveryState {
  canDeliver: boolean;
  /** The kitchen paused orders (branches.settings.orders_paused). Nothing can be ordered. */
  paused: boolean;
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
  const [{ data: branchRow }, { data: policy }] = await Promise.all([
    client.from('branches').select('settings').eq('id', branchId).maybeSingle(),
    client.rpc('branch_schedule_policy', { p_branch_id: branchId }),
  ]);
  const paused = ordersPaused((branchRow?.settings ?? null) as Record<string, unknown> | null);
  if (paused || !status.delivery_entitled || !status.scheduling_enabled) {
    return { canDeliver: false, paused };
  }
  // Same parsing as the checkout picker: a failed policy read means opening hours alone decide,
  // and `windows: null` (never armed) is not the same statement as an empty list.
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
  return { canDeliver: days.length > 0, paused };
}
