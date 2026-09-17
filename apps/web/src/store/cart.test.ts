import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CartModule from './cart';

type Cart = typeof CartModule;

const B1 = 'branch-1';
const B2 = 'branch-2';

const item = (branchId: string, id = 'item-1', price = 75) =>
  ({
    id,
    branchId,
    categoryId: 'cat-1',
    name: 'Pad Krapow',
    price,
    imageUrl: '/icon.svg',
    description: '',
    isRecommended: false,
    isNew: false,
    dietaryTags: [],
    rating: 0,
    reviewCount: 0,
    prepTimeMinutes: 0,
    calories: 0,
    isActive: true,
  }) as never;

const combo = (branchId: string, comboId = 'combo-1') => ({
  comboId,
  name: 'Lunch set',
  imageUrl: null,
  totalPrice: 120,
  branchId,
  contents: [{ item_name: 'Pad Krapow', quantity: 1 }],
});

/** A line as the legacy origin-wide cart stored it: no branch of its own. */
const legacyLine = (id = 'line-1') => ({
  id,
  menuItemId: 'item-1',
  name: 'Pad Krapow',
  unitPrice: 75,
  quantity: 2,
  imageUrl: null,
});

const writeLegacyCart = (state: Record<string, unknown>, version = 2) =>
  localStorage.setItem('favornoms-cart-v1', JSON.stringify({ state, version }));

const readKey = (key: string) => {
  const raw = localStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as { state: Record<string, unknown>; version: number });
};

// Every test gets a fresh module: the per-branch store map and the once-per-load legacy check
// are module state, exactly as they are once per page in the browser.
let cart: Cart;
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.resetModules();
  cart = await import('./cart');
});

describe('cart store (one branch)', () => {
  it('starts empty with zero subtotal, zero items and its own branch', () => {
    const s = cart.getCartStore(B1).getState();
    expect(s.branchId).toBe(B1);
    expect(s.lines).toEqual([]);
    expect(s.subtotal()).toBe(0);
    expect(s.itemCount()).toBe(0);
  });

  it('adds an item and stamps the line with the branch', () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1));
    const s = store.getState();
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]?.quantity).toBe(1);
    expect(s.lines[0]?.branchId).toBe(B1);
    expect(s.subtotal()).toBe(75);
    expect(s.itemCount()).toBe(1);
  });

  it('merges quantities for the same item with the same notes', () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1));
    store.getState().add(item(B1), 2);
    expect(store.getState().lines).toHaveLength(1);
    expect(store.getState().lines[0]?.quantity).toBe(3);
    expect(store.getState().subtotal()).toBe(225);
  });

  it('keeps lines separate when notes differ', () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1), 1, 'no spice');
    store.getState().add(item(B1), 1, 'extra spicy');
    expect(store.getState().lines).toHaveLength(2);
    expect(store.getState().subtotal()).toBe(150);
  });

  it('treats empty/whitespace notes as no-notes (merges)', () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1));
    store.getState().add(item(B1), 2, '   ');
    expect(store.getState().lines).toHaveLength(1);
    expect(store.getState().lines[0]?.quantity).toBe(3);
  });

  it('adds a combo as its own line, stamped with the branch', () => {
    const store = cart.getCartStore(B1);
    store.getState().addCombo(combo(B1), 2);
    const line = store.getState().lines[0];
    expect(line?.comboId).toBe('combo-1');
    expect(line?.branchId).toBe(B1);
    expect(store.getState().subtotal()).toBe(240);
  });

  it('setQuantity removes the line at 0 and updates positive values', () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1));
    const lineId = store.getState().lines[0]!.id;
    store.getState().setQuantity(lineId, 5);
    expect(store.getState().lines[0]?.quantity).toBe(5);
    expect(store.getState().subtotal()).toBe(375);
    store.getState().setQuantity(lineId, 0);
    expect(store.getState().lines).toHaveLength(0);
  });

  it('remove drops the line', () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1));
    store.getState().remove(store.getState().lines[0]!.id);
    expect(store.getState().lines).toHaveLength(0);
  });

  it('setLineNotes trims, and treats an empty note as none', () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1), 1, 'note');
    const lineId = store.getState().lines[0]!.id;
    store.getState().setLineNotes(lineId, '  extra rice  ');
    expect(store.getState().lines[0]?.notes).toBe('extra rice');
    store.getState().setLineNotes(lineId, '   ');
    expect(store.getState().lines[0]?.notes).toBeUndefined();
  });

  it('clear drops all lines and notes', () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1));
    store.getState().setNotes('please knock');
    store.getState().clear();
    expect(store.getState().lines).toHaveLength(0);
    expect(store.getState().notes).toBe('');
  });

  it('refuses an item from another branch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = cart.getCartStore(B1);
    store.getState().add(item(B2));
    expect(store.getState().lines).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a combo from another branch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = cart.getCartStore(B1);
    store.getState().addCombo(combo(B2));
    expect(store.getState().lines).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

const mod = (option_id: string) => ({
  group_id: 'group-1',
  group_name: 'Spice',
  option_id,
  option_name: option_id,
  price_delta: 0,
});

describe('reprice', () => {
  it('removes every line carrying an option that is no longer offered, and counts it', () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1, 'item-1'), 1, undefined, [mod('opt-gone')]);
    store.getState().add(item(B1, 'item-1'), 1, undefined, [mod('opt-ok')]);
    store.getState().add(item(B1, 'item-2'), 1, undefined, [mod('opt-ok'), mod('opt-gone')]);
    store.getState().add(item(B1, 'item-3'));
    store.getState().addCombo(combo(B1));
    expect(store.getState().lines).toHaveLength(5);

    const result = store.getState().reprice(new Map(), new Set(['opt-gone']));
    expect(result).toEqual({ changed: 0, removed: 2 });
    const left = store.getState().lines.map((l) => [l.menuItemId, (l.modifiers ?? []).map((m) => m.option_id)]);
    expect(left).toEqual([
      ['item-1', ['opt-ok']],
      ['item-3', []],
      ['combo-1', []],
    ]);
  });

  it('counts a line once when both its item and an option are gone, and still re-prices the rest', () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1, 'item-1'), 1, undefined, [mod('opt-gone')]);
    store.getState().add(item(B1, 'item-2', 75));
    const result = store.getState().reprice(
      new Map([
        ['item-1', { price: 0, available: false }],
        ['item-2', { price: 80, available: true }],
      ]),
      new Set(['opt-gone']),
    );
    expect(result).toEqual({ changed: 1, removed: 1 });
    expect(store.getState().lines.map((l) => [l.menuItemId, l.unitPrice])).toEqual([['item-2', 80]]);
  });

  it('leaves the cart alone with no unavailable options and nothing to re-price', () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1, 'item-1'), 1, undefined, [mod('opt-ok')]);
    const before = store.getState().lines;
    expect(store.getState().reprice(new Map(), new Set())).toEqual({ changed: 0, removed: 0 });
    expect(store.getState().reprice(new Map())).toEqual({ changed: 0, removed: 0 });
    expect(store.getState().lines).toBe(before);
  });
});

