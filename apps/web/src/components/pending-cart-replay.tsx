'use client';

import * as React from 'react';
import { useCart, useCartHydrated } from '@/store/cart';
import { useAuth } from '@/components/auth/use-auth';
import { takePendingAdd } from '@/lib/pending-cart';

/**
 * Puts back whatever the diner had configured when the login gate interrupted them.
 *
 * Tapping Add while signed out parks the line (lib/pending-cart) and redirects to sign-in.
 * The moment a session exists this drops that line into the cart, so the diner returns to
 * find the item already there instead of an empty cart and a form to fill in again.
 *
 * Mounted once in the branch layout: sign-in redirects to `next`, which is wherever the
 * diner was, so the replay has to work on any page under /r/{restaurant}/{branch}.
 */
export function PendingCartReplay({ branchId }: { branchId: string }) {
  const { user, loading } = useAuth();
  const add = useCart((s) => s.add);
  const addCombo = useCart((s) => s.addCombo);
  // An add made before the stored cart is read would be overwritten by it a tick later.
  const cartHydrated = useCartHydrated();
  // Replay at most once per mount, even if `user` re-identifies on a token refresh.
  const done = React.useRef(false);

  React.useEffect(() => {
    if (loading || !cartHydrated || done.current) return;

    // Still signed out — leave it parked.
    if (!user) return;

    done.current = true;
    // Only this branch's slot: a line parked at another branch waits for that branch.
    const pending = takePendingAdd(branchId);
    if (!pending) return;

    if (pending.kind === 'item') {
      add(pending.item, pending.quantity, pending.notes, pending.modifiers);
    } else {
      addCombo(pending.combo, pending.quantity);
    }
  }, [user, loading, cartHydrated, branchId, add, addCombo]);

  return null;
}
