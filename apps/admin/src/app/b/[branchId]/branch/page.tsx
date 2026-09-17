import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
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
      'id, restaurant_id, brand_id, name, address, timezone, theme_override, settings, is_active, custom_domain, sales_tax_rate, geo_lat, geo_lng, logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url, app_icon',
    )
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();
  // The brand this branch renders from: its own if linked, otherwise the restaurant's default —
  // the same ladder resolveTenant uses. Read only for the Branding card's preview: its name is the
  // first half of "<brand> - <branch>", and its logo and icon are what a branch with none of its
  // own falls back to. The card never writes it.
  const brandQuery = branch.brand_id
    ? supabase
        .from('brands')
        .select('name, logo_url, favicon_url, icon_192_url')
        .eq('id', branch.brand_id)
        .maybeSingle()
    : supabase
        .from('brands')
        .select('name, logo_url, favicon_url, icon_192_url')
        .eq('restaurant_id', branch.restaurant_id)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

  const [{ data: restaurant }, entitlements, { data: brand }, t] = await Promise.all([
    supabase.from('restaurants').select('name, storefront').eq('id', branch.restaurant_id).maybeSingle(),
    getEntitlementsForBranch(supabase, branchId),
    brandQuery,
    getTranslations('branch'),
  ]);
  return (
    <BranchSettings
      branch={branch as never}
      restaurantStorefront={(restaurant?.storefront ?? null) as Record<string, unknown> | null}
      branding={{
        brandName: brand?.name?.trim() || restaurant?.name?.trim() || t('defaultRestaurantName'),
        identity: {
          logo_url: branch.logo_url,
          favicon_url: branch.favicon_url,
          icon_192_url: branch.icon_192_url,
          icon_512_url: branch.icon_512_url,
          icon_maskable_512_url: branch.icon_maskable_512_url,
          app_icon: branch.app_icon,
        },
        brandDefaults: {
          logoUrl: brand?.logo_url || null,
          iconUrl: brand?.icon_192_url || brand?.favicon_url || null,
        },
      }}
      canUseDelivery={hasFeature(entitlements, 'delivery')}
      canUseCard={hasFeature(entitlements, 'card_payment')}
    />
  );
}
