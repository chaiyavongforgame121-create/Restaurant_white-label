import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_STATION_KEYS,
  findStation,
  isBuiltInStation,
  isNoStation,
  isValidStationKey,
  NO_STATION,
  sortStations,
  stationLabel,
  stationNameClash,
  type KitchenStation,
} from './kitchen-stations';

const BRANCH = '11111111-1111-4111-8111-111111111111';

function station(key: string, name: string | null, displayOrder: number, id = `id-${key}`): KitchenStation {
  return { id, branchId: BRANCH, key, name, displayOrder };
}

const STATIONS: KitchenStation[] = [
  station('hot', null, 10),
  station('cold', 'Salads', 20),
  station('st_0123456789', 'ครัวย่าง', 60),
];

/** Stands in for t('stations.<key>'). */
const translate = (key: string) => `T:${key}`;

describe('built-in keys', () => {
  it('are the five every branch starts with, in their seeded order', () => {
    expect(BUILT_IN_STATION_KEYS).toEqual(['hot', 'cold', 'bar', 'dessert', 'expo']);
  });

  it('isBuiltInStation knows them and nothing else', () => {
    for (const key of BUILT_IN_STATION_KEYS) expect(isBuiltInStation(key)).toBe(true);
    for (const key of ['Hot', 'st_0123456789', NO_STATION, '', null, undefined]) {
      expect(isBuiltInStation(key)).toBe(false);
    }
  });
});

describe('the reserved "No station" key', () => {
  it('is _none, and is never a valid station key', () => {
    expect(NO_STATION).toBe('_none');
    expect(isNoStation('_none')).toBe(true);
    expect(isNoStation('hot')).toBe(false);
    expect(isNoStation(null)).toBe(false);
    expect(isValidStationKey(NO_STATION)).toBe(false);
  });

  it('isValidStationKey follows the database rule', () => {
    for (const key of ['hot', 'st_0123456789', 'grill-2', 'a', 'x'.repeat(40)]) {
      expect(isValidStationKey(key)).toBe(true);
    }
    for (const key of ['', 'Hot', 'pizza oven', 'ครัว', 'x'.repeat(41), null, undefined]) {
      expect(isValidStationKey(key)).toBe(false);
    }
  });
});

describe('findStation', () => {
  it('finds by key, and nothing for no key', () => {
    expect(findStation(STATIONS, 'cold')?.name).toBe('Salads');
    expect(findStation(STATIONS, 'bar')).toBeUndefined();
    expect(findStation(STATIONS, null)).toBeUndefined();
    expect(findStation(STATIONS, '')).toBeUndefined();
  });
});

describe('stationLabel', () => {
  it("shows the merchant's name, exactly as typed", () => {
    expect(stationLabel('st_0123456789', STATIONS, translate)).toBe('ครัวย่าง');
    expect(stationLabel('cold', STATIONS, translate)).toBe('Salads');
  });

  it('translates a built-in that has no name', () => {
    expect(stationLabel('hot', STATIONS, translate)).toBe('T:hot');
  });

  it('translates a built-in the branch has deleted (an old line still names it)', () => {
    expect(stationLabel('dessert', STATIONS, translate)).toBe('T:dessert');
  });

  it('shows the raw key of a station the branch no longer has', () => {
    expect(stationLabel('st_ffffffffff', STATIONS, translate)).toBe('st_ffffffffff');
  });

  it('shows unknownLabel instead of the raw key, when one is given', () => {
    expect(stationLabel('st_ffffffffff', STATIONS, translate, 'No station', 'Deleted station')).toBe(
      'Deleted station',
    );
    expect(stationLabel('st_ffffffffff', STATIONS, translate, '', '')).toBe('');
  });

  it('leaves unknownLabel out of everything else', () => {
    const label = (key: string | null) =>
      stationLabel(key, STATIONS, translate, 'No station', 'Deleted station');
    expect(label('st_0123456789')).toBe('ครัวย่าง');
    expect(label('hot')).toBe('T:hot');
    // A deleted built-in still has its translation.
    expect(label('dessert')).toBe('T:dessert');
    expect(label(null)).toBe('No station');
    expect(label(NO_STATION)).toBe('No station');
    // A station object not in the list is a station, not an unknown key.
    const fryer = station('st_aaaaaaaaaa', 'Fryer', 70);
    expect(stationLabel(fryer, STATIONS, translate, '', 'Deleted station')).toBe('Fryer');
  });

  it('gives "No station" for null, blank and the reserved key', () => {
    for (const key of [null, undefined, '', '  ', NO_STATION]) {
      expect(stationLabel(key, STATIONS, translate, 'No station')).toBe('No station');
      expect(stationLabel(key, STATIONS, translate)).toBe('');
    }
  });

  it('takes a station object, preferring the list\'s current copy', () => {
    expect(stationLabel(station('cold', 'Old name', 20), STATIONS, translate)).toBe('Salads');
    // Not in the list (just created, say): its own name, or its translation.
    expect(stationLabel(station('st_aaaaaaaaaa', 'Fryer', 70), STATIONS, translate)).toBe('Fryer');
    expect(stationLabel(station('bar', null, 30), STATIONS, translate)).toBe('T:bar');
  });

  it('treats a blank name as none', () => {
    expect(stationLabel('hot', [station('hot', '   ', 10)], translate)).toBe('T:hot');
  });
});

