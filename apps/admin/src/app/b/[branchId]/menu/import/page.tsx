import { listCategories } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { PageAccessDenied } from '@/components/page-access-denied';
import { MenuImportView } from './_components/menu-import-view';

interface Props { params: Promise<{ branchId: string }> }

export default async function MenuImportPage({ params }: Props) {
  const { branchId } = await params;
  // An import writes the whole menu at once: the menu editor's own gate.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/menu/import`);
  if (!can('menu.manage')) return <PageAccessDenied area="menu" branchName={branch.name} />;
  const categories = await listCategories(supabase, branchId);
  return <MenuImportView branchId={branchId} categories={categories} />;
}
