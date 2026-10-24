/**
 * Which message a failed menu write shows. Raw PostgREST, RPC and storage text never reaches the
 * merchant: known codes map to a key under `menu.errors`, anything else to `generic`. Callers log
 * the raw error themselves before translating the key.
 */
export type MenuErrorKey =
  | 'generic'
  | 'network'
  | 'permission'
  | 'notFound'
  | 'inUse'
  | 'duplicate'
  | 'invalidValue'
  | 'fileTooLarge'
  | 'fileType';

const INVALID_VALUE_CODES = new Set(['23502', '23514', '22P02', '22003']);

export function menuErrorKey(err: unknown): MenuErrorKey {
  if (!err) return 'generic';
  const e = (typeof err === 'object' ? err : {}) as {
    code?: unknown;
    message?: unknown;
    statusCode?: unknown;
    status?: unknown;
  };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof err === 'string' ? err : typeof e.message === 'string' ? e.message : '';
  const lower = message.toLowerCase();
  const status = String(e.statusCode ?? e.status ?? '');

  if (
    code === '42501' ||
    /not_authorized|auth_required|row-level security|permission denied/.test(lower)
  ) {
    return 'permission';
  }
  if (lower.includes('item_not_found') || lower.includes('group_not_found')) return 'notFound';
  if (code === '23503' || lower.includes('foreign key')) return 'inUse';
  if (code === '23505' || lower.includes('duplicate key')) return 'duplicate';
  if (
    INVALID_VALUE_CODES.has(code) ||
    /violates (check|not-null) constraint|invalid input syntax|out of range/.test(lower)
  ) {
    return 'invalidValue';
  }
  if (status === '413' || /maximum allowed size|payload too large/.test(lower)) return 'fileTooLarge';
  if (status === '415' || /mime type/.test(lower)) return 'fileType';
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed/.test(lower)) {
    return 'network';
  }
  return 'generic';
}

/** Refusals of delete_menu_category that have their own sentence under `menu.categories.errors`. */
export type CategoryDeleteErrorKey = 'notEmpty' | 'invalidTarget' | 'usedByHappyHour' | 'notFound';

/**
 * The key for a refused category delete, or null for any other failure (translate those with
 * menuErrorKey). usedByHappyHour's sentence names the happy hours, which the function sends in
 * the error's `details`.
 */
export function categoryDeleteErrorKey(err: unknown): CategoryDeleteErrorKey | null {
  const message =
    typeof err === 'string'
      ? err
      : err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
        ? ((err as { message: string }).message)
        : '';
  if (message.includes('category_not_empty')) return 'notEmpty';
  if (message.includes('invalid_move_target')) return 'invalidTarget';
  if (message.includes('category_used_by_happy_hour')) return 'usedByHappyHour';
  if (message.includes('category_not_found')) return 'notFound';
  return null;
}

/**
 * Kitchen station failures that have their own sentence under `menu.stationManager.errors`
 * (docs/KITCHEN-STATIONS-2026-10-24.md):
 * - notFound, invalidTarget, listChanged: refusals of delete_kitchen_station, renameKitchenStation
 *   and reorder_kitchen_stations, each meaning the list on screen is out of date;
 * - inUse: delete_kitchen_station refusing a station that dishes still use when no target and no
 *   "No station" choice was sent (station_in_use): the sheet showed it unused from a stale list;
 * - nameTaken, nameInvalid: kitchen_stations' unique name index and name check;
 * - stationGone: a dish saved with a station deleted since the sheet opened
 *   (menu_items_branch_id_station_fkey).
 * Matched on the function's word or the constraint's name, never a bare code, so a unique or
 * foreign key failure elsewhere in the same save keeps menuErrorKey's sentence.
 */
export type StationErrorKey =
  | 'notFound'
  | 'invalidTarget'
  | 'listChanged'
  | 'inUse'
  | 'nameTaken'
  | 'nameInvalid'
  | 'stationGone';

/** The key for a station failure, or null for any other (translate those with menuErrorKey). */
export function stationErrorKey(err: unknown): StationErrorKey | null {
  const message =
    typeof err === 'string'
      ? err
      : err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
        ? ((err as { message: string }).message)
        : '';
  if (message.includes('station_not_found')) return 'notFound';
  if (message.includes('move_target_invalid')) return 'invalidTarget';
  if (message.includes('ids_mismatch')) return 'listChanged';
  if (message.includes('station_in_use')) return 'inUse';
  if (message.includes('kitchen_stations_branch_name_key')) return 'nameTaken';
  if (message.includes('kitchen_stations_name_check')) return 'nameInvalid';
  if (message.includes('menu_items_branch_id_station_fkey')) return 'stationGone';
  return null;
}
