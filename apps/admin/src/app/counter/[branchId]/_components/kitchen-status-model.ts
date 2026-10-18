/* The till's read-only view of the kitchen: which tickets the cooks have, in which lane, and how
   long each has waited. The rules are the kitchen board's own (kitchen-model), so the counter and
   the pass never disagree about where an order is; this file only shapes them for the modal. */

import {
  ACTIVE_STATUSES,
  isLineDone,
  isOnBoard,
  laneOf,
  linesInMenuOrder,
  readyStartedMs,
  workStartedMs,
  type Order,
} from '@/app/kitchen/[branchId]/_components/kitchen-model';

/** What the view reads per ticket: the board's card fields, without riders, deliveries or
 *  anything the till has no use for when it is only watching. */
export const KITCHEN_VIEW_SELECT =
  'id, order_number, status, status_history, channel, created_at, customer_name, customer_notes, kitchen_notes, held, awaiting_payment, scheduled_for, table_id, tables(table_number, display_name), order_items(id, item_name, quantity, notes, prep_status, modifiers, combo_id, combo_contents, menu_item_id, category_position, item_position, created_at)';

export { ACTIVE_STATUSES };

export type KitchenLane = 'new' | 'cooking' | 'ready';
export const KITCHEN_LANES: readonly KitchenLane[] = ['new', 'cooking', 'ready'];

export type KitchenLanes = Record<KitchenLane, Order[]>;

/** When a ticket's clock starts in its lane: the kitchen's own rule. Ready counts from the moment
 *  it became ready (how long the food has been waiting on the pass); the others from when the
 *  ticket became the kitchen's work (a scheduled order from its release, not from when it was
 *  booked). */
export function laneClockStart(order: Order, leadMs: number): number {
  return laneOf(order.status) === 'ready' ? readyStartedMs(order) : workStartedMs(order, leadMs);
}

/**
 * The tickets the kitchen board shows (isOnBoard: not held, not waiting for a transfer, with
 * lines), split into its three lanes, each newest first as on the board (the owner's request
 * there), so the till and the pass show the same ticket at the top of each lane.
 */
export function kitchenLanes(orders: readonly Order[]): KitchenLanes {
  const lanes: KitchenLanes = { new: [], cooking: [], ready: [] };
  for (const raw of orders) {
    const order = normaliseOrder(raw);
    if (!isOnBoard(order)) continue;
    lanes[laneOf(order.status)].push(linesInMenuOrder(order));
  }
  const newestFirst = (a: Order, b: Order) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  for (const lane of KITCHEN_LANES) lanes[lane].sort(newestFirst);
  return lanes;
}

/** Lines ticked off by the cooks, of all of the ticket's lines. */
export function lineProgress(order: Pick<Order, 'order_items'>): { done: number; total: number } {
  const total = order.order_items.length;
  const done = order.order_items.filter((it) => isLineDone(it)).length;
  return { done, total };
}

/** PostgREST hands a one-to-one embed back as an object (or null) and the lines as an array;
 *  a row read any other way is made safe to render rather than throwing in the modal. */
function normaliseOrder(order: Order): Order {
  const items = Array.isArray(order.order_items) ? order.order_items : [];
  const table = Array.isArray(order.tables) ? (order.tables[0] ?? null) : (order.tables ?? null);
  return items === order.order_items && table === order.tables ? order : { ...order, order_items: items, tables: table };
}

/** The table a ticket is for, as the board's chip writes it: the floor plan's own name as it is
 *  ("Patio 7"), else "Table {number}" through `tableWord`. */
export function tableLabel(order: Pick<Order, 'tables'>, tableWord: (number: string) => string): string | null {
  const t = order.tables;
  if (!t) return null;
  const named = t.display_name?.trim();
  if (named) return named;
  return t.table_number ? tableWord(t.table_number) : null;
}

/** The order's notes for the kitchen, joined as the board's card joins them. */
export function orderNote(order: Pick<Order, 'customer_notes' | 'kitchen_notes'>): string {
  return [order.customer_notes, order.kitchen_notes].filter(Boolean).join(' · ');
}
