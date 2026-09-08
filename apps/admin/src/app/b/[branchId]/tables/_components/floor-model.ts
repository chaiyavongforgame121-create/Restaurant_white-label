import type { FloorSession, FloorTable } from '@favornoms/database/queries';

// Everything the floor board decides without touching React or the network: what a table
// card says, which sitting belongs to it, what it owes, and the order the zones come in.
// Kept pure because these are the rules that go wrong quietly — a cancelled round counted
// into a bill, a settled table still reading "Seated", zone-less tables vanishing.

export type FloorBadgeVariant = 'muted' | 'success' | 'warning' | 'neutral' | 'info';

/** Rounds in these states are not part of what the table owes. */
const VOID_ORDER_STATES = new Set(['cancelled', 'refunded']);

export interface FloorTableState {
  table: FloorTable;
  /** The open or locked sitting at this table, if any. */
  session: FloorSession | null;
  /** What the floor calls it. */
  label: string;
  badge: { text: string; variant: FloorBadgeVariant };
  /** Kind, seats and party size as one line. Empty when there is nothing worth saying. */
  detail: string;
  /** Rounds ordered in this sitting, cancellations excluded. */
  rounds: number;
  /** What the sitting has run up so far. */
  total: number;
}

export function tableLabel(table: Pick<FloorTable, 'display_name' | 'table_number'>): string {
  return table.display_name?.trim() || `Table ${table.table_number}`;
}

/** '42m', '1h 05m', '—'. Never negative: a clock skew must not read as a nine-hour sitting. */
export function elapsedLabel(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '—';
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started)) return '—';
  const min = Math.max(0, Math.floor((nowMs - started) / 60_000));
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
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

function badgeFor(
  table: FloorTable,
  session: FloorSession | null,
  nowMs: number,
): { text: string; variant: FloorBadgeVariant } {
  if (session?.status === 'locked') return { text: 'Bill requested', variant: 'warning' };
  if (session) return { text: `Seated · ${elapsedLabel(session.opened_at, nowMs)}`, variant: 'success' };
  // tables.status is only meaningful once a sitting has written it, which is why a table
  // that has never been seated reads Free rather than falling through to a blank badge.
  if (table.status === 'dirty') return { text: 'Needs clearing', variant: 'neutral' };
  if (table.status === 'reserved') return { text: 'Reserved', variant: 'info' };
  return { text: 'Free', variant: 'muted' };
}

function detailFor(table: FloorTable, session: FloorSession | null): string {
  const kind =
    table.table_type && table.table_type !== 'standard'
      ? table.table_type.replace(/_/g, ' ')
      : null;
  const seats = table.capacity ? `${table.capacity} seats` : null;
  const party = session?.party_size ? `party of ${session.party_size}` : null;
  return [kind, seats, party].filter(Boolean).join(' · ');
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
