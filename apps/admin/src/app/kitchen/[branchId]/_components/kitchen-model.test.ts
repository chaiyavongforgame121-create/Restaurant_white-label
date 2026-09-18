import { describe, expect, it } from 'vitest';
import {
  eightySixTargets,
  fmtTimer,
  heardOnTap,
  isLineDone,
  isOnBoard,
  lateTicketIds,
  lineMatchesStation,
  lineStations,
  mergeSoldOut,
  overlaySnapshot,
  parseComboContents,
  parseTimestamp,
  readyStartedMs,
  reminderDue,
  safeElapsedSec,
  speakableTicket,
  type Order,
  type OrderItem,
} from './kitchen-model';

const T0 = Date.parse('2026-09-18T12:00:00Z');

function order(partial: Partial<Order>): Order {
  return {
    id: 'o1',
    order_number: 'A-2609-001234',
    status: 'pending',
    channel: 'pickup',
    created_at: new Date(T0).toISOString(),
    order_items: [{ id: 'l1', item_name: 'Pad Thai', quantity: 1, menu_item_id: 'm1' }],
    ...partial,
  };
}

const fmt = {
  hoursMinutes: (h: number, m: number) => `${h}h ${m}m`,
  daysHours: (d: number, h: number) => `${d}d ${h}h`,
};

describe('timestamps and the Ready clock', () => {
  it('reads both the ISO and the Postgres text forms status_history holds', () => {
    expect(parseTimestamp('2026-09-18T00:45:33.322Z')).toBe(Date.parse('2026-09-18T00:45:33.322Z'));
    expect(parseTimestamp('2026-09-18 00:45:33.573215+00')).toBe(Date.parse('2026-09-18T00:45:33.573Z'));
    expect(parseTimestamp('2026-09-18 00:45:33+07')).toBe(Date.parse('2026-09-17T17:45:33Z'));
    expect(Number.isNaN(parseTimestamp(null))).toBe(true);
  });

  it('starts the Ready clock at the last ready entry, not at page load', () => {
    const o = order({
      status: 'ready',
      status_history: [
        { status: 'pending', at: '2026-09-18T10:00:00.000Z' },
        { status: 'ready', at: '2026-09-18 10:05:00+00' },
        { status: 'preparing', at: '2026-09-18 10:06:00+00' },
        { status: 'ready', at: '2026-09-18 10:20:00.123456+00' },
      ],
    });
    expect(readyStartedMs(o)).toBe(Date.parse('2026-09-18T10:20:00.123Z'));
    // A newer local press (echo not back yet) wins; an older one does not.
    expect(readyStartedMs(o, Date.parse('2026-09-18T10:21:00Z'))).toBe(Date.parse('2026-09-18T10:21:00Z'));
    expect(readyStartedMs(o, Date.parse('2026-09-18T10:00:00Z'))).toBe(Date.parse('2026-09-18T10:20:00.123Z'));
  });

  it('falls back to created_at when the history has no ready entry', () => {
    expect(readyStartedMs(order({ status: 'ready', status_history: null }))).toBe(T0);
  });

  it('shows an old ticket as old: no 12-hour clamp to 0, only skew is clamped', () => {
    expect(safeElapsedSec(T0, T0 + 13 * 3600_000)).toBe(13 * 3600);
    expect(safeElapsedSec(T0 + 5_000, T0)).toBe(0);
    expect(fmtTimer(13 * 3600 + 5 * 60, fmt)).toBe('13h 5m');
    expect(fmtTimer(2 * 86_400 + 3 * 3600, fmt)).toBe('2d 3h');
    expect(fmtTimer(65, fmt)).toBe('1:05');
  });
});

describe('what is on the board', () => {
  it('keeps a ticket without lines off the board', () => {
    expect(isOnBoard(order({}))).toBe(true);
    expect(isOnBoard(order({ order_items: [] }))).toBe(false);
    expect(isOnBoard(order({ held: true }))).toBe(false);
    expect(isOnBoard(order({ awaiting_payment: true }))).toBe(false);
    expect(isOnBoard(order({ status: 'completed' }))).toBe(false);
  });

  it('treats ready and served lines as done', () => {
    expect(isLineDone({ prep_status: 'ready' })).toBe(true);
    expect(isLineDone({ prep_status: 'served' })).toBe(true);
    expect(isLineDone({ prep_status: 'pending' })).toBe(false);
    expect(isLineDone({})).toBe(false);
  });
});

