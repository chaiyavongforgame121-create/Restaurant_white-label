// place-order's rule that an option is ordered only on a dish that offers it, with no I/O, so it
// can be unit-tested.
//
// Imports nothing on purpose: index.ts (Deno) imports it as './item-options.ts', and
// apps/web/src/lib/item-options-edge.test.ts imports it from Node to pin the rule, and to pin the
// storefront cart's own reading of it (optionsOffTheirDish in apps/web/src/store/cart.ts) to the
// same answers: the cart takes such a line out before the diner reaches the button, so the two
// must agree. When deploying through the Management API / MCP rather than the CLI, pass this file
// with index.ts.

/** One menu_item_modifiers row: the dish shows that option group. */
export interface ItemGroupLink {
  menu_item_id: string;
  modifier_group_id: string;
}

/** An order line as far as this rule reads it: the dish, and the options chosen on it. */
export interface OptionLine {
  menu_item_id: string;
  modifier_option_ids?: readonly string[] | null;
}

/** An option sent on a dish that does not offer it, and that dish. */
export interface OptionOffItem {
  option_id: string;
  item_id: string;
}

/**
 * The first option, in line order, sent on a dish that does not show the option's group; null
 * when every option is on its own dish.
 *
 * A dish offers an option only through a group linked to it (menu_item_modifiers). Checking the
 * option's branch and is_active alone let any option of the branch ride on any dish. That was
 * harmless while every dish showed the shared groups as they were; since a dish can carry its own
 * copy of a library group (20261030100000_item_modifier_copies), a cart built before the copy
 * still sends the library's option the merchant took off that one dish -- "Thai Hot" on the curry
 * whose own Spicy Level no longer has it, while the library group, and every other dish, still do.
 * It also catches a group unlinked from a dish after the cart was built.
 *
 * `groupOf` is each option's group (place-order's modMap); an option it does not know is on no
 * dish. `links` are the menu_item_modifiers rows of the lines' dishes; a dish with none shows no
 * group, so any option sent on it is off.
 */
export function optionNotOnItem(
  lines: readonly OptionLine[],
  groupOf: ReadonlyMap<string, { group_id: string }>,
  links: readonly ItemGroupLink[],
): OptionOffItem | null {
  const shown = new Map<string, Set<string>>();
  for (const link of links) {
    let groups = shown.get(link.menu_item_id);
    if (!groups) {
      groups = new Set();
      shown.set(link.menu_item_id, groups);
    }
    groups.add(link.modifier_group_id);
  }
  for (const line of lines) {
    for (const optionId of line.modifier_option_ids ?? []) {
      const group = groupOf.get(optionId)?.group_id;
      if (group === undefined || !shown.get(line.menu_item_id)?.has(group)) {
        return { option_id: optionId, item_id: line.menu_item_id };
      }
    }
  }
  return null;
}
