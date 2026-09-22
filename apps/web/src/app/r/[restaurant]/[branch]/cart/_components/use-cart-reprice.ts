'use client';

import * as React from 'react';
import { getBrowserClient } from '@favornoms/database/client';
import { useCart, useCartStoreApi, type CurrentPrice } from '@/store/cart';

/** Do not re-ask more often than this when a view is flicked in and out of the foreground. */
const RECHECK_MIN_GAP_MS = 30_000;

/**
 * What the last check moved, for the cart to say in the diner's language (cart.priceNotice.*).
 * Never both zero: nothing moved is `null`.
 */
export interface CartPriceNotice {
  /** Lines taken out because the item, the combo or an option chosen on it can no longer be ordered. */
  removed: number;
  /** Lines whose price was updated to the current one. */
  changed: number;
}

/**
 * Re-validates the cart against the live menu, and reports what moved when something did.
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
export function useCartReprice(branchId: string, storefrontVersion: number): CartPriceNotice | null {
  // This branch's cart (CartProvider), so every line was added here and every id is one the
  // queries below can find at `branchId` — a miss really does mean the dish is gone.
  const cart = useCartStoreApi();
  const lines = useCart((s) => s.lines);
  const reprice = useCart((s) => s.reprice);
  const [notice, setNotice] = React.useState<CartPriceNotice | null>(null);
  const [wake, setWake] = React.useState(0);
  const lastCheck = React.useRef(0);

  // Identity of the cart's contents, not of the array: re-checking on every quantity tap is
  // noise, but adding or removing a line, or the same dish with other options, is worth a look.
  const idsKey = lines
    .map((l) =>
      l.comboId ?? [l.menuItemId, ...(l.modifiers ?? []).map((m) => m.option_id).sort()].join('+'),
    )
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
    if (!idsKey || !branchId) return;
    let cancelled = false;
    lastCheck.current = Date.now();

    const current = cart.getState().lines;
    const itemIds = [...new Set(current.filter((l) => !l.comboId).map((l) => l.menuItemId))];
    const comboIds = [...new Set(current.flatMap((l) => (l.comboId ? [l.comboId] : [])))];
    const optionIds = [
      ...new Set(
        current.flatMap((l) => (l.comboId ? [] : (l.modifiers ?? []).map((m) => m.option_id))),
      ),
    ];

    void (async () => {
      const supabase = getBrowserClient();
      const [itemRows, comboRows, effectiveRows, optionRows] = await Promise.all([
        itemIds.length
          ? supabase
              .from('menu_items')
              .select('id, price, is_active, out_of_stock, sold_out_until')
              .eq('branch_id', branchId)
              .in('id', itemIds)
          : null,
        comboIds.length
          ? supabase
              .from('v_active_combos')
              .select('id, total_price, is_available')
              .eq('branch_id', branchId)
              .in('id', comboIds)
          : null,
        // Happy hour prices, the same source the menu page renders from — the stored unit
        // price is already the discounted one when a promotion was live.
        itemIds.length ? supabase.rpc('get_effective_prices', { p_branch_id: branchId }) : null,
        // The options chosen on those lines. place-order refuses the WHOLE order for an option
        // that was switched off, deleted or belongs to another branch's group (modifier_inactive /
        // modifier_branch_mismatch), so a line still carrying one is as unorderable as a dish that
        // is gone — better taken out here, with the notice, than found out at the button.
        optionIds.length
          ? supabase
              .from('modifier_options')
              .select('id, is_active, price_delta, modifier_groups!inner(branch_id)')
              .in('id', optionIds)
          : null,
      ]);
      // A failed read tells us nothing, and nothing is exactly what it should change.
      if (cancelled || itemRows?.error || comboRows?.error || optionRows?.error) return;

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
          row.out_of_stock === true ||
          (!!row.sold_out_until && new Date(row.sold_out_until).getTime() > now);
        live.set(row.id, {
          price: discounted.get(row.id) ?? Number(row.price),
          available: row.is_active && !soldOut,
        });
      }
      for (const id of comboIds) live.set(id, { price: 0, available: false });
      for (const row of comboRows?.data ?? []) {
        if (!row.id) continue;
        // v_active_combos lists only combos on sale, and says whether each can be made right now:
        // is_available is false while any dish in it is switched off, 86'd or short of stock,
        // which place-order refuses like the sold-out dish itself. A row with no price is
        // unreadable rather than gone — leave that line alone.
        if (row.total_price == null) live.delete(row.id);
        else live.set(row.id, { price: Number(row.total_price), available: row.is_available === true });
      }

      // The same three tests place-order applies, so the cart takes out exactly what the server
      // would refuse: no row (deleted), switched off, or a group at another branch.
      const unavailableOptions = new Set(optionIds);
      // What each option still on offer adds today: place-order charges the current delta, not the
      // one the line was added with, so a fried egg that went up must move the cart's quote too.
      const optionPrices = new Map<string, number>();
      for (const row of optionRows?.data ?? []) {
        const group = Array.isArray(row.modifier_groups) ? row.modifier_groups[0] : row.modifier_groups;
        if (row.is_active && group?.branch_id === branchId) {
          unavailableOptions.delete(row.id);
          optionPrices.set(row.id, Number(row.price_delta));
        }
      }

      const { changed, removed } = reprice(live, unavailableOptions, optionPrices);
      if (cancelled) return;
      // The words are the cart view's: a hook has no business picking a language.
      setNotice(removed > 0 || changed > 0 ? { removed, changed } : null);
    })();

    return () => {
      cancelled = true;
    };
    // `lines` is read from the store inside so a quantity change does not re-run this; idsKey
    // is what decides whether the contents are different.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, cart, storefrontVersion, idsKey, wake, reprice]);

  return notice;
}
