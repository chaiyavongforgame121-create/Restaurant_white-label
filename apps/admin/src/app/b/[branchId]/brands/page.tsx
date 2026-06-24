import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { BrandsManager } from './_components/brands-manager';

interface Props { params: Promise<{ branchId: string }> }

export default async function BrandsPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  const { data: branch } = await supabase
    .from('branches')
    .select('id, restaurant_id, brand_id')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();

  const [brandsRes, branchesRes, restaurantRes] = await Promise.all([
    supabase
      .from('brands')
      .select('id, slug, name, theme, logo_url, is_default, created_at')
      .eq('restaurant_id', branch.restaurant_id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true }),
    supabase
      .from('branches')
      .select('id, name, brand_id, is_active')
      .eq('restaurant_id', branch.restaurant_id)
      .order('created_at', { ascending: true }),
    supabase
      .from('restaurants')
      .select('id, name, loyalty_scope, storefront')
      .eq('id', branch.restaurant_id)
      .maybeSingle(),
  ]);

  return (
    <BrandsManager
      restaurantId={branch.restaurant_id}
      restaurantName={restaurantRes.data?.name ?? 'Restaurant'}
      loyaltyScope={(restaurantRes.data?.loyalty_scope as 'branch' | 'brand') ?? 'branch'}
      currentBranchId={branchId}
      brands={(brandsRes.data ?? []) as never}
      branches={(branchesRes.data ?? []) as never}
      storefront={(restaurantRes.data?.storefront ?? {}) as Record<string, unknown>}
    />
  );
}
