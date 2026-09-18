/* Pure data and timing rules of the kitchen board, kept out of the 'use client' view so the
   server page can share the select and the rules can be unit-tested. */

import type { BranchRider } from '@favornoms/database/queries';

/** Everything the board reads per ticket. page.tsx (first paint) and the view's reload() must
 *  select the same shape, or a refetch silently drops a field a card relies on. */
export const KITCHEN_ORDER_SELECT =
  'id, order_number, status, status_history, channel, created_at, customer_name, customer_notes, kitchen_notes, held, awaiting_payment, scheduled_for, table_id, tables(table_number, display_name), order_items(id, menu_item_id, combo_id, combo_contents, item_name, quantity, notes, prep_status, station, modifiers), deliveries(id, status, driver_id, accepted_at, batch_id, batch_seq)';

export const ACTIVE_STATUSES = ['pending', 'confirmed', 'preparing', 'ready'];

export interface OrderItem {
  id: string;
  item_name: string;
  quantity: number;
  notes?: string | null;
  prep_status?: string | null;
  station?: string | null;
  modifiers?: unknown;
  menu_item_id?: string | null;
  combo_id?: string | null;
  /** The dishes inside a combo line, snapshotted by place-order. Shape is read defensively. */
  combo_contents?: unknown;
}
export interface Delivery {
  id: string;
  status: string;
  driver_id: string | null;
  accepted_at: string | null;
  batch_id?: string | null;
  batch_seq?: number | null;
}
export interface Order {
  id: string;
  order_number: string;
  status: 'pending' | 'confirmed' | 'preparing' | 'ready' | string;
  /** [{ status, at }, …] appended by orders_status_history_trigger on every status change. */
  status_history?: unknown;
  channel: 'dine_in' | 'pickup' | 'delivery' | 'qr_ordering' | string;
  created_at: string;
  customer_name?: string | null;
  customer_notes?: string | null;
  kitchen_notes?: string | null;
  held?: boolean;
  /** A QR-transfer order whose money the merchant has not confirmed. Read from the ORDER
   *  row on purpose: payments is gated behind the 'payments.view' capability, which kitchen
   *  staff do not have, so an embedded payments check silently returns nothing and passes. */
  awaiting_payment?: boolean;
  scheduled_for?: string | null;
  table_id?: string | null;
  tables?: { table_number: string; display_name: string | null } | null;
  order_items: OrderItem[];
  deliveries?: Delivery[];
}

/** A rider approved for this branch, from list_branch_riders. */
export interface DriverLite {
  id: string;
  full_name: string;
  phone: string | null;
  vehicle_type: string;
  /** Online at THIS branch (driver_branch_availability), not the global drivers flag. */
  is_online: boolean;
  /** Holds an assigned / picked-up / in-transit delivery right now. */
  busy: boolean;
  location_updated_at: string | null;
}

export function toDriverLite(r: BranchRider): DriverLite {
  return {
    id: r.driver_id,
    full_name: r.full_name,
    phone: r.phone,
    vehicle_type: r.vehicle_type,
    is_online: r.online,
    busy: r.active_delivery_id != null,
    location_updated_at: r.location_updated_at,
  };
}

/** A dish 86'd at this branch (menu_items.sold_out_until in the future). */
export interface SoldOutItem {
  id: string;
  name: string;
  sold_out_until: string;
}

/** One dish inside a combo line. */
export interface ComboPart {
  menu_item_id: string | null;
  name: string;
  /** Per combo; the line's own quantity multiplies it. */
  quantity: number;
  station: string | null;
}

/* ── time ──────────────────────────────────────────────────────────────── */

/** Parse a timestamp as either JSON (ISO, "…Z") or Postgres text ("2026-09-18 00:45:33.573215+00")
 *  writes it — status_history holds both. Safari's Date.parse refuses the Postgres form. */
export function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
  const iso = value
    .trim()
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  return Date.parse(iso);
}

