'use client';

import * as React from 'react';
import { createStore, useStore } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import {
  comboLineSignature,
  lineSignature,
  lineTotal,
  MAX_LINE_QUANTITY,
  mergeIdenticalLines,
  normalizeLineNotes,
  sumMoney,
  unitPrice4,
  type MenuItem,
} from '@favornoms/shared';

export interface CartLineModifier {
  group_id: string;
  group_name: string;
  option_id: string;
  option_name: string;
  price_delta: number;
}

export interface CartLine {
  id: string;
  /**
   * The branch this line was added at — always the branch of the cart holding it. Carried on
   * the line itself so anything that reads lines (checkout above all) can prove where they
   * came from instead of trusting whichever storefront it happens to be rendered on.
   */
  branchId: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  imageUrl: string | null;
  notes?: string;
  modifiers?: CartLineModifier[];
  comboId?: string;
  comboContents?: Array<{ item_name: string; quantity: number }>;
}

export interface ComboPick {
  comboId: string;
  name: string;
  imageUrl: string | null;
  totalPrice: number;
  branchId: string;
  contents: Array<{ item_name: string; quantity: number }>;
}

export type OrderChannel = 'delivery' | 'pickup' | 'dine_in';

/** What the restaurant sells this line for RIGHT NOW, and whether it still sells it at all. */
export interface CurrentPrice {
  price: number;
  available: boolean;
}

/**
 * One thing a cart line can be built from that the restaurant may stop offering: a menu item, a
 * combo, or a modifier option. place-order names the one it refused by id.
 */
export interface CartPart {
  kind: 'item' | 'combo' | 'option';
  id: string;
}

/**
 * The lines that use `part`, and so cannot be ordered while it is gone: an item's own lines (never
 * a combo line, which carries its combo id in the same `menuItemId` slot), a combo's lines, or
 * every item line with that option chosen. Combo lines send no options to place-order, so an
 * option can only sink an item line.
 */
export function linesUsing(lines: readonly CartLine[], part: CartPart): CartLine[] {
  switch (part.kind) {
    case 'item':
      return lines.filter((l) => !l.comboId && l.menuItemId === part.id);
    case 'combo':
      return lines.filter((l) => l.comboId === part.id);
    case 'option':
      return lines.filter((l) => !l.comboId && (l.modifiers ?? []).some((m) => m.option_id === part.id));
  }
}

/** What one cart line costs: place-order's own lineTotal (money.ts), options included. */
export function cartLineTotal(line: Pick<CartLine, 'unitPrice' | 'quantity' | 'modifiers'>): number {
  return lineTotal(
    line.unitPrice,
    (line.modifiers ?? []).map((m) => Number(m.price_delta ?? 0)),
    line.quantity,
  );
}

/**
 * Which selection a line is: the dish, the SET of options chosen on it and its trimmed note, or
 * the combo and its note. Two lines with the same key are the same food at the same price, and
 * place-order bills them as one line (consolidateOrderLines in @favornoms/shared), so the cart
 * keeps them as one line too.
 */
export function cartLineKey(line: Pick<CartLine, 'menuItemId' | 'comboId' | 'modifiers' | 'notes'>): string {
  if (line.comboId) return comboLineSignature(line.comboId, line.notes);
  // Read from storage on every load, where only the line's outline is checked (isLineShaped): a
  // malformed options value must not throw here and leave the cart un-hydrated for good.
  const options = Array.isArray(line.modifiers) ? line.modifiers.filter((m) => !!m) : [];
  return lineSignature(line.menuItemId, options, line.notes);
}

/**
 * The lines with each selection (cartLineKey) on one line, the first of them keeping its place,
 * and none above MAX_LINE_QUANTITY. The array itself when nothing changed.
 *
 * Capped because place-order folds identical lines the same way and then refuses a line above the
 * limit, for the whole order: 60 + 50 of one combo, which an older build kept on two lines, would
 * otherwise sit in the cart as a line of 110 that cannot be ordered and that no stepper explains.
 */
export function foldCartLines(lines: readonly CartLine[]): CartLine[] {
  const merged = mergeIdenticalLines(lines, cartLineKey);
  if (!merged.some((l) => l.quantity > MAX_LINE_QUANTITY)) return merged;
  return merged.map((l) => (l.quantity > MAX_LINE_QUANTITY ? { ...l, quantity: MAX_LINE_QUANTITY } : l));
}

