import { getServerClient } from '@favornoms/database/server';
import { resolveScheduleDelivery } from '@/lib/schedule-delivery';
import { listCategories, listMenuItems } from '@favornoms/database/queries';
import { resolveStorefrontStatus, resolveTenant } from '@/lib/tenant';
import { MenuView } from './_components/menu-view';
import { SuspendedStorefront } from './_components/suspended-storefront';
import { TablePinNotice, TableScanPin } from './_components/table-pin';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
  /** `?t=<tables.qr_code_token>` — the whole of the per-table deep link. */
  searchParams: Promise<{ t?: string | string[] }>;
}

/** One row of public.resolve_table_qr. The session columns arrived with dine-in sittings;
 *  `session_code` is deliberately absent — the resolver is the one function anon can call. */
interface ScannedTable {
  branch_id: string;
  table_id: string;
  table_number: string;
  display_name: string | null;
  session_id: string | null;
  /** 'open' | 'locked' | 'closed' | 'none'. */
  session_status: string;
  accepting_orders: boolean;
  requires_join_code: boolean;
  /** 'auto' — a scan opens the sitting; 'staff' — only staff may seat a table. */
  session_mode: string;
}

export default async function MenuPage({ params, searchParams }: Props) {
  const { restaurant, branch } = await params;
  const { t: tokenParam } = await searchParams;
  const tableToken = (Array.isArray(tokenParam) ? tokenParam[0] : tokenParam)?.trim();
  const tenant = await resolveTenant(restaurant, branch);

  // Checked before the menu queries so a lapsed subscription costs one round
  // trip, not eight. The deadline is authoritative — no cron has to have run.
  const status = await resolveStorefrontStatus(tenant.branch.id);
  if (!status.entitled) {
    return <SuspendedStorefront brandName={tenant.theme.brandName ?? tenant.restaurant.name} />;
  }

  const supabase = await getServerClient();

  // get_happy_hours_for_menu and resolve_table_qr aren't in the generated types yet —
  // thin typed escape.
  const rpcAny = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown }>;

  const [
    categories,
    items,
    openCheck,
    reviewsCheck,
    combosCheck,
    effectivePriceCheck,
    hhCheck,
    tableCheck,
  ] = await Promise.all([
    listCategories(supabase, tenant.branch.id),
    listMenuItems(supabase, tenant.branch.id),
    supabase.rpc('is_branch_open', { p_branch_id: tenant.branch.id }),
    supabase.rpc('get_branch_reviews', { p_branch_id: tenant.branch.id, p_limit: 3 }),
    supabase
      .from('v_active_combos')
      .select('id, name, description, total_price, image_url, items')
      .eq('branch_id', tenant.branch.id),
    supabase.rpc('get_effective_prices', { p_branch_id: tenant.branch.id }),
    rpcAny('get_happy_hours_for_menu', { p_branch_id: tenant.branch.id }),
    // Unknown, retired or rotated tokens come back empty; the diner just gets the
    // ordinary menu rather than an error page they cannot act on.
    tableToken
      ? rpcAny('resolve_table_qr', { p_token: tableToken })
      : Promise.resolve({ data: null }),
  ]);

  // The storefront in the URL wins. A token belonging to another branch must not pin
  // anything here — otherwise a code lifted from one restaurant's table tent would seat
  // a diner in a second restaurant's dining room and send the ticket to its kitchen.
  const scanned = ((tableCheck.data as ScannedTable[] | null) ?? [])[0];
  // Resolving the code says which table it is, not that this diner may order at it: the
  // sitting, the sign-in and the party membership are all decided by join_table_session and
  // re-checked by place-order. This just decides whether to offer the seat at all.
  const scannedHere =
    scanned && scanned.branch_id === tenant.branch.id && tableToken ? scanned : null;

  const priceMap = new Map<string, { list: number; effective: number; label: string | null }>();
  for (const row of (effectivePriceCheck.data ?? []) as Array<{
    menu_item_id: string;
    list_price: number;
    effective_price: number;
    discount_label: string | null;
  }>) {
    priceMap.set(row.menu_item_id, {
      list: Number(row.list_price),
      effective: Number(row.effective_price),
      label: row.discount_label,
    });
  }
  // Mutate items to use effective price, but remember the list price for strikethrough.
  for (const item of items) {
    const eff = priceMap.get(item.id);
    if (eff && eff.effective < eff.list) {
      item.listPrice = eff.list;
      item.saleLabel = eff.label ?? 'Happy hour';
      item.price = eff.effective;
    }
  }

  // Build happy-hour sections (each renders as its own titled section on the menu). Resolve the
  // items each one applies to from the already-loaded menu (explicit ids ∪ items in its
  // categories; empty applies-to = whole menu). Item prices already reflect the discount when
  // the happy hour is live (via get_effective_prices above).
  const happyHoursRaw = (hhCheck.data ?? []) as Array<{
    id: string;
    name: string;
    discount_type: 'percent' | 'fixed';
    discount_value: number;
    days_of_week: number[];
    start_time: string;
    end_time: string;
    applies_to_item_ids: string[] | null;
    applies_to_category_ids: string[] | null;
    is_live: boolean;
  }>;
  const happyHours = happyHoursRaw
    .map((hh) => {
      const itemIds = new Set(hh.applies_to_item_ids ?? []);
      const catIds = new Set(hh.applies_to_category_ids ?? []);
      const appliesToAll = itemIds.size === 0 && catIds.size === 0;
      const hhItems = appliesToAll
        ? []
        : items.filter((it) => itemIds.has(it.id) || (it.categoryId != null && catIds.has(it.categoryId)));
      return {
        id: hh.id,
        name: hh.name,
        discountType: hh.discount_type,
        discountValue: Number(hh.discount_value),
        daysOfWeek: hh.days_of_week ?? [],
        startTime: hh.start_time,
        endTime: hh.end_time,
        isLive: hh.is_live,
        appliesToAll,
        items: hhItems,
      };
    })
    .filter((hh) => hh.appliesToAll || hh.items.length > 0);

  const scheduleDelivery = await resolveScheduleDelivery(supabase, tenant.branch.id, status);
  const isOpen = openCheck.data !== false;
  const reviews = (reviewsCheck.data ?? null) as {
    summary: { rating: number | null; count: number };
    recent: Array<{ food_stars: number; delivery_stars: number | null; comment: string; created_at: string }>;
  } | null;
  const combos = (combosCheck.data ?? []) as Array<{
    id: string;
    name: string;
    description: string | null;
    total_price: number | string;
    image_url: string | null;
    items: Array<{ menu_item_id: string; item_name: string; quantity: number; list_price: number }>;
  }>;
  return (
    <>
      {scannedHere && (
        <TableScanPin
          token={tableToken!}
          table={{
            id: scannedHere.table_id,
            number: scannedHere.table_number,
            label: scannedHere.display_name?.trim() || `Table ${scannedHere.table_number}`,
          }}
          sessionMode={scannedHere.session_mode}
          requiresJoinCode={scannedHere.requires_join_code}
        />
      )}
      {/* The menu is where a diner spends the meal, so it is where the running bill has to
          be reachable — the cart says it too, but nobody opens the cart to check a total. */}
      <TablePinNotice />
      <MenuView
        branch={tenant.branch}
        categories={categories}
        items={items}
        isOpen={isOpen}
        reviews={reviews}
        combos={combos}
        happyHours={happyHours}
        canDeliver={scheduleDelivery.canDeliver}
        // The scan is being seated by <TableScanPin> above, which may be bouncing the diner
        // through sign-in. Until that lands there is no pin, and without this the gate would
        // open over somebody who is demonstrably sitting at a table.
        seatingFromScan={scannedHere !== null}
        menuLayout={tenant.storefront.menuLayout}
        menuCardStyle={tenant.storefront.menuCardStyle}
        heroUrl={tenant.storefront.heroUrl}
        heroTitle={tenant.storefront.heroTitle}
        heroSubtitle={tenant.storefront.heroSubtitle}
      />
    </>
  );
}
