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
  if (lower.includes('item_not_found')) return 'notFound';
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