describe('stations and combos', () => {
  const hot: OrderItem = { id: 'a', item_name: 'Curry', quantity: 1, station: 'hot', menu_item_id: 'm1' };
  const none: OrderItem = { id: 'b', item_name: 'Soup', quantity: 1, station: null, menu_item_id: 'm2' };
  const combo: OrderItem = {
    id: 'c',
    item_name: 'Family Meal',
    quantity: 2,
    station: null,
    menu_item_id: null,
    combo_id: 'k1',
    combo_contents: [
      { menu_item_id: 'm3', name: 'Green Curry', quantity: 1, station: 'hot' },
      { menu_item_id: 'm4', name: 'Iced Tea', quantity: 2, station: 'bar' },
    ],
  };

  it('parses combo contents defensively', () => {
    expect(parseComboContents(combo.combo_contents)).toEqual([
      { menu_item_id: 'm3', name: 'Green Curry', quantity: 1, station: 'hot' },
      { menu_item_id: 'm4', name: 'Iced Tea', quantity: 2, station: 'bar' },
    ]);
    expect(parseComboContents(null)).toEqual([]);
    expect(parseComboContents([{ name: null }, 'x', { name: 'Rice', quantity: 0 }])).toEqual([
      { menu_item_id: null, name: 'Rice', quantity: 1, station: null },
    ]);
  });

  it('shows a line with no station on every station, and a combo where its dishes cook', () => {
    expect(lineMatchesStation(hot, 'hot')).toBe(true);
    expect(lineMatchesStation(hot, 'bar')).toBe(false);
    expect(lineMatchesStation(none, 'bar')).toBe(true);
    expect(lineMatchesStation(combo, 'bar')).toBe(true);
    expect(lineMatchesStation(combo, 'cold')).toBe(false);
    expect(lineMatchesStation({ ...combo, combo_contents: null }, 'cold')).toBe(true);
    expect(lineMatchesStation(hot, null)).toBe(true);
  });

  it('counts a line toward the matching station pills', () => {
    const stations = ['bar', 'cold', 'hot'];
    expect(lineStations(hot, stations)).toEqual(['hot']);
    expect(lineStations(none, stations)).toEqual(stations);
    expect(lineStations(combo, stations)).toEqual(['bar', 'hot']);
  });

  it('86es dishes by id, and a combo by the dishes inside it', () => {
    expect(eightySixTargets([hot, combo, { ...hot, id: 'dup' }])).toEqual([
      { id: 'm1', name: 'Curry' },
      { id: 'm3', name: 'Green Curry' },
      { id: 'm4', name: 'Iced Tea' },
    ]);
    expect(eightySixTargets([{ ...combo, combo_contents: null }])).toEqual([]);
  });
});

describe('sold-out strip', () => {
  const now = T0;
  const later = new Date(T0 + 3600_000).toISOString();

  it('adds, keeps and drops items by sold_out_until', () => {
    const one = mergeSoldOut([], { id: 'm1', name: 'Pad Thai', sold_out_until: later }, now);
    expect(one).toEqual([{ id: 'm1', name: 'Pad Thai', sold_out_until: later }]);
    // A stock-only update of the same dish returns the same array (no repaint).
    expect(mergeSoldOut(one, { id: 'm1', name: 'Pad Thai', sold_out_until: later }, now)).toBe(one);
    // An update of a dish that is not sold out changes nothing.
    expect(mergeSoldOut(one, { id: 'm2', name: 'Soup', sold_out_until: null }, now)).toBe(one);
    // Back on sale, or expired.
    expect(mergeSoldOut(one, { id: 'm1', name: 'Pad Thai', sold_out_until: null }, now)).toEqual([]);
    expect(mergeSoldOut(one, { id: 'm1', name: 'Pad Thai', sold_out_until: new Date(T0 - 1).toISOString() }, now)).toEqual([]);
  });

  it('drops a dish taken off the menu, and never adds one', () => {
    const one = mergeSoldOut([], { id: 'm1', name: 'Pad Thai', sold_out_until: later }, now);
    expect(mergeSoldOut(one, { id: 'm1', name: 'Pad Thai', sold_out_until: later, is_active: false }, now)).toEqual([]);
    expect(mergeSoldOut([], { id: 'm2', name: 'Soup', sold_out_until: later, is_active: false }, now)).toEqual([]);
  });
});

