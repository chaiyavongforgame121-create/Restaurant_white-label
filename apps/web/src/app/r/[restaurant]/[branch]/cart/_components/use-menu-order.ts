'use client';

import * as React from 'react';
import { getBrowserClient } from '@favornoms/database/client';
import { menuLinePositions, sortOrderLines } from '@favornoms/shared';
import type { CartLine } from '@/store/cart';

type PositionOf = ReturnType<typeof menuLinePositions>;

/**
 * The cart's lines in menu order: combos first, then category by category in the order the
 * restaurant arranged its menu, the same dish with other options side by side. That is the order
 * the bill, the receipt and the kitchen ticket will list the order in once it is placed, so the
 * diner reads their order the way the restaurant does.
 *
 * Display only. The cart store keeps the order things were added in; nothing is reordered in it.
 * Until the menu's positions are read (or if the read fails) the lines show in that stored order.
 * The cart page does not load the menu, so this reads the three positions it needs, and reads them
 * again only when the set of dishes and combos in the cart changes.
 */
export function useLinesInMenuOrder(branchId: string, lines: CartLine[]): CartLine[] {
  const [positionOf, setPositionOf] = React.useState<PositionOf | null>(null);

  const itemIds = [...new Set(lines.filter((l) => !l.comboId).map((l) => l.menuItemId))].sort();
  const comboIds = [...new Set(lines.flatMap((l) => (l.comboId ? [l.comboId] : [])))].sort();
  const idsKey = `${itemIds.join(',')}|${comboIds.join(',')}`;

  React.useEffect(() => {
    if (!branchId || idsKey === '|') return;
    let cancelled = false;
    const [itemPart = '', comboPart = ''] = idsKey.split('|');
    const items = itemPart ? itemPart.split(',') : [];
    const combos = comboPart ? comboPart.split(',') : [];
    void (async () => {
      const supabase = getBrowserClient();
      const [categoryRows, itemRows, comboRows] = await Promise.all([
        // The branch's categories in the menu's order; only their order matters here. Ties fall
        // back to age and id, as the trigger that stamps order lines does. Active ones only, as
        // the trigger counts them: RLS already hides a hidden category from a diner, but not
        // from a signed-in member of staff, whose cart would otherwise count it and list the
        // lines in an order the bill will not.
        supabase
          .from('menu_categories')
          .select('id, display_order')
          .eq('branch_id', branchId)
          .eq('is_active', true)
          .order('display_order')
          .order('created_at')
          .order('id'),
        items.length
          ? supabase
              .from('menu_items')
              .select('id, category_id, display_order')
              .eq('branch_id', branchId)
              .in('id', items)
          : null,
        combos.length
          ? supabase.from('v_active_combos').select('id, display_order').eq('branch_id', branchId).in('id', combos)
          : null,
      ]);
      // A failed read leaves the cart in the order it was built: nothing is lost but the sorting.
      if (cancelled || categoryRows.error || itemRows?.error || comboRows?.error) return;
      const next = menuLinePositions({
        categories: (categoryRows.data ?? []).map((c) => ({ id: c.id, displayOrder: c.display_order })),
        items: (itemRows?.data ?? []).map((i) => ({
          id: i.id,
          categoryId: i.category_id,
          displayOrder: i.display_order,
        })),
        combos: (comboRows?.data ?? []).flatMap((c) => (c.id ? [{ id: c.id, order: c.display_order }] : [])),
      });
      setPositionOf(() => next);
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, idsKey]);

  return React.useMemo(
    () =>
      positionOf
        ? sortOrderLines(lines, (l) => ({
            ...positionOf(l.comboId ? { comboId: l.comboId } : { menuItemId: l.menuItemId }),
            item_name: l.name,
            modifiers: l.modifiers,
          }))
        : lines,
    [lines, positionOf],
  );
}
