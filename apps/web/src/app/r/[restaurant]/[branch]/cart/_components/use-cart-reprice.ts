'use client';

import * as React from 'react';
import { getBrowserClient } from '@favornoms/database/client';
import { useCart, type CurrentPrice } from '@/store/cart';

/** Do not re-ask more often than this when a view is flicked in and out of the foreground. */
const RECHECK_MIN_GAP_MS = 30_000;

/**
 * Re-validates the cart against the live menu, and returns a plain-English notice when
 * something moved.
 *
 * The cart stores the price each line was added at. place-order re-reads menu_items and
 * get_effective_prices on the server and prices the order from those rows — so a diner whose
 * cart had been sitting since a happy hour ended saw one total on the cart screen, tapped
 * through, and was charged another; a diner with a 86'd item in their cart got the whole order
 * refused with no idea which item was the problem. Both are the same bug: the last time anyone
 * checked was when the item was added.
 *
 * Re-runs on mount (opening the cart is exactly the moment to check), whenever the storefront
 * version changes, whenever the set of lines changes, and when a backgrounded view comes back.
 */
export function useCartReprice(branchId: string, storefrontVersion: number): string | null {
  const lines = useCart((s) => s.lines);
  const reprice = useCart((s) => s.reprice);
  // One cart is persisted per origin, not per restaurant, so a diner can be looking at this
  // storefront's cart page holding a cart built at a different branch. Every id would then miss
  // and the cart would be wiped for being "unavailable" — check nothing rather than that.
  const cartBranchId = useCart((s) => s.branchId);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [wake, setWake] = React.useState(0);
  const lastCheck = React.useRef(0);

  // Identity of the cart's contents, not of the array: re-checking on every quantity tap is
  // noise, but adding or removing a line is worth a look.
  const idsKey = lines
    .map((l) => l.comboId ?? l.menuItemId)
    .sort()
    .join('|');

  React.useEffect(() => {
    const bump = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastCheck.current < RECHECK_MIN_GAP_MS) return;
      setWake((n) => n + 1);
    };
    document.addEventListener('visibilitychange', bump);
    window.addEventListener('online', bump);
    return () => {
      document.removeEventListener('visibilitychange', bump);
      window.removeEventListener('online', bump);
    };
  }, []);

  React.useEffect(() => {
    if (!idsKey || !branchId || cartBranchId !== branchId) return;
    let cancelled = false;
    lastCheck.current = Date.now();

    const current = useCart.getState().lines;
    const itemIds = [...new Set(current.filter((l) => !l.comboId).map((l) => l.menuItemId))];
    const comboIds = [...new Set(current.flatMap((l) => (l.comboId ? [l.comboId] : [])))];

    void (async () => {
      const supabase = getBrowserClient();
      const [itemRows, comboRows, effectiveRows] = await Promise.all([
        itemIds.length
          ? supabase
              .from('menu_items')
              .select('id, price, is_active, track_stock, stock_quantity, sold_out_until')
              .eq('branch_id', branchId)
              .in('id', itemIds)
          : null,
        comboIds.length
          ? supabase
              .from('v_active_combos')
              .select('id, total_price')
              .eq('branch_id', branchId)
              .in('id', comboIds)
          : null,
        // Happy hour prices, the same source the menu page renders from — the stored unit
        // price is already the discounted one when a promotion was live.
        itemIds.length ? supabase.rpc('get_effective_prices', { p_branch_id: branchId }) : null,
      ]);
      // A failed read tells us nothing, and nothing is exactly what it should change.
      if (cancelled || itemRows?.error || comboRows?.error) return;

      const discounted = new Map<string, number>();
      for (const row of effectiveRows?.data ?? []) {
        if (Number(row.effective_price) < Number(row.list_price)) {
          discounted.set(row.menu_item_id, Number(row.effective_price));
        }
      }

      const now = Date.now();
      const live = new Map<string, CurrentPrice>();
      // Seed every id as gone: an item the query did not return has been deleted, or moved to
      // another branch, and either way it cannot be ordered here.
      for (const id of itemIds) live.set(id, { price: 0, available: false });
      for (const row of itemRows?.data ?? []) {
        const soldOut =
          (row.track_stock === true && (row.stock_quantity ?? 0) <= 0) ||
          (!!row.sold_out_until && new Date(row.sold_out_until).getTime() > now);
        live.set(row.id, {
          price: discounted.get(row.id) ?? Number(row.price),
          available: row.is_active && !soldOut,
        });
      }
      for (const id of comboIds) live.set(id, { price: 0, available: false });
      for (const row of comboRows?.data ?? []) {
        if (!row.id) continue;
        // v_active_combos only lists live combos, so being in it IS availability. A row with
        // no price is unreadable rather than gone — leave that line alone.
        if (row.total_price == null) live.delete(row.id);
        else live.set(row.id, { price: Number(row.total_price), available: true });
      }

      const { changed, removed } = reprice(live);
      if (cancelled) return;
      if (removed > 0) {
        const what = removed === 1 ? 'One item is' : `${removed} items are`;
        const verb = removed === 1 ? 'it has' : 'they have';
        setNotice(
          `${what} no longer available, so ${verb} been removed from your cart.` +
            (changed > 0 ? ' Some prices have changed too.' : ''),
        );
      } else if (changed > 0) {
        setNotice("The restaurant's prices have changed — your cart now shows the current ones.");
      } else {
        setNotice(null);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `lines` is read from the store inside so a quantity change does not re-run this; idsKey
    // is what decides whether the contents are different.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, cartBranchId, storefrontVersion, idsKey, wake, reprice]);

  return notice;
}
