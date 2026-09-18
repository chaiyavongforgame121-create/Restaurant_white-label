/**
 * The combo editor's draft: what one combo card holds between Save presses, and the checks it
 * runs before handing the whole card to save_combo. Kept apart from the component so the rules
 * are testable without a DOM.
 */

/** What the editor reads for each combo, on the server and on every refetch. */
export const COMBO_SELECT =
  'id, name, description, total_price, image_url, is_active, archived_at, display_order, created_at, combo_items(menu_item_id, quantity, position)';

/** One combo_sets row with its dishes, as COMBO_SELECT returns it. */
export interface ComboRecord {
  id: string;
  name: string;
  description: string | null;
  total_price: number | string;
  image_url: string | null;
  is_active: boolean;
  archived_at: string | null;
  display_order: number;
  created_at: string;
  combo_items: Array<{ menu_item_id: string; quantity: number; position: number }>;
}

export interface ComboDraftItem {
  menu_item_id: string;
  quantity: number;
}

export interface ComboDraft {
  name: string;
  description: string;
  /** As typed; parsed on save so a half-typed "12." is not rewritten under the cursor. */
  price: string;
  imageUrl: string | null;
  isActive: boolean;
  /** In display order. */
  items: ComboDraftItem[];
}

export const EMPTY_DRAFT: ComboDraft = {
  name: '',
  description: '',
  price: '',
  imageUrl: null,
  isActive: false,
  items: [],
};

/** What the editor reads for each dish of the branch, on the server and on every refetch. */
export const MENU_ITEM_SELECT = 'id, name, price, image_url, is_active, track_stock, stock_quantity, sold_out_until';

/** A dish of this branch as the editor needs it, hidden and sold-out ones included. */
export interface ComboMenuItem {
  id: string;
  name: string;
  price: number | string;
  image_url: string | null;
  is_active: boolean;
  track_stock: boolean;
  stock_quantity: number | null;
  sold_out_until: string | null;
}

/** A saved combo as an editable draft: dishes in their saved order, the price as it would be typed. */
export function draftFromCombo(combo: ComboRecord): ComboDraft {
  return {
    name: combo.name,
    description: combo.description ?? '',
    price: Number(combo.total_price).toFixed(2),
    imageUrl: combo.image_url,
    isActive: combo.is_active,
    items: [...(combo.combo_items ?? [])]
      .sort((a, b) => a.position - b.position || a.menu_item_id.localeCompare(b.menu_item_id))
      .map((ci) => ({ menu_item_id: ci.menu_item_id, quantity: ci.quantity })),
  };
}

/**
 * The arguments for save_combo, one whole card at a time. Callers check draftProblems first, so
 * the price parses; the server checks everything again.
 */
export function saveComboArgs(branchId: string, comboId: string | null, draft: ComboDraft) {
  return {
    p_branch_id: branchId,
    // New combos have no id yet; the generated type does not know the argument may be null.
    p_combo_id: comboId as string,
    p_name: draft.name.trim(),
    p_description: draft.description.trim(),
    p_total_price: parsePrice(draft.price) ?? 0,
    p_image_url: draft.imageUrl ?? '',
    p_is_active: draft.isActive,
    p_items: draft.items.map((it) => ({ menu_item_id: it.menu_item_id, quantity: it.quantity })),
  };
}

export type DraftProblem = 'nameRequired' | 'priceInvalid' | 'emptyActive';

/** The price a draft would save, or null when it is not a positive amount of money. */
export function parsePrice(raw: string): number | null {
  const text = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** What stops a draft from being saved, in the order the form shows the fields. */
export function draftProblems(draft: ComboDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (!draft.name.trim()) out.push('nameRequired');
  if (parsePrice(draft.price) === null) out.push('priceInvalid');
  if (draft.isActive && draft.items.length === 0) out.push('emptyActive');
  return out;
}

export function sameDraft(a: ComboDraft, b: ComboDraft): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.price === b.price &&
    a.imageUrl === b.imageUrl &&
    a.isActive === b.isActive &&
    a.items.length === b.items.length &&
    a.items.every((it, i) => it.menu_item_id === b.items[i]?.menu_item_id && it.quantity === b.items[i]?.quantity)
  );
}

/**
 * A draft written the way the server hands it back once saved: text trimmed, the price with two
 * decimals. A draft that saved "259" or " Thai Duo " then compares equal to the refetched row.
 */
export function normalizeDraft(draft: ComboDraft): ComboDraft {
  const price = parsePrice(draft.price);
  return {
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    price: price === null ? draft.price : price.toFixed(2),
  };
}

/**
 * What a card holds after a refetch hands it a new saved version (`next`, replacing `previous`).
 * The card follows the server when it holds no edits of its own: nothing changed since `previous`,
 * or, right after its own save, nothing changed since what it sent (`saved`, normalised), whatever
 * format the merchant typed it in. Edits typed while the save was in flight stay, still unsaved.
 */
export function draftAfterRefetch(
  current: ComboDraft,
  previous: ComboDraft,
  next: ComboDraft,
  saved: ComboDraft | null,
): ComboDraft {
  const clean = sameDraft(current, previous) || (saved !== null && sameDraft(normalizeDraft(current), saved));
  return clean ? next : current;
}

/** What the dishes would cost bought one by one, at today's menu prices. Unknown dishes count 0. */
export function listPriceTotal(items: ComboDraftItem[], menuById: Map<string, ComboMenuItem>): number {
  const cents = items.reduce((sum, it) => {
    const m = menuById.get(it.menu_item_id);
    return sum + (m ? Math.round(Number(m.price) * 100) * it.quantity : 0);
  }, 0);
  return cents / 100;
}

/**
 * Whether one dish can be sold as part of the combo right now -- the same test v_active_combos
 * applies, so the badge in the editor matches what the storefront does with the deal.
 */
export type DishState = 'ok' | 'hidden' | 'soldOut' | 'missing';

export function dishState(item: ComboMenuItem | undefined, quantity: number, now = Date.now()): DishState {
  if (!item) return 'missing';
  if (!item.is_active) return 'hidden';
  const eightySixed = !!item.sold_out_until && new Date(item.sold_out_until).getTime() > now;
  const short = item.track_stock && (item.stock_quantity ?? 0) < quantity;
  return eightySixed || short ? 'soldOut' : 'ok';
}

/** The list with the entry at `index` moved one place up (-1) or down (1); unchanged at an end. */
export function moveEntry<T>(list: readonly T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [entry] = next.splice(index, 1);
  next.splice(target, 0, entry as T);
  return next;
}
