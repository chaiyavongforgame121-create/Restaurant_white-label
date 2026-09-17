import type { FloorSession, FloorTable } from '@favornoms/database/queries';

// Everything the floor board decides without touching React or the network: what a table
// card says, which sitting belongs to it, what it owes, and the order the zones come in.
// Kept pure because these are the rules that go wrong quietly — a cancelled round counted
// into a bill, a settled table still reading "Seated", zone-less tables vanishing.
//
// Nothing here is worded: labels, badges and details come back as codes and numbers, and the
// board turns them into words in the viewer's language.

export type FloorBadgeVariant = 'muted' | 'success' | 'warning' | 'neutral' | 'info';

/** Rounds in these states are not part of what the table owes. */
const VOID_ORDER_STATES = new Set(['cancelled', 'refunded']);

/** How long a party has been sitting, in whole minutes split for display. */
export interface Elapsed {
  hours: number;
  /** 0–59 once `hours` is above zero; the whole count below an hour. */
  minutes: number;
}

/** What the floor calls a table: the merchant's name for it, else its number. */
export type TableLabel = { kind: 'name'; name: string } | { kind: 'number'; number: string };

export type FloorBadgeCode = 'billRequested' | 'seated' | 'needsClearing' | 'reserved' | 'free';

export interface FloorBadge {
  code: FloorBadgeCode;
  variant: FloorBadgeVariant;
  /** Only on `seated`: how long the sitting has been open (null when the clock is unreadable). */
  elapsed?: Elapsed | null;
}

/** One piece of the card's detail line, in the order it is shown. */
export type FloorDetailPart =
  | { kind: 'type'; tableType: string }
  | { kind: 'seats'; count: number }
  | { kind: 'party'; size: number };

export interface FloorTableState {
  table: FloorTable;
  /** The open or locked sitting at this table, if any. */
  session: FloorSession | null;
  /** What the floor calls it. */
  label: TableLabel;
  badge: FloorBadge;
  /** Kind, seats and party size, in that order. Empty when there is nothing worth saying. */
  detail: FloorDetailPart[];
  /** Rounds ordered in this sitting, cancellations excluded. */
  rounds: number;
  /** What the sitting has run up so far. */
  total: number;
}

export function tableLabel(table: Pick<FloorTable, 'display_name' | 'table_number'>): TableLabel {
  const name = table.display_name?.trim();
  return name ? { kind: 'name', name } : { kind: 'number', number: table.table_number };
}

/**
 * Whole minutes since `iso`, as hours and minutes. Null for a missing or unparseable
 * timestamp. Never negative: a clock skew must not read as a nine-hour sitting.
 */
export function elapsedTime(iso: string | null | undefined, nowMs: number): Elapsed | null {
  if (!iso) return null;
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started)) return null;
  const min = Math.max(0, Math.floor((nowMs - started) / 60_000));
  if (min < 60) return { hours: 0, minutes: min };
  return { hours: Math.floor(min / 60), minutes: min % 60 };
}

/** What the sitting owes, and over how many rounds. */
export function sessionTotals(session: FloorSession | null): { rounds: number; total: number } {
  if (!session) return { rounds: 0, total: 0 };
  const live = (session.orders ?? []).filter((o) => !VOID_ORDER_STATES.has(o.status));
  return {
    rounds: live.length,
    total: live.reduce((sum, o) => sum + Number(o.total ?? 0), 0),
  };
}

function badgeFor(table: FloorTable, session: FloorSession | null, nowMs: number): FloorBadge {
  if (session?.status === 'locked') return { code: 'billRequested', variant: 'warning' };
  if (session) {
    return { code: 'seated', variant: 'success', elapsed: elapsedTime(session.opened_at, nowMs) };
  }
  // tables.status is only meaningful once a sitting has written it, which is why a table
  // that has never been seated reads Free rather than falling through to a blank badge.
  if (table.status === 'dirty') return { code: 'needsClearing', variant: 'neutral' };
  if (table.status === 'reserved') return { code: 'reserved', variant: 'info' };
  return { code: 'free', variant: 'muted' };
}

function detailFor(table: FloorTable, session: FloorSession | null): FloorDetailPart[] {
  const parts: FloorDetailPart[] = [];
  if (table.table_type && table.table_type !== 'standard') {
    parts.push({ kind: 'type', tableType: table.table_type });
  }
  if (table.capacity) parts.push({ kind: 'seats', count: table.capacity });
  if (session?.party_size) parts.push({ kind: 'party', size: session.party_size });
  return parts;
}

/**
 * Zip the branch's tables with whatever is sitting at them.
 *
 * The two are read separately because `tables` has no foreign key to `table_sessions` —
 * the arrow points the other way — so PostgREST cannot embed one on the other.
 */
export function buildFloor(
  tables: FloorTable[],
  sessions: FloorSession[],
  nowMs: number,
): FloorTableState[] {
  const byTable = new Map<string, FloorSession>();
  for (const s of sessions) {
    // The partial unique index guarantees at most one non-closed sitting per table, so the
    // first is the only one; being explicit keeps this honest if that ever changes.
    if (!byTable.has(s.table_id)) byTable.set(s.table_id, s);
  }
  return tables.map((table) => {
    const session = byTable.get(table.id) ?? null;
    const { rounds, total } = sessionTotals(session);
    return {
      table,
      session,
      label: tableLabel(table),
      badge: badgeFor(table, session, nowMs),
      detail: detailFor(table, session),
      rounds,
      total,
    };
  });
}

export interface FloorZone {
  /** Null for tables with no zone — they are a real group, not a missing one. */
  zone: string | null;
  tables: FloorTableState[];
}

/**
 * Group by zone, in the order the zones first appear (the list arrives sorted by
 * sort_order), with the zone-less tables last. A floor with no zones at all therefore
 * renders as one unlabelled group rather than as nothing.
 */
export function groupByZone(states: FloorTableState[]): FloorZone[] {
  const zones: FloorZone[] = [];
  const index = new Map<string, FloorZone>();
  const loose: FloorTableState[] = [];
  for (const state of states) {
    const zone = state.table.zone?.trim();
    if (!zone) {
      loose.push(state);
      continue;
    }
    let bucket = index.get(zone);
    if (!bucket) {
      bucket = { zone, tables: [] };
      index.set(zone, bucket);
      zones.push(bucket);
    }
    bucket.tables.push(state);
  }
  if (loose.length > 0) zones.push({ zone: null, tables: loose });
  return zones;
}

/** The one-line summary above the board. */
export function floorCounts(states: FloorTableState[]): {
  seated: number;
  free: number;
  billRequested: number;
  outstanding: number;
} {
  let seated = 0;
  let free = 0;
  let billRequested = 0;
  let outstanding = 0;
  for (const state of states) {
    if (state.session) {
      seated += 1;
      outstanding += state.total;
      if (state.session.status === 'locked') billRequested += 1;
    } else if (state.table.status !== 'dirty') {
      free += 1;
    }
  }
  return { seated, free, billRequested, outstanding };
}