/**
 * How many of one selection (a cartLineKey) the cart holds: what an add of it is added to. An item
 * sheet caps its stepper at MAX_LINE_QUANTITY less this, so the diner sees the limit before
 * tapping Add instead of an add that quietly stops at it.
 */
export function cartQuantityOf(lines: readonly CartLine[], key: string): number {
  return lines.reduce((n, l) => (cartLineKey(l) === key ? n + l.quantity : n), 0);
}

/**
 * How many of a dish the cart holds, over every line of it: each set of options is a line of its
 * own, so "7 x SET A No Egg" and "1 x SET A Fried egg" are 8 in the cart, not the first line's 7.
 * Never a combo line, which carries its combo id in the same `menuItemId` slot.
 */
export function dishQuantityInCart(lines: readonly CartLine[], menuItemId: string): number {
  return linesUsing(lines, { kind: 'item', id: menuItemId }).reduce((n, l) => n + l.quantity, 0);
}

/** The chosen options without a repeated one: place-order counts each option once. */
function distinctModifiers(modifiers: readonly CartLineModifier[] | undefined): CartLineModifier[] | undefined {
  if (!modifiers || modifiers.length === 0) return undefined;
  const seen = new Set<string>();
  return modifiers.filter((m) => {
    if (seen.has(m.option_id)) return false;
    seen.add(m.option_id);
    return true;
  });
}

/**
 * One branch's cart.
 *
 * There used to be ONE cart for the whole origin, and every storefront on the host read it:
 * two branches of the same restaurant on one domain showed each other's carts, and a line
 * added at one could be carried to the other's checkout. Every branch now has a store of its
 * own under its own storage key (see getCartStore), so nothing here needs to ask "which
 * branch is this for?" — the answer is `branchId`, and it cannot change.
 */
export interface CartState {
  /** The branch this cart belongs to. Fixed when the store is created and never persisted. */
  readonly branchId: string;
  lines: CartLine[];
  notes: string;
  /**
   * `null` until the diner picks an order type in the gate, or a scanned table
   * pin sets dine-in on their behalf. There is no default: delivery, pickup and
   * dine-in change the price, the required fields and where the food ends up, so
   * the storefront asks instead of guessing.
   */
  channel: OrderChannel | null;
  setChannel: (channel: OrderChannel) => void;
  /**
   * Drop a persisted choice that no longer applies — a branch that has since lost the
   * delivery add-on, or dine-in on a device that is not sitting at a table. Clearing re-opens
   * the gate rather than silently substituting a channel the diner did not pick.
   *
   * `hasTablePin` must be the SETTLED answer: call this only once the table-pin
   * provider is ready, never while it is still validating a stored sitting, or
   * this will clear the channel out from under a seated diner.
   */
  resolveChannel: (canDeliver: boolean, hasTablePin: boolean) => void;
  setNotes: (notes: string) => void;
  /**
   * Adds to the line of the same selection (cartLineKey) when the cart has one, else starts a
   * line, never taking a line past MAX_LINE_QUANTITY. Returns how many were added: fewer than
   * asked when the line was near the limit, 0 when it was full. Refused (0, and a console
   * warning) for an item from any other branch.
   */
  add: (item: MenuItem, quantity?: number, notes?: string, modifiers?: CartLineModifier[]) => number;
  /**
   * Adds to the line of the same combo with no note when the cart has one, else starts a line,
   * never taking a line past MAX_LINE_QUANTITY. Returns how many were added, as `add` does.
   * Refused (0, and a console warning) for a combo from any other branch.
   */
  addCombo: (combo: ComboPick, quantity?: number) => number;
  setLineNotes: (lineId: string, notes: string) => void;
  /**
   * Folds lines of one selection into the first of them (foldCartLines). A note edit can make
   * two lines the same selection, and setLineNotes leaves them apart while the diner types; the
   * cart calls this when the note box loses focus, so the lines it shows are the lines place-order
   * bills, each rounded once, and never two lines it would refuse as one above the limit.
   */
  foldIdenticalLines: () => void;
  remove: (lineId: string) => void;
  setQuantity: (lineId: string, quantity: number) => void;
  clear: () => void;
  /**
   * Re-price the cart against what the restaurant sells now. Keyed by `comboId` for combo
   * lines and `menuItemId` for everything else.
   *
   * A line records the price it was added at and kept it forever, so a cart opened after a
   * price change — or after the kitchen 86'd something — showed a total the diner would not be
   * charged: place-order re-reads menu_items and prices from the server rows, so it silently
   * charged a different number, or refused the whole order for an item the diner had no idea
   * was gone. Better to say so on the cart screen than in the confirmation.
   *
   * Keys that are absent from `current` are left exactly as they are: a failed or partial read
   * must never empty somebody's cart. Returns what changed so the caller can say it out loud.
   *
   * `unavailableOptionIds` are modifier options the restaurant no longer offers here (switched
   * off, deleted, or not this branch's). Every line carrying one is removed and counted in
   * `removed`: place-order refuses the whole order for it, and quietly dropping just the option
   * would sell the diner a different dish at a different price.
   *
   * `optionPrices` is what each option adds now (modifier_options.price_delta), by option id. A
   * line stores the delta it was added with, and place-order charges the current one, so a raised
   * fried egg left the cart quoting less than the charge. A line whose unit or any option moved
   * counts once in `changed`; options absent from the map are left as they are.
   */
  reprice: (
    current: Map<string, CurrentPrice>,
    unavailableOptionIds?: ReadonlySet<string>,
    optionPrices?: ReadonlyMap<string, number>,
  ) => { changed: number; removed: number };
  subtotal: () => number;
  itemCount: () => number;
}

