/**
 * The stock columns as the database holds them. They are not part of MenuItem: the
 * storefront only needs `outOfStock` and the mapper in @favornoms/database throws the
 * rest away. The merchant needs the raw numbers — after unticking Track stock the card
 * has to visibly stop saying "Sold out" — so the menu page reads them alongside the
 * items and hands them straight over. The kitchen station rides along: it is back-office
 * only, and the storefront has no use for it.
 *
 * A plain module, not the 'use client' grid: a server page importing a value from a client
 * module gets a client reference, not the string.
 */
export interface MenuItemStockRow {
  id: string;
  track_stock: boolean | null;
  stock_quantity: number | null;
  low_stock_threshold: number | null;
  sold_out_until: string | null;
  station: string | null;
}

/** The select behind MenuItemStockRow, shared by the page and the grid's reload. */
export const MENU_STOCK_COLUMNS = 'id, track_stock, stock_quantity, low_stock_threshold, sold_out_until, station';
