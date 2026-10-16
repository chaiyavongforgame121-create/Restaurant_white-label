import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_FILTERS,
  AVAILABILITY_SELECT,
  OPS_SETTINGS_SELECT,
  OPS_SETTING_KEYS,
  availabilityCounts,
  availabilityGroups,
  matchesAvailabilityFilter,
  mergeAvailability,
  pickOpsSettings,
  stockBadge,
  toAvailabilityItem,
  type AvailabilityItem,
} from './kitchen-model';

function dish(partial: Partial<AvailabilityItem> & { id: string }): AvailabilityItem {
  return {
    name: partial.id,
    category: 'Mains',
    categoryOrder: 1,
    displayOrder: 0,
    track_stock: false,
    stock_quantity: null,
    low_stock_threshold: 5,
    ...partial,
  };
}

describe('the settings the board reads', () => {
  it('selects only the four keys it uses, never the whole settings object', () => {
    expect(OPS_SETTINGS_SELECT).toBe(
      'orders_paused:settings->orders_paused, busy_extra_prep_min:settings->busy_extra_prep_min, ' +
        'prep_time_min:settings->prep_time_min, schedule_lead_time_min:settings->schedule_lead_time_min',
    );
    expect(OPS_SETTINGS_SELECT).not.toMatch(/(^|[ ,])settings(,|$)/);
  });

  it('keeps those keys out of the full object patch_branch_settings answers with', () => {
    const full = {
      orders_paused: true,
      busy_extra_prep_min: 20,
      prep_time_min: 25,
      schedule_lead_time_min: 30,
      payment_qr: { promptpay_id: '0812345678' },
      delivery_fee: 3.5,
    };
    expect(pickOpsSettings(full)).toEqual({
      orders_paused: true,
      busy_extra_prep_min: 20,
      prep_time_min: 25,
      schedule_lead_time_min: 30,
    });
  });

  it('leaves out keys the branch never set, so the board uses its defaults', () => {
    // A row read with OPS_SETTINGS_SELECT answers null for a missing key.
    expect(pickOpsSettings({ orders_paused: false, busy_extra_prep_min: null, prep_time_min: null, schedule_lead_time_min: null }))
      .toEqual({ orders_paused: false });
    expect(pickOpsSettings(null)).toEqual({});
    expect(pickOpsSettings([1, 2])).toEqual({});
    expect(pickOpsSettings('settings')).toEqual({});
  });

  it('names every key patch_branch_settings lets the kitchen write', () => {
    for (const key of ['orders_paused', 'busy_extra_prep_min']) expect(OPS_SETTING_KEYS).toContain(key);
  });
});

