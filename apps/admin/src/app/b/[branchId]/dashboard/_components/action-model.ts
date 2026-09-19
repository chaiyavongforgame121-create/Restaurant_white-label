import type {
  DashboardKitchenOrder,
  DashboardScheduledDelivery,
  DashboardScheduledOrder,
  LiveDelivery,
} from '@favornoms/database/queries';
import {
  boardCounts,
  describeDelivery,
  OVERDUE_AFTER_MS,
  partitionStale,
  STALE_AFTER_MS,
} from '../../deliveries/_components/live-ops-model';

// Everything the dashboard decides without React or the network. Every threshold here is
// either imported from the screen that owns it or mirrored with the line it came from:
// two screens disagreeing about the same number is worse than no number.
//
// Nothing here is worded: rows carry a reason code and a span, and the page puts them into
// the reader's language. Only the decisions live in this module.

export { OVERDUE_AFTER_MS, STALE_AFTER_MS };

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
/**
 * A Schedule Delivery booking this close is drawn a step louder even once it is accepted: it
 * is the next thing out of the door. An hour is the lead time plus a delivery run with room to
 * spare, and short enough that a normal evening does not light up the whole list.
 */
export const BOOKING_DUE_SOON_MS = 60 * 60_000;
/**
 * How long past its booked time an unfinished delivery booking stays on the list. Past that it
 * is either delivered and nobody pressed the button, or forgotten test data — the kitchen and
 * delivery boards already have their own "stalled" rules for both.
 */
export const BOOKING_LATE_WINDOW_MS = 2 * 60 * 60_000;
/** How many of the upcoming bookings the dashboard lists before "See all". */
export const BOOKING_ROWS_SHOWN = 10;
/** kitchen-view's DEFAULT_LEAD_MIN and release_scheduled_orders' last fallback. */
export const DEFAULT_LEAD_MIN = 15;

/**
 * How long before its booked time a scheduled order is let into the kitchen, read exactly as the
 * other three readers of these keys read them — release_scheduled_orders' coalesce, place-order's
 * `??` and kitchen-view's onSettings: the explicit lead time, else the prep time, else fifteen
 * minutes. A saved 0 ("let it in at the booked time") is an answer, not a gap. This used `||`,
 * which read 0 as missing and fell through to the prep time: every booking then said it would go
 * to the kitchen fifteen minutes before the database actually let it out, and was called stuck
 * for those fifteen minutes.
 */
export function leadTimeMs(settings: Readonly<Record<string, unknown>>): number {
  const prep = Number(settings.prep_time_min ?? DEFAULT_LEAD_MIN);
  const lead = Number(settings.schedule_lead_time_min ?? prep);
  return (Number.isFinite(lead) && lead >= 0 ? lead : DEFAULT_LEAD_MIN) * 60_000;
}

/**
 * A duration in the parts the screen writes it with: '<1 min', '3 min', '2 h 10 min', '3 d'.
 * Same cut-offs as the delivery board's ageLabel; `unknown` is its '—'.
 */
export type Span =
  | { unit: 'unknown' }
  | { unit: 'underMinute' }
  | { unit: 'minutes'; minutes: number }
  | { unit: 'hours'; hours: number; minutes: number }
  | { unit: 'days'; days: number };

/** Never negative; anything that is not a finite number is `unknown`. */
export function spanOf(ms: number | null | undefined): Span {
  if (ms == null || !Number.isFinite(ms)) return { unit: 'unknown' };
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return { unit: 'underMinute' };
  if (min < 60) return { unit: 'minutes', minutes: min };
  const h = Math.floor(min / 60);
  if (h < 24) return { unit: 'hours', hours: h, minutes: min % 60 };
  return { unit: 'days', days: Math.floor(h / 24) };
}

/** How long ago an ISO stamp was. */
export function spanSince(iso: string | null | undefined, nowMs: number): Span {
  if (!iso) return { unit: 'unknown' };
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? spanOf(nowMs - t) : { unit: 'unknown' };
}

/**
 * The right-hand column of a row. `waited` is how long it has sat there; `dueIn` is how long
 * until a booking is due. null prints nothing (stock has no waiting clock of its own).
 */
export type RowAge = { kind: 'waited' | 'dueIn'; span: Span } | null;

