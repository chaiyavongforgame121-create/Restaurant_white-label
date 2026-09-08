import type {
  DashboardKitchenOrder,
  DashboardScheduledOrder,
  LiveDelivery,
} from '@favornoms/database/queries';
import {
  ageLabel,
  boardCounts,
  describeDelivery,
  OVERDUE_AFTER_MS,
  partitionStale,
  STALE_AFTER_MS,
} from '../../deliveries/_components/live-ops-model';

// Everything the dashboard decides without React or the network. Every threshold here is
// either imported from the screen that owns it or mirrored with the line it came from:
// two screens disagreeing about the same number is worse than no number.

export { ageLabel, OVERDUE_AFTER_MS, STALE_AFTER_MS };

/**
 * A ticket nobody has touched for this long is abandoned, not late. Same number and the
 * same reason as the delivery board's STALE_AFTER_MS and the kitchen display's
 * safeElapsedSec clamp (kitchen-view.tsx safeElapsedSec, 12 h) — imported, not re-typed.
 */
export const ABANDONED_AFTER_MS = STALE_AFTER_MS;
/** kitchen-view agingTier: a non-ready lane turns 'late' at 900 s. */
export const COOK_LATE_MS = 15 * 60_000;
/** kitchen-view agingTier: the ready lane turns 'late' at 300 s. */
export const PASS_LATE_MS = 5 * 60_000;
/** A diner who has not even been told yes. Deliberately tighter than COOK_LATE_MS. */
export const ACCEPT_LATE_MS = 10 * 60_000;
/** A booking this close that nobody has accepted is the merchant's problem now. */
export const SCHEDULED_SOON_MS = 3 * 60 * 60_000;

/** One line in Action Required: what it is, why it needs a human, how long it has waited. */
export interface ActionRow {
  key: string;
  title: string;
  why: string;
  age: string;
  ageMs: number;
  href: string;
}

const byAgeDesc = (a: ActionRow, b: ActionRow) => b.ageMs - a.ageMs;

/**
 * status_history carries two stamp formats: place-order writes ISO
 * ('2026-09-06T15:22:07.534Z'), while the orders_after_status_update trigger writes
 * now()::text ('2026-09-06 15:26:50.190222+00'). Date.parse returns NaN for the second —
 * microsecond precision and a two-digit zone are both outside what it accepts — so the
 * space, the extra digits and the short offset are normalised before parsing, and the
 * result is verified rather than trusted.
 */
export function parseStamp(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const iso = trimmed
    .replace(' ', 'T')
    .replace(/(T\d{2}:\d{2}:\d{2}\.\d{3})\d+/, '$1')
    .replace(/(T\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})$/, '$1$2:00');
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * When this order last entered `ready`, or null. Only meaningful while the order still is
 * ready: recall_order puts a ticket back to `preparing` and leaves the old `ready` entry
 * behind, so reading this unconditionally would print a months-old age on live work.
 */
export function lastReadyAt(o: Pick<DashboardKitchenOrder, 'status_history'>): number | null {
  if (!Array.isArray(o.status_history)) return null;
  let latest: number | null = null;
  for (const entry of o.status_history) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (row.status !== 'ready') continue;
    const t = parseStamp(row.at);
    if (t != null && (latest == null || t > latest)) latest = t;
  }
  return latest;
}

/**
 * When a ticket became the kitchen's work — kitchen-view's workStartedMs, verbatim. For a
 * scheduled order that is the moment release_scheduled_orders let it out, not the moment
 * the diner typed it in, or a lunch booked at breakfast lands on the board four hours late.
 */
export function workStartedMs(
  o: Pick<DashboardKitchenOrder, 'created_at' | 'scheduled_for'>,
  leadMs: number,
): number {
  const created = Date.parse(o.created_at);
  if (!o.scheduled_for) return created;
  const due = Date.parse(o.scheduled_for);
  if (!Number.isFinite(due)) return created;
  return Math.max(created, due - leadMs);
}

export type Lane = 'waiting' | 'cooking' | 'ready' | 'hidden';

/**
 * The kitchen display's lanes and its visibility filter, in one place. WAITING is the NEW
 * lane (pending + confirmed); held pre-orders live in their own drawer and awaiting_payment
 * tickets are not work yet, so neither is on the board and neither is counted here.
 */
export function laneOf(
  o: Pick<DashboardKitchenOrder, 'status' | 'held' | 'awaiting_payment'>,
): Lane {
  if (o.held || o.awaiting_payment) return 'hidden';
  if (o.status === 'pending' || o.status === 'confirmed') return 'waiting';
  if (o.status === 'preparing') return 'cooking';
  if (o.status === 'ready') return 'ready';
  return 'hidden';
}

export interface KitchenReading {
  waiting: number;
  cooking: number;
  ready: number;
  /** On the board more than 12 h: junk from an abandoned service, not urgency. */
  abandoned: number;
  /** Accepted work aging past the kitchen's own "late" threshold. */
  kitchenLate: ActionRow[];
  /** A diner waiting on someone: not accepted yet, or cooked and not collected. */
  customersWaiting: ActionRow[];
}

