// What place-order answers when public.is_branch_open_for() refuses an order, with no I/O, so it
// can be unit-tested (./closed-refusal.test.ts, run with `deno test`).
//
// The database says only yes or no. The diner needs to know why: "the restaurant is closed" sends
// them to read opening hours, which is wrong for a delivery at a branch whose delivery has its own
// hours ("Limit delivery to set hours"), since those may lie before opening or after closing. That
// case gets the code the checkout and the till already explain for delivery hours, the one
// tg_enforce_delivery_hours raises at insert.
//
// Imports nothing on purpose. When deploying through the Management API / MCP rather than the CLI,
// pass this file with index.ts.

export type ClosedRefusalCode =
  | 'branch_closed'
  | 'branch_closed_at_scheduled_time'
  | 'delivery_not_available_at_that_time';

function flag(settings: unknown, key: string): boolean {
  if (settings === null || typeof settings !== 'object') return false;
  const value = (settings as Record<string, unknown>)[key];
  // settings->>'key' = 'true' in SQL: a JSON true or the string "true", nothing else.
  return value === true || value === 'true';
}

/** "Limit delivery to set hours" (settings.delivery_hours_enabled), as is_branch_open_for reads it. */
export function deliveryHoursEnabled(settings: unknown): boolean {
  return flag(settings, 'delivery_hours_enabled');
}

export interface ClosedRefusalInput {
  channel: string;
  /** The order names a time (scheduled_for). */
  scheduled: boolean;
  /** The branch row read with the order, or null when it could not be read. */
  branch: { is_active?: unknown; settings?: unknown } | null;
  /** A branch_closures row covers the order's time. */
  closureCovers: boolean;
}

/** A delivery at a branch whose delivery hours are on and which is otherwise taking orders
 *  (active, not paused, no closure) was refused for its delivery hours alone:
 *  delivery_not_available_at_that_time. Anything else keeps branch_closed, or
 *  branch_closed_at_scheduled_time for a booked order. A paused or closed branch is "closed" for
 *  every channel, so it wins over the delivery hours. */
export function closedRefusalCode(input: ClosedRefusalInput): ClosedRefusalCode {
  const { channel, scheduled, branch, closureCovers } = input;
  const settings = branch?.settings;
  const takingOrders = branch != null &&
    branch.is_active === true &&
    !flag(settings, 'orders_paused') &&
    !closureCovers;
  if (channel === 'delivery' && takingOrders && deliveryHoursEnabled(settings)) {
    return 'delivery_not_available_at_that_time';
  }
  return scheduled ? 'branch_closed_at_scheduled_time' : 'branch_closed';
}
