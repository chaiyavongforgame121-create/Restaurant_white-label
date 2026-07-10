import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { BranchSettings } from './_components/branch-settings';

interface Props { params: Promise<{ branchId: string }> }

export default async function BranchPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: branch } = await supabase
    .from('branches')
    .select('id, restaurant_id, name, address, timezone, theme_override, settings, is_active, custom_domain, sales_tax_rate')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('storefront')
    .eq('id', branch.restaurant_id)
    .maybeSingle();
  return (
    <BranchSettings
      branch={branch as never}
      restaurantStorefront={(restaurant?.storefront ?? null) as Record<string, unknown> | null}
    />
  );
}
