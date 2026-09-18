import { describe, expect, it } from 'vitest';
import {
  formatSoldOutUntil,
  inventoryErrorKey,
  nextSoldOutExpiry,
  parseWholeNumber,
  stockState,
} from './stock-model';

const NOW = Date.parse('2026-09-18T04:18:00Z');

const row = (over: Partial<Parameters<typeof stockState>[0]> = {}) => ({
  track_stock: true,
  stock_quantity: 10,
  low_stock_threshold: 2,
  sold_out_until: null,
  ...over,
});

describe('stockState', () => {
  it('reads a kitchen 86 as sold out whatever the count (Mango Sticky Rice, 29 on the shelf)', () => {
    const s = stockState(row({ stock_quantity: 29, sold_out_until: '2026-09-18T05:00:00+00:00' }), NOW);
    expect(s.isSoldOut).toBe(true);
    expect(s.isLow).toBe(false);
    expect(s.soldOutUntil).toBe('2026-09-18T05:00:00+00:00');
    expect(s.count).toBe(29);
  });

  it('forgets an 86 that has already lifted', () => {
    const s = stockState(row({ sold_out_until: '2026-09-18T04:00:00+00:00' }), NOW);
    expect(s.soldOutUntil).toBeNull();
    expect(s.isSoldOut).toBe(false);
  });

  it('86s an untracked dish without inventing a count', () => {
    const s = stockState(
      row({ track_stock: false, stock_quantity: null, low_stock_threshold: 5, sold_out_until: '2026-09-18T05:00:00Z' }),
      NOW,
    );
    expect(s).toMatchObject({ tracked: false, count: null, isSoldOut: true, isLow: false });
  });

  it('marks a counted dish at zero as sold out and low', () => {
    expect(stockState(row({ stock_quantity: 0 }), NOW)).toMatchObject({ isSoldOut: true, isLow: true });
  });

  it('marks a counted dish at the threshold as low but on sale', () => {
    expect(stockState(row({ stock_quantity: 2 }), NOW)).toMatchObject({ isSoldOut: false, isLow: true });
    expect(stockState(row({ stock_quantity: 3 }), NOW)).toMatchObject({ isSoldOut: false, isLow: false });
  });

  it('never treats an untracked dish as low or sold out by count', () => {
    expect(stockState(row({ track_stock: false, stock_quantity: null }), NOW)).toMatchObject({
      isSoldOut: false,
      isLow: false,
      count: null,
    });
  });
});

describe('nextSoldOutExpiry', () => {
  it('picks the soonest future 86 and ignores past ones', () => {
    expect(
      nextSoldOutExpiry(
        [
          { sold_out_until: null },
          { sold_out_until: '2026-09-18T04:00:00Z' },
          { sold_out_until: '2026-09-19T05:00:00Z' },
          { sold_out_until: '2026-09-18T05:00:00Z' },
        ],
        NOW,
      ),
    ).toBe(Date.parse('2026-09-18T05:00:00Z'));
    expect(nextSoldOutExpiry([{ sold_out_until: null }], NOW)).toBeNull();
  });
});

describe('parseWholeNumber', () => {
  it('accepts whole numbers at or above the minimum', () => {
    expect(parseWholeNumber('10', 1)).toBe(10);
    expect(parseWholeNumber(' 0 ', 0)).toBe(0);
  });

  it('refuses decimals, signs, blanks and out-of-range values', () => {
    expect(parseWholeNumber('2.5', 1)).toBeNull();
    expect(parseWholeNumber('-1', 0)).toBeNull();
    expect(parseWholeNumber('', 0)).toBeNull();
    expect(parseWholeNumber('0', 1)).toBeNull();
    expect(parseWholeNumber('1e3', 1)).toBeNull();
    expect(parseWholeNumber('3000000000', 0)).toBeNull();
  });
});

describe('inventoryErrorKey', () => {
  it('maps RLS and RPC refusals to a permission sentence', () => {
    expect(inventoryErrorKey({ code: '42501', message: 'new row violates row-level security policy' })).toBe(
      'permissionDenied',
    );
    expect(inventoryErrorKey({ code: 'P0001', message: 'not_authorized' })).toBe('permissionDenied');
  });

  it('maps a missing item, a bad value and a dropped connection', () => {
    expect(inventoryErrorKey({ code: 'P0001', message: 'item_not_in_branch' })).toBe('notFound');
    expect(inventoryErrorKey({ code: 'P0001', message: 'invalid_count' })).toBe('invalidValue');
    expect(inventoryErrorKey({ code: '23514', message: 'violates check constraint' })).toBe('invalidValue');
    expect(inventoryErrorKey({ message: 'TypeError: Failed to fetch' })).toBe('network');
    expect(inventoryErrorKey({ message: 'boom' })).toBe('generic');
  });
});

describe('formatSoldOutUntil', () => {
  it('shows the time alone when the 86 lifts later the same day in the branch zone', () => {
    // 04:18 UTC is 23:18 on the 17th in Chicago; 04:50 UTC is 23:50 the same evening.
    expect(formatSoldOutUntil('2026-09-18T04:50:00Z', 'America/Chicago', 'en', NOW)).toBe('11:50 PM');
  });

  it('adds the weekday when it lifts on another day (the kitchen default: midnight)', () => {
    expect(formatSoldOutUntil('2026-09-18T05:00:00Z', 'America/Chicago', 'en', NOW)).toBe('Fri 12:00 AM');
  });

  it('falls back to UTC for a zone the runtime does not know', () => {
    expect(formatSoldOutUntil('2026-09-18T05:00:00Z', 'Not/AZone', 'en', NOW)).toBe('5:00 AM');
  });
});