/** When the order last became 'ready', from its status history; null when it never did (or the
 *  history is unreadable). */
export function readyAtFromHistory(history: unknown): number | null {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i] as { status?: unknown; at?: unknown } | null;
    if (entry && typeof entry === 'object' && entry.status === 'ready') {
      const ms = parseTimestamp(entry.at);
      return Number.isFinite(ms) ? ms : null;
    }
  }
  return null;
}

/** Where a Ready ticket's clock starts. The history is the truth every tablet shares; a local
 *  stamp (this tab just pressed Ready and the UPDATE has not echoed back yet) wins only when it
 *  is newer. Never the page-load time: that restarted every Ready clock at 0:00 on reload. */
export function readyStartedMs(order: Pick<Order, 'status_history' | 'created_at'>, localReadyAt?: number): number {
  const fromHistory = readyAtFromHistory(order.status_history);
  const candidates = [fromHistory, localReadyAt].filter((v): v is number => v != null && Number.isFinite(v));
  if (candidates.length > 0) return Math.max(...candidates);
  return new Date(order.created_at).getTime();
}

/** When a ticket became the kitchen's work.
 *
 *  For a scheduled order that is the moment private.release_scheduled_orders() let it out —
 *  scheduled_for − schedule_lead_time_min — not the moment the diner typed it in. A pickup
 *  booked at 09:00 for 13:00 reached the board at 12:40 already showing 3h 40m, wearing the
 *  urgent red skin with a pulsing critical ring, and dragged its stations into "drowning",
 *  which made every genuinely late ticket beside it unreadable. */
export function workStartedMs(order: Pick<Order, 'created_at' | 'scheduled_for'>, leadMs: number): number {
  const created = new Date(order.created_at).getTime();
  if (!order.scheduled_for) return created;
  const due = new Date(order.scheduled_for).getTime();
  if (!Number.isFinite(due)) return created;
  // Clamped to created_at: a slot booked for sooner than the lead time is released
  // immediately, and such a ticket has been work since it was placed.
  return Math.max(created, due - leadMs);
}

/** Seconds since `fromMs`. Only clock skew (a stamp slightly in the future) is clamped; an old
 *  ticket shows its real age — the 12-hour clamp used to paint a forgotten ticket as a calm 0:00. */
export function safeElapsedSec(fromMs: number, now: number): number {
  if (!Number.isFinite(fromMs)) return 0;
  const raw = Math.floor((now - fromMs) / 1000);
  return raw < 0 ? 0 : raw;
}

export interface TimerFormatters {
  hoursMinutes: (hours: number, minutes: number) => string;
  daysHours: (days: number, hours: number) => string;
}
export function fmtTimer(sec: number, f: TimerFormatters): string {
  if (sec < 3600) return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  if (sec < 86_400) return f.hoursMinutes(Math.floor(sec / 3600), Math.floor((sec % 3600) / 60));
  return f.daysHours(Math.floor(sec / 86_400), Math.floor((sec % 86_400) / 3600));
}

export type TierKey = 'fresh' | 'work' | 'warn' | 'late' | 'crit';
export function agingTierKey(sec: number, lane: string): TierKey {
  if (lane === 'ready') return sec < 180 ? 'fresh' : sec < 300 ? 'warn' : 'late';
  return sec < 300 ? 'fresh' : sec < 600 ? 'work' : sec < 900 ? 'warn' : sec < 1200 ? 'late' : 'crit';
}

export function laneOf(status: string): 'new' | 'cooking' | 'ready' {
  return status === 'preparing' ? 'cooking' : status === 'ready' ? 'ready' : 'new';
}

/* ── what is on the board ──────────────────────────────────────────────── */

/** A ticket the cooks should see. A ticket with no lines yet is held back: place-order writes
 *  the order and its items in separate requests, and an empty card is not work. */
export function isOnBoard(o: Order): boolean {
  return !o.held && !o.awaiting_payment && ACTIVE_STATUSES.includes(o.status) && o.order_items.length > 0;
}

