'use client';

import type { MenuItem } from '@favornoms/shared';
import type { CartLineModifier, ComboPick } from '@/store/cart';

/**
 * A cart add the diner configured while signed out.
 *
 * Adding to the cart is login-gated (an owner decision — see the login-gated cart work),
 * so tapping Add while signed out bounces to sign-in. Before this, the sheet simply
 * unmounted and everything the diner had picked — quantity, modifiers, notes — was thrown
 * away; they came back from sign-in to an empty cart and had to configure it all again.
 *
 * The gate stays. What changes is that the configured line is parked here first and
 * replayed the moment a session exists, so signing in costs the diner nothing.
 *
 * sessionStorage, not localStorage: this is a single interrupted interaction, not a cart.
 * It must not resurface in a new tab days later, and it is cleared as soon as it is used.
 */
export type PendingCartAdd =
  | {
      kind: 'item';
      branchId: string;
      item: MenuItem;
      quantity: number;
      notes?: string;
      modifiers?: CartLineModifier[];
    }
  | { kind: 'combo'; branchId: string; combo: ComboPick; quantity: number };

const KEY = 'favornoms-pending-add-v1';

export function stashPendingAdd(pending: PendingCartAdd): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Private mode / storage disabled — the diner just re-picks, same as before.
  }
}

/** Read and clear in one step: a replay must never be able to run twice. */
export function takePendingAdd(): PendingCartAdd | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as PendingCartAdd;
    if (parsed?.kind !== 'item' && parsed?.kind !== 'combo') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingAdd(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
