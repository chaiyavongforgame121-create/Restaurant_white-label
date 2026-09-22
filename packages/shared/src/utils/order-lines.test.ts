import { describe, expect, it } from 'vitest';
import {
  compareOrderLines,
  menuLinePositions,
  orderLineOptionsKey,
  sortOrderLines,
  type OrderLineSortKey,
} from './index';

/**
 * Food Thai Thai, order A-2609-0005 as place-order wrote it (cart order): a SET A, a drink, two
 * soups and another SET A. The categories run Appetizers, Soups, ..., Desserts, Special SET, Drink
 * (display_order 0..10), so the trigger stamps Soups 2, Special SET 10 and Drink 11.
 */
const setNoEgg = {
  id: 'l1',
  item_name: 'SET A : Green Curry Chicken',
  category_position: 10,
  item_position: 0,
  modifiers: [{ group_id: 'g', option_id: 'o1', name: 'No Egg', price_delta: 0 }],
  created_at: '2026-09-21T21:22:44.452404+00:00',
};
const drink = { id: 'l2', item_name: 'Fountain Drink', category_position: 11, item_position: 0, modifiers: [] };
const tomYum = { id: 'l3', item_name: 'Tom Yum Soup', category_position: 2, item_position: 1, modifiers: [] };
const tomKha = { id: 'l4', item_name: 'Tom Kha Soup', category_position: 2, item_position: 3, modifiers: [] };
const setEgg = {
  ...setNoEgg,
  id: 'l5',
  modifiers: [{ group_id: 'g', option_id: 'o2', name: 'Runny-Yolk Fried Egg', price_delta: 2 }],
};

describe('sortOrderLines', () => {
  it('lists order #0005 category by category: soups, then the sets side by side, then the drink', () => {
    const sorted = sortOrderLines([setNoEgg, drink, tomYum, tomKha, setEgg]);
    expect(sorted.map((l) => l.id)).toEqual(['l3', 'l4', 'l1', 'l5', 'l2']);
  });

  it('returns a new array and leaves the one it was given alone', () => {
    const input = [drink, tomYum];
    const sorted = sortOrderLines(input);
    expect(sorted).not.toBe(input);
    expect(input.map((l) => l.id)).toEqual(['l2', 'l3']);
  });

  it('puts combos (category 0) above every category', () => {
    const combo = { id: 'c', item_name: 'Burger Combo Deal', category_position: 0, item_position: 0 };
    expect(sortOrderLines([tomYum, combo]).map((l) => l.id)).toEqual(['c', 'l3']);
  });

  it('puts a line without a position after every line with one', () => {
    const lost = { id: 'x', item_name: 'Aardvark', category_position: null, item_position: 0 };
    const noItemPos = { id: 'y', item_name: 'Aardvark', category_position: 2, item_position: null };
    expect(sortOrderLines([lost, noItemPos, tomKha]).map((l) => l.id)).toEqual(['l4', 'y', 'x']);
  });

  it('reads positions that arrive as strings', () => {
    const a = { id: 'a', category_position: '10', item_position: '2' };
    const b = { id: 'b', category_position: '9', item_position: '5' };
    expect(sortOrderLines([a, b]).map((l) => l.id)).toEqual(['b', 'a']);
  });

  it('breaks a tie on position by name, then options, then age, then id', () => {
    const base = { category_position: 3, item_position: 0 };
    const lines: Array<OrderLineSortKey & { id: string }> = [
      { ...base, id: 'd', item_name: 'Pad Thai', modifiers: ['Mild'], created_at: '2026-09-21T10:00:00Z' },
      { ...base, id: 'c', item_name: 'Pad Thai', modifiers: ['Mild'], created_at: '2026-09-21T10:00:00Z' },
      { ...base, id: 'b', item_name: 'Pad Thai', modifiers: ['Mild'], created_at: '2026-09-21T09:00:00Z' },
      { ...base, id: 'a', item_name: 'Pad Thai', modifiers: [] },
      { ...base, id: 'z', item_name: 'Pad See Ew' },
    ];
    // "Pad See Ew" < "Pad Thai" in code-unit order; a plain Pad Thai before the Mild ones.
    expect(sortOrderLines(lines).map((l) => l.id)).toEqual(['z', 'a', 'b', 'c', 'd']);
  });

  it('keeps the given order for lines that tie on every key', () => {
    const one = { item_name: 'Tea' };
    const two = { item_name: 'Tea' };
    const sorted = sortOrderLines([two, one]);
    expect(sorted[0]).toBe(two);
    expect(sorted[1]).toBe(one);
  });

  it('sorts any shape through a key function (a cart line, a bill row)', () => {
    const cart = [
      { id: 'x', name: 'Mango Sticky Rice', pos: { category_position: 9, item_position: 0 } },
      { id: 'y', name: 'Pad Thai', pos: { category_position: 3, item_position: 0 } },
    ];
    const sorted = sortOrderLines(cart, (l) => ({ ...l.pos, item_name: l.name }));
    expect(sorted.map((l) => l.id)).toEqual(['y', 'x']);
  });
});

