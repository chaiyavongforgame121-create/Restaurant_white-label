// Which realtime changes are worth re-rendering the dashboard for, and how often it may be
// re-rendered. Pure, so auto-refresh.tsx stays wiring and these rules can be tested.
//
// A refresh here is a full server render: eleven reads and every card recomputed. Refreshing on
// every payload would be the live-ops board's old mistake — a rider pushes GPS every 3 seconds as
// a `deliveries` UPDATE — at the price of a whole page instead of one map pin.

export type WatchedTable = 'orders' | 'deliveries';

/**
 * The columns any Action Required bucket or overview tile reads. A change that leaves all of them
 * alone (a GPS ping, an ETA, a note) cannot move a row between buckets.
 */
const RELEVANT_COLUMNS: Record<WatchedTable, readonly string[]> = {
  orders: ['status', 'held', 'awaiting_payment', 'scheduled_for', 'channel', 'total'],
  deliveries: [
    'status',
    'driver_id',
    'accepted_at',
    'offered_at',
    'offer_expires_at',
    'dispatch_attempts',
    'failed_reason',
    'picked_up_at',
  ],
};

/** Beyond this many remembered rows the memory starts over; the cost is one extra refresh each. */
export const CHANGE_MEMORY_CAP = 2_000;

export function isWatchedTable(table: string): table is WatchedTable {
  return table === 'orders' || table === 'deliveries';
}

/** The relevant columns of one row, as one comparable string. */
export function relevantSignature(table: WatchedTable, row: Record<string, unknown>): string {
  return JSON.stringify(RELEVANT_COLUMNS[table].map((c) => row[c] ?? null));
}

/**
 * Whether one realtime payload should refresh the page. `memory` holds the last signature seen
 * per row and is updated here.
 *
 * The publication keeps the default replica identity, so an UPDATE carries the new row but only
 * the key of the old one: "did the status change?" cannot be read off the payload. The memory
 * answers it instead. The first UPDATE seen for a row always counts — the page may well be
 * showing that row in a state this tab never heard about — and after that only a change to a
 * relevant column does. An INSERT or a DELETE always counts.
 *
 * One exception: every UPDATE of an order still waiting on its transfer counts. `payments` is not
 * in the realtime publication, so a slip being uploaded, the diner pressing "I've paid" (which is
 * what puts it in the slips-to-approve bucket) and the approval itself reach this page only as the
 * orders UPDATE that private.sync_order_awaiting_payment issues on every payments write. Until the
 * approval that UPDATE leaves every relevant column as it was — awaiting_payment is rewritten to
 * the same `true` — so the signature rule would drop the one signal the top bucket has. Only the
 * payment flow writes to such a row, so this costs a handful of renders per transfer order.
 */
export function changeMatters(
  table: string,
  eventType: string,
  row: Record<string, unknown> | null | undefined,
  memory: Map<string, string>,
): boolean {
  if (!isWatchedTable(table)) return false;
  const id = typeof row?.id === 'string' ? row.id : null;
  const memoKey = id ? `${table}:${id}` : null;
  if (eventType === 'DELETE') {
    if (memoKey) memory.delete(memoKey);
    return true;
  }
  if (!row || !memoKey) return true;
  const sig = relevantSignature(table, row);
  const before = memory.get(memoKey);
  if (memory.size >= CHANGE_MEMORY_CAP && before === undefined) memory.clear();
  memory.set(memoKey, sig);
  if (eventType === 'INSERT') return true;
  if (table === 'orders' && row.awaiting_payment === true) return true;
  return before !== sig;
}

/** A burst of changes (an order and its delivery row written together) lands as one refresh. */
export const REFRESH_SETTLE_MS = 400;
/** Never two server renders closer than this, however busy the branch is. */
export const REFRESH_MIN_GAP_MS = 3_000;
/**
 * A catch-up (realtime connected, tab woke up, network came back) this soon after the last render
 * has nothing to catch up on. It is also what stops the first connect — a second or two after the
 * page was rendered — from rendering everything again.
 */
export const CATCH_UP_SKIP_MS = 10_000;

/** How long to wait before the next refresh, given when the last one happened. */
export function refreshDelay(nowMs: number, lastRefreshMs: number): number {
  return Math.max(REFRESH_SETTLE_MS, lastRefreshMs + REFRESH_MIN_GAP_MS - nowMs);
}

/** Whether a catch-up request is worth a render. A change request always is. */
export function catchUpWorthIt(nowMs: number, lastRefreshMs: number): boolean {
  return nowMs - lastRefreshMs >= CATCH_UP_SKIP_MS;
}

/**
 * A hidden tab is still rendered on the fallback, at this many times the visible interval.
 *
 * Not never: the tab title and the chime are the only signals that reach an owner who is on
 * another tab, and half of Action Required arrives by the clock — a diner kept waiting past ten
 * minutes, a ticket turning late, a booking going past its time — with no row changing to wake
 * realtime. Slower, because nobody is reading the rows themselves.
 */
export const HIDDEN_FALLBACK_FACTOR = 2;
/** A timer can fire a hair before its nominal time by the clock it is compared with. */
const FALLBACK_SLACK_MS = 1_000;

/** Whether the fallback timer, firing now, should render the page. */
export function fallbackDue(
  nowMs: number,
  lastRefreshMs: number,
  intervalMs: number,
  visible: boolean,
): boolean {
  const every = visible ? intervalMs : intervalMs * HIDDEN_FALLBACK_FACTOR;
  return nowMs - lastRefreshMs >= every - FALLBACK_SLACK_MS;
}