describe('the availability panel', () => {
  it('reads the stock columns and the category, nothing about money', () => {
    for (const col of ['id', 'name', 'track_stock', 'stock_quantity', 'low_stock_threshold', 'menu_categories(name, display_order)']) {
      expect(AVAILABILITY_SELECT).toContain(col);
    }
    expect(AVAILABILITY_SELECT).not.toMatch(/price|cost/);
  });

  it('reads a row with the category embedded as an object or an array', () => {
    const base = { id: 'm1', name: 'Pad Thai', display_order: 3, track_stock: true, stock_quantity: 4, low_stock_threshold: 5 };
    expect(toAvailabilityItem({ ...base, menu_categories: { name: 'Noodles', display_order: 2 } })).toEqual({
      id: 'm1',
      name: 'Pad Thai',
      category: 'Noodles',
      categoryOrder: 2,
      displayOrder: 3,
      track_stock: true,
      stock_quantity: 4,
      low_stock_threshold: 5,
    });
    expect(toAvailabilityItem({ ...base, menu_categories: [{ name: 'Noodles', display_order: 2 }] })?.category).toBe('Noodles');
    const loose = toAvailabilityItem({ ...base, menu_categories: null });
    expect(loose?.category).toBeNull();
    expect(loose?.categoryOrder).toBe(Number.MAX_SAFE_INTEGER);
    expect(toAvailabilityItem({ name: 'no id' })).toBeNull();
    expect(toAvailabilityItem(null)).toBeNull();
  });

  it('says Low at or under the threshold, None left at zero, nothing for an uncounted dish', () => {
    expect(stockBadge({ track_stock: true, stock_quantity: 3, low_stock_threshold: 5 })).toEqual({ kind: 'low', count: 3 });
    expect(stockBadge({ track_stock: true, stock_quantity: 5, low_stock_threshold: 5 })).toEqual({ kind: 'low', count: 5 });
    expect(stockBadge({ track_stock: true, stock_quantity: 6, low_stock_threshold: 5 })).toBeNull();
    expect(stockBadge({ track_stock: true, stock_quantity: 0, low_stock_threshold: 5 })).toEqual({ kind: 'out' });
    // Not counted: the count column means nothing.
    expect(stockBadge({ track_stock: false, stock_quantity: 0, low_stock_threshold: 5 })).toBeNull();
    expect(stockBadge({ track_stock: null, stock_quantity: 1, low_stock_threshold: 5 })).toBeNull();
    // The column default (5) when the threshold is missing, as the back office reads it.
    expect(stockBadge({ track_stock: true, stock_quantity: 4, low_stock_threshold: null })).toEqual({ kind: 'low', count: 4 });
  });

  it('filters sold out (86 or none left) and low (counted, at or under the threshold)', () => {
    const items = [
      dish({ id: 'plenty', track_stock: true, stock_quantity: 40 }),
      dish({ id: 'low', track_stock: true, stock_quantity: 2 }),
      dish({ id: 'empty', track_stock: true, stock_quantity: 0 }),
      dish({ id: 'eightySixed' }),
      dish({ id: 'loose' }),
    ];
    const soldOut = new Set(['eightySixed']);
    const ids = (f: (typeof AVAILABILITY_FILTERS)[number]) =>
      items.filter((it) => matchesAvailabilityFilter(it, f, soldOut)).map((it) => it.id);
    expect(ids('all')).toEqual(['plenty', 'low', 'empty', 'eightySixed', 'loose']);
    expect(ids('soldOut')).toEqual(['empty', 'eightySixed']);
    expect(ids('low')).toEqual(['low', 'empty']);
    expect(availabilityCounts(items, soldOut)).toEqual({ all: 5, soldOut: 2, low: 2 });
  });

  it('groups by category in menu order, dishes in menu order, the uncategorised last', () => {
    const items = [
      dish({ id: 'Spring rolls', category: 'Starters', categoryOrder: 0, displayOrder: 2 }),
      dish({ id: 'Water', category: null, categoryOrder: Number.MAX_SAFE_INTEGER }),
      dish({ id: 'Satay', category: 'Starters', categoryOrder: 0, displayOrder: 1 }),
      dish({ id: 'Green curry', category: 'Mains', categoryOrder: 1, displayOrder: 1 }),
      dish({ id: 'Pad Thai', category: 'Mains', categoryOrder: 1, displayOrder: 1 }),
    ];
    const groups = availabilityGroups(items, { query: '', filter: 'all', soldOutIds: new Set() });
    expect(groups.map((g) => [g.category, g.items.map((it) => it.name)])).toEqual([
      ['Starters', ['Satay', 'Spring rolls']],
      ['Mains', ['Green curry', 'Pad Thai']],
      [null, ['Water']],
    ]);
  });

  it('searches by name in any case, under the chosen filter', () => {
    const items = [
      dish({ id: 'm1', name: 'Pad Thai', track_stock: true, stock_quantity: 1 }),
      dish({ id: 'm2', name: 'Pad See Ew' }),
      dish({ id: 'm3', name: 'Tom Yum' }),
    ];
    const names = (query: string, filter: 'all' | 'low' = 'all') =>
      availabilityGroups(items, { query, filter, soldOutIds: new Set() }).flatMap((g) => g.items.map((it) => it.name));
    expect(names('  pad ')).toEqual(['Pad See Ew', 'Pad Thai']);
    expect(names('PAD', 'low')).toEqual(['Pad Thai']);
    expect(names('curry')).toEqual([]);
  });

  it('follows the stock count from a realtime UPDATE, and keeps the same list for a non-change', () => {
    const list = [dish({ id: 'm1', track_stock: true, stock_quantity: 9 }), dish({ id: 'm2' })];
    const sold = mergeAvailability(list, { id: 'm1', is_active: true, track_stock: true, stock_quantity: 4, low_stock_threshold: 5 });
    expect(sold).not.toBe(list);
    expect(sold[0]!.stock_quantity).toBe(4);
    expect(stockBadge(sold[0]!)).toEqual({ kind: 'low', count: 4 });
    // The same row again (an 86 elsewhere touches updated_at, not the count): nothing to repaint.
    expect(mergeAvailability(sold, { id: 'm1', is_active: true, track_stock: true, stock_quantity: 4, low_stock_threshold: 5 })).toBe(sold);
    // A dish this list does not hold waits for the next read.
    expect(mergeAvailability(sold, { id: 'm9', is_active: true, stock_quantity: 1 })).toBe(sold);
    expect(mergeAvailability(sold, { id: null })).toBe(sold);
  });

  it('drops a dish taken off the menu', () => {
    const list = [dish({ id: 'm1' }), dish({ id: 'm2' })];
    expect(mergeAvailability(list, { id: 'm2', is_active: false }).map((it) => it.id)).toEqual(['m1']);
  });

  it('has every sentence it uses in all four languages', () => {
    const keys = [
      'toggle', 'lowCount', 'title', 'close', 'search', 'filterLabel', 'loading', 'loadFailed', 'retry', 'emptyMenu',
      'noMatch', 'noCategory', 'soldOutUntil', 'noneLeft', 'lowStock', 'stockHint', 'markSoldOut', 'markSoldOutItem', 'help',
    ];
    for (const locale of ['en', 'th', 'es', 'vi']) {
      const file = path.resolve(__dirname, `../../../../../messages/${locale}/kitchen.json`);
      const kitchen = JSON.parse(readFileSync(file, 'utf8')) as {
        header: Record<string, unknown>;
        toast: Record<string, unknown>;
        eightySix: Record<string, unknown>;
        availability: Record<string, unknown> & { filter: Record<string, unknown> };
      };
      for (const key of keys) expect(typeof kitchen.availability[key], `${locale} kitchen.availability.${key}`).toBe('string');
      for (const f of AVAILABILITY_FILTERS) {
        expect(typeof kitchen.availability.filter[f], `${locale} kitchen.availability.filter.${f}`).toBe('string');
      }
      expect(kitchen.availability.lowCount, `${locale} lowCount`).toMatch(/\{count[,}]/);
      expect(kitchen.availability.lowStock, `${locale} lowStock`).toMatch(/\{count[,}]/);
      expect(kitchen.availability.soldOutUntil, `${locale} soldOutUntil`).toMatch(/\{time\}/);
      expect(kitchen.availability.markSoldOutItem, `${locale} markSoldOutItem`).toMatch(/\{item\}/);
      expect(typeof kitchen.eightySix.backOnSale, `${locale} kitchen.eightySix.backOnSale`).toBe('string');
      expect(typeof kitchen.header.dashboard, `${locale} kitchen.header.dashboard`).toBe('string');
      expect(kitchen.toast.rejectPaid, `${locale} kitchen.toast.rejectPaid`).toMatch(/\{ticket\}/);
    }
  });
});
