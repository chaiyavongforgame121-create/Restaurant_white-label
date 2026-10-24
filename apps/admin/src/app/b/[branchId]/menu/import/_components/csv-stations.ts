// What a CSV row's station cell means at this branch (docs/KITCHEN-STATIONS-2026-10-24.md, CSV
// import). Pure, so the card's preview and its import read a cell alike and the rule can be tested.

import {
  isBuiltInStation,
  sortStations,
  stationLabel,
  type BuiltInStationKey,
  type KitchenStation,
} from '@/lib/kitchen-stations';

/**
 * - none: a blank cell, "No station" (it used to become expo);
 * - station: a station the branch has, by its key;
 * - new: a name the branch has no station for, which the import adds as a station first, as it
 *   adds a category it has not seen.
 */
export type CsvStation =
  | { kind: 'none' }
  | { kind: 'station'; key: string }
  | { kind: 'new'; name: string };

/** kitchen_stations_name_check: 1 to 40 characters once trimmed. */
export const STATION_NAME_MAX = 40;

/** Counted in characters as Postgres's char_length counts them, so an emoji is one. */
export function stationNameTooLong(name: string): boolean {
  return [...name.trim()].length > STATION_NAME_MAX;
}

/** Trimmed and case-folded the same way for every candidate and every cell. */
function fold(text: string | null | undefined): string {
  return (text ?? '').trim().toLowerCase();
}

/**
 * Reads cells against the branch's stations, ignoring case and surrounding spaces. A cell may name
 * a station as the merchant sees it (its name, or a built-in's label in this language), by its key
 * (the old template's hot, bar, …), or by a renamed built-in's label. When two stations could
 * claim a cell, what is on screen wins: a station named "Hot" over the built-in hot renamed
 * "Grill".
 */
export function csvStationMatcher(
  stations: readonly KitchenStation[],
  translateBuiltIn: (key: BuiltInStationKey) => string,
): (cell: string | null | undefined) => CsvStation {
  const ordered = sortStations(stations);
  const byText = new Map<string, string>();
  const claim = (text: string | null | undefined, key: string) => {
    const folded = fold(text);
    if (folded && !byText.has(folded)) byText.set(folded, key);
  };
  for (const s of ordered) claim(stationLabel(s, ordered, translateBuiltIn), s.key);
  for (const s of ordered) claim(s.key, s.key);
  for (const s of ordered) if (isBuiltInStation(s.key)) claim(translateBuiltIn(s.key), s.key);

  return (cell) => {
    const name = (cell ?? '').trim();
    if (!name) return { kind: 'none' };
    const key = byText.get(fold(name));
    return key ? { kind: 'station', key } : { kind: 'new', name };
  };
}

/**
 * The stations an import would add, once each however many rows name them and whatever their
 * case, spelled as their first row spells them, in the order the rows name them.
 */
export function newStationNames(
  cells: readonly (string | null | undefined)[],
  match: (cell: string | null | undefined) => CsvStation,
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const cell of cells) {
    const result = match(cell);
    if (result.kind !== 'new') continue;
    const folded = fold(result.name);
    if (seen.has(folded)) continue;
    seen.add(folded);
    names.push(result.name);
  }
  return names;
}