describe('linesUsing', () => {
  const lines = () => {
    const store = cart.getCartStore(B1);
    store.getState().add(item(B1, 'item-1'), 1, undefined, [mod('opt-a')]);
    store.getState().add(item(B1, 'item-1'), 1, 'no ice');
    store.getState().add(item(B1, 'item-2'), 1, undefined, [mod('opt-b'), mod('opt-a')]);
    store.getState().addCombo(combo(B1, 'item-1'));
    return store.getState().lines;
  };

  it("finds an item's own lines but never a combo line that shares the id slot", () => {
    const found = cart.linesUsing(lines(), { kind: 'item', id: 'item-1' });
    expect(found).toHaveLength(2);
    expect(found.every((l) => !l.comboId && l.menuItemId === 'item-1')).toBe(true);
  });

  it("finds a combo's lines", () => {
    const found = cart.linesUsing(lines(), { kind: 'combo', id: 'item-1' });
    expect(found.map((l) => l.comboId)).toEqual(['item-1']);
  });

  it('finds every line with an option chosen, across items', () => {
    const found = cart.linesUsing(lines(), { kind: 'option', id: 'opt-a' });
    expect(found.map((l) => l.menuItemId)).toEqual(['item-1', 'item-2']);
    expect(cart.linesUsing(lines(), { kind: 'option', id: 'opt-missing' })).toEqual([]);
  });
});