/** What is written to storage: the diner's data, never the actions or the branch id. */
type PersistedCart = Pick<CartState, 'lines' | 'notes' | 'channel'>;

/**
 * The origin-wide cart every storefront used to share. Moved into its branch's own key the
 * first time any cart touches storage, then deleted (migrateLegacyCart).
 */
export const LEGACY_CART_STORAGE_KEY = 'favornoms-cart-v1';

/** One key per branch, so two branches on the same host can never read each other's cart. */
export const cartStorageKey = (branchId: string) => `favornoms-cart-v2:${branchId}`;

const CART_PERSIST_VERSION = 0;

const CHANNELS: readonly string[] = ['delivery', 'pickup', 'dine_in'] satisfies OrderChannel[];
const isChannel = (value: unknown): value is OrderChannel =>
  typeof value === 'string' && CHANNELS.includes(value);

/** Enough of a line to render and order. Anything less is storage noise and is dropped. */
function isLineShaped(value: unknown): value is Omit<CartLine, 'branchId'> & { branchId?: unknown } {
  if (!value || typeof value !== 'object') return false;
  const l = value as Record<string, unknown>;
  return (
    typeof l.id === 'string' &&
    typeof l.menuItemId === 'string' &&
    typeof l.name === 'string' &&
    typeof l.unitPrice === 'number' &&
    typeof l.quantity === 'number'
  );
}

/**
 * The legacy cart, reshaped for its branch's key. `null` when there is nothing to move: no
 * branch recorded (the cart was never added to), or a value that does not parse.
 */
function legacyCartForBranch(raw: string): { branchId: string; state: PersistedCart } | null {
  let envelope: { state?: unknown; version?: unknown } | null;
  try {
    envelope = JSON.parse(raw) as { state?: unknown; version?: unknown } | null;
  } catch {
    return null;
  }
  const legacy = envelope?.state as Record<string, unknown> | undefined;
  if (!legacy || typeof legacy !== 'object') return null;
  const branchId = typeof legacy.branchId === 'string' && legacy.branchId ? legacy.branchId : null;
  if (!branchId) return null;
  const lines = Array.isArray(legacy.lines)
    ? legacy.lines.filter(isLineShaped).map((l) => ({ ...l, branchId }))
    : [];
  // The legacy key recorded which branch a channel was chosen at, because it served them all.
  // A choice made anywhere else is not this branch's answer. Persist versions before 2 assigned
  // the channel as often as the diner chose it, and that store's own migration threw it away.
  const channel =
    typeof envelope?.version === 'number' &&
    envelope.version >= 2 &&
    legacy.channelBranchId === branchId &&
    isChannel(legacy.channel)
      ? legacy.channel
      : null;
  const notes = typeof legacy.notes === 'string' ? legacy.notes : '';
  return { branchId, state: { lines, notes, channel } };
}

