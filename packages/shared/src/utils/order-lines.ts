/**
 * The order an order's lines are listed in: the menu's.
 *
 * Bills, receipts and kitchen tickets used to list lines in whatever order the cart held them,
 * so a dessert, a set or a drink tapped early sat in the middle of the mains. Food Thai Thai's
 * owner asked for the lines to run category by category, in the order the back office's Arrange
 * tab puts them (menu_categories.display_order, then menu_items.display_order inside a category).
 *
 * place-order does not write the positions: a BEFORE INSERT trigger on order_items stamps
 * category_position and item_position from the menu (migration 20260922120000), and lines on
 * orders still open follow when the owner reorders. Combos have no category; the storefront shows
 * them in their own section above every category, so their lines take category_position 0 and the
 * active categories count from 1. A dish in a hidden category has none and sorts last.
 *
 * Every screen that lists lines sorts them with compareOrderLines, and the SQL that lists them
 * (get_table_session_bill, get_driver_order, issue_tax_invoice) orders by the same keys, with
 * private.order_line_options_key as the twin of orderLineOptionsKey below. Edit the two together.
 */

/** What compareOrderLines reads of a line. Everything is optional: a missing key sorts last. */
export interface OrderLineSortKey {
  /** order_items.category_position: 0 for a combo, then the dish's category, counted from 1. */
  category_position?: number | string | null;
  /** order_items.item_position: the dish's place in its category, or the combo's among combos. */
  item_position?: number | string | null;
  item_name?: string | null;
  /** The chosen options: order_items.modifiers jsonb, a cart line's modifiers, or plain names. */
  modifiers?: unknown;
  created_at?: string | null;
  id?: string | null;
}

/** Code-unit order: the same on every device and in every language, like Postgres's "C" collation. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A position, or null when the line has none (a dish that has lost its category). */
function position(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Positions ascending, a line without one after every line with one. */
function comparePosition(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a - b;
}

/** Joins option names. U+0001 sorts below every printable character, so joined keys compare name by name. */
const OPTION_SEPARATOR = String.fromCharCode(1);

/**
 * The chosen options as one comparable key: their names, in the order they were chosen (the
 * menu's group order), so the same dish with different options sits side by side in a stable
 * order, and a line with no options comes first.
 *
 * Reads the shapes a line's options arrive in: place-order's [{ name, option_id, ... }], a cart
 * line's [{ option_name, ... }], bare strings, and the {label}/{title}/{value} spellings the
 * kitchen board tolerates. private.order_line_options_key is the SQL twin.
 */
export function orderLineOptionsKey(raw: unknown): string {
  let entries: unknown[] = [];
  if (Array.isArray(raw)) entries = raw;
  else if (raw && typeof raw === 'object') entries = Object.values(raw as Record<string, unknown>);
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.trim()) names.push(entry.trim());
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const name = [o.name, o.label, o.option_name, o.title, o.value].find(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    if (name) names.push(name.trim());
  }
  return names.join(OPTION_SEPARATOR);
}

/** Creation time, read as a time when both sides parse and as text otherwise. */
function compareCreated(a: string, b: string): number {
  if (a === b) return 0;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  return compareText(a, b);
}

/** A line's sort key with every field read once. */
interface ReadKey {
  category: number | null;
  item: number | null;
  name: string;
  options: string;
  created: string;
  id: string;
}

function readKey(k: OrderLineSortKey): ReadKey {
  return {
    category: position(k.category_position),
    item: position(k.item_position),
    name: k.item_name ?? '',
    options: orderLineOptionsKey(k.modifiers),
    created: k.created_at ?? '',
    id: k.id ?? '',
  };
}

function compareReadKeys(a: ReadKey, b: ReadKey): number {
  return (
    comparePosition(a.category, b.category) ||
    comparePosition(a.item, b.item) ||
    compareText(a.name, b.name) ||
    compareText(a.options, b.options) ||
    compareCreated(a.created, b.created) ||
    compareText(a.id, b.id)
  );
}

/**
 * Menu order: the category's position, the dish's position in it, the dish's name, its options,
 * then when the line was written and its id, so two screens never disagree about a tie.
 */
export function compareOrderLines(a: OrderLineSortKey, b: OrderLineSortKey): number {
  return compareReadKeys(readKey(a), readKey(b));
}

/**
 * The lines in menu order, as a new array; the input is left as it was.
 *
 * Without `key` each line is read as an order_items row. Pass one for any other shape: a cart
 * line, or a bill row that calls the dish `name`.
 */
export function sortOrderLines<T>(lines: readonly T[], key?: (line: T) => OrderLineSortKey): T[] {
  const read = key ?? ((line: T) => line as unknown as OrderLineSortKey);
  // Keys are read once per line rather than once per comparison, since orderLineOptionsKey walks
  // the options. Lines that tie on every key keep the order they came in.
  const keyed = lines.map((line, index) => ({ line, index, key: readKey(read(line)) }));
  keyed.sort((a, b) => compareReadKeys(a.key, b.key) || a.index - b.index);
  return keyed.map((entry) => entry.line);
}

