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
      'id, restaurant_id, name, address, timezone, theme_override, settings, is_active, custom_domain, sales_tax_rate, geo_lat, geo_lng',
    )
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();
  const [{ data: restaurant }, entitlements] = await Promise.all([
    supabase.from('restaurants').select('storefront').eq('id', branch.restaurant_id).maybeSingle(),
    getEntitlementsForBranch(supabase, branchId),
  ]);
  return (
    <BranchSettings
      branch={branch as never}
      restaurantStorefront={(restaurant?.storefront ?? null) as Record<string, unknown> | null}
      canUseDelivery={hasFeature(entitlements, 'delivery')}
      canUseCard={hasFeature(entitlements, 'card_payment')}
    />
  );
}
