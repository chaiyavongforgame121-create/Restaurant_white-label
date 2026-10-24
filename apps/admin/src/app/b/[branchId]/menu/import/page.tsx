import { listCategories, listKitchenStations } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { PageAccessDenied } from '@/components/page-access-denied';
import { MenuImportView } from './_components/menu-import-view';

interface Props { params: Promise<{ branchId: string }> }

export default async function MenuImportPage({ params }: Props) {
  const { branchId } = await params;
  // An import writes the whole menu at once: the menu editor's own gate.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/menu/import`);
  if (!can('menu.manage')) return <PageAccessDenied area="menu" branchName={branch.name} />;
  const [categories, stations] = await Promise.all([
    listCategories(supabase, branchId),
    // Only for the preview of the stations an import would add: the import itself reads them
    // again, so a failed read here costs the preview, not the page.
    listKitchenStations(supabase, branchId).catch((err) => {
      console.error('[menu-import] stations read failed', err);
      return [];
    }),
  ]);
  return <MenuImportView branchId={branchId} categories={categories} stations={stations} />;
}
