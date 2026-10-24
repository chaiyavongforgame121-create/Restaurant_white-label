import { listCategories, listKitchenStations, listMenuItems } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { PageAccessDenied } from '@/components/page-access-denied';
import { MenuManager } from './_components/menu-manager';
import { MENU_STOCK_COLUMNS, type MenuItemStockRow } from './_components/menu-stock';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function MenuPage({ params }: Props) {
  const { branchId } = await params;
  // Only the sidebar used to gate the menu editor; a cashier holds backoffice.access now and
  // would have opened it by URL, with every save refused by RLS.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/menu`);
  if (!can('menu.manage')) return <PageAccessDenied area="menu" branchName={branch.name} />;
  // listMenuItems reduces track_stock/stock_quantity to a single `outOfStock` boolean,
  // which is all the storefront needs but leaves the merchant grid unable to say what
  // it is counting or how many are left. The raw columns come back alongside it — one
  // extra select for the whole page, not one per card.
  const [categories, items, stock, detail, stations] = await Promise.all([
    listCategories(supabase, branchId),
    // Hidden dishes included: this is the screen where the merchant switches them back on.
    listMenuItems(supabase, branchId, { includeInactive: true }),
    supabase.from('menu_items').select(MENU_STOCK_COLUMNS).eq('branch_id', branchId),
    // "Sold out until …" is the shop's clock, and prices are the branch's own currency.
    supabase.from('branches').select('timezone, settings').eq('id', branchId).maybeSingle(),
    // The branch's own kitchen stations, for the dish dialog and the Kitchen stations sheet. Like
    // stock, a failed read leaves the menu up: the dialog then offers only "No station" (keeping a
    // dish's own), and the next reload tries again.
    listKitchenStations(supabase, branchId).catch((err) => {
      console.error('[menu] kitchen stations read failed', err);
      return [];
    }),
  ]);
  const settings = (detail.data?.settings ?? {}) as Record<string, unknown>;
  return (
    <MenuManager
      branchId={branchId}
      categories={categories}
      items={items}
      // A failed stock read must not take the menu down with it: the grid still
      // renders, just without the stock badges, and opening an item re-reads them.
      stockRows={(stock.data ?? []) as MenuItemStockRow[]}
      stations={stations}
      timezone={detail.data?.timezone ?? 'America/New_York'}
      currency={typeof settings.currency === 'string' && settings.currency ? settings.currency : 'USD'}
    />
  );
}