describe('order channel', () => {
  it('starts with no channel until one is chosen', () => {
    expect(cart.getCartStore(B1).getState().channel).toBeNull();
  });

  it('setChannel records the channel', () => {
    const store = cart.getCartStore(B1);
    store.getState().setChannel('pickup');
    expect(store.getState().channel).toBe('pickup');
    store.getState().setChannel('dine_in');
    expect(store.getState().channel).toBe('dine_in');
  });

  it('resolveChannel keeps delivery while the branch can deliver', () => {
    const store = cart.getCartStore(B1);
    store.getState().setChannel('delivery');
    store.getState().resolveChannel(true, false);
    expect(store.getState().channel).toBe('delivery');
  });

  it('resolveChannel clears delivery when the branch cannot deliver', () => {
    const store = cart.getCartStore(B1);
    store.getState().setChannel('delivery');
    store.getState().resolveChannel(false, false);
    expect(store.getState().channel).toBeNull();
  });

  it('resolveChannel leaves pickup alone when the branch cannot deliver', () => {
    const store = cart.getCartStore(B1);
    store.getState().setChannel('pickup');
    store.getState().resolveChannel(false, false);
    expect(store.getState().channel).toBe('pickup');
  });

  // Dine-in stopped being a choice a diner can make; only a scanned table grants it.
  it('resolveChannel clears dine-in when no table is pinned', () => {
    const store = cart.getCartStore(B1);
    store.getState().setChannel('dine_in');
    store.getState().resolveChannel(true, false);
    expect(store.getState().channel).toBeNull();
  });

  it('resolveChannel leaves dine-in alone while a table is pinned', () => {
    const store = cart.getCartStore(B1);
    store.getState().setChannel('dine_in');
    store.getState().resolveChannel(true, true);
    expect(store.getState().channel).toBe('dine_in');
  });
});

describe('one cart per branch', () => {
  it('shares one store per branch and never across branches', () => {
    expect(cart.getCartStore(B1)).toBe(cart.getCartStore(B1));
    expect(cart.getCartStore(B1)).not.toBe(cart.getCartStore(B2));
  });

  it('two branches do not share lines, notes or channel', () => {
    const one = cart.getCartStore(B1);
    const two = cart.getCartStore(B2);
    one.getState().add(item(B1));
    one.getState().setNotes('ring twice');
    one.getState().setChannel('delivery');
    two.getState().add(item(B2, 'item-9', 40), 3);

    expect(one.getState().lines.map((l) => l.menuItemId)).toEqual(['item-1']);
    expect(two.getState().lines.map((l) => l.menuItemId)).toEqual(['item-9']);
    expect(two.getState().notes).toBe('');
    expect(two.getState().channel).toBeNull();

    two.getState().clear();
    expect(one.getState().lines).toHaveLength(1);
  });

  it('persists each branch under its own key', () => {
    const one = cart.getCartStore(B1);
    const two = cart.getCartStore(B2);
    expect(one.persist.getOptions().name).toBe('favornoms-cart-v2:branch-1');
    expect(two.persist.getOptions().name).toBe('favornoms-cart-v2:branch-2');

    one.getState().add(item(B1));
    expect(readKey('favornoms-cart-v2:branch-1')?.state.lines).toHaveLength(1);
    expect(readKey('favornoms-cart-v2:branch-2')).toBeNull();
    // Only the diner's data is written; the branch is the key's, not the value's.
    expect(Object.keys(readKey('favornoms-cart-v2:branch-1')!.state).sort()).toEqual([
      'channel',
      'lines',
      'notes',
    ]);
  });

  it('rehydrates from its own key only, and drops a stored line from another branch', async () => {
    const own = { ...legacyLine('own'), branchId: B1 };
    const foreign = { ...legacyLine('foreign'), branchId: B2 };
    localStorage.setItem(
      'favornoms-cart-v2:branch-1',
      JSON.stringify({ state: { lines: [own, foreign], notes: 'n', channel: 'pickup' }, version: 0 }),
    );
    const one = cart.getCartStore(B1);
    const two = cart.getCartStore(B2);
    await one.persist.rehydrate();
    await two.persist.rehydrate();
    expect(one.getState().lines.map((l) => l.id)).toEqual(['own']);
    expect(one.getState().branchId).toBe(B1);
    expect(one.getState().channel).toBe('pickup');
    expect(two.getState().lines).toEqual([]);
    expect(two.getState().channel).toBeNull();
  });

  it('reads a corrupt stored cart as empty instead of never hydrating', async () => {
    localStorage.setItem('favornoms-cart-v2:branch-1', '{not json');
    const one = cart.getCartStore(B1);
    await one.persist.rehydrate();
    expect(one.persist.hasHydrated()).toBe(true);
    expect(one.getState().lines).toEqual([]);
  });
});

