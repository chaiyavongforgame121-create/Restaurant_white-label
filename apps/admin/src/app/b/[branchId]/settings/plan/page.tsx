import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import {
  getEntitlementsForBranch,
  getPendingBillingRequest,
  listBillingProducts,
} from '@favornoms/database/queries';
import { PlanView } from './_components/plan-view';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ suspended?: string; checkout?: string }>;
}

export const metadata = { title: 'Plan & billing · Favornoms' };

// This page is the escape hatch: the branch layout skips its suspension
// redirect for exactly this path, so a lapsed merchant can always reach it.
export default async function PlanPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  await searchParams; // `?suspended=1` only marks where the redirect came from.
  const supabase = await getServerClient();

  const { data: branch } = await supabase
    .from('branches')
    .select('restaurant_id')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch?.restaurant_id) notFound();

  const [entitlements, catalog, pendingRequest] = await Promise.all([
    getEntitlementsForBranch(supabase, branchId),
    listBillingProducts(supabase),
    getPendingBillingRequest(supabase, branch.restaurant_id),
  ]);

  return (
    <PlanView
      branchId={branchId}
      restaurantId={branch.restaurant_id}
      entitlements={entitlements}
      catalog={catalog}
      pendingRequest={pendingRequest}
      suspended={!entitlements.entitled}
    />
  );
}
