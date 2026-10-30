import { groupsOnDishes, type CartLineModifier, type ComboPick } from '@/store/cart';

/**
 * "Order again": a past order's lines as the restaurant sells them today, for the orders list to
 * put in the cart. No I/O, so it can be unit-tested; orders-list.tsx does the reads and the adds.
 *
 * Live rows only: current prices, current availability. A dish, combo or option that no longer
 * exists (or is 86'd) is left out and counted, never silently, and the diner is told to review the
 * cart. An option goes back only on a dish that shows its group now (place-order refuses any other,
 * modifier_inactive / not_on_item), with one carry-over: a dish given its own copy of a library
 * group since the order still offers the same choices, under new ids.
 */

/** A row PostgREST embeds through a foreign key: the row, a one-row array, or nothing. */
type Embedded<T> = T | readonly T[] | null | undefined;

const isList = <T>(value: T | readonly T[]): value is readonly T[] => Array.isArray(value);

function one<T>(value: Embedded<T>): T | null {
  if (value == null) return null;
  return isList(value) ? (value[0] ?? null) : value;
}

/** An option chosen on a past line, as place-order stored it (order_items.modifiers). */
export interface PastOption {
  group_id: string;
  option_id: string;
  /** The option's name when the order was placed. */
  name: string;
  price_delta: number;
}

/** A past order's line (order_items): a dish with its options, or a combo. */
export interface PastLine {
  menu_item_id: string | null;
  combo_id?: string | null;
  quantity: number;
  notes?: string | null;
  modifiers?: readonly PastOption[] | null;
}

export interface LiveDish {
  id: string;
  branch_id: string;
  category_id: string | null;
  name: string;
  price: number | string;
  image_url: string | null;
  is_active: boolean;
}

export interface LiveCombo {
  id: string;
  branch_id: string;
  name: string;
  image_url: string | null;
  total_price: number | string;
  is_active: boolean;
  combo_items?: ReadonlyArray<{ quantity: number; menu_items: Embedded<{ name: string }> }> | null;
}

export interface LiveOption {
  id: string;
  group_id: string;
  name: string;
  price_delta: number | string;
  is_active: boolean;
  modifier_groups?: Embedded<{ name?: string | null }>;
}

export interface LiveGroupOption {
  id: string;
  name: string;
  price_delta: number | string;
  is_active: boolean;
}

/**
 * One menu_item_modifiers row of a dish an option was chosen on, with the group it shows and that
 * group's options: read together, so a dish's own copy of a library group can be told apart.
 */
export interface LiveDishGroup {
  menu_item_id: string;
  modifier_group_id: string;
  modifier_groups?: Embedded<{
    name: string;
    /** Set on a dish's own copy: the library group it was made from. */
    source_group_id: string | null;
    is_required: boolean;
    min_select: number;
    modifier_options?: readonly LiveGroupOption[] | null;
  }>;
}

/** What Order again reads for a past order: the dishes, combos and options it names. */
export function reorderIds(lines: readonly PastLine[]) {
  const itemLines = lines.filter((l) => l.menu_item_id);
  return {
    menuIds: [...new Set(itemLines.map((l) => l.menu_item_id as string))],
    comboIds: [...new Set(lines.filter((l) => !l.menu_item_id && l.combo_id).map((l) => l.combo_id as string))],
    optionIds: [...new Set(itemLines.flatMap((l) => (l.modifiers ?? []).map((m) => m.option_id)))],
    // The dishes those options were chosen on, whose groups (menu_item_modifiers) are read too.
    optionMenuIds: [
      ...new Set(itemLines.filter((l) => (l.modifiers ?? []).length > 0).map((l) => l.menu_item_id as string)),
    ],
  };
}

/** A dish to put back, in the fields the cart's add reads (orders-list hands it over as a MenuItem). */
export interface ReorderDish {
  id: string;
  branchId: string;
  categoryId: string;
  name: string;
  price: number;
  imageUrl: string | null;
}

export type ReorderAdd =
  | { kind: 'item'; dish: ReorderDish; quantity: number; notes?: string; modifiers?: CartLineModifier[] }
  | { kind: 'combo'; combo: ComboPick; quantity: number };

export interface ReorderPlan {
  /** What goes in the cart, in the order's own line order. */
  adds: ReorderAdd[];
  /** Lines and options left out. Above 0, the diner is told to review the cart. */
  dropped: number;
}

/** A dish's own copy of a library group, as the carry-over reads it. */
interface DishCopy {
  id: string;
  name: string;
  /** Choices the dish needs made in it: min_select, and at least one when it is required. */
  needed: number;
  options: readonly LiveGroupOption[];
}

function activeNamed(options: readonly LiveGroupOption[], name: string | undefined): LiveGroupOption | undefined {
  return name === undefined ? undefined : options.find((o) => o.is_active && o.name === name);
}

