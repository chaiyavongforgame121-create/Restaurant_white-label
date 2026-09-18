/**
 * Which sentence a failed combo write shows. Raw PostgREST and RPC text never reaches the
 * merchant: the refusals save_combo, set_combo_archived and reorder_combo_sets raise by name get
 * their own key under `menuExtras.combos.errors`, known SQLSTATEs a key under `menuExtras.errors`,
 * anything else `errors.generic`. Callers log the raw error before translating.
 */
export type ComboErrorKey =
  | 'combos.errors.nameRequired'
  | 'combos.errors.priceInvalid'
  | 'combos.errors.quantityInvalid'
  | 'combos.errors.emptyActive'
  | 'combos.errors.itemOtherBranch'
  | 'combos.errors.itemDuplicate'
  | 'combos.errors.imageInvalid'
  | 'combos.errors.notFound'
  | 'combos.errors.archived'
  | 'errors.permissionDenied'
  | 'errors.network'
  | 'errors.duplicate'
  | 'errors.inUse'
  | 'errors.invalidValue'
  | 'errors.generic';

/** Refusals raised by name, checked before the SQLSTATE they share with other failures. */
const NAMED: ReadonlyArray<[string, ComboErrorKey]> = [
  ['combo_name_required', 'combos.errors.nameRequired'],
  ['combo_price_invalid', 'combos.errors.priceInvalid'],
  ['combo_quantity_invalid', 'combos.errors.quantityInvalid'],
  ['combo_empty', 'combos.errors.emptyActive'],
  ['combo_item_branch_mismatch', 'combos.errors.itemOtherBranch'],
  ['combo_item_duplicate', 'combos.errors.itemDuplicate'],
  ['combo_image_invalid', 'combos.errors.imageInvalid'],
  ['combo_not_found', 'combos.errors.notFound'],
  ['branch_not_found', 'combos.errors.notFound'],
  ['combo_archived', 'combos.errors.archived'],
];

export function comboErrorKey(err: unknown): ComboErrorKey {
  if (!err) return 'errors.generic';
  const e = (typeof err === 'object' ? err : {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof err === 'string' ? err : typeof e.message === 'string' ? e.message : '';
  const lower = message.toLowerCase();

  for (const [name, key] of NAMED) {
    if (lower.includes(name)) return key;
  }
  if (code === '42501' || /not_authorized|auth_required|row-level security|permission denied/.test(lower)) {
    return 'errors.permissionDenied';
  }
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed/.test(lower)) {
    return 'errors.network';
  }
  if (code === '23505') return 'errors.duplicate';
  if (code === '23503') return 'errors.inUse';
  if (/^(22|23)/.test(code)) return 'errors.invalidValue';
  return 'errors.generic';
}
