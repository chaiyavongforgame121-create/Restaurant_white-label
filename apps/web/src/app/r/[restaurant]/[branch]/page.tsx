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

  const [categories, items, openCheck, reviewsCheck, combosCheck, effectivePriceCheck] = await Promise.all([
    listCategories(supabase, tenant.branch.id),
    listMenuItems(supabase, tenant.branch.id),
    supabase.rpc('is_branch_open', { p_branch_id: tenant.branch.id }),
    supabase.rpc('get_branch_reviews', { p_branch_id: tenant.branch.id, p_limit: 3 }),
    supabase
      .from('v_active_combos')
      .select('id, name, description, total_price, image_url, items')
      .eq('branch_id', tenant.branch.id),
    supabase.rpc('get_effective_prices', { p_branch_id: tenant.branch.id }),
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
    />
  );
}
