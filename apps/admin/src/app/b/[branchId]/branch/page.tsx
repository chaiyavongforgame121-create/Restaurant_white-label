import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { getEntitlementsForBranch } from '@favornoms/database/queries';
import { hasFeature } from '@favornoms/shared';
import { BranchSettings } from './_components/branch-settings';

interface Props { params: Promise<{ branchId: string }> }

export default async function BranchPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: branch } = await supabase
    .from('branches')
    .select(
      'id, restaurant_id, brand_id, name, address, timezone, theme_override, settings, is_active, custom_domain, sales_tax_rate, geo_lat, geo_lng',
    )
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();
  // The brand this branch actually renders from: its own if linked, otherwise the
  // restaurant's default — the same fallback resolveTenant uses for assets. Null when the
  // restaurant has never created one, which the Branding card handles by creating it.
  const brandQuery = branch.brand_id
    ? supabase
        .from('brands')
        .select('id, name, logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url')
        .eq('id', branch.brand_id)
        .maybeSingle()
    : supabase
        .from('brands')
        .select('id, name, logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url')
        .eq('restaurant_id', branch.restaurant_id)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

  const [{ data: restaurant }, entitlements, { data: brand }] = await Promise.all([
    supabase.from('restaurants').select('name, storefront').eq('id', branch.restaurant_id).maybeSingle(),
    getEntitlementsForBranch(supabase, branchId),
    brandQuery,
  ]);
  return (
    <BranchSettings
      branch={branch as never}
      restaurantStorefront={(restaurant?.storefront ?? null) as Record<string, unknown> | null}
      restaurantName={restaurant?.name ?? 'My restaurant'}
      brand={(brand ?? null) as never}
      canUseDelivery={hasFeature(entitlements, 'delivery')}
      canUseCard={hasFeature(entitlements, 'card_payment')}
    />
  );
}