/** Why a row needs a human. The page turns each code into a sentence. */
export type RowReason =
  | { code: 'orderNotAccepted' }
  | { code: 'cookingLong'; minutes: number }
  | { code: 'acceptedNotStarted' }
  | { code: 'readyNotCollected' }
  | { code: 'deliveryWaitingKitchen' }
  | { code: 'deliveryKitchenReady' }
  /** `status` is the order's raw status code; the page labels it. */
  | { code: 'deliveryKitchenStatus'; status: string }
  | { code: 'deliveryLookingForRider' }
  | { code: 'deliveryAskedRiders'; count: number }
  | { code: 'deliveryOwnStaff' }
  | { code: 'deliveryNoRiderHolds' }
  | { code: 'deliveryOfferExpired' }
  /** `reason` is what the rider typed, shown as written; null when nobody said. */
  | { code: 'deliveryFailed'; reason: string | null; startedAgo: Span }
  | { code: 'bookingNotAccepted' }
  | { code: 'bookingStillHeld' };

/** One line in Action Required: what it is, why it needs a human, how long it has waited. */
export interface ActionRow {
  key: string;
  /** '#A-2609-100001'. null only for a delivery with no order attached. */
  title: string | null;
  why: RowReason;
  age: RowAge;
  ageMs: number;
  href: string;
  /**
   * The order the row is about, when it is about one. A delivery row's key is the delivery's
   * own id, so this is how one order listed by two buckets is recognised as one thing.
   */
  orderId?: string | null;
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
      orderId: o.id,
      title: `#${o.order_number}`,
      ageMs: elapsed,
      age: { kind: 'waited', span: spanOf(elapsed) } as const,
    };
    // Split by WHO is waiting, so no ticket is counted in two buckets.
    if (o.status === 'pending' && elapsed > ACCEPT_LATE_MS) {
      reading.customersWaiting.push({
        ...base,
        href: `/b/${branchId}/orders?status=pending`,
        why: { code: 'orderNotAccepted' },
      });
    } else if ((o.status === 'confirmed' || o.status === 'preparing') && elapsed > COOK_LATE_MS) {
      reading.kitchenLate.push({
        ...base,
        href: kitchenHref,
        why:
          o.status === 'preparing'
            ? { code: 'cookingLong', minutes: COOK_LATE_MS / 60_000 }
            : { code: 'acceptedNotStarted' },
      });
    } else if (lane === 'ready' && o.channel !== 'delivery' && elapsed > PASS_LATE_MS) {
      reading.customersWaiting.push({
        ...base,
        href: kitchenHref,
        why: { code: 'readyNotCollected' },
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

/**
 * Why an overdue, unaccepted delivery is on the list: the second line the Live deliveries
 * board prints for the same row (its detail, else its label), as a code. Whether the row is
 * overdue at all stays describeDelivery's call; only the wording is mirrored here. Called
 * without assignments, as readDeliveries always did, so "Rider cancelled" never applies.
 */
export function unacceptedReason(d: LiveDelivery, selfDelivery: boolean): RowReason {
  if (d.status === 'pending') {
    const kitchen = d.order?.status;
    if (kitchen === 'ready') return { code: 'deliveryKitchenReady' };
    if (kitchen) return { code: 'deliveryKitchenStatus', status: kitchen };
    return { code: 'deliveryWaitingKitchen' };
  }
  if (d.status === 'dispatching') {
    return d.dispatch_attempts > 0
      ? { code: 'deliveryAskedRiders', count: d.dispatch_attempts }
      : { code: 'deliveryLookingForRider' };
  }
  // `assigned` and not accepted. With no rider it is waiting on staff or on the pool; with a
  // rider, an offer still open is never overdue, so only an expired one reaches this list.
  if (!d.driver_id) {
    return selfDelivery ? { code: 'deliveryOwnStaff' } : { code: 'deliveryNoRiderHolds' };
  }
  return { code: 'deliveryOfferExpired' };
}

/**
 * The orders still held for their booked time, from every read that carries the flag.
 *
 * place-order creates a booking's delivery row the moment the diner books, as `pending`, and
 * neither the live-deliveries read nor describeDelivery knows the order is held — so half an hour
 * after tonight's booking was taken, its delivery counts as "overdue, nobody has taken it". It is
 * not waiting on anyone: release_scheduled_orders lets it into the kitchen at its lead time, and
 * a release that is late is the bookings group's "Not released", not a rider's problem.
 */
export function heldOrderIds(
  ...lists: ReadonlyArray<readonly { id: string; held: boolean }[]>
): Set<string> {
  const out = new Set<string>();
  for (const list of lists) for (const o of list) if (o.held) out.add(o.id);
  return out;
}

export function readDeliveries(
  all: readonly LiveDelivery[],
  nowMs: number,
  selfDelivery: boolean,
  branchId: string,
  /** See heldOrderIds. Only Action Required leaves them out; the tile still counts the board. */
  heldOrders: ReadonlySet<string> = new Set(),
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

  const row = (d: LiveDelivery, href: string, why: RowReason): ActionRow => ({
    key: d.id,
    orderId: d.order?.id ?? null,
    href,
    ageMs: nowMs - Date.parse(d.created_at),
    age: { kind: 'waited', span: spanSince(d.created_at, nowMs) },
    title: d.order ? `#${d.order.order_number}` : null,
    why,
  });

  const deliveriesHref = `/b/${branchId}/deliveries`;
  const unaccepted = live
    .filter(
      (d) =>
        d.status === 'pending' ||
        d.status === 'dispatching' ||
        (d.status === 'assigned' && !d.accepted_at),
    )
    .filter((d) => !(d.order && heldOrders.has(d.order.id)))
    .filter((d) => describeDelivery(d, nowMs, selfDelivery).overdue)
    .map((d) => row(d, deliveriesHref, unacceptedReason(d, selfDelivery)))
    .sort(byAgeDesc);

  // Failures are pulled from BOTH partitions: a rider's problem does not stop mattering
  // because it is twelve hours old — isStale only decides what the map draws. The age is
  // the delivery's own, because deliveries has no failed_at and no updated_at column.
  const failed = [...live, ...stale]
    .filter((d) => d.status === 'failed')
    .map((d) =>
      row(d, `/b/${branchId}/orders`, {
        code: 'deliveryFailed',
        reason: d.failed_reason ?? null,
        startedAgo: spanSince(d.created_at, nowMs),
      }),
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
      age: { kind: 'dueIn', span: spanOf(untilDue) },
      why: overdueRelease ? { code: 'bookingStillHeld' } : { code: 'bookingNotAccepted' },
    });
  }
  // Soonest first: the opposite of every other bucket, because here small means urgent.
  return out.sort((a, b) => a.ageMs - b.ageMs);
}

// ---------------------------------------------------------------------------------------
// Schedule Delivery bookings
// ---------------------------------------------------------------------------------------

/**
 * Where a delivery booking has got to, as the merchant would say it. One state per row, picked
 * in the order the checks are listed: payment blocks everything after it (the
 * orders_block_unpaid_transfer trigger keeps an unpaid transfer at `pending`), and a booking
 * still held past its release time is a fault whatever its status says.
 */
export type BookingState =
  | 'unpaid'
  | 'stuckHeld'
  | 'notAccepted'
  | 'accepted'
  | 'inKitchen'
  | 'ready'
  | 'onTheWay';

/**
 * How loudly a row is drawn. `strong` needs a human now; `normal` is the next thing out of the
 * door; `quiet` is simply coming up, listed so the owner can see the evening ahead.
 */
export type BookingWeight = 'strong' | 'normal' | 'quiet';

export interface BookingRow {
  key: string;
  orderNumber: string;
  /** As the diner typed it. */
  customerName: string | null;
  dueMs: number;
  /** Negative once the booked time has passed. */
  untilDueMs: number;
  /** When release_scheduled_orders lets it into the kitchen: the booked time less the lead. */
  releaseMs: number;
  state: BookingState;
  /** Past its booked time and not on the road yet. */
  late: boolean;
  dueSoon: boolean;
  needsAction: boolean;
  /**
   * Another bucket lists this order already: a booking past its time is also a late kitchen
   * ticket, one nobody accepted is also a diner kept waiting, an unpaid one with its slip in is a
   * slip to approve. It is still drawn as needing action here; it is only not counted twice.
   */
  listedElsewhere: boolean;
  weight: BookingWeight;
  href: string;
}

export interface BookingReading {
  /** Soonest first, every row read; the page decides how many it lists. */
  rows: BookingRow[];
  /** Rows that need a human: the bucket's own "N need you". */
  needsAction: number;
  /**
   * Those of them no other bucket lists — the only ones this group adds to "N things waiting on
   * you". Counting a late booking in both groups said "2 things" about one order.
   */
  needsActionOnlyHere: number;
}

/**
 * Every order the given rows are about, plus any ids named directly (a slip is listed by its
 * payment, but it is about an order all the same).
 */
export function ordersListedIn(
  rowLists: ReadonlyArray<readonly ActionRow[]>,
  orderIds: readonly string[] = [],
): Set<string> {
  const out = new Set<string>(orderIds);
  for (const rows of rowLists) for (const r of rows) if (r.orderId) out.add(r.orderId);
  return out;
}

export function bookingState(
  o: Pick<DashboardScheduledDelivery, 'status' | 'held' | 'awaiting_payment'>,
  releaseMs: number,
  nowMs: number,
): BookingState {
  if (o.awaiting_payment) return 'unpaid';
  // readScheduled's overdueRelease, for the same reason: the release job runs every minute.
  if (o.held && releaseMs < nowMs) return 'stuckHeld';
  switch (o.status) {
    case 'pending':
      return 'notAccepted';
    case 'confirmed':
      return o.held ? 'accepted' : 'inKitchen';
    case 'preparing':
      return 'inKitchen';
    case 'ready':
      return 'ready';
    case 'out_for_delivery':
      return 'onTheWay';
    default:
      // The read asks for unfinished statuses only; anything new is shown as accepted
      // rather than dropped, which would hide a booking.
      return 'accepted';
  }
}

/**
 * Every Schedule Delivery booking still to go out, with what each one needs. A booking nobody
 * has accepted needs a human however far off it is — the diner is waiting to hear yes, and
 * accepting it is the whole job — so unlike readScheduled there is no "due soon" gate on that.
 * An unpaid one only becomes the merchant's problem close to its time (until then it is the
 * diner's move, and the slip queue already asks for the decision once a slip is in).
 */
export function readScheduledDeliveries(
  rows: readonly DashboardScheduledDelivery[],
  nowMs: number,
  leadMs: number,
  branchId: string,
  /** Orders another bucket already lists (ordersListedIn). */
  listedElsewhere: ReadonlySet<string> = new Set(),
): BookingReading {
  const out: BookingRow[] = [];
  for (const o of rows) {
    const dueMs = Date.parse(o.scheduled_for);
    if (!Number.isFinite(dueMs)) continue;
    const untilDueMs = dueMs - nowMs;
    const releaseMs = dueMs - leadMs;
    const state = bookingState(o, releaseMs, nowMs);
    const late = untilDueMs < 0 && state !== 'onTheWay';
    const dueSoon = untilDueMs <= BOOKING_DUE_SOON_MS;
    const needsAction =
      state === 'notAccepted' ||
      state === 'stuckHeld' ||
      (state === 'unpaid' && dueSoon) ||
      late;
    out.push({
      key: o.id,
      orderNumber: o.order_number,
      customerName: o.customer_name?.trim() || null,
      dueMs,
      untilDueMs,
      releaseMs,
      state,
      late,
      dueSoon,
      needsAction,
      listedElsewhere: listedElsewhere.has(o.id),
      weight: needsAction ? 'strong' : dueSoon && state !== 'onTheWay' ? 'normal' : 'quiet',
      // The order itself, found by its number, and not the scheduled filter: that one starts
      // at now(), so it would not show a booking that is already late.
      href: `/b/${branchId}/orders?q=${encodeURIComponent(o.order_number)}`,
    });
  }
  // By booked time, as the kitchen needs them; the number breaks a tie so two bookings for the
  // same slot do not swap places on every refresh.
  out.sort((a, b) => a.dueMs - b.dueMs || a.orderNumber.localeCompare(b.orderNumber));
  return {
    rows: out,
    needsAction: out.filter((r) => r.needsAction).length,
    needsActionOnlyHere: out.filter((r) => r.needsAction && !r.listedElsewhere).length,
  };
}
