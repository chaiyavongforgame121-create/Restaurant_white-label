// What the checkout quotes has to be what place-order charges. These pin the two places the
// checkout builds on the cart: the loyalty reward it takes off, and the lines it sends.

import { describe, expect, it } from 'vitest';
import { lineTotal, mergeIdenticalLines, sumMoney } from '@favornoms/shared';
import { loyaltyRewardDiscount, type LoyaltyReward } from '@favornoms/database/queries';
import { cartLineKey, cartLineTotal, type CartLine } from '@/store/cart';
import { orderLinesFromCart } from './cart-order-lines';

const SET_A = 'set-a';

const line = (over: Partial<CartLine> & Pick<CartLine, 'id'>): CartLine => ({
  branchId: 'branch-1',
  menuItemId: SET_A,
  name: 'SET A : Green Curry Chicken',
  unitPrice: 7.995,
  quantity: 1,
  imageUrl: null,
  ...over,
});

const freeSetA: Pick<LoyaltyReward, 'kind' | 'value' | 'max_discount' | 'menu_item_id' | 'menu_item_price'> = {
  kind: 'free_item',
  value: 0,
  max_discount: null,
  menu_item_id: SET_A,
  // list_loyalty_rewards reports the LIST price; the happy hour sells SET A at half of it.
  menu_item_price: 15.99,
};

/** place-order's free_item rule, as written there: the first dish line of the item, one unit. */
const serverFreeItemOff = (lines: readonly CartLine[], subtotal: number) => {
  const match = lines.find((l) => !l.comboId && l.menuItemId === SET_A);
  return match ? Math.min(lineTotal(match.unitPrice, 0, 1), subtotal) : null;
};

describe('loyaltyRewardDiscount, free item', () => {
  it('takes off the happy-hour unit the cart charges, not the list price', () => {
    const lines = [line({ id: 'l1', quantity: 2 })];
    const subtotal = sumMoney(lines.map(cartLineTotal));
    expect(subtotal).toBe(15.99);
    // Before: $15.99 off, food $0.00 on screen, while place-order took $8.00 off and charged $7.99.
    expect(loyaltyRewardDiscount(freeSetA, subtotal, lines)).toBe(8);
    expect(loyaltyRewardDiscount(freeSetA, subtotal, lines)).toBe(serverFreeItemOff(lines, subtotal));
  });

  it('prices one unit as a line of one: 7.995 is $8.00 off, never a fraction of a cent', () => {
    const lines = [line({ id: 'l1', quantity: 7 })];
    const subtotal = sumMoney(lines.map(cartLineTotal));
    expect(subtotal).toBe(55.97);
    expect(loyaltyRewardDiscount(freeSetA, subtotal, lines)).toBe(8);
  });

  it('leaves the options paid for', () => {
    const lines = [
      line({
        id: 'l1',
        modifiers: [
          { group_id: 'g', group_name: 'Egg', option_id: 'egg', option_name: 'Fried egg', price_delta: 2 },
        ],
      }),
    ];
    const subtotal = sumMoney(lines.map(cartLineTotal));
    expect(subtotal).toBe(10);
    expect(loyaltyRewardDiscount(freeSetA, subtotal, lines)).toBe(8);
  });

  it('reads the first dish line of the item, never a combo line in the same slot', () => {
    const lines = [
      line({ id: 'c1', comboId: SET_A, unitPrice: 20 }),
      line({ id: 'l1', unitPrice: 12.5 }),
    ];
    const subtotal = sumMoney(lines.map(cartLineTotal));
    expect(loyaltyRewardDiscount(freeSetA, subtotal, lines)).toBe(12.5);
    expect(loyaltyRewardDiscount(freeSetA, subtotal, lines)).toBe(serverFreeItemOff(lines, subtotal));
  });

  it('is capped at the subtotal', () => {
    const lines = [line({ id: 'l1', unitPrice: 15.99 })];
    expect(loyaltyRewardDiscount(freeSetA, 5, lines)).toBe(5);
  });

  it('previews the list price while the dish is not in the cart', () => {
    const lines = [line({ id: 'l1', menuItemId: 'tom-yum', unitPrice: 15.99 })];
    expect(loyaltyRewardDiscount(freeSetA, 15.99, lines)).toBe(15.99);
    expect(loyaltyRewardDiscount(freeSetA, 40)).toBe(15.99);
  });

  it('leaves the other kinds as they were', () => {
    const base = { max_discount: null, menu_item_id: null, menu_item_price: null };
    expect(loyaltyRewardDiscount({ ...base, kind: 'percent_off', value: 10 }, 55.97)).toBe(5.6);
    expect(
      loyaltyRewardDiscount({ ...base, kind: 'percent_off', value: 50, max_discount: 20 }, 55.97),
    ).toBe(20);
    expect(loyaltyRewardDiscount({ ...base, kind: 'fixed_off', value: 5 }, 3.2)).toBe(3.2);
    expect(loyaltyRewardDiscount({ ...base, kind: 'free_delivery', value: 0 }, 30)).toBe(0);
  });
});

describe('orderLinesFromCart', () => {
  it('sends two lines a note edit made identical as the one line subtotal() priced', () => {
    // SET A with a note, SET A again, then the first line's note cleared: two cart lines, one
    // selection. subtotal() prices it as 2 x 7.995 = $15.99, and that is the line sent.
    const lines = [line({ id: 'l1', notes: '' }), line({ id: 'l2' })];
    const sent = orderLinesFromCart(lines);
    expect(sent.items).toEqual([
      { menu_item_id: SET_A, quantity: 2, notes: undefined, modifier_option_ids: [] },
    ]);
    expect(sent.combos).toEqual([]);
    // The line place-order will charge, and the cart's own subtotal() of the same lines.
    expect(lineTotal(7.995, 0, sent.items[0]!.quantity)).toBe(15.99);
    expect(sumMoney(mergeIdenticalLines(lines, cartLineKey).map(cartLineTotal))).toBe(15.99);
  });

  it('keeps different options and notes apart, and options in any order as one', () => {
    const egg = { group_id: 'g', group_name: 'Egg', option_id: 'egg', option_name: 'Egg', price_delta: 2 };
    const rice = { group_id: 'r', group_name: 'Rice', option_id: 'rice', option_name: 'Rice', price_delta: 1 };
    const sent = orderLinesFromCart([
      line({ id: 'l1', modifiers: [egg, rice] }),
      line({ id: 'l2', modifiers: [rice, egg], quantity: 2 }),
      line({ id: 'l3', notes: ' no chili ' }),
      line({ id: 'l4' }),
    ]);
    expect(sent.items).toEqual([
      { menu_item_id: SET_A, quantity: 3, notes: undefined, modifier_option_ids: ['egg', 'rice'] },
      { menu_item_id: SET_A, quantity: 1, notes: 'no chili', modifier_option_ids: [] },
      { menu_item_id: SET_A, quantity: 1, notes: undefined, modifier_option_ids: [] },
    ]);
  });

  it('sends combo lines as combos, never merged with a dish that shares the id', () => {
    const sent = orderLinesFromCart([
      line({ id: 'c1', comboId: SET_A, unitPrice: 20 }),
      line({ id: 'l1' }),
      line({ id: 'c2', comboId: SET_A, unitPrice: 20, notes: '  ' }),
    ]);
    expect(sent.items).toEqual([
      { menu_item_id: SET_A, quantity: 1, notes: undefined, modifier_option_ids: [] },
    ]);
    expect(sent.combos).toEqual([{ combo_id: SET_A, quantity: 2, notes: undefined }]);
  });
});
