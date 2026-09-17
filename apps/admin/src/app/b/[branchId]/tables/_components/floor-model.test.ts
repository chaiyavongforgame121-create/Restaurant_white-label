import { describe, expect, it } from 'vitest';
import type { FloorSession, FloorTable } from '@favornoms/database/queries';
import {
  buildFloor,
  elapsedTime,
  floorCounts,
  groupByZone,
  sessionTotals,
  tableLabel,
} from './floor-model';

// The shapes here are the ones the floor board actually gets: a table that has never been
// seated (status 'open', no sitting), a table settled a minute ago (status 'dirty', no
// sitting), a sitting with a cancelled round in it, and tables with no zone at all.

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

function table(over: Partial<FloorTable> = {}): FloorTable {
  return {
    id: 't1',
    table_number: '1',
    display_name: null,
    capacity: null,
    zone: null,
    table_type: 'standard',
    sort_order: 1,
    status: 'open',
    is_active: true,
    qr_code_token: 'tok',
    ...over,
  };
}

function session(over: Partial<FloorSession> = {}): FloorSession {
  return {
    id: 's1',
    table_id: 't1',
    status: 'open',
    opened_at: new Date(NOW - 42 * 60_000).toISOString(),
    expires_at: new Date(NOW + 60 * 60_000).toISOString(),
    bill_requested_at: null,
    party_size: null,
    session_code: '1234',
    orders: [],
    ...over,
  };
}

describe('tableLabel', () => {
  it('prefers the table name and falls back to the number', () => {
    expect(tableLabel({ display_name: 'Window booth', table_number: '7' })).toEqual({
      kind: 'name',
      name: 'Window booth',
    });
    expect(tableLabel({ display_name: '   ', table_number: '7' })).toEqual({ kind: 'number', number: '7' });
    expect(tableLabel({ display_name: null, table_number: '7' })).toEqual({ kind: 'number', number: '7' });
  });
});

describe('elapsedTime', () => {
  it('reads minutes, then hours and minutes', () => {
    expect(elapsedTime(new Date(NOW - 42 * 60_000).toISOString(), NOW)).toEqual({ hours: 0, minutes: 42 });
    expect(elapsedTime(new Date(NOW - 65 * 60_000).toISOString(), NOW)).toEqual({ hours: 1, minutes: 5 });
  });

  it('never goes negative — a clock skew must not read as a nine-hour sitting', () => {
    expect(elapsedTime(new Date(NOW + 5 * 60_000).toISOString(), NOW)).toEqual({ hours: 0, minutes: 0 });
  });

  it('survives a missing or unparseable timestamp', () => {
    expect(elapsedTime(null, NOW)).toBeNull();
    expect(elapsedTime('not a date', NOW)).toBeNull();
  });
});

describe('sessionTotals', () => {
  it('leaves cancelled and refunded rounds out of the bill', () => {
    const s = session({
      orders: [
        { id: 'o1', order_number: 'A-1', status: 'confirmed', total: 20, session_seq: 1, created_at: '' },
        { id: 'o2', order_number: 'A-2', status: 'cancelled', total: 99, session_seq: 2, created_at: '' },
        { id: 'o3', order_number: 'A-3', status: 'ready', total: '12.5', session_seq: 3, created_at: '' },
      ],
    });
    expect(sessionTotals(s)).toEqual({ rounds: 2, total: 32.5 });
  });

  it('is zero for a table with nobody at it', () => {
    expect(sessionTotals(null)).toEqual({ rounds: 0, total: 0 });
  });
});

describe('buildFloor', () => {
  it('marks a seated table with how long the party has been there', () => {
    const [state] = buildFloor([table()], [session()], NOW);
    expect(state!.badge).toEqual({ code: 'seated', variant: 'success', elapsed: { hours: 0, minutes: 42 } });
  });

  it('shows a locked sitting as the bill request it is, not as time elapsed', () => {
    const [state] = buildFloor([table()], [session({ status: 'locked' })], NOW);
    expect(state!.badge).toEqual({ code: 'billRequested', variant: 'warning' });
  });

  it('reads a just-settled table as needing clearing, and a fresh one as free', () => {
    const [dirty] = buildFloor([table({ status: 'dirty' })], [], NOW);
    expect(dirty!.badge.code).toBe('needsClearing');
    const [fresh] = buildFloor([table({ status: 'open' })], [], NOW);
    expect(fresh!.badge.code).toBe('free');
  });

  it('ignores a sitting belonging to another table', () => {
    const [state] = buildFloor([table({ id: 't1' })], [session({ table_id: 't9' })], NOW);
    expect(state!.session).toBeNull();
    expect(state!.badge.code).toBe('free');
  });

  it('describes the kind, the seats and the party in one line', () => {
    const [state] = buildFloor(
      [table({ table_type: 'high_top', capacity: 4 })],
      [session({ party_size: 3 })],
      NOW,
    );
    expect(state!.detail).toEqual([
      { kind: 'type', tableType: 'high_top' },
      { kind: 'seats', count: 4 },
      { kind: 'party', size: 3 },
    ]);
  });

  it('says nothing about a plain table with no seats recorded', () => {
    const [state] = buildFloor([table()], [], NOW);
    expect(state!.detail).toEqual([]);
  });
});

describe('groupByZone', () => {
  it('keeps zone order and puts the zone-less tables last', () => {
    const states = buildFloor(
      [
        table({ id: 'a', table_number: '1', zone: 'Terrace' }),
        table({ id: 'b', table_number: '2', zone: null }),
        table({ id: 'c', table_number: '3', zone: 'Terrace' }),
        table({ id: 'd', table_number: '4', zone: 'Bar' }),
      ],
      [],
      NOW,
    );
    const zones = groupByZone(states);
    expect(zones.map((z) => z.zone)).toEqual(['Terrace', 'Bar', null]);
    expect(zones[0]!.tables.map((t) => t.table.id)).toEqual(['a', 'c']);
  });

  it('renders a floor with no zones as one unlabelled group rather than as nothing', () => {
    const states = buildFloor([table(), table({ id: 't2', table_number: '2' })], [], NOW);
    const zones = groupByZone(states);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.zone).toBeNull();
    expect(zones[0]!.tables).toHaveLength(2);
  });
});

describe('floorCounts', () => {
  it('counts seated, free and bills waiting, and sums what the floor owes', () => {
    const states = buildFloor(
      [
        table({ id: 'a', table_number: '1' }),
        table({ id: 'b', table_number: '2' }),
        table({ id: 'c', table_number: '3', status: 'dirty' }),
      ],
      [
        session({
          id: 's1',
          table_id: 'a',
          orders: [
            { id: 'o1', order_number: 'A-1', status: 'confirmed', total: 30, session_seq: 1, created_at: '' },
          ],
        }),
      ],
      NOW,
    );
    // The dirty table is neither seated nor free — it needs a hand before the next party.
    expect(floorCounts(states)).toEqual({
      seated: 1,
      free: 1,
      billRequested: 0,
      outstanding: 30,
    });
  });
});
