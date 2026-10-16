import { getBranchAccess } from '@/lib/capabilities';
import { PageAccessDenied } from '@/components/page-access-denied';
import { FranchiseManager } from './_components/franchise-manager';

interface Props { params: Promise<{ branchId: string }> }

export default async function FranchisePage({ params }: Props) {
  const { branchId } = await params;
  // Joining or running a franchise group speaks for the whole restaurant: hq.view, the owner's,
  // which the sidebar entry has always asked for. The page relied on the RPCs refusing.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/franchise`);
  if (!can('hq.view')) return <PageAccessDenied area="franchise" branchName={branch.name} />;
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
