// The pure half of the branch's kitchen stations (docs/KITCHEN-STATIONS-2026-10-24.md): which keys
// are built in, the reserved "No station" key, what a station is called on screen, which names
// would be confused with another station's and the order stations are listed in. No React and no database, so the menu page, the stations sheet, the
// kitchen board and the CSV import share one rule, and it can be unit-tested.

import type { KitchenStation } from '@favornoms/database/queries';

export type { KitchenStation };

/**
 * The five stations every branch starts with (display_order 10-50). Their keys are fixed: dishes,
 * order lines and tablets pinned to `?station=hot` hold them. Until the merchant renames one, its
 * label is the translation `stations.<key>`.
 */
export const BUILT_IN_STATION_KEYS = ['hot', 'cold', 'bar', 'dessert', 'expo'] as const;

export type BuiltInStationKey = (typeof BUILT_IN_STATION_KEYS)[number];

export function isBuiltInStation(key: string | null | undefined): key is BuiltInStationKey {
  return (BUILT_IN_STATION_KEYS as readonly string[]).includes(key ?? '');
}

/**
 * The kitchen board's "No station" pill and its `?station=` value. The database refuses it as a
 * station key (kitchen_stations_key_check), so it can never name a real station.
 */
export const NO_STATION = '_none';

/** Is this the reserved "No station" value rather than a station's key? */
export function isNoStation(key: string | null | undefined): boolean {
  return key === NO_STATION;
}

/**
 * Could this be a station's key? The database's own rule: lower-case letters, digits, _ and -,
 * 1 to 40 of them, and never NO_STATION. A `?station=` value that fails it names no station.
 */
export function isValidStationKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && /^[a-z0-9_-]{1,40}$/.test(key) && key !== NO_STATION;
}

/** The station with this key in the list, if the branch still has it. */
export function findStation(
  stations: readonly KitchenStation[],
  key: string | null | undefined,
): KitchenStation | undefined {
  if (!key) return undefined;
  return stations.find((s) => s.key === key);
}

/**
 * What a station is called on screen:
 * - the merchant's name, when the station has one;
 * - a built-in with no name, or one the branch has since deleted (an old order line): its
 *   translation, from `translateBuiltIn`;
 * - no station (null, blank or NO_STATION): `noStationLabel`, or '' when none is given;
 * - any other key the list does not hold (a deleted station on an old line, a station added
 *   elsewhere since the list was read): `unknownLabel` (a "Deleted station" text, say) when one is
 *   given, else the key itself, so the line still has a label instead of vanishing.
 * A station object is looked up by key in `stations` first, so a copy held from before a rename
 * shows the current name.
 */
export function stationLabel(
  station: KitchenStation | string | null | undefined,
  stations: readonly KitchenStation[],
  translateBuiltIn: (key: BuiltInStationKey) => string,
  noStationLabel = '',
  unknownLabel?: string,
): string {
  const key = typeof station === 'string' ? station : (station?.key ?? null);
  if (key == null || key.trim() === '' || isNoStation(key)) return noStationLabel;
  const current = findStation(stations, key) ?? (typeof station === 'object' ? station : undefined);
  const name = current?.name?.trim();
  if (name) return name;
  if (isBuiltInStation(key)) return translateBuiltIn(key);
  if (!current && unknownLabel !== undefined) return unknownLabel;
  return key;
}

/** Trimmed and case-folded, as the CSV import folds a cell. */
function foldName(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * The other station that `name` would be confused with, or null when there is none. A name
 * clashes when, trimmed and ignoring case, it equals another station's label as `stationLabel`
 * shows it (its name, or a built-in's translation while it has none) or its key (what the CSV
 * import also matches a cell against). The database's unique index only sees stored names, so it
 * misses a custom "Bar" next to an unnamed built-in bar; this is checked before writing.
 * `exceptId` is the station being renamed, so a station may take its own label. To check a
 * built-in going back to its translation, pass that translation as `name`. A blank name clashes
 * with nothing (the name rules refuse it on their own).
 */
export function stationNameClash(
  name: string,
  stations: readonly KitchenStation[],
  translateBuiltIn: (key: BuiltInStationKey) => string,
  exceptId?: string | null,
): KitchenStation | null {
  const wanted = foldName(name);
  if (wanted === '') return null;
  for (const s of stations) {
    if (exceptId != null && s.id === exceptId) continue;
    const label = stationLabel(s, stations, translateBuiltIn);
    if (foldName(label) === wanted || foldName(s.key) === wanted) return s;
  }
  return null;
}

/** Plain code-unit order, so a key's place never depends on the viewer's language. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stations in the order they are listed everywhere: display_order, then key, then id, the same
 * keys listKitchenStations orders by. Returns a new array; the one passed in is left as it was.
 */
export function sortStations<T extends Pick<KitchenStation, 'id' | 'key' | 'displayOrder'>>(
  stations: readonly T[],
): T[] {
  return [...stations].sort(
    (a, b) => a.displayOrder - b.displayOrder || compareText(a.key, b.key) || compareText(a.id, b.id),
  );
}
