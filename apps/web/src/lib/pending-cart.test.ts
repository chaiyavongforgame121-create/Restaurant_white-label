import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stashPendingAdd, takePendingAdd } from './pending-cart';

const B1 = 'branch-1';

const setA = {
  id: 'set-a',
  branchId: B1,
  categoryId: 'special-set',
  name: 'SET A : Green Curry Chicken',
  price: 7.995,
  imageUrl: null,
} as never;

const noEgg = {
  group_id: 'egg',
  group_name: 'Egg',
  option_id: 'no-egg',
  option_name: 'No Egg',
  price_delta: 0,
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
});

describe('a line parked at sign-in', () => {
  it('replays onto the line of the same selection instead of starting another', async () => {
    const { getCartStore } = await import('@/store/cart');
    const store = getCartStore(B1);
    store.getState().add(setA, 7, undefined, [noEgg]);

    // Signed out, the diner configured one more from the Happy Hour strip, with a stray space in
    // the note box, and was sent to sign in.
    stashPendingAdd({ kind: 'item', branchId: B1, item: setA, quantity: 1, notes: ' ', modifiers: [noEgg] });

    // What PendingCartReplay does once a session exists.
    const pending = takePendingAdd(B1);
    expect(pending?.kind).toBe('item');
    if (pending?.kind !== 'item') return;
    store.getState().add(pending.item, pending.quantity, pending.notes, pending.modifiers);

    expect(store.getState().lines.map((l) => [l.menuItemId, l.quantity])).toEqual([['set-a', 8]]);
    // Taken once: a second replay finds nothing.
    expect(takePendingAdd(B1)).toBeNull();
  });

  it('replays a parked combo onto the same combo already in the cart', async () => {
    const { getCartStore } = await import('@/store/cart');
    const store = getCartStore(B1);
    const combo = {
      comboId: 'lunch',
      name: 'Lunch set',
      imageUrl: null,
      totalPrice: 9.99,
      branchId: B1,
      contents: [{ item_name: 'Green Curry', quantity: 1 }],
    };
    store.getState().addCombo(combo, 1);
    stashPendingAdd({ kind: 'combo', branchId: B1, combo, quantity: 2 });

    const pending = takePendingAdd(B1);
    if (pending?.kind !== 'combo') throw new Error('expected a parked combo');
    store.getState().addCombo(pending.combo, pending.quantity);

    expect(store.getState().lines.map((l) => [l.comboId, l.quantity])).toEqual([['lunch', 3]]);
  });
});
