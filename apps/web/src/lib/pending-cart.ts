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

/**
 * One slot per branch, like the cart it feeds. A line parked at one branch is only ever
 * replayed there: a sign-in that ends on another storefront neither drops it into that
 * branch's cart nor throws it away.
 */
const pendingAddKey = (branchId: string) => `favornoms-pending-add-v2:${branchId}`;

/** The single slot every storefront used to share. Taken only by the branch it was parked at. */
const LEGACY_KEY = 'favornoms-pending-add-v1';

export function stashPendingAdd(pending: PendingCartAdd): void {
  try {
    sessionStorage.setItem(pendingAddKey(pending.branchId), JSON.stringify(pending));
  } catch {
    // Private mode / storage disabled — the diner just re-picks, same as before.
  }
}

function parsePendingAdd(raw: string | null, branchId: string): PendingCartAdd | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingCartAdd | null;
    if (parsed?.kind !== 'item' && parsed?.kind !== 'combo') return null;
    return parsed.branchId === branchId ? parsed : null;
  } catch {
    return null;
  }
}

/** Read and clear this branch's parked add in one step: a replay must never be able to run twice. */
export function takePendingAdd(branchId: string): PendingCartAdd | null {
  try {
    const key = pendingAddKey(branchId);
    const raw = sessionStorage.getItem(key);
    if (raw) {
      sessionStorage.removeItem(key);
      return parsePendingAdd(raw, branchId);
    }
    // Parked by the build before per-branch slots, mid sign-in across a deploy.
    const legacy = parsePendingAdd(sessionStorage.getItem(LEGACY_KEY), branchId);
    if (legacy) sessionStorage.removeItem(LEGACY_KEY);
    return legacy;
  } catch {
    return null;
  }
}

export function clearPendingAdd(branchId: string): void {
  try {
    sessionStorage.removeItem(pendingAddKey(branchId));
  } catch {
    /* ignore */
  }
}
