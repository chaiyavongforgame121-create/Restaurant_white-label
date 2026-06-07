import { getServerClient } from '@favornoms/database/server';
import { listCategories } from '@favornoms/database/queries';
import { MenuImportView } from './_components/menu-import-view';

interface Props { params: Promise<{ branchId: string }> }

export default async function MenuImportPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const categories = await listCategories(supabase, branchId);
  return <MenuImportView branchId={branchId} categories={categories} />;
}