describe('compareOrderLines', () => {
  it('orders by category before the dish position inside it', () => {
    expect(compareOrderLines(tomKha, setNoEgg)).toBeLessThan(0);
    expect(compareOrderLines(setNoEgg, drink)).toBeLessThan(0);
    expect(compareOrderLines(tomYum, tomKha)).toBeLessThan(0);
    expect(compareOrderLines(tomYum, tomYum)).toBe(0);
  });
});

describe('orderLineOptionsKey', () => {
  it('reads place-order rows, cart lines and bare names alike', () => {
    expect(orderLineOptionsKey([{ name: ' No Egg ', option_id: 'o1' }])).toBe('No Egg');
    expect(orderLineOptionsKey([{ option_id: 'o1', option_name: 'No Egg' }])).toBe('No Egg');
    expect(orderLineOptionsKey(['No Egg'])).toBe('No Egg');
    expect(orderLineOptionsKey([{ label: 'Large' }, null, 3, { price: 1 }])).toBe('Large');
  });

  it('is empty for no options at all', () => {
    expect(orderLineOptionsKey([])).toBe('');
    expect(orderLineOptionsKey(null)).toBe('');
    expect(orderLineOptionsKey(undefined)).toBe('');
  });

  it('compares name by name, so a shorter choice list that is a prefix comes first', () => {
    const one = orderLineOptionsKey(['Egg']);
    const two = orderLineOptionsKey(['Egg', 'Rice']);
    const spaced = orderLineOptionsKey(['Egg A']);
    expect(one < two).toBe(true);
    // Element-wise: "Egg" < "Egg A", so ['Egg', 'Rice'] sorts before ['Egg A'].
    expect(two < spaced).toBe(true);
  });
});