describe('stationNameClash', () => {
  /** Stand in for the English and the Thai t('stations.<key>'). */
  const EN: Record<string, string> = { hot: 'Hot', cold: 'Cold', bar: 'Bar', dessert: 'Dessert', expo: 'Expo' };
  const TH: Record<string, string> = { hot: 'ครัวร้อน', cold: 'ครัวเย็น', bar: 'บาร์' };
  const english = (key: string) => EN[key] ?? key;
  const BRANCH_STATIONS: KitchenStation[] = [
    station('hot', null, 10),
    station('cold', null, 20),
    station('bar', null, 30),
    station('st_0123456789', 'Grill', 60),
  ];

  it('finds an unnamed built-in by its translated label, trimmed and ignoring case', () => {
    for (const name of ['Bar', 'bar', ' BAR ', 'Hot', 'hot ', 'HOT']) {
      expect(stationNameClash(name, BRANCH_STATIONS, english)?.key).toBe(name.trim().toLowerCase());
    }
  });

  it("finds another station by its merchant's name", () => {
    expect(stationNameClash('grill', BRANCH_STATIONS, english)?.id).toBe('id-st_0123456789');
  });

  it('finds a station by its key, even once it is renamed', () => {
    const renamed = BRANCH_STATIONS.map((s) => (s.key === 'hot' ? { ...s, name: 'Charcoal' } : s));
    expect(stationNameClash('Charcoal', renamed, english)?.key).toBe('hot');
    // The CSV import reads "hot" as this station, so a custom "Hot" would be ambiguous there.
    expect(stationNameClash('Hot', renamed, english)?.key).toBe('hot');
    expect(stationNameClash('st_0123456789', BRANCH_STATIONS, english)?.name).toBe('Grill');
  });

  it('returns null for a name nobody uses, and for a blank one', () => {
    expect(stationNameClash('Wok', BRANCH_STATIONS, english)).toBeNull();
    expect(stationNameClash('Dessert', BRANCH_STATIONS, english)).toBeNull(); // the branch deleted it
    expect(stationNameClash('   ', BRANCH_STATIONS, english)).toBeNull();
    expect(stationNameClash('Bar', [], english)).toBeNull();
  });

  it('skips the station being renamed, so it may keep or take its own label', () => {
    expect(stationNameClash('Hot', BRANCH_STATIONS, english, 'id-hot')).toBeNull();
    expect(stationNameClash('grill ', BRANCH_STATIONS, english, 'id-st_0123456789')).toBeNull();
    // ...but not another station's.
    expect(stationNameClash('Bar', BRANCH_STATIONS, english, 'id-hot')?.key).toBe('bar');
  });

  it('checks a built-in going back to its translation against the other stations', () => {
    const stations = [station('hot', 'Grill', 10), station('st_aaaaaaaaaa', 'Hot', 60)];
    expect(stationNameClash(english('hot'), stations, english, 'id-hot')?.key).toBe('st_aaaaaaaaaa');
  });

  it("reads labels in the language it is given (the viewer's)", () => {
    const thai = (key: string) => TH[key] ?? key;
    expect(stationNameClash('บาร์', BRANCH_STATIONS, thai)?.key).toBe('bar');
    expect(stationNameClash('Bar', BRANCH_STATIONS, thai)?.key).toBe('bar'); // still its key
    expect(stationNameClash('Hot', BRANCH_STATIONS, thai)?.key).toBe('hot');
  });
});

describe('sortStations', () => {
  it('orders by display_order, then key, then id, without touching the input', () => {
    const input = [
      station('st_bbbbbbbbbb', 'B', 20, 'id-2'),
      station('hot', null, 10),
      station('st_aaaaaaaaaa', 'A', 20, 'id-3'),
      station('st_aaaaaaaaaa', 'A again', 20, 'id-1'),
    ];
    const before = [...input];
    expect(sortStations(input).map((s) => s.id)).toEqual(['id-hot', 'id-1', 'id-3', 'id-2']);
    expect(input).toEqual(before);
  });
});
