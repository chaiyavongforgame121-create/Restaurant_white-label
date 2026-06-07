import { getServerClient } from '@favornoms/database/server';
import { listCategories, listMenuItems } from '@favornoms/database/queries';
import { MenuManager } from './_components/menu-manager';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function MenuPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const [categories, items] = await Promise.all([
    listCategories(supabase, branchId),
    listMenuItems(supabase, branchId),
  ]);
  return <MenuManager branchId={branchId} categories={categories} items={items} />;
}
