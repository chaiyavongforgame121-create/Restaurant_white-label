'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MenuItem } from '@favornoms/shared';

export interface CartLineModifier {
  group_id: string;
  group_name: string;
  option_id: string;
  option_name: string;
  price_delta: number;
}

export interface CartLine {
  id: string;
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

interface CartState {
  branchId: string | null;
  lines: CartLine[];
  notes: string;
  /**
   * `null` until the diner picks an order type in the gate. There is no default:
   * delivery, pickup and dine-in change the price, the required fields and where
   * the food ends up, so the storefront asks instead of guessing.
   */
  channel: OrderChannel | null;
  /**
   * The branch the choice was made for. One localStorage key serves every
   * restaurant on this origin, so "dine-in, table 7" at one storefront must not
   * carry into the next one.
   */
  channelBranchId: string | null;
  setChannel: (channel: OrderChannel, branchId: string) => void;
  /**
   * Drop a persisted choice that no longer applies — different branch, or a
   * branch that has since lost the delivery add-on. Clearing re-opens the gate
   * rather than silently substituting a channel the diner did not pick.
   */
  resolveChannel: (canDeliver: boolean, branchId: string) => void;
  setNotes: (notes: string) => void;
  add: (item: MenuItem, quantity?: number, notes?: string, modifiers?: CartLineModifier[]) => void;
  addCombo: (combo: ComboPick, quantity?: number) => void;
  setLineNotes: (lineId: string, notes: string) => void;
  remove: (lineId: string) => void;
  setQuantity: (lineId: string, quantity: number) => void;
  clear: () => void;
  subtotal: () => number;
  itemCount: () => number;
}

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      branchId: null,
      lines: [],
      notes: '',
      channel: null,
      channelBranchId: null,
      setChannel: (channel, branchId) => set({ channel, channelBranchId: branchId }),
      resolveChannel: (canDeliver, branchId) => {
        const { channel, channelBranchId } = get();
        if (channel === null) return;
        // A choice belongs to the branch it was made on.
        if (channelBranchId !== branchId) {
          set({ channel: null, channelBranchId: null });
          return;
        }
        // Delivery is a paid add-on and can lapse between visits. Re-ask rather
        // than downgrading to pickup behind the diner's back.
        if (!canDeliver && channel === 'delivery') set({ channel: null, channelBranchId: null });
      },
      setNotes: (notes) => set({ notes }),
      add: (item, quantity = 1, notes, modifiers) => {
        const trimmed = notes?.trim() || undefined;
        const modSig = modifiers && modifiers.length > 0
          ? modifiers.map((m) => m.option_id).sort().join('|')
          : '';
        // Merge with existing line only when notes AND modifier selection match.
        const existing = get().lines.find((l) => {
          if (l.menuItemId !== item.id) return false;
          if ((l.notes ?? undefined) !== trimmed) return false;
          const sig = (l.modifiers ?? []).map((m) => m.option_id).sort().join('|');
          return sig === modSig;
        });
        if (existing) {
          set({
            lines: get().lines.map((l) =>
              l.id === existing.id ? { ...l, quantity: l.quantity + quantity } : l,
            ),
          });
          return;
        }
        set({
          branchId: item.branchId,
          lines: [
            ...get().lines,
            {
              id: `${item.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              menuItemId: item.id,
              name: item.name,
              unitPrice: item.price,
              imageUrl: item.imageUrl,
              quantity,
              notes: trimmed,
              modifiers: modifiers && modifiers.length > 0 ? modifiers : undefined,
            },
          ],
        });
      },
      addCombo: (combo, quantity = 1) => {
        // Combos always get their own line (no merging with item lines).
        set({
          branchId: combo.branchId,
          lines: [
            ...get().lines,
            {
              id: `combo-${combo.comboId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              menuItemId: combo.comboId,
              name: combo.name,
              unitPrice: combo.totalPrice,
              imageUrl: combo.imageUrl,
              quantity,
              comboId: combo.comboId,
              comboContents: combo.contents,
            },
          ],
        });
      },
      setLineNotes: (lineId, notes) =>
        set({
          lines: get().lines.map((l) =>
            l.id === lineId ? { ...l, notes: notes.trim() || undefined } : l,
          ),
        }),
      remove: (lineId) =>
        set({ lines: get().lines.filter((l) => l.id !== lineId) }),
      setQuantity: (lineId, quantity) =>
        set({
          lines:
            quantity <= 0
              ? get().lines.filter((l) => l.id !== lineId)
              : get().lines.map((l) =>
                  l.id === lineId ? { ...l, quantity } : l,
                ),
        }),
      clear: () => set({ lines: [], notes: '' }),
      subtotal: () =>
        get().lines.reduce((sum, l) => {
          const modDelta = (l.modifiers ?? []).reduce((s, m) => s + Number(m.price_delta ?? 0), 0);
          return sum + (l.unitPrice + modDelta) * l.quantity;
        }, 0),
      itemCount: () => get().lines.reduce((sum, l) => sum + l.quantity, 0),
    }),
    {
      name: 'favornoms-cart-v1',
      version: 2,
      // v1 persisted a channel that was auto-assigned as often as it was chosen
      // (`channelTouched` recorded which, but a false there is indistinguishable
      // from "picked pickup, the old default"). Every v1 cart re-enters the gate;
      // the lines themselves are kept.
      migrate: (state) => {
        const { channelTouched: _dropped, ...rest } = (state ?? {}) as Record<string, unknown>;
        return { ...rest, channel: null, channelBranchId: null } as CartState;
      },
      skipHydration: true,
    },
  ),
);
