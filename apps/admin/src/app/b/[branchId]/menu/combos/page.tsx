import { getServerClient } from '@favornoms/database/server';
import { CombosManager } from './_components/combos-manager';

interface Props {
  params: Promise<{ branchId: string }>;
}

export const metadata = { title: 'Combos · Favornoms admin' };

export default async function CombosPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const [{ data: combos }, { data: menuItems }] = await Promise.all([
    supabase
      .from('combo_sets')
      .select(
        `id, name, description, total_price, image_url, is_active,
         combo_items(menu_item_id, quantity, is_swappable, swap_group)`,
      )
      .eq('branch_id', branchId),
    supabase
      .from('menu_items')
      .select('id, name, price')
      .eq('branch_id', branchId)
      .eq('is_active', true)
      .order('name'),
  ]);

  return (
    <CombosManager
      branchId={branchId}
      initialCombos={(combos ?? []) as never[]}
      menuItems={(menuItems ?? []) as never[]}
    />
  );
}