describe('menuLinePositions', () => {
  const menu = {
    categories: [
      { id: 'soups', displayOrder: 1 },
      { id: 'apps', displayOrder: 0 },
      // Tied with Soups: kept after it, as the list gave them.
      { id: 'noodles', displayOrder: 1 },
    ],
    items: [
      { id: 'tom-yum', categoryId: 'soups', displayOrder: 1 },
      { id: 'spring-roll', categoryId: 'apps', displayOrder: 0 },
      { id: 'pad-thai', categoryId: 'noodles' },
      { id: 'orphan', categoryId: null, displayOrder: 4 },
    ],
    combos: [{ id: 'deal', order: 2 }],
  };
  const positionOf = menuLinePositions(menu);

  it('counts categories from 1 in the menu order, and gives combos 0', () => {
    expect(positionOf({ menuItemId: 'spring-roll' })).toEqual({ category_position: 1, item_position: 0 });
    expect(positionOf({ menuItemId: 'tom-yum' })).toEqual({ category_position: 2, item_position: 1 });
    // No displayOrder: its place in the item list.
    expect(positionOf({ menuItemId: 'pad-thai' })).toEqual({ category_position: 3, item_position: 2 });
    expect(positionOf({ comboId: 'deal', menuItemId: 'deal' })).toEqual({ category_position: 0, item_position: 2 });
  });

  it('gives nulls to what the menu no longer lists, and no category to a dish without one', () => {
    expect(positionOf({ menuItemId: 'gone' })).toEqual({ category_position: null, item_position: null });
    expect(positionOf({ comboId: 'gone' })).toEqual({ category_position: null, item_position: null });
    expect(positionOf({ menuItemId: 'orphan' })).toEqual({ category_position: null, item_position: 4 });
  });

  it('does not count a hidden category, and gives its dishes no category position', () => {
    // Food Thai Thai with Soups hidden: the trigger counts active categories only, so Drink is
    // 10, not 11, and Tom Yum (still on sale) goes to the end of the bill, as in the cart.
    const withHidden = menuLinePositions({
      categories: [
        { id: 'apps', displayOrder: 0 },
        { id: 'soups', displayOrder: 1, isActive: false },
        { id: 'special-set', displayOrder: 9, isActive: true },
        { id: 'drink', displayOrder: 10 },
      ],
      items: [
        { id: 'spring-roll', categoryId: 'apps', displayOrder: 0 },
        { id: 'tom-yum', categoryId: 'soups', displayOrder: 1 },
        { id: 'set-a', categoryId: 'special-set', displayOrder: 0 },
        { id: 'fountain', categoryId: 'drink', displayOrder: 0 },
      ],
    });
    expect(withHidden({ menuItemId: 'spring-roll' })).toEqual({ category_position: 1, item_position: 0 });
    expect(withHidden({ menuItemId: 'tom-yum' })).toEqual({ category_position: null, item_position: 1 });
    expect(withHidden({ menuItemId: 'set-a' })).toEqual({ category_position: 2, item_position: 0 });
    expect(withHidden({ menuItemId: 'fountain' })).toEqual({ category_position: 3, item_position: 0 });

    // The same answer as a reader that never saw the hidden category (a diner, the counter).
    const unseen = menuLinePositions({
      categories: [
        { id: 'apps', displayOrder: 0 },
        { id: 'special-set', displayOrder: 9 },
        { id: 'drink', displayOrder: 10 },
      ],
      items: [
        { id: 'tom-yum', categoryId: 'soups', displayOrder: 1 },
        { id: 'fountain', categoryId: 'drink', displayOrder: 0 },
      ],
    });
    expect(unseen({ menuItemId: 'tom-yum' })).toEqual(withHidden({ menuItemId: 'tom-yum' }));
    expect(unseen({ menuItemId: 'fountain' })).toEqual(withHidden({ menuItemId: 'fountain' }));

    const cart = [
      { id: '1', menuItemId: 'tom-yum', name: 'Tom Yum Soup' },
      { id: '2', menuItemId: 'fountain', name: 'Fountain Drink' },
      { id: '3', menuItemId: 'set-a', name: 'SET A : Green Curry Chicken' },
    ];
    const sorted = sortOrderLines(cart, (l) => ({ ...withHidden(l), item_name: l.name }));
    expect(sorted.map((l) => l.id)).toEqual(['3', '2', '1']);
  });

  it('sorts a cart the way the bill will list it', () => {
    const cart = [
      { id: '1', menuItemId: 'tom-yum', name: 'Tom Yum Soup' },
      { id: '2', menuItemId: 'deal', comboId: 'deal', name: 'Deal' },
      { id: '3', menuItemId: 'spring-roll', name: 'Spring Roll' },
    ];
    const sorted = sortOrderLines(cart, (l) => ({ ...positionOf(l), item_name: l.name }));
    expect(sorted.map((l) => l.id)).toEqual(['2', '3', '1']);
  });
});
