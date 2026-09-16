import { getServerClient } from '@favornoms/database/server';
import { listCategories, listMenuItems } from '@favornoms/database/queries';
import { MenuManager, type MenuItemStockRow } from './_components/menu-manager';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function MenuPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  // listMenuItems reduces track_stock/stock_quantity to a single `outOfStock` boolean,
  // which is all the storefront needs but leaves the merchant grid unable to say what
  // it is counting or how many are left. The raw columns come back alongside it — one
  // extra select for the whole page, not one per card.
  const [categories, items, stock] = await Promise.all([
    listCategories(supabase, branchId),
    // Hidden dishes included: this is the screen where the merchant switches them back on.
    listMenuItems(supabase, branchId, { includeInactive: true }),
    supabase
      .from('menu_items')
      .select('id, track_stock, stock_quantity, low_stock_threshold')
      .eq('branch_id', branchId),
  ]);
  return (
    <MenuManager
      branchId={branchId}
      categories={categories}
      items={items}
      // A failed stock read must not take the menu down with it: the grid still
      // renders, just without the stock badges, and opening an item re-reads them.
      stockRows={(stock.data ?? []) as MenuItemStockRow[]}
    />
  );
}