describe('board reads vs newer changes', () => {
  const a = { id: 'a', v: 'read' };
  const b = { id: 'b', v: 'read' };

  it('takes the read for rows nobody changed since it started', () => {
    const held = [{ id: 'a', v: 'held' }, { id: 'gone', v: 'held' }];
    expect(overlaySnapshot(held, [a, b], () => false, () => true)).toEqual([a, b]);
  });

  it('keeps the held row when it changed after the read began (a tap and its echo)', () => {
    const held = [{ id: 'a', v: 'held' }];
    expect(overlaySnapshot(held, [a, b], (id) => id === 'a', () => true)).toEqual([{ id: 'a', v: 'held' }, b]);
  });

  it('does not bring back a row removed after the read began (a cancel)', () => {
    expect(overlaySnapshot([b], [a, b], (id) => id === 'a', () => true)).toEqual([b]);
  });

  it('keeps a row the read could not see yet only when asked to (an Undo put back)', () => {
    const putBack = { id: 'c', v: 'held' };
    expect(overlaySnapshot([putBack], [a], (id) => id === 'c', () => true)).toEqual([a, putBack]);
    expect(overlaySnapshot([putBack], [a], (id) => id === 'c', () => false)).toEqual([a]);
    expect(overlaySnapshot([putBack], [a], () => false, () => true)).toEqual([a]);
  });
});

describe('sound rules', () => {
  it('reminds while a ticket has waited in New for a reminder period, not for abandoned ones', () => {
    const fresh = order({ created_at: new Date(T0 - 5_000).toISOString() });
    const waiting = order({ created_at: new Date(T0 - 40_000).toISOString() });
    const cooking = order({ status: 'preparing', created_at: new Date(T0 - 40_000).toISOString() });
    const abandoned = order({ created_at: new Date(T0 - 13 * 3600_000).toISOString() });
    expect(reminderDue([fresh], T0, 0)).toBe(false);
    expect(reminderDue([waiting], T0, 0)).toBe(true);
    expect(reminderDue([cooking], T0, 0)).toBe(false);
    expect(reminderDue([abandoned], T0, 0)).toBe(false);
  });

  it('keeps reminding for a pending ticket until it is accepted, whoever has touched the screen', () => {
    const pending = order({ id: 'p', created_at: new Date(T0 - 10 * 60_000).toISOString() });
    expect(reminderDue([pending], T0, 0, new Set(['p']))).toBe(true);
  });

  it('reminds for an accepted ticket only while it is young and nobody has touched the screen', () => {
    const accepted = order({ id: 'c', status: 'confirmed', created_at: new Date(T0 - 40_000).toISOString() });
    expect(reminderDue([accepted], T0, 0)).toBe(true);
    // Heard: a tap on the board since it arrived.
    expect(reminderDue([accepted], T0, 0, new Set(['c']))).toBe(false);
    // A queue of accepted tickets no longer rings all service.
    const queued = order({ id: 'q', status: 'confirmed', created_at: new Date(T0 - 5 * 60_000).toISOString() });
    expect(reminderDue([queued], T0, 0)).toBe(false);
  });

  it('a tap acknowledges the tickets in New; a pending one still rings until accepted', () => {
    const board = [
      order({ id: 'p', status: 'pending', created_at: new Date(T0 - 40_000).toISOString() }),
      order({ id: 'c', status: 'confirmed' }),
      order({ id: 'k', status: 'preparing' }),
      order({ id: 'r', status: 'ready' }),
    ];
    const heard = new Set(heardOnTap(board));
    expect([...heard]).toEqual(['p', 'c']);
    expect(reminderDue([board[0]!], T0, 0, heard)).toBe(true);
    // The tap on its Accept button landed while it was pending: once accepted it is seen.
    expect(reminderDue([{ ...board[0]!, status: 'confirmed' }], T0, 0, heard)).toBe(false);
  });

  it('lists New and Cooking tickets in the late tier, never Ready ones', () => {
    const late = order({ id: 'late', status: 'preparing', created_at: new Date(T0 - 16 * 60_000).toISOString() });
    const ok = order({ id: 'ok', created_at: new Date(T0 - 60_000).toISOString() });
    const ready = order({ id: 'ready', status: 'ready', created_at: new Date(T0 - 60 * 60_000).toISOString() });
    expect(lateTicketIds([late, ok, ready], T0, 0)).toEqual(['late']);
  });

  it('spells the ticket number for speech', () => {
    expect(speakableTicket('A-2609-001234')).toBe('1 2 3 4');
  });
});