/** Where a dish or a combo sits on the menu, for a line that has no order_items row yet. */
export interface MenuLinePosition {
  category_position: number | null;
  item_position: number | null;
}

/** The menu as the storefront and the counter already hold it. */
export interface MenuOrderSource {
  /**
   * In the menu's order (display_order, then age); a stable sort by displayOrder keeps ties as
   * given. A category with `isActive: false` is left out, as if it had not been read.
   */
  categories: ReadonlyArray<{ id: string; displayOrder?: number | null; isActive?: boolean | null }>;
  /** In the menu's order. A dish without displayOrder takes its place in this list. */
  items: ReadonlyArray<{ id: string; categoryId?: string | null; displayOrder?: number | null }>;
  /** In the merchant's order. A combo without `order` takes its place in this list. */
  combos?: ReadonlyArray<{ id: string; order?: number | null }>;
}

/**
 * The positions a line will be given once it is an order_items row, worked out from the menu the
 * page already loaded, so the cart (before an order exists) lists lines in the same order as the
 * bill will. Categories are counted from 1 and combos take 0, as the trigger does; a dish or combo
 * the menu no longer lists gets nulls and sorts last.
 *
 * Only active categories are counted, and a dish in a hidden one has no category position, which
 * is the rule private.order_line_menu_position follows. A hidden category's dishes are still on
 * sale, but a diner's session cannot read the category (RLS) and the counter does not load it, so
 * such a dish sorts last here whatever happens; the bill agrees only because the trigger does not
 * count hidden categories either. A caller that did read one (staff, whose reads RLS lets through)
 * passes isActive and gets the same answer.
 */
export function menuLinePositions(
  menu: MenuOrderSource,
): (ref: { menuItemId?: string | null; comboId?: string | null }) => MenuLinePosition {
  const categoryRank = new Map<string, number>();
  menu.categories
    .filter((c) => c.isActive !== false)
    .map((c, index) => ({ id: c.id, order: c.displayOrder ?? index, index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .forEach((c, rank) => categoryRank.set(c.id, rank + 1));

  const items = new Map<string, MenuLinePosition>();
  menu.items.forEach((item, index) => {
    items.set(item.id, {
      category_position: item.categoryId ? (categoryRank.get(item.categoryId) ?? null) : null,
      item_position: item.displayOrder ?? index,
    });
  });

  const combos = new Map<string, MenuLinePosition>();
  (menu.combos ?? []).forEach((combo, index) => {
    combos.set(combo.id, { category_position: 0, item_position: combo.order ?? index });
  });

  const none: MenuLinePosition = { category_position: null, item_position: null };
  return ({ menuItemId, comboId }) => {
    if (comboId) return combos.get(comboId) ?? none;
    return (menuItemId ? items.get(menuItemId) : undefined) ?? none;
  };
}

/**
 * The dishes in the menu's own order: category by category in the order the owner arranged them
 * (the Categories sheet and Reorder mode), then dish by dish inside each category.
 *
 * The storefront, the counter and the POS used to list their dishes by display_order alone. That
 * number is a position INSIDE a category, so every category's first dish shared 0, every second
 * dish shared 1, and the "All" view interleaved the categories: a test dish in the last category
 * could open the menu while the admin showed it at the bottom. Sorting here keeps every screen in
 * the order the admin shows, which is also the order bills and kitchen tickets use
 * (menuLinePositions ranks categories the same way).
 *
 * A dish whose category is missing from `categories` (none, hidden, or not read) goes after every
 * ranked one. Ties fall back to the name and then the id, so the order is the same on every load.
 * Returns a new array; the input is not reordered.
 */
export function sortItemsInMenuOrder<
  T extends { id: string; name?: string | null; categoryId?: string | null; displayOrder?: number | null },
>(items: readonly T[], categories: MenuOrderSource['categories']): T[] {
  const categoryRank = new Map<string, number>();
  categories
    .filter((c) => c.isActive !== false)
    .map((c, index) => ({ id: c.id, order: c.displayOrder ?? index, index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .forEach((c, rank) => categoryRank.set(c.id, rank));
  const unranked = Number.MAX_SAFE_INTEGER;
  const rankOf = (item: T) => (item.categoryId ? (categoryRank.get(item.categoryId) ?? unranked) : unranked);
  const orderOf = (item: T) =>
    typeof item.displayOrder === 'number' && Number.isFinite(item.displayOrder) ? item.displayOrder : unranked;
  const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...items].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      orderOf(a) - orderOf(b) ||
      byCode(a.name ?? '', b.name ?? '') ||
      byCode(a.id, b.id),
  );
}
