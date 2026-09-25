import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { getEntitlementsForBranch, listCategories, listMenuItems } from '@favornoms/database/queries';
import { hasFeature, sortItemsInMenuOrder } from '@favornoms/shared';
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
  const [categories, unsortedItems, entitlements] = await Promise.all([
    listCategories(supabase, branchId),
    listMenuItems(supabase, branchId),
    getEntitlementsForBranch(supabase, branchId),
  ]);
  // In the admin's order: category by category, then dish by dish. display_order is a position
  // inside a category, so listing by it alone interleaved every category's first dishes.
  const items = sortItemsInMenuOrder(unsortedItems, categories);
  return (
    <PosView
      branchId={branchId}
      branchName={branch.name}
      categories={categories}
      items={items}
      canUseCard={hasFeature(entitlements, 'card_payment')}
      // getEntitlementsForBranch resolves the payload FOR this branch, so this is "THIS
      // branch delivers" — delivery is bought per branch (docs/PACKAGING-2026-09-23.md §2).
      canDeliver={hasFeature(entitlements, 'delivery')}
    />
  );
}
