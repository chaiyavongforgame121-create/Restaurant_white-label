import { getServerClient } from '@favornoms/database/server';
import { listCategories, listMenuItems } from '@favornoms/database/queries';
import { resolveTenant } from '@/lib/tenant';
import { MenuView } from './_components/menu-view';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function MenuPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const supabase = await getServerClient();

  // get_happy_hours_for_menu isn't in the generated types yet — thin typed escape.
  const rpcAny = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown }>;

  const [categories, items, openCheck, reviewsCheck, combosCheck, effectivePriceCheck, hhCheck] =
    await Promise.all([
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
    ]);

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
    <MenuView
      branch={tenant.branch}
      categories={categories}
      items={items}
      isOpen={isOpen}
      reviews={reviews}
      combos={combos}
      happyHours={happyHours}
    />
  );
}