/**
 * The lines of a past order that can go back in the cart, priced and named as they are now, and
 * how many lines and options were left out.
 *
 * `live` is what was read for reorderIds(lines): every read must have succeeded. A failed read is
 * not "gone", and the caller stops before calling this.
 */
export function planReorder(
  lines: readonly PastLine[],
  live: {
    dishes: readonly LiveDish[];
    combos: readonly LiveCombo[];
    options: readonly LiveOption[];
    dishGroups: readonly LiveDishGroup[];
  },
): ReorderPlan {
  const dishById = new Map(live.dishes.map((d) => [d.id, d]));
  const comboById = new Map(live.combos.map((c) => [c.id, c]));
  const optionById = new Map(live.options.map((o) => [o.id, o]));
  // The groups each of those dishes shows now. A dish offers an option only through a group linked
  // to it: a dish given its own copy of a library group since this order no longer offers the
  // library's options, though other dishes still do, and place-order would refuse them.
  const shownOn = groupsOnDishes(reorderIds(lines).optionMenuIds, live.dishGroups);
  // By dish, then by library group: the dish's own copy of that group. The first change made to a
  // library group in a dish's editor gives the dish a copy (customize_item_modifier_group) with the
  // same names and a new id for every option, and the dish shows the copy in its place.
  const copiesOn = new Map<string, Map<string, DishCopy>>();
  for (const row of live.dishGroups) {
    const group = one(row.modifier_groups);
    if (!group?.source_group_id) continue;
    let bySource = copiesOn.get(row.menu_item_id);
    if (!bySource) {
      bySource = new Map();
      copiesOn.set(row.menu_item_id, bySource);
    }
    if (bySource.has(group.source_group_id)) continue;
    bySource.set(group.source_group_id, {
      id: row.modifier_group_id,
      name: group.name,
      needed: Math.max(Number(group.min_select) || 0, group.is_required ? 1 : 0),
      options: group.modifier_options ?? [],
    });
  }

  let dropped = 0;
  const adds: ReorderAdd[] = [];

  for (const line of lines) {
    if (line.menu_item_id) {
      const dish = dishById.get(line.menu_item_id);
      if (!dish || !dish.is_active) { dropped += 1; continue; }
      const shown = shownOn.get(dish.id);
      const modifiers: CartLineModifier[] = [];
      // The dish's copies this line lost a choice in.
      const lostIn: DishCopy[] = [];
      for (const sel of line.modifiers ?? []) {
        const option = optionById.get(sel.option_id);
        if (option && option.is_active && shown?.has(option.group_id)) {
          modifiers.push({
            group_id: option.group_id,
            group_name: one(option.modifier_groups)?.name ?? 'Options',
            option_id: option.id,
            option_name: option.name,
            price_delta: Number(option.price_delta),
          });
          continue;
        }
        // The dish carries its own copy of the option's library group now: the same choice is the
        // copy's option of that name. Looked up by the order's own group and name as well, so a
        // library option deleted after the copy was made is still found in the copy.
        const copy = copiesOn.get(dish.id)?.get(option?.group_id ?? sel.group_id);
        const twin = copy && (activeNamed(copy.options, sel.name) ?? activeNamed(copy.options, option?.name));
        if (copy && twin) {
          modifiers.push({
            group_id: copy.id,
            group_name: copy.name,
            option_id: twin.id,
            option_name: twin.name,
            price_delta: Number(twin.price_delta),
          });
          continue;
        }
        if (copy) lostIn.push(copy);
        dropped += 1;
      }
      // A copy that needs a choice this line can no longer carry into it. Put back without one, the
      // curry would reach the kitchen with no spice level: neither the cart nor place-order checks
      // required groups. Left out instead (its option is already counted); the item sheet asks for
      // the choice when the diner adds the dish again.
      const unmet = lostIn.some(
        (copy) => new Set(modifiers.filter((m) => m.group_id === copy.id).map((m) => m.option_id)).size < copy.needed,
      );
      if (unmet) continue;
      adds.push({
        kind: 'item',
        dish: {
          id: dish.id,
          branchId: dish.branch_id,
          categoryId: dish.category_id ?? '',
          name: dish.name,
          price: Number(dish.price),
          imageUrl: dish.image_url ?? null,
        },
        quantity: line.quantity,
        notes: line.notes ?? undefined,
        modifiers: modifiers.length > 0 ? modifiers : undefined,
      });
    } else if (line.combo_id) {
      const combo = comboById.get(line.combo_id);
      if (!combo || !combo.is_active) { dropped += 1; continue; }
      adds.push({
        kind: 'combo',
        combo: {
          comboId: combo.id,
          name: combo.name,
          imageUrl: combo.image_url ?? null,
          totalPrice: Number(combo.total_price),
          branchId: combo.branch_id,
          contents: (combo.combo_items ?? []).map((ci) => ({
            item_name: one(ci.menu_items)?.name ?? '',
            quantity: ci.quantity,
          })),
        },
        quantity: line.quantity,
      });
    }
  }

  return { adds, dropped };
}
