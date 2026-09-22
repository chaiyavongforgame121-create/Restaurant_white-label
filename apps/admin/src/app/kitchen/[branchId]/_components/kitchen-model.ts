/* Pure data and timing rules of the kitchen board, kept out of the 'use client' view so the
   server page can share the select and the rules can be unit-tested. */

import type { BranchRider } from '@favornoms/database/queries';
import { sortOrderLines } from '@favornoms/shared';

/** Everything the board reads per ticket. page.tsx (first paint) and the view's reload() must
 *  select the same shape, or a refetch silently drops a field a card relies on. */
export const KITCHEN_ORDER_SELECT =
  'id, order_number, status, status_history, channel, created_at, customer_name, customer_notes, kitchen_notes, held, awaiting_payment, scheduled_for, table_id, tables(table_number, display_name), order_items(id, menu_item_id, combo_id, combo_contents, item_name, quantity, notes, prep_status, station, modifiers, category_position, item_position, created_at), deliveries(id, status, driver_id, accepted_at, batch_id, batch_seq)';

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
  /** Where the dish sits on the menu. A ticket lists its lines in that order (linesInMenuOrder). */
  category_position?: number | null;
  item_position?: number | null;
  created_at?: string | null;
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

/** What the board says about itself, as keys under kitchen.header. */
export interface BoardHealth {
  /** The full-width red bar: the board is not to be trusted while it is up. One at a time. */
  banner: 'connectionLost' | 'readFailed' | null;
  /** The header's status line. */
  status: 'statusLive' | 'statusReconnecting' | 'statusRetrying';
  /** May an empty lane say "All clear"? */
  allClear: boolean;
}

/** `socketHealthy`: realtime is connected. `readFailed`: the last read of the tickets was refused.
 *  A refused read used to leave an empty board saying "0 active · live" and "All clear, chef."
 *  (the select named a column the database did not have yet, and no ticket reached the kitchen);
 *  an empty lane is only "clear" when the read that emptied it worked. A dropped socket keeps its
 *  own bar and wins: it is the one that explains a failed read as well. */
export function boardHealth(socketHealthy: boolean, readFailed: boolean): BoardHealth {
  if (!socketHealthy) return { banner: 'connectionLost', status: 'statusReconnecting', allClear: !readFailed };
  if (readFailed) return { banner: 'readFailed', status: 'statusRetrying', allClear: false };
  return { banner: null, status: 'statusLive', allClear: true };
}

/** A line the cook has ticked off. */
export function isLineDone(it: Pick<OrderItem, 'prep_status'>): boolean {
  return it.prep_status === 'ready' || it.prep_status === 'served';
}

/** A ticket with its lines in menu order, category by category, as the bill lists them. Applied
 *  wherever lines reach the board (first paint, a re-read, a line's realtime UPDATE, which is how
 *  the owner reordering the menu arrives), so the cards, the batch view and the 86 list all read
 *  the same order. The same ticket comes back when its lines are already in order. */