/**
 * Moves the legacy origin-wide cart into the per-branch key of the branch it was built at,
 * then deletes it.
 *
 * Only into an ABSENT key: a branch that already has a cart of its own has something newer
 * than the legacy one, and overwriting it would lose that. Safe to call any number of times —
 * once the legacy key is gone there is nothing to do.
 */
export function migrateLegacyCart(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): void {
  try {
    const raw = storage.getItem(LEGACY_CART_STORAGE_KEY);
    if (raw === null) return;
    const moved = legacyCartForBranch(raw);
    if (moved) {
      const key = cartStorageKey(moved.branchId);
      const { lines, notes, channel } = moved.state;
      if (storage.getItem(key) === null && (lines.length > 0 || notes !== '' || channel !== null)) {
        const value: StorageValue<PersistedCart> = { state: moved.state, version: CART_PERSIST_VERSION };
        storage.setItem(key, JSON.stringify(value));
      }
    }
    storage.removeItem(LEGACY_CART_STORAGE_KEY);
  } catch {
    // Storage blocked or full. The legacy cart stays put and is tried again on the next load;
    // ordering does not depend on it.
  }
}

/** Once per page load, before the first read or write of any branch's cart. */
let legacyCartChecked = false;

/**
 * localStorage, JSON-encoded, with the legacy move in front of it.
 *
 * `undefined` on the server and wherever storage is blocked — persist then keeps the cart in
 * memory and leaves `store.persist` undefined, which is why every reader of it checks.
 *
 * Hand-rolled rather than createJSONStorage so that a corrupt value reads as "no cart" and a
 * full disk does not throw out of `add`: a rejected read would leave persist un-hydrated for
 * good, and every screen that waits for hydration would wait forever.
 */
