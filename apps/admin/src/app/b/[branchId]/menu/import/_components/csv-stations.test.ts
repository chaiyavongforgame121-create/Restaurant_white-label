import { describe, expect, it } from 'vitest';
import type { KitchenStation } from '@/lib/kitchen-stations';
import { csvStationMatcher, newStationNames, stationNameTooLong } from './csv-stations';

const station = (key: string, name: string | null, displayOrder: number): KitchenStation => ({
  id: `id-${key}`,
  branchId: 'b1',
  key,
  name,
  displayOrder,
});

const BUILT_INS = [
  station('hot', null, 10),
  station('cold', null, 20),
  station('bar', null, 30),
  station('dessert', null, 40),
  station('expo', null, 50),
];

// The Thai labels, as the merchant would see them with the back office in Thai.
const thai = (key: string) =>
  ({ hot: 'ครัวร้อน', cold: 'ครัวเย็น', bar: 'บาร์', dessert: 'ของหวาน', expo: 'จุดจ่ายอาหาร' })[key] ?? key;

describe('csvStationMatcher', () => {
  it('reads a blank cell as no station, not expo', () => {
    const match = csvStationMatcher(BUILT_INS, thai);
    expect(match('')).toEqual({ kind: 'none' });
    expect(match('   ')).toEqual({ kind: 'none' });
    expect(match(undefined)).toEqual({ kind: 'none' });
    expect(match(null)).toEqual({ kind: 'none' });
  });

  it('matches a key, a name or a built-in label, ignoring case and surrounding spaces', () => {
    const grill = station('st_0123456789', 'Grill', 60);
    const match = csvStationMatcher([...BUILT_INS, grill], thai);
    expect(match('hot')).toEqual({ kind: 'station', key: 'hot' });
    expect(match(' HOT ')).toEqual({ kind: 'station', key: 'hot' });
    expect(match('ครัวร้อน')).toEqual({ kind: 'station', key: 'hot' });
    expect(match('grill')).toEqual({ kind: 'station', key: 'st_0123456789' });
    expect(match('ST_0123456789')).toEqual({ kind: 'station', key: 'st_0123456789' });
  });

  it('still knows a renamed built-in by its key and its label', () => {
    const match = csvStationMatcher([station('hot', 'Wok line', 10), ...BUILT_INS.slice(1)], thai);
    expect(match('Wok Line')).toEqual({ kind: 'station', key: 'hot' });
    expect(match('hot')).toEqual({ kind: 'station', key: 'hot' });
    expect(match('ครัวร้อน')).toEqual({ kind: 'station', key: 'hot' });
  });

  it('gives a cell to the station shown with that name before a key or a label', () => {
    // The built-in hot was renamed Grill, and the merchant made a station called Hot.
    const match = csvStationMatcher(
      [station('hot', 'Grill', 10), station('st_aaaaaaaaaa', 'Hot', 20)],
      (key) => (key === 'hot' ? 'Hot' : key),
    );
    expect(match('hot')).toEqual({ kind: 'station', key: 'st_aaaaaaaaaa' });
    expect(match('grill')).toEqual({ kind: 'station', key: 'hot' });
  });

  it('reads a name the branch has no station for as a new station, spelled as written', () => {
    const match = csvStationMatcher(BUILT_INS, thai);
    expect(match('  Pastry ')).toEqual({ kind: 'new', name: 'Pastry' });
  });

  it('does not offer a built-in the branch has deleted', () => {
    const match = csvStationMatcher(
      BUILT_INS.filter((s) => s.key !== 'bar'),
      thai,
    );
    expect(match('bar')).toEqual({ kind: 'new', name: 'bar' });
  });
});

describe('newStationNames', () => {
  it('lists each new station once, as its first row spells it, in row order', () => {
    const match = csvStationMatcher(BUILT_INS, thai);
    expect(newStationNames(['Wok', 'hot', '', 'pastry', 'WOK', 'Pastry ', undefined, 'Grill'], match)).toEqual([
      'Wok',
      'pastry',
      'Grill',
    ]);
  });

  it('is empty when every cell names a station or none', () => {
    const match = csvStationMatcher(BUILT_INS, thai);
    expect(newStationNames(['hot', 'Bar', '', null], match)).toEqual([]);
  });
});

describe('stationNameTooLong', () => {
  it('allows 40 characters once trimmed, counting an emoji as one', () => {
    expect(stationNameTooLong('a'.repeat(40))).toBe(false);
    expect(stationNameTooLong(`  ${'a'.repeat(40)}  `)).toBe(false);
    expect(stationNameTooLong('a'.repeat(41))).toBe(true);
    expect(stationNameTooLong('🔥'.repeat(40))).toBe(false);
    expect(stationNameTooLong('🔥'.repeat(41))).toBe(true);
  });
});
