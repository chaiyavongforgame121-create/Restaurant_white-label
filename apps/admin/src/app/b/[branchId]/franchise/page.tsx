import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { FranchiseManager } from './_components/franchise-manager';

interface Props { params: Promise<{ branchId: string }> }

export default async function FranchisePage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: branch } = await supabase
    .from('branches')
    .select('id, restaurant_id')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('id, name, franchise_group_id')
    .eq('id', branch.restaurant_id)
    .maybeSingle();
  return (
    <FranchiseManager
      currentBranchId={branchId}
      restaurantId={branch.restaurant_id}
      restaurantName={restaurant?.name ?? ''}
      currentGroupId={restaurant?.franchise_group_id ?? null}
    />
  );
}
