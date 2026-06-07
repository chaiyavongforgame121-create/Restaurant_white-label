import { getServerClient } from '@favornoms/database/server';
import { InventoryView } from './_components/inventory-view';

interface Props {
  params: Promise<{ branchId: string }>;
}

export const metadata = { title: 'Inventory · Favornoms admin' };

export default async function InventoryPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const [{ data: items }, { data: lowStock }, { data: restocks }, { data: waste }] = await Promise.all([
    supabase
      .from('menu_items')
      .select('id, name, image_url, price, track_stock, stock_quantity, low_stock_threshold, is_active')
      .eq('branch_id', branchId)
      .order('name'),
    supabase
      .from('v_low_stock_items')
      .select('id, name, stock_quantity, low_stock_threshold')
      .eq('branch_id', branchId),
    supabase
      .from('restock_log')
      .select('id, menu_item_id, delta, cost_per_unit, supplier, notes, created_at')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('waste_log')
      .select('id, menu_item_id, quantity, reason, notes, created_at')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  return (
    <InventoryView
      branchId={branchId}
      items={(items ?? []) as never[]}
      lowStock={(lowStock ?? []) as never[]}
      restocks={(restocks ?? []) as never[]}
      waste={(waste ?? []) as never[]}
    />
  );
}
