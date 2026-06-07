import { getServerClient } from '@favornoms/database/server';
import { ModifiersManager } from './_components/modifiers-manager';

interface Props {
  params: Promise<{ branchId: string }>;
}

export const metadata = { title: 'Modifiers · Favornoms admin' };

export default async function ModifiersPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const [{ data: groups }, { data: menuItems }] = await Promise.all([
    supabase
      .from('modifier_groups')
      .select(
        `id, name, min_select, max_select, is_required, selection_type, display_order,
         modifier_options(id, name, price_delta, is_default, is_active, display_order)`,
      )
      .eq('branch_id', branchId)
      .order('display_order'),
    supabase
      .from('menu_items')
      .select('id, name, menu_item_modifiers(modifier_group_id)')
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
