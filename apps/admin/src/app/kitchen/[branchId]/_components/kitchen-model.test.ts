import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NO_STATION,
  batchGroups,
  boardHealth,
  eightySixTargets,
  fmtTimer,
  heardOnTap,
  isLineDone,
  isOnBoard,
  lateTicketIds,
  lineMatchesStation,
  lineStationKeys,
  linesInMenuOrder,
  mergeSoldOut,
  overlaySnapshot,
  parseComboContents,
  parseTimestamp,
  partMatchesStation,
  readyStartedMs,
  reminderDue,
  safeElapsedSec,
  speakableTicket,
  stationPills,
  stationStats,
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

  it('shows a line only where it is made, and a line with no station only under "No station"', () => {
    expect(lineMatchesStation(hot, 'hot')).toBe(true);
    expect(lineMatchesStation(hot, 'bar')).toBe(false);
    expect(lineMatchesStation(hot, NO_STATION)).toBe(false);
    // Order #0005: Tom Yum with no station no longer shows on the Dessert screen.
    expect(lineMatchesStation(none, 'dessert')).toBe(false);
    expect(lineMatchesStation(none, NO_STATION)).toBe(true);
    expect(lineMatchesStation({ ...hot, station: '' }, NO_STATION)).toBe(true);
    // All shows everything.
    expect(lineMatchesStation(hot, null)).toBe(true);
    expect(lineMatchesStation(none, null)).toBe(true);
  });

  it('shows a combo where one of its dishes is made, and only that station counts inside it', () => {
    expect(lineStationKeys(combo)).toEqual(['hot', 'bar']);
    expect(lineMatchesStation(combo, 'bar')).toBe(true);
    expect(lineMatchesStation(combo, 'cold')).toBe(false);
    expect(lineMatchesStation(combo, NO_STATION)).toBe(false);
    const [curry, tea] = parseComboContents(combo.combo_contents);
    expect(partMatchesStation(curry!, 'bar')).toBe(false);
    expect(partMatchesStation(tea!, 'bar')).toBe(true);
    expect(partMatchesStation(tea!, null)).toBe(true);
    // A dish of the combo with no station is "No station"'s, not every station's.
    const mixed: OrderItem = {
      ...combo,
      combo_contents: [
        { menu_item_id: 'm3', name: 'Green Curry', quantity: 1, station: 'hot' },
        { menu_item_id: 'm5', name: 'Rice', quantity: 1, station: null },
      ],
    };
    expect(lineStationKeys(mixed)).toEqual(['hot', NO_STATION]);
    expect(lineMatchesStation(mixed, 'bar')).toBe(false);
    expect(partMatchesStation(parseComboContents(mixed.combo_contents)[1]!, 'hot')).toBe(false);
    expect(partMatchesStation(parseComboContents(mixed.combo_contents)[1]!, NO_STATION)).toBe(true);
    // A combo whose dishes cannot be read falls back to the line's own station.
    expect(lineStationKeys({ ...combo, combo_contents: null })).toEqual([NO_STATION]);
    expect(lineMatchesStation({ ...combo, combo_contents: null }, 'cold')).toBe(false);
  });

  it('lists the pills: menu stations and board stations, then "No station" only while a line has none', () => {
    const board = [order({ order_items: [hot, combo] })];
    expect(stationPills(['cold', 'hot'], board, null)).toEqual(['bar', 'cold', 'hot']);
    expect(stationPills(['cold', 'hot'], [order({ order_items: [hot, none] })], null)).toEqual(['cold', 'hot', NO_STATION]);
    // The active filter keeps its pill even with nothing left under it.
    expect(stationPills(['hot'], board, NO_STATION)).toEqual(['bar', 'hot', NO_STATION]);
    expect(stationPills(['hot'], [], 'grill')).toEqual(['grill', 'hot']);
    expect(stationPills(['', NO_STATION, 'hot'], [], null)).toEqual(['hot']);
  });

  it('counts TICKETS per pill, like All, and flags a pill when one of its tickets is late', () => {
    // The owner's board: five tickets, "Hot 11" counted lines.
    const t1 = order({ id: 't1', order_items: [hot, { ...hot, id: 'a2' }, { ...hot, id: 'a3' }] });
    const t2 = order({ id: 't2', order_items: [hot, none, combo] });
    const t3 = order({ id: 't3', order_items: [{ ...hot, id: 'd', station: 'dessert' }] });
    const pills = stationPills(['dessert', 'hot'], [t1, t2, t3], null);
    const stats = stationStats([t1, t2, t3], pills, (o) => o.id === 't3');
    expect(stats).toEqual({
      bar: { count: 1, drown: false },
      dessert: { count: 1, drown: true },
      hot: { count: 2, drown: false },
      [NO_STATION]: { count: 1, drown: false },
    });
  });

  it('adds up the batch strip by the same rule as the cards', () => {
    const cooking = [
      order({ id: 'k1', order_number: 'A-2609-000001', order_items: [hot, none, combo] }),
      order({ id: 'k2', order_number: 'A-2609-000002', order_items: [{ ...hot, id: 'a2', quantity: 2 }] }),
    ];
    const mods = () => '';
    expect(batchGroups(cooking, 'hot', mods)).toEqual([
      { name: 'Curry', qty: 3, sources: ['#0001 ×1', '#0002 ×2'] },
      { name: 'Green Curry', qty: 2, sources: ['#0001 ×2'] },
    ]);
    expect(batchGroups(cooking, 'bar', mods)).toEqual([{ name: 'Iced Tea', qty: 4, sources: ['#0001 ×4'] }]);
    expect(batchGroups(cooking, NO_STATION, mods)).toEqual([{ name: 'Soup', qty: 1, sources: ['#0001 ×1'] }]);
    expect(batchGroups(cooking, null, mods).map((g) => [g.name, g.qty])).toEqual([
      ['Iced Tea', 4],
      ['Curry', 3],
      ['Green Curry', 2],
      ['Soup', 1],
    ]);
    // Modifiers split a dish into its own group.
    const spicy = (m: unknown) => (m ? 'spicy' : '');
    expect(batchGroups([order({ order_items: [hot, { ...hot, id: 'x', modifiers: ['spicy'] }] })], 'hot', spicy)).toHaveLength(2);
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

describe('lines in menu order', () => {
  // Order A-2609-0005 as tapped: SET A, a drink, two soups, another SET A.
  const lines: OrderItem[] = [
    { id: 'l1', item_name: 'SET A', quantity: 1, category_position: 10, item_position: 0, modifiers: [{ name: 'No Egg' }] },
    { id: 'l2', item_name: 'Fountain Drink', quantity: 1, category_position: 11, item_position: 0 },
    { id: 'l3', item_name: 'Tom Yum Soup', quantity: 1, category_position: 2, item_position: 1 },
    { id: 'l4', item_name: 'Tom Kha Soup', quantity: 1, category_position: 2, item_position: 3 },
    { id: 'l5', item_name: 'SET A', quantity: 1, category_position: 10, item_position: 0, modifiers: [{ name: 'Runny-Yolk Fried Egg' }] },
  ];

  it('lists a ticket category by category: soups, the two sets side by side, then the drink', () => {
    const sorted = linesInMenuOrder(order({ order_items: lines }));
    expect(sorted.order_items.map((it) => it.id)).toEqual(['l3', 'l4', 'l1', 'l5', 'l2']);
  });

  it('hands back the same ticket when its lines are already in order', () => {
    const sorted = linesInMenuOrder(order({ order_items: lines }));
    expect(linesInMenuOrder(sorted)).toBe(sorted);
  });

  it('re-sorts after a realtime UPDATE moves a line (the owner reordered the menu)', () => {
    const sorted = linesInMenuOrder(order({ order_items: lines }));
    // Drink moved above the soups: its line arrives as an UPDATE of category_position.
    const merged = sorted.order_items.map((it) => (it.id === 'l2' ? { ...it, category_position: 1 } : it));
    expect(linesInMenuOrder({ ...sorted, order_items: merged }).order_items.map((it) => it.id)).toEqual([
      'l2', 'l3', 'l4', 'l1', 'l5',
    ]);
  });
});

describe('what the board says about itself', () => {
  it('is live and may say "All clear" when connected and the last read worked', () => {
    expect(boardHealth(true, false)).toEqual({ banner: null, status: 'statusLive', allClear: true });
  });

  it('does not pass off a refused read as a quiet kitchen', () => {
    // The admin app shipped before the migration its select needs: every read is refused.
    const h = boardHealth(true, true);
    expect(h.banner).toBe('readFailed');
    expect(h.status).toBe('statusRetrying');
    expect(h.allClear).toBe(false);
  });

  it('shows one bar at a time: a dropped socket explains a failed read too', () => {
    expect(boardHealth(false, true)).toEqual({ banner: 'connectionLost', status: 'statusReconnecting', allClear: false });
    expect(boardHealth(false, false)).toEqual({ banner: 'connectionLost', status: 'statusReconnecting', allClear: true });
  });

  it('has every sentence it can pick in all four languages', () => {
    const keys = new Set<string>();
    for (const socket of [true, false]) {
      for (const failed of [true, false]) {
        const h = boardHealth(socket, failed);
        if (h.banner) keys.add(h.banner);
        keys.add(h.status);
      }
    }
    expect([...keys].sort()).toEqual(['connectionLost', 'readFailed', 'statusLive', 'statusReconnecting', 'statusRetrying']);
    for (const locale of ['en', 'th', 'es', 'vi']) {
      const file = path.resolve(__dirname, `../../../../../messages/${locale}/kitchen.json`);
      const header = (JSON.parse(readFileSync(file, 'utf8')) as { header: Record<string, unknown> }).header;
      for (const key of keys) expect(typeof header[key], `${locale} kitchen.header.${key}`).toBe('string');
      // The status lines are formatted with the ticket count.
      for (const key of ['statusLive', 'statusReconnecting', 'statusRetrying']) {
        expect(header[key], `${locale} kitchen.header.${key}`).toMatch(/\{count[,}]/);
      }
    }
  });
});
