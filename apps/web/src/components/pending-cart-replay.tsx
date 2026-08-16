'use client';

import * as React from 'react';
import { useCart } from '@/store/cart';
import { useAuth } from '@/components/auth/use-auth';
import { clearPendingAdd, takePendingAdd } from '@/lib/pending-cart';

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
  // Replay at most once per mount, even if `user` re-identifies on a token refresh.
  const done = React.useRef(false);

  React.useEffect(() => {
    if (loading || done.current) return;

    if (!user) {
      // Still signed out — leave it parked. It is only dropped when it belongs to a
      // different branch, since the cart is single-branch.
      return;
    }

    done.current = true;
    const pending = takePendingAdd();
    if (!pending) return;

    // A parked line from another branch must not leak into this branch's cart.
    if (pending.branchId !== branchId) {
      clearPendingAdd();
      return;
    }

    if (pending.kind === 'item') {
      add(pending.item, pending.quantity, pending.notes, pending.modifiers);
    } else {
      addCombo(pending.combo, pending.quantity);
    }
  }, [user, loading, branchId, add, addCombo]);

  return null;
}