/** A line the cook has ticked off. */
export function isLineDone(it: Pick<OrderItem, 'prep_status'>): boolean {
  return it.prep_status === 'ready' || it.prep_status === 'served';
}

/** Fold a menu_items row (a realtime UPDATE, or this board's own 86) into the sold-out strip.
 *  Returns the SAME array when nothing changed: menu_items is updated on every sale (stock), and
 *  a new array each time would repaint the board for nothing. A dish taken off the menu
 *  (is_active false) leaves the strip: "Back on sale" would not bring it back to the diners. */
export function mergeSoldOut(
  list: SoldOutItem[],
  row: { id?: string | null; name?: string | null; sold_out_until?: string | null; is_active?: boolean | null },
  now: number,
): SoldOutItem[] {
  if (!row.id) return list;
  const existing = list.find((s) => s.id === row.id);
  const until = parseTimestamp(row.sold_out_until);
  if (row.is_active === false || !Number.isFinite(until) || until <= now) {
    return existing ? list.filter((s) => s.id !== row.id) : list;
  }
  const name = row.name ?? existing?.name;
  if (!name) return list;
  if (existing && existing.name === name && existing.sold_out_until === row.sold_out_until) return list;
  return [...list.filter((s) => s.id !== row.id), { id: row.id, name, sold_out_until: row.sold_out_until as string }].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

/** Lay a fresh read over the rows held in state.
 *
 *  A read is a snapshot of the moment it started. While it was in flight a cook may have tapped
 *  Start (an optimistic change, then its realtime echo), or a cancel may have removed a ticket;
 *  replacing everything with the snapshot put the card back in New, or brought a cancelled ticket
 *  back, until the next event. So a row changed here after the read began (`changedSince`) keeps
 *  the version held in state, and stays gone if it was removed. A held row the read could not see
 *  yet (an Undo put back a bumped ticket) stays when `keepUnseen` says so. Everything else is the
 *  read's. */
export function overlaySnapshot<T extends { id: string }>(
  held: T[],
  fresh: T[],
  changedSince: (id: string) => boolean,
  keepUnseen: (row: T) => boolean,
): T[] {
  const heldById = new Map(held.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of fresh) {
    seen.add(r.id);
    if (!changedSince(r.id)) {
      out.push(r);
      continue;
    }
    const h = heldById.get(r.id);
    if (h) out.push(h);
  }
  for (const h of held) if (!seen.has(h.id) && changedSince(h.id) && keepUnseen(h)) out.push(h);
  return out;
}

/* ── combos and stations ───────────────────────────────────────────────── */

export function parseComboContents(raw: unknown): ComboPart[] {
  if (!Array.isArray(raw)) return [];
  const out: ComboPart[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const name = [o.name, o.item_name, o.menu_item_name].find((v) => typeof v === 'string' && v.trim() !== '') as
      | string
      | undefined;
    if (!name) continue;
    const qty = Number(o.quantity ?? o.qty ?? 1);
    const id = [o.menu_item_id, o.id].find((v) => typeof v === 'string' && v !== '') as string | undefined;
    out.push({
      menu_item_id: id ?? null,
      name,
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
      station: typeof o.station === 'string' && o.station !== '' ? o.station : null,
    });
  }
  return out;
}

/** Does this line belong on a station's screen?
 *  - a line with a station: only that station;
 *  - a combo: any station one of its dishes cooks at; a dish with no station puts it everywhere;
 *  - a line with no station at all (hand-built menus, old combos): every station, so no ticket
 *    can vanish from every screen but "All". */
export function lineMatchesStation(it: OrderItem, station: string | null): boolean {
  if (!station) return true;
  if (it.station) return it.station === station;
  const parts = parseComboContents(it.combo_contents);
  if (parts.length === 0) return true;
  return parts.some((p) => p.station === null || p.station === station);
}

/** The station pills a line counts toward (same rule as lineMatchesStation). */
export function lineStations(it: OrderItem, stations: string[]): string[] {
  if (it.station) return stations.includes(it.station) ? [it.station] : [];
  const parts = parseComboContents(it.combo_contents);
  if (parts.length === 0 || parts.some((p) => p.station === null)) return stations;
  return stations.filter((s) => parts.some((p) => p.station === s));
}

/** What the card's 86 menu may mark sold out: a dish by its menu item id, and for a combo each
 *  dish inside it (a combo is not a menu item). Deduplicated by id. */
export function eightySixTargets(items: OrderItem[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const it of items) {
    if (it.menu_item_id) {
      if (!seen.has(it.menu_item_id)) seen.set(it.menu_item_id, it.item_name);
      continue;
    }
    for (const p of parseComboContents(it.combo_contents)) {
      if (p.menu_item_id && !seen.has(p.menu_item_id)) seen.set(p.menu_item_id, p.name);
    }
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

/* ── sound rules ───────────────────────────────────────────────────────── */

export const REMINDER_INTERVAL_MS = 30_000;
/** A ticket older than this in New is left-over data (a test order from last month), not a
 *  diner waiting: it stays red on the board but does not ring all night. */
export const REMINDER_MAX_AGE_MS = 12 * 3600_000;

/** How long an ACCEPTED ticket ('confirmed') waiting in New keeps reminding: about three reminders
 *  over its first two minutes. */
export const CONFIRMED_REMINDER_WINDOW_MS = 2 * 60_000;

/** Should the 30-second reminder ring? Only for a ticket that has waited in New for at least one
 *  reminder period, and not so long that it is clearly abandoned:
 *  - 'pending' (nobody has accepted it; the diner is waiting for that): every 30 s until Accept or
 *    Start cooking;
 *  - 'confirmed' (accepted already; counter, cash and dine-in orders arrive this way without anyone
 *    in the kitchen having seen them): only while it is young (CONFIRMED_REMINDER_WINDOW_MS) and
 *    nobody has touched this screen since it arrived (`heard`). It used to ring until Start cooking,
 *    so a normal queue of accepted tickets chimed every 30 s all service and cooks muted the board,
 *    new-order chimes included. */
export function reminderDue(
  board: Order[],
  now: number,
  leadMs: number,
  heard: ReadonlySet<string> = new Set(),
): boolean {
  return board.some((o) => {
    if (laneOf(o.status) !== 'new') return false;
    const age = now - workStartedMs(o, leadMs);
    if (age < REMINDER_INTERVAL_MS - 1_000 || age >= REMINDER_MAX_AGE_MS) return false;
    if (o.status === 'pending') return true;
    return !heard.has(o.id) && age < CONFIRMED_REMINDER_WINDOW_MS;
  });
}

/** The tickets a tap on the board acknowledges: every ticket in New. A pending one keeps reminding
 *  anyway until it is accepted (reminderDue ignores `heard` for it); marking it here means the tap
 *  on its own Accept button, which lands while it is still pending, also counts as seen once the
 *  ticket turns 'confirmed'. */
export function heardOnTap(board: Order[]): string[] {
  return board.filter((o) => laneOf(o.status) === 'new').map((o) => o.id);
}

/** Tickets in New or Cooking whose clock is in the late / critical tier. Ready tickets are the
 *  pass's business, not the cooks', and are left out. */
export function lateTicketIds(board: Order[], now: number, leadMs: number): string[] {
  return board
    .filter((o) => {
      const lane = laneOf(o.status);
      if (lane === 'ready') return false;
      const tier = agingTierKey(safeElapsedSec(workStartedMs(o, leadMs), now), lane);
      return tier === 'late' || tier === 'crit';
    })
    .map((o) => o.id);
}

/** "A-2609-001234" → "1 2 3 4": a speech engine reads a bare 1234 as a number. */
export function speakableTicket(orderNumber: string): string {
  return orderNumber.slice(-4).split('').join(' ');
}