export function readKitchen(
  orders: readonly DashboardKitchenOrder[],
  nowMs: number,
  leadMs: number,
  branchId: string,
): KitchenReading {
  const reading: KitchenReading = {
    waiting: 0,
    cooking: 0,
    ready: 0,
    abandoned: 0,
    kitchenLate: [],
    customersWaiting: [],
  };
  const kitchenHref = `/kitchen/${branchId}`;

  for (const o of orders) {
    const lane = laneOf(o);
    if (lane === 'hidden') continue;
    if (lane === 'waiting') reading.waiting += 1;
    else if (lane === 'cooking') reading.cooking += 1;
    else reading.ready += 1;

    const started = workStartedMs(o, leadMs);
    const from = lane === 'ready' ? (lastReadyAt(o) ?? started) : started;
    const elapsed = nowMs - from;
    if (!Number.isFinite(elapsed) || elapsed < 0) continue;
    if (elapsed > ABANDONED_AFTER_MS) {
      reading.abandoned += 1;
      continue;
    }

    const base = {
      key: o.id,
      title: `#${o.order_number}`,
      ageMs: elapsed,
      age: ageLabel(new Date(from).toISOString(), nowMs),
    };
    // Split by WHO is waiting, so no ticket is counted in two buckets.
    if (o.status === 'pending' && elapsed > ACCEPT_LATE_MS) {
      reading.customersWaiting.push({
        ...base,
        href: `/b/${branchId}/orders?status=pending`,
        why: 'Nobody has accepted this order yet',
      });
    } else if ((o.status === 'confirmed' || o.status === 'preparing') && elapsed > COOK_LATE_MS) {
      reading.kitchenLate.push({
        ...base,
        href: kitchenHref,
        why: o.status === 'preparing' ? 'Cooking longer than 15 min' : 'Accepted but not started',
      });
    } else if (lane === 'ready' && o.channel !== 'delivery' && elapsed > PASS_LATE_MS) {
      reading.customersWaiting.push({
        ...base,
        href: kitchenHref,
        why: 'Ready on the pass, not collected',
      });
    }
  }

  reading.kitchenLate.sort(byAgeDesc);
  reading.customersWaiting.sort(byAgeDesc);
  return reading;
}

export interface DeliveryReading {
  inFlight: number;
  /** Rows the board parks as forgotten. Shown beside the tile so 0 does not read as broken. */
  stalled: number;
  unaccepted: ActionRow[];
  failed: ActionRow[];
}

export function readDeliveries(
  all: readonly LiveDelivery[],
  nowMs: number,
  selfDelivery: boolean,
  branchId: string,
): DeliveryReading {
  const { live, stale } = partitionStale(all, nowMs);
  const counts = boardCounts(live);
  // "In flight" is every live row that is not an alarm — the same five pills the delivery
  // board shows, minus `failed`, which is a job for a human rather than food in motion.
  const inFlight =
    counts.waitingKitchen +
    counts.findingRider +
    counts.offered +
    counts.accepted +
    counts.onTheWay;

  const row = (d: LiveDelivery, href: string, why?: string): ActionRow => {
    const described = describeDelivery(d, nowMs, selfDelivery);
    return {
      key: d.id,
      href,
      ageMs: nowMs - Date.parse(d.created_at),
      age: ageLabel(d.created_at, nowMs),
      title: d.order ? `#${d.order.order_number}` : 'Delivery',
      why: why ?? (described.detail || described.label),
    };
  };

  const deliveriesHref = `/b/${branchId}/deliveries`;
  const unaccepted = live
    .filter(
      (d) =>
        d.status === 'pending' ||
        d.status === 'dispatching' ||
        (d.status === 'assigned' && !d.accepted_at),
    )
    .filter((d) => describeDelivery(d, nowMs, selfDelivery).overdue)
    .map((d) => row(d, deliveriesHref))
    .sort(byAgeDesc);

  // Failures are pulled from BOTH partitions: a rider's problem does not stop mattering
  // because it is twelve hours old — isStale only decides what the map draws. The age is
  // the delivery's own, because deliveries has no failed_at and no updated_at column.
  const failed = [...live, ...stale]
    .filter((d) => d.status === 'failed')
    .map((d) =>
      row(
        d,
        `/b/${branchId}/orders`,
        `${d.failed_reason ?? 'No reason recorded'} · raised on a delivery started ${ageLabel(d.created_at, nowMs)} ago`,
      ),
    )
    .sort(byAgeDesc);

  return { inFlight, stalled: stale.length, unaccepted, failed };
}

/**
 * Bookings close enough to matter that nobody has taken responsibility for. `pending` is a
 * diner still waiting to hear yes; a `held` order whose lead time has already passed should
 * be on the board by now — release_scheduled_orders runs every minute, so if it is still
 * held something is wrong with it, not with the clock.
 */
export function readScheduled(
  rows: readonly DashboardScheduledOrder[],
  nowMs: number,
  leadMs: number,
  branchId: string,
): ActionRow[] {
  const href = `/b/${branchId}/orders?when=scheduled`;
  // ageLabel formats a span as "how long ago"; a point that far in the past reads it back
  // as the same span, which is what "due in 40 min" needs.
  const spanLabel = (ms: number) =>
    ageLabel(new Date(nowMs - Math.max(0, ms)).toISOString(), nowMs);
  const out: ActionRow[] = [];
  for (const o of rows) {
    const due = Date.parse(o.scheduled_for);
    if (!Number.isFinite(due)) continue;
    const untilDue = Math.max(0, due - nowMs);
    const overdueRelease = o.held && due - leadMs < nowMs;
    if (o.status !== 'pending' && !overdueRelease) continue;
    out.push({
      key: o.id,
      title: `#${o.order_number}`,
      href,
      // For a booking the number a merchant acts on is the time LEFT, not the time since,
      // so that is what "how long has it waited" means in this one bucket.
      ageMs: untilDue,
      age: `due in ${spanLabel(untilDue)}`,
      why: overdueRelease
        ? 'Should already be in the kitchen — still held'
        : 'Nobody has accepted this booking yet',
    });
  }
  // Soonest first: the opposite of every other bucket, because here small means urgent.
  return out.sort((a, b) => a.ageMs - b.ageMs);
}