export function linesInMenuOrder<T extends Pick<Order, 'order_items'>>(o: T): T {
  const sorted = sortOrderLines(o.order_items);
  return sorted.every((it, i) => it === o.order_items[i]) ? o : { ...o, order_items: sorted };
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

/** The station key, filter value and ?station= value of the "No station" pill: lines whose dish has
 *  no station. The underscore keeps it apart from the station codes the menu editor, menu import and
 *  the CSV write (hot, cold, bar, dessert, expo). */
export const NO_STATION = '_none';

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

/** The dishes of a combo line, as the card lists them; none for a dish line. */
export function comboParts(it: OrderItem): ComboPart[] {
  return it.menu_item_id ? [] : parseComboContents(it.combo_contents);
}

/** Where one dish of a combo is made: its station, or NO_STATION. */
export function partStation(p: ComboPart): string {
  return p.station ?? NO_STATION;
}

/** Where a line is made, as the station keys it counts toward:
 *  - a combo: the stations of the dishes inside it;
 *  - any other line (and a combo whose dishes are unreadable): its own station;
 *  - no station at all: NO_STATION, and nothing else.
 *  A line with no station used to be put on EVERY station, so that no ticket could vanish from every
 *  screen but "All". That filled the Dessert screen with the soups and the drink of a ticket placed
 *  before the owner had given those dishes a station. Such a line is now found under "No station",
 *  and order_items.station follows the menu while the order is in the kitchen (migration
 *  20260922110000_kitchen_station_follows_menu), so giving the dish a station moves the line. */
export function lineStationKeys(it: OrderItem): string[] {
  const parts = comboParts(it);
  if (parts.length > 0) return [...new Set(parts.map(partStation))];
  return [it.station || NO_STATION];
}

/** Does this line belong on the screen filtered to `station` (null: All)? */
export function lineMatchesStation(it: OrderItem, station: string | null): boolean {
  return !station || lineStationKeys(it).includes(station);
}

/** Within a combo only the filtered station's dishes count: the card greys the others, and the
 *  batch strip leaves them out. */
export function partMatchesStation(p: ComboPart, station: string | null): boolean {
  return !station || partStation(p) === station;
}

/** The station pills after "All", in order: every station the menu uses and every station a line on
 *  the board is made at (a dish moved to a new station mid-service brings its pill along), sorted;
 *  then "No station", only while a line on the board has none. The active filter always keeps its
 *  pill, so the board is never filtered by something the bar does not show (the last ticket without
 *  a station bumped, a bookmarked ?station= the menu no longer uses). */
export function stationPills(menuStations: string[], board: Order[], active: string | null): string[] {
  const named = new Set(menuStations.filter((s) => s !== '' && s !== NO_STATION));
  let unassigned = active === NO_STATION;
  for (const o of board) {
    for (const it of o.order_items) {
      for (const key of lineStationKeys(it)) {
        if (key === NO_STATION) unassigned = true;
        else named.add(key);
      }
    }
  }
  if (active && active !== NO_STATION) named.add(active);
  const pills = [...named].sort();
  if (unassigned) pills.push(NO_STATION);
  return pills;
}

export interface StationStat {
  /** Tickets on the board with at least one line made at this station. */
  count: number;
  /** One of those tickets is late or critical. */
  drown: boolean;
}

/** Each pill's figure, in TICKETS: the unit "All" counts in. Counting lines put "Hot 11" beside
 *  "All 5" on a board of five tickets. */
export function stationStats(board: Order[], pills: string[], isLate: (o: Order) => boolean): Record<string, StationStat> {
  const stats: Record<string, StationStat> = {};
  for (const s of pills) stats[s] = { count: 0, drown: false };
  for (const o of board) {
    const keys = new Set(o.order_items.flatMap(lineStationKeys));
    const late = isLate(o);
    for (const key of keys) {
      const stat = stats[key];
      if (!stat) continue;
      stat.count += 1;
      if (late) stat.drown = true;
    }
  }
  return stats;
}

export interface BatchGroup {
  name: string;
  qty: number;
  /** "#1234 ×2", one per line that went into the total. */
  sources: string[];
}

/** The batch strip: how many of each dish the tickets being cooked add up to, under the station
 *  filter. A combo counts as the dishes inside it (the cook makes two soups, not "a Family Meal"),
 *  and only the filtered station's dishes; any other line by the same rule as the cards. Dishes are
 *  grouped by name and modifiers (`modsKey`), the largest total first. */
export function batchGroups(
  cooking: Order[],
  station: string | null,
  modsKey: (modifiers: unknown) => string,
): BatchGroup[] {
  const map = new Map<string, BatchGroup>();
  const add = (name: string, mods: string, qty: number, ticket: string) => {
    const sig = `${name}|${mods}`;
    const g = map.get(sig) ?? { name, qty: 0, sources: [] };
    g.qty += qty;
    g.sources.push(`#${ticket} ×${qty}`);
    map.set(sig, g);
  };
  for (const o of cooking) {
    const ticket = o.order_number.slice(-4);
    for (const it of o.order_items) {
      const parts = comboParts(it);
      if (parts.length > 0) {
        for (const p of parts) if (partMatchesStation(p, station)) add(p.name, '', p.quantity * it.quantity, ticket);
        continue;
      }
      if (lineMatchesStation(it, station)) add(it.item_name, modsKey(it.modifiers), it.quantity, ticket);
    }
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty);
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
