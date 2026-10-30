import { describe, expect, it } from 'vitest';
import * as edge from '../../../../supabase/functions/place-order/item-options';
import { groupsOnDishes, optionsOffTheirDish, type CartLine } from '@/store/cart';

/**
 * place-order's rule that an option is ordered only on a dish that shows its group, pinned from
 * here because a Deno function cannot run under this app's test runner but a module with no
 * imports can: supabase/functions/place-order/item-options.ts imports nothing for exactly this
 * reason.
 *
 * What is at stake: a dish can carry its own copy of a library option group, made the first time
 * the group is changed in that dish's editor. The library's options are then off that one dish
 * while the library group, and every other dish showing it, still offer them. A cart built before
 * the copy must not order the library's "Thai Hot" on the curry whose own Spicy Level dropped it,
 * and the storefront cart (optionsOffTheirDish) has to take out exactly the lines place-order
 * would refuse, or the diner meets the refusal at the button instead of on the cart screen.
 */

// The owner's Spicy Level, shared by the curry and Pad Krapow until the curry was given its own
// copy without Thai Hot. Protein is linked to the curry only.
const GROUP_OF: Record<string, string> = {
  mild: 'spicy',
  'thai-hot': 'spicy',
  'copy-mild': 'spicy-copy',
  chicken: 'protein',
};
const LINKS: edge.ItemGroupLink[] = [
  { menu_item_id: 'curry', modifier_group_id: 'spicy-copy' },
  { menu_item_id: 'curry', modifier_group_id: 'protein' },
  { menu_item_id: 'pad-krapow', modifier_group_id: 'spicy' },
];
const groupOf = (table: Record<string, string> = GROUP_OF) =>
  new Map(Object.entries(table).map(([id, group_id]) => [id, { id, group_id }]));

describe('place-order: an option rides only on a dish that shows its group', () => {
  it('accepts every option of a group linked to its own line’s dish', () => {
    const lines = [
      { menu_item_id: 'curry', modifier_option_ids: ['copy-mild', 'chicken'] },
      { menu_item_id: 'pad-krapow', modifier_option_ids: ['thai-hot'] },
      { menu_item_id: 'pad-krapow', modifier_option_ids: ['mild'] },
    ];
    expect(edge.optionNotOnItem(lines, groupOf(), LINKS)).toBeNull();
  });

  it('refuses the library’s option on a dish that carries its own copy, naming the dish', () => {
    const lines = [
      { menu_item_id: 'pad-krapow', modifier_option_ids: ['thai-hot'] },
      { menu_item_id: 'curry', modifier_option_ids: ['chicken', 'thai-hot'] },
    ];
    expect(edge.optionNotOnItem(lines, groupOf(), LINKS)).toEqual({ option_id: 'thai-hot', item_id: 'curry' });
  });

  it('refuses an option whose group is linked only to another dish of the order', () => {
    const lines = [
      { menu_item_id: 'curry', modifier_option_ids: ['chicken'] },
      { menu_item_id: 'pad-krapow', modifier_option_ids: ['chicken'] },
    ];
    expect(edge.optionNotOnItem(lines, groupOf(), LINKS)).toEqual({ option_id: 'chicken', item_id: 'pad-krapow' });
  });

  it('names the first offending option in line order', () => {
    const lines = [
      { menu_item_id: 'curry', modifier_option_ids: ['copy-mild', 'mild'] },
      { menu_item_id: 'pad-krapow', modifier_option_ids: ['chicken'] },
    ];
    expect(edge.optionNotOnItem(lines, groupOf(), LINKS)).toEqual({ option_id: 'mild', item_id: 'curry' });
  });

  it('refuses any option on a dish that shows no group at all', () => {
    const lines = [{ menu_item_id: 'plain-rice', modifier_option_ids: ['mild'] }];
    expect(edge.optionNotOnItem(lines, groupOf(), LINKS)).toEqual({ option_id: 'mild', item_id: 'plain-rice' });
  });

  it('refuses an option it has no group for rather than letting it through', () => {
    // index.ts refuses an unknown option before this runs; the rule still never waves one through.
    const lines = [{ menu_item_id: 'curry', modifier_option_ids: ['ghost'] }];
    expect(edge.optionNotOnItem(lines, groupOf(), LINKS)).toEqual({ option_id: 'ghost', item_id: 'curry' });
  });

  it('has nothing to say about lines without options', () => {
    const lines = [
      { menu_item_id: 'plain-rice' },
      { menu_item_id: 'plain-rice', modifier_option_ids: null },
      { menu_item_id: 'plain-rice', modifier_option_ids: [] },
    ];
    expect(edge.optionNotOnItem(lines, groupOf(), [])).toBeNull();
  });
});

describe('the storefront cart takes out exactly the lines place-order would refuse', () => {
  const cartLine = (menuItemId: string, optionId: string): CartLine => ({
    id: `${menuItemId}-${optionId}`,
    branchId: 'branch-1',
    menuItemId,
    name: menuItemId,
    unitPrice: 10,
    quantity: 1,
    imageUrl: null,
    modifiers: [{ group_id: 'g', group_name: 'Options', option_id: optionId, option_name: optionId, price_delta: 0 }],
  });

  // The cart leaves alone an option or a dish its reads do not cover (a failed or partial read
  // changes nothing); place-order reads every one, so the cases below give both sides all of them.
  const cases: Array<{ name: string; links: edge.ItemGroupLink[] }> = [
    { name: 'the curry with its own copy', links: LINKS },
    {
      name: 'before the copy',
      links: [
        ...LINKS.filter((l) => l.modifier_group_id !== 'spicy-copy'),
        { menu_item_id: 'curry', modifier_group_id: 'spicy' },
      ],
    },
    { name: 'a dish with no group', links: LINKS.filter((l) => l.menu_item_id !== 'pad-krapow') },
    { name: 'nothing linked anywhere', links: [] },
  ];
  const dishes = ['curry', 'pad-krapow', 'plain-rice'];

  it.each(cases)('agrees on every dish and option: $name', ({ links }) => {
    const optionGroups = new Map(Object.entries(GROUP_OF));
    const shown = groupsOnDishes(dishes, links);
    for (const dish of dishes) {
      for (const option of Object.keys(GROUP_OF)) {
        const refused = edge.optionNotOnItem([{ menu_item_id: dish, modifier_option_ids: [option] }], groupOf(), links) !== null;
        const takenOut = optionsOffTheirDish([cartLine(dish, option)], optionGroups, shown).get(dish)?.has(option) ?? false;
        expect(takenOut, `${option} on ${dish}`).toBe(refused);
      }
    }
  });
});
