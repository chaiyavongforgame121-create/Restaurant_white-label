import { describe, expect, it } from 'vitest';
import type { Order, OrderItem } from '@/app/kitchen/[branchId]/_components/kitchen-model';
import { kitchenLanes, laneClockStart, lineProgress, orderNote, tableLabel } from './kitchen-status-model';

const line = (id: string, prep_status: string | null = null): OrderItem => ({ id, item_name: `Dish ${id}`, quantity: 1, prep_status });

const order = (id: string, status: string, created_at: string, extra: Partial<Order> = {}): Order => ({
  id,
  order_number: `A-2610-${id}`,
  status,
  channel: 'dine_in',
  created_at,
  order_items: [line(`${id}-1`)],
  ...extra,
});

describe('kitchenLanes', () => {
  it('puts each ticket in the board’s lane, newest first as on the board', () => {
    const lanes = kitchenLanes(
      [
        order('3', 'confirmed', '2026-10-19T10:05:00Z'),
        order('1', 'pending', '2026-10-19T10:00:00Z'),
        order('2', 'preparing', '2026-10-19T10:02:00Z'),
        order('4', 'ready', '2026-10-19T09:50:00Z', {
          status_history: [{ status: 'ready', at: '2026-10-19T10:10:00Z' }],
        }),
      ],
    );
    expect(lanes.new.map((o) => o.id)).toEqual(['3', '1']);
    expect(lanes.cooking.map((o) => o.id)).toEqual(['2']);
    expect(lanes.ready.map((o) => o.id)).toEqual(['4']);
  });

  it('leaves out what the kitchen board leaves out', () => {
    const lanes = kitchenLanes(
      [
        order('h', 'pending', '2026-10-19T10:00:00Z', { held: true }),
        order('t', 'confirmed', '2026-10-19T10:00:00Z', { awaiting_payment: true }),
        order('e', 'pending', '2026-10-19T10:00:00Z', { order_items: [] }),
        order('c', 'completed', '2026-10-19T10:00:00Z'),
        order('x', 'cancelled', '2026-10-19T10:00:00Z'),
      ],
    );
    expect(lanes.new.length + lanes.cooking.length + lanes.ready.length).toBe(0);
  });

  it('survives a row whose lines or table came back in another shape', () => {
    const odd = { ...order('o', 'pending', '2026-10-19T10:00:00Z'), order_items: null } as unknown as Order;
    expect(kitchenLanes([odd]).new).toEqual([]);
    const arrTable = order('a', 'pending', '2026-10-19T10:00:00Z', {
      tables: [{ table_number: '4', display_name: null }] as unknown as Order['tables'],
    });
    expect(tableLabel(kitchenLanes([arrTable]).new[0]!, (n) => `Table ${n}`)).toBe('Table 4');
  });
});

describe('laneClockStart', () => {
  it('counts a ready ticket from when it became ready, and a scheduled one from its release', () => {
    const ready = order('r', 'ready', '2026-10-19T09:00:00Z', {
      status_history: [{ status: 'ready', at: '2026-10-19T09:30:00Z' }],
    });
    expect(laneClockStart(ready, 0)).toBe(Date.parse('2026-10-19T09:30:00Z'));
    const scheduled = order('s', 'confirmed', '2026-10-19T08:00:00Z', { scheduled_for: '2026-10-19T12:00:00Z' });
    expect(laneClockStart(scheduled, 15 * 60_000)).toBe(Date.parse('2026-10-19T11:45:00Z'));
  });
});

describe('lineProgress, tableLabel, orderNote', () => {
  it('counts the lines the cooks ticked off', () => {
    expect(lineProgress({ order_items: [line('1', 'ready'), line('2', 'served'), line('3', 'pending')] })).toEqual({
      done: 2,
      total: 3,
    });
  });
  it('names the table as the board’s chip does', () => {
    const word = (n: string) => `Table ${n}`;
    expect(tableLabel({ tables: { table_number: '7', display_name: 'Patio 7' } }, word)).toBe('Patio 7');
    expect(tableLabel({ tables: { table_number: '7', display_name: '  ' } }, word)).toBe('Table 7');
    expect(tableLabel({ tables: null }, word)).toBeNull();
  });
  it('joins the diner’s and the kitchen’s notes', () => {
    expect(orderNote({ customer_notes: 'No peanuts', kitchen_notes: 'Rush' })).toBe('No peanuts · Rush');
    expect(orderNote({ customer_notes: null, kitchen_notes: null })).toBe('');
  });
});