function cartPersistStorage(): PersistStorage<PersistedCart> | undefined {
  let local: Storage;
  try {
    local = window.localStorage;
  } catch {
    return undefined;
  }
  const migrateOnce = () => {
    if (legacyCartChecked) return;
    legacyCartChecked = true;
    migrateLegacyCart(local);
  };
  return {
    getItem: (name) => {
      migrateOnce();
      try {
        const raw = local.getItem(name);
        return raw === null ? null : (JSON.parse(raw) as StorageValue<PersistedCart>);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      migrateOnce();
      try {
        local.setItem(name, JSON.stringify(value));
      } catch {
        // Full or blocked: the cart still works for this visit.
      }
    },
    removeItem: (name) => {
      try {
        local.removeItem(name);
      } catch {
        // nothing to remove
      }
    },
  };
}

/**
 * Stored values over the defaults, keeping only what belongs here. The branch id is the
 * store's own, never storage's, and a line from any other branch is dropped rather than shown.
 * Lines of one selection are folded into one (foldCartLines): a cart saved by an older build, or
 * one where a note was edited to match another line's, would otherwise show the dish twice.
 *
 * `keepChannel` leaves this window's order type exactly as it is and takes only the lines and
 * notes from storage (see createCartStore's merge).
 */
function mergePersistedCart(
  branchId: string,
  persisted: unknown,
  current: CartState,
  keepChannel: boolean,
): CartState {
  if (!persisted || typeof persisted !== 'object') return current;
  const p = persisted as Partial<Record<keyof PersistedCart, unknown>>;
  return {
    ...current,
    lines: Array.isArray(p.lines)
      ? foldCartLines(p.lines.filter((l): l is CartLine => isLineShaped(l) && l.branchId === branchId))
      : current.lines,
    notes: typeof p.notes === 'string' ? p.notes : current.notes,
    channel: keepChannel ? current.channel : isChannel(p.channel) ? p.channel : null,
  };
}

/** A fresh, un-hydrated store for one branch. Prefer getCartStore, which shares one per branch. */
export function createCartStore(branchId: string) {
  /**
   * Whether this store has already taken its order type from storage. It does that once, on its
   * first hydration; every later one (another window of this branch wrote the key, see
   * CartProvider) brings in only the lines and the notes.
   *
   * The order type belongs to the window. A diner seated at a table in one tab who opens the menu
   * in another and picks Pickup there must not have their table tab flip to Pickup, or lose
   * dine-in and land back at the gate, the moment the other tab saves. Nor may the window write
   * its own channel back to fix storage up: the other window would then do the same, and the two
   * would trade the key back and forth for as long as both stayed open. Storage simply holds
   * whichever window saved last, which is what a newly opened window starts from.
   */
  let channelTakenFromStorage = false;
  return createStore<CartState>()(
    persist(
      (set, get) => ({
        branchId,
        lines: [],
        notes: '',
        channel: null,
        setChannel: (channel) => set({ channel }),
        resolveChannel: (canDeliver, hasTablePin) => {
          const { channel } = get();
          if (channel === null) return;
          // Dine-in is not something a phone can claim any more: it is granted by the
          // table pin the QR scan proves. A dine_in persisted before that — or left
          // behind by a sitting this device has since lost — would sail past the gate
          // and reach a checkout with no table and no session, which place-order
          // refuses. Hand the question back instead.
          if (channel === 'dine_in' && !hasTablePin) {
            set({ channel: null });
            return;
          }
          // Delivery is a paid add-on and can lapse between visits. Re-ask rather
          // than downgrading to pickup behind the diner's back.
          if (!canDeliver && channel === 'delivery') set({ channel: null });
        },
        setNotes: (notes) => set({ notes }),
        add: (item, quantity = 1, notes, modifiers) => {
          if (item.branchId !== branchId) {
            console.warn('cart: refused an item from another branch', {
              cartBranchId: branchId,
              itemBranchId: item.branchId,
              menuItemId: item.id,
            });
            return 0;
          }
          const trimmed = normalizeLineNotes(notes);
          const chosen = distinctModifiers(modifiers);
          // One line per selection, whichever card, row or sheet it was added from: the same dish
          // with the same options (in any order) and the same note (blank and whitespace are no
          // note) adds to the line already there. Different options are different food at a
          // different price and stay a line of their own.
          const key = lineSignature(item.id, chosen ?? [], trimmed);
          const existing = get().lines.find((l) => !l.comboId && cartLineKey(l) === key);
          if (existing) {
            // Up to the limit place-order holds a line to, and no further: past it the whole order
            // would be refused for a line the diner built one valid add at a time.
            const added = Math.max(0, Math.min(quantity, MAX_LINE_QUANTITY - existing.quantity));
            set({
              lines: get().lines.map((l) =>
                l.id === existing.id
                  ? // The line as the diner was just shown it, which is how place-order charges every
                    // unit on it: today's price for the dish AND for each option. The options are
                    // the same ones (that is what the key says), but what each adds may have moved
                    // since the first add, and keeping the old delta quoted less than the charge.
                    { ...l, quantity: l.quantity + added, unitPrice: item.price, modifiers: chosen }
                  : l,
              ),
            });
            return added;
          }
          const added = Math.min(quantity, MAX_LINE_QUANTITY);
          set({
            lines: [
              ...get().lines,
              {
                id: `${item.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                branchId,
                menuItemId: item.id,
                name: item.name,
                unitPrice: item.price,
                imageUrl: item.imageUrl,
                quantity: added,
                notes: trimmed,
                modifiers: chosen,
              },
            ],
          });
          return added;
        },
        addCombo: (combo, quantity = 1) => {
          if (combo.branchId !== branchId) {
            console.warn('cart: refused a combo from another branch', {
              cartBranchId: branchId,
              comboBranchId: combo.branchId,
              comboId: combo.comboId,
            });
            return 0;
          }
          // The same deal with no note adds to the line already there, as a dish does. Combos
          // used to get a line per tap, so two taps on the Lunch Set were two lines on the bill.
          // A combo never merges into a dish line, even one sharing the id slot.
          const key = comboLineSignature(combo.comboId);
          const existing = get().lines.find((l) => l.comboId === combo.comboId && cartLineKey(l) === key);
          if (existing) {
            // Held to the limit as a dish line is. Two adds of 60 used to be two lines, each one
            // place-order accepted; merged without a cap they were one line of 120 it refuses.
            const added = Math.max(0, Math.min(quantity, MAX_LINE_QUANTITY - existing.quantity));
            set({
              lines: get().lines.map((l) =>
                l.id === existing.id
                  ? {
                      ...l,
                      quantity: l.quantity + added,
                      unitPrice: combo.totalPrice,
                      comboContents: combo.contents,
                    }
                  : l,
              ),
            });
            return added;
          }
          const added = Math.min(quantity, MAX_LINE_QUANTITY);
          set({
            lines: [
              ...get().lines,
              {
                id: `combo-${combo.comboId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                branchId,
                menuItemId: combo.comboId,
                name: combo.name,
                unitPrice: combo.totalPrice,
                imageUrl: combo.imageUrl,
                quantity: added,
                comboId: combo.comboId,
                comboContents: combo.contents,
              },
            ],
          });
          return added;
        },
        // Kept as typed, because the cart's note box writes here on every keystroke: trimming
        // each one ate the space after a word, so "no egg" could not be typed. A blank note is
        // no note, and every comparison (cartLineKey) and place-order trim the rest.
        //
        // Not merged into an identical line here, though a note edit can make one: folding on a
        // keystroke would either pull the line being typed in out from under the diner's cursor,
        // or, folded the other way, hand the next letters they type to the other line's units
        // too. The cart folds the pair when the note box loses focus (foldIdenticalLines); until
        // then subtotal() prices the pair as one line, as place-order bills it.
        setLineNotes: (lineId, notes) => {
          const typed = normalizeLineNotes(notes) === undefined ? undefined : notes;
          set({ lines: get().lines.map((l) => (l.id === lineId ? { ...l, notes: typed } : l)) });
        },
        foldIdenticalLines: () => {
          const lines = get().lines;
          const folded = foldCartLines(lines);
          if (folded !== lines) set({ lines: folded });
        },
        remove: (lineId) =>
          set({ lines: get().lines.filter((l) => l.id !== lineId) }),
        // Held to MAX_LINE_QUANTITY like every add: the stepper stops there, and so does the store.
        setQuantity: (lineId, quantity) =>
          set({
            lines:
              quantity <= 0
                ? get().lines.filter((l) => l.id !== lineId)
                : get().lines.map((l) =>
                    l.id === lineId ? { ...l, quantity: Math.min(quantity, MAX_LINE_QUANTITY) } : l,
                  ),
          }),
        clear: () => set({ lines: [], notes: '' }),
        reprice: (current, unavailableOptionIds, optionPrices) => {
          let changed = 0;
          let removed = 0;
          const lines = get().lines.flatMap((l) => {
            if (
              unavailableOptionIds &&
              unavailableOptionIds.size > 0 &&
              (l.modifiers ?? []).some((m) => unavailableOptionIds.has(m.option_id))
            ) {
              removed += 1;
              return [];
            }
            let next = l;
            const now = current.get(l.comboId ?? l.menuItemId);
            if (now) {
              if (!now.available) {
                removed += 1;
                return [];
              }
              // Compared to the four decimals a unit price carries. Rounding both sides to the cent
              // would store a happy-hour 7.995 as 8.00 (or 7.99: 7.995 is 7.99499... times 100) and
              // quote a line place-order does not charge.
              const price = unitPrice4(now.price);
              if (price !== unitPrice4(l.unitPrice)) next = { ...next, unitPrice: price };
            }
            // What each chosen option adds today. Combo lines send place-order no options.
            if (optionPrices && optionPrices.size > 0 && !l.comboId && l.modifiers && l.modifiers.length > 0) {
              let moved = false;
              const modifiers = l.modifiers.map((m) => {
                const live = optionPrices.get(m.option_id);
                if (live === undefined || !Number.isFinite(live)) return m;
                const delta = unitPrice4(live);
                if (delta === unitPrice4(Number(m.price_delta ?? 0))) return m;
                moved = true;
                return { ...m, price_delta: delta };
              });
              if (moved) next = { ...next, modifiers };
            }
            if (next !== l) changed += 1;
            return [next];
          });
          if (changed > 0 || removed > 0) set({ lines });
          return { changed, removed };
        },
        // Exactly what place-order charges: each line rounded to the cent once (the unit never
        // is), then the lines added up with nothing rounded after. This feeds the loyalty cap
        // and every fee on the checkout, so it cannot carry a float tail either: 0.25 + 0.33 is
        // 0.58 here, not 0.5800000000000001. Two lines of one selection (a note edited to match
        // another line's) are priced as the single line place-order makes of them: 2 x $7.995 is
        // $15.99, where $8.00 + $8.00 would quote a cent more than is charged.
        subtotal: () => sumMoney(mergeIdenticalLines(get().lines, cartLineKey).map(cartLineTotal)),
        itemCount: () => get().lines.reduce((sum, l) => sum + l.quantity, 0),
      }),
      {
        name: cartStorageKey(branchId),
        version: CART_PERSIST_VERSION,
        storage: cartPersistStorage(),
        partialize: (s): PersistedCart => ({ lines: s.lines, notes: s.notes, channel: s.channel }),
        merge: (persisted, current) => {
          const merged = mergePersistedCart(branchId, persisted, current, channelTakenFromStorage);
          channelTakenFromStorage = true;
          return merged;
        },
        // Hydrated from an effect (useCartHydrated / CartProvider), never during render: the
        // server has no cart, and reading one on the first client paint is a hydration mismatch.
        skipHydration: true,
      },
    ),
  );
}

export type CartStore = ReturnType<typeof createCartStore>;
type CartPersistApi = CartStore['persist'];

const cartStores = new Map<string, CartStore>();

/**
 * The one store for a branch on this page. Memoised so every provider, window listener and
 * test that asks for a branch's cart gets the same instance.
 *
 * Not memoised on the server, where a module-level map would be a single cart shared by every
 * request the process serves. Nothing writes to a server-side store, but nothing has to.
 */
export function getCartStore(branchId: string): CartStore {
  if (typeof window === 'undefined') return createCartStore(branchId);
  let store = cartStores.get(branchId);
  if (!store) {
    store = createCartStore(branchId);
    cartStores.set(branchId, store);
  }
  return store;
}

/** `store.persist` is typed as always there, but it is absent when storage is unavailable. */
const persistApiOf = (store: CartStore): CartPersistApi | undefined =>
  store.persist as CartPersistApi | undefined;

function startCartHydration(store: CartStore): void {
  const api = persistApiOf(store);
  if (!api || api.hasHydrated()) return;
  void api.rehydrate();
}

const CartContext = React.createContext<CartStore | null>(null);

/**
 * Provides the cart of ONE branch to everything under it. Mounted by the branch layout, above
 * the table pin, the app shell and every page — each of those reads this branch's cart and no
 * other.
 *
 * Hydrates the cart as soon as it mounts, so an add made from anywhere under it (a reorder, a
 * replayed sign-in add) lands on the stored cart rather than being overwritten by it a tick
 * later; and keeps other windows of the SAME branch in step. Other branches use other keys, so
 * their windows never touch this one.
 */
export function CartProvider({ branchId, children }: { branchId: string; children: React.ReactNode }) {
  const store = React.useMemo(() => getCartStore(branchId), [branchId]);

  React.useEffect(() => {
    startCartHydration(store);
    const api = persistApiOf(store);
    if (!api) return;
    const key = api.getOptions().name;
    // Fired only in the OTHER windows of this origin, after one of them wrote the key. This
    // rehydrate follows that window's lines and notes but keeps this window's own order type (the
    // store's merge reads the channel from storage on the first hydration only), and it writes
    // nothing back, so two open windows never answer each other's saves.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      void api.rehydrate();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [store]);

  return React.createElement(CartContext.Provider, { value: store }, children);
}

/**
 * This branch's store itself, for code that needs `getState` / `setState` outside a render.
 * Throws outside a CartProvider: a cart with no branch is exactly the bug this store replaces.
 */
export function useCartStoreApi(): CartStore {
  const store = React.useContext(CartContext);
  if (!store) {
    throw new Error(
      'useCart must be used inside <CartProvider branchId>. Carts are per branch, so every cart reader has to render under the branch layout that provides one.',
    );
  }
  return store;
}

/** Select from this branch's cart. Same call shape as the old global `useCart` hook. */
export function useCart<T>(selector: (state: CartState) => T): T {
  return useStore(useCartStoreApi(), selector);
}

/**
 * False on the server and on the first client render, true once this branch's cart has been
 * read from storage. Anything that decides from the cart's CONTENTS — an empty-cart redirect, a
 * channel reconciliation, a badge — waits for this, or it decides on the empty defaults the
 * store starts with and storage then overwrites.
 */
export function useCartHydrated(): boolean {
  const store = useCartStoreApi();
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => {
    const api = persistApiOf(store);
    if (!api || api.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsubscribe = api.onFinishHydration(() => setHydrated(true));
    startCartHydration(store);
    return unsubscribe;
  }, [store]);
  return hydrated;
}
