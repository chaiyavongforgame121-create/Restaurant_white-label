import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { getEntitlementsForBranch, listCategories, listMenuItems } from '@favornoms/database/queries';
import { hasFeature } from '@favornoms/shared';
import { PosView } from './_components/pos-view';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function PosPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: branch } = await supabase
    .from('branches')
    .select('id, name')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();
  const [categories, items, entitlements] = await Promise.all([
    listCategories(supabase, branchId),
    listMenuItems(supabase, branchId),
    getEntitlementsForBranch(supabase, branchId),
  ]);
  return (
    <PosView
      branchId={branchId}
      branchName={branch.name}
      categories={categories}
      items={items}
      canUseCard={hasFeature(entitlements, 'card_payment')}
      canDeliver={hasFeature(entitlements, 'delivery')}
    />
  );
}
