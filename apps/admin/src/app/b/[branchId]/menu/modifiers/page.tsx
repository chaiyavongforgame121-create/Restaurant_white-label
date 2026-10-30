import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getBranchAccess } from '@/lib/capabilities';
import { PageAccessDenied } from '@/components/page-access-denied';
import { ModifiersManager } from './_components/modifiers-manager';

interface Props {
  params: Promise<{ branchId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('menuExtras');
  return { title: t('modifiers.metaTitle') };
}

export default async function ModifiersPage({ params }: Props) {
  const { branchId } = await params;
  // The same gate as the menu itself: option groups are menu editing.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/menu/modifiers`);
  if (!can('menu.manage')) return <PageAccessDenied area="menu" branchName={branch.name} />;
  const [{ data: groups }, { data: menuItems }] = await Promise.all([
    supabase
      .from('modifier_groups')
      .select(
        `id, name, min_select, max_select, is_required, selection_type, display_order, created_at,
         modifier_options(id, name, price_delta, is_default, is_active, display_order, created_at)`,
      )
      .eq('branch_id', branchId)
      // The library only. A dish's own copy of a group, or a group made in its editor, belongs to
      // that dish and is edited there.
      .is('owner_menu_item_id', null)
      .order('display_order'),
    supabase
      .from('menu_items')
      // A linked group's source_group_id marks the dish's own copy of a library group, and says which.
      .select('id, name, menu_item_modifiers(modifier_group_id, modifier_groups(source_group_id))')
      .eq('branch_id', branchId)
      .eq('is_active', true)
      .order('name'),
  ]);

  return (
    <ModifiersManager
      branchId={branchId}
      initialGroups={(groups ?? []) as never[]}
      menuItems={(menuItems ?? []) as never[]}
    />
  );
}