describe('legacy origin-wide cart', () => {
  it('moves into its branch key before the first rehydrate, whichever branch opens first, then is deleted', async () => {
    writeLegacyCart({
      branchId: B1,
      lines: [legacyLine()],
      notes: 'knock',
      channel: 'pickup',
      channelBranchId: B1,
    });

    // The OTHER branch is opened first: it must stay empty, and the move must still happen.
    const two = cart.getCartStore(B2);
    await two.persist.rehydrate();
    expect(two.getState().lines).toEqual([]);
    expect(localStorage.getItem('favornoms-cart-v1')).toBeNull();
    expect(readKey('favornoms-cart-v2:branch-2')).toBeNull();

    const one = cart.getCartStore(B1);
    await one.persist.rehydrate();
    const s = one.getState();
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatchObject({ id: 'line-1', branchId: B1, quantity: 2 });
    expect(s.notes).toBe('knock');
    expect(s.channel).toBe('pickup');
  });

  it('does not carry a channel that was chosen at another branch', () => {
    writeLegacyCart({ branchId: B1, lines: [legacyLine()], notes: '', channel: 'delivery', channelBranchId: B2 });
    cart.migrateLegacyCart(localStorage);
    const moved = readKey('favornoms-cart-v2:branch-1');
    expect(moved?.state.lines).toHaveLength(1);
    expect(moved?.state.channel).toBeNull();
    expect(localStorage.getItem('favornoms-cart-v1')).toBeNull();
  });

  it('does not carry a channel from before persist version 2', () => {
    writeLegacyCart({ branchId: B1, lines: [legacyLine()], channel: 'pickup', channelBranchId: B1 }, 1);
    cart.migrateLegacyCart(localStorage);
    expect(readKey('favornoms-cart-v2:branch-1')?.state.channel).toBeNull();
  });

  it('never overwrites a cart the branch already has', () => {
    const newer = { ...legacyLine('newer'), branchId: B1 };
    localStorage.setItem(
      'favornoms-cart-v2:branch-1',
      JSON.stringify({ state: { lines: [newer], notes: '', channel: null }, version: 0 }),
    );
    writeLegacyCart({ branchId: B1, lines: [legacyLine('older')], channel: null, channelBranchId: null });
    cart.migrateLegacyCart(localStorage);
    const lines = readKey('favornoms-cart-v2:branch-1')?.state.lines as Array<{ id: string }>;
    expect(lines.map((l) => l.id)).toEqual(['newer']);
    expect(localStorage.getItem('favornoms-cart-v1')).toBeNull();
  });

  it('deletes an empty or unreadable legacy cart without writing anything', () => {
    writeLegacyCart({ branchId: B1, lines: [], notes: '', channel: null, channelBranchId: null });
    cart.migrateLegacyCart(localStorage);
    expect(localStorage.getItem('favornoms-cart-v1')).toBeNull();
    expect(readKey('favornoms-cart-v2:branch-1')).toBeNull();

    localStorage.setItem('favornoms-cart-v1', '{not json');
    cart.migrateLegacyCart(localStorage);
    expect(localStorage.getItem('favornoms-cart-v1')).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});

describe('CartProvider', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  it('throws a clear error for a cart reader outside the provider', async () => {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    function Orphan() {
      cart.useCart((s) => s.lines.length);
      return null;
    }
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = createRoot(document.createElement('div'), {
      onUncaughtError: (error) => errors.push(error),
    });
    try {
      await act(async () => root.render(createElement(Orphan)));
    } catch (error) {
      errors.push(error);
    }
    expect(String((errors[0] as Error | undefined)?.message)).toMatch(/CartProvider/);
    root.unmount();
  });

  it('hydrates its branch and follows other windows of the same branch only', async () => {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    localStorage.setItem(
      'favornoms-cart-v2:branch-1',
      JSON.stringify({ state: { lines: [{ ...legacyLine(), branchId: B1 }], notes: '', channel: null }, version: 0 }),
    );
    function Probe() {
      const hydrated = cart.useCartHydrated();
      const count = cart.useCart((s) => s.lines.length);
      return createElement('output', null, `${hydrated}:${count}`);
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(createElement(cart.CartProvider, { branchId: B1, children: createElement(Probe) })),
    );
    expect(container.textContent).toBe('true:1');

    // Another window of branch 2 writes its own key: nothing here moves.
    localStorage.setItem(
      'favornoms-cart-v2:branch-2',
      JSON.stringify({ state: { lines: [], notes: '', channel: null }, version: 0 }),
    );
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'favornoms-cart-v2:branch-2' }));
    });
    expect(container.textContent).toBe('true:1');

    // Another window of branch 1 empties the cart: this window follows.
    localStorage.setItem(
      'favornoms-cart-v2:branch-1',
      JSON.stringify({ state: { lines: [], notes: '', channel: null }, version: 0 }),
    );
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'favornoms-cart-v2:branch-1' }));
    });
    expect(container.textContent).toBe('true:0');

    await act(async () => root.unmount());
  });

  it("follows another window's lines and notes but keeps this window's order type, and writes nothing back", async () => {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const key = 'favornoms-cart-v2:branch-1';
    localStorage.setItem(
      key,
      JSON.stringify({ state: { lines: [{ ...legacyLine('a'), branchId: B1 }], notes: '', channel: 'dine_in' }, version: 0 }),
    );
    function Probe() {
      const hydrated = cart.useCartHydrated();
      const count = cart.useCart((s) => s.lines.length);
      const notes = cart.useCart((s) => s.notes);
      const channel = cart.useCart((s) => s.channel);
      return createElement('output', null, `${hydrated}:${count}:${notes}:${channel}`);
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(createElement(cart.CartProvider, { branchId: B1, children: createElement(Probe) })),
    );
    // The first hydration takes the stored order type: this window is the one at the table.
    expect(container.textContent).toBe('true:1::dine_in');

    // Another window of the same branch adds a line, writes a note and picks Pickup.
    const otherWindow = JSON.stringify({
      state: {
        lines: [
          { ...legacyLine('a'), branchId: B1 },
          { ...legacyLine('b'), menuItemId: 'item-2', branchId: B1 },
        ],
        notes: 'ring twice',
        channel: 'pickup',
      },
      version: 0,
    });
    localStorage.setItem(key, otherWindow);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: otherWindow }));
    });
    // Lines and notes follow; the seated window is still dine-in.
    expect(container.textContent).toBe('true:2:ring twice:dine_in');
    expect(cart.getCartStore(B1).getState().channel).toBe('dine_in');
    // Nothing was written back, so the other window gets no storage event to answer.
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(otherWindow);

    // The other window clears its order type; this one still keeps its own.
    const cleared = JSON.stringify({ state: { lines: [], notes: '', channel: null }, version: 0 });
    localStorage.setItem(key, cleared);
    setItem.mockClear();
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: cleared }));
    });
    expect(container.textContent).toBe('true:0::dine_in');
    expect(setItem).not.toHaveBeenCalled();

    // This window's next own change saves its own order type with the synced lines.
    await act(async () => {
      cart.getCartStore(B1).getState().setNotes('table 4');
    });
    // (The spy does see this window's own writes, so the two checks above are not vacuous.)
    expect(setItem).toHaveBeenCalled();
    expect(readKey(key)?.state).toMatchObject({ lines: [], notes: 'table 4', channel: 'dine_in' });

    await act(async () => root.unmount());
  });

  it('does not take an order type from another window when this one has none yet', async () => {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const key = 'favornoms-cart-v2:branch-1';
    function Probe() {
      const hydrated = cart.useCartHydrated();
      const channel = cart.useCart((s) => s.channel);
      const count = cart.useCart((s) => s.lines.length);
      return createElement('output', null, `${hydrated}:${count}:${channel}`);
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(createElement(cart.CartProvider, { branchId: B1, children: createElement(Probe) })),
    );
    expect(container.textContent).toBe('true:0:null');

    const otherWindow = JSON.stringify({
      state: { lines: [{ ...legacyLine(), branchId: B1 }], notes: '', channel: 'delivery' },
      version: 0,
    });
    localStorage.setItem(key, otherWindow);
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: otherWindow }));
    });
    // The diner in this window is still asked; the other window's choice is not theirs.
    expect(container.textContent).toBe('true:1:null');

    await act(async () => root.unmount());
  });
});

describe('rehydrating an already-hydrated store', () => {
  it('reads the order type from storage once and keeps the local one afterwards', async () => {
    const key = 'favornoms-cart-v2:branch-1';
    const write = (state: Record<string, unknown>) =>
      localStorage.setItem(key, JSON.stringify({ state, version: 0 }));
    write({ lines: [], notes: '', channel: 'pickup' });
    const store = cart.getCartStore(B1);
    await store.persist.rehydrate();
    expect(store.getState().channel).toBe('pickup');

    store.getState().setChannel('dine_in');
    write({ lines: [{ ...legacyLine(), branchId: B1 }], notes: 'n', channel: 'delivery' });
    await store.persist.rehydrate();
    expect(store.getState().lines).toHaveLength(1);
    expect(store.getState().notes).toBe('n');
    expect(store.getState().channel).toBe('dine_in');
  });
});
