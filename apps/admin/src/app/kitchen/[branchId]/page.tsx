import { getServerClient } from '@favornoms/database/server';
import { notFound } from 'next/navigation';
import { KitchenView } from './_components/kitchen-view';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ station?: string }>;
}

export default async function KitchenPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const { station } = await searchParams;
  const supabase = await getServerClient();

  const { data: branch } = await supabase
    .from('branches')
    .select('id, name')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();

  const { data: orders } = await supabase
    .from('orders')
    .select(
      'id, order_number, status, channel, created_at, customer_name, customer_notes, kitchen_notes, held, scheduled_for, table_id, tables(table_number, display_name), order_items(id, item_name, quantity, notes, prep_status, station, modifiers), deliveries(status, driver_id, accepted_at)',
    )
    .eq('branch_id', branchId)
    .in('status', ['pending', 'confirmed', 'preparing', 'ready'])
    .order('created_at', { ascending: true });

  const { data: menu } = await supabase
    .from('menu_items')
    .select('station')
    .eq('branch_id', branchId)
    .not('station', 'is', null);
  const stations = [...new Set((menu ?? []).map((m) => m.station as string).filter(Boolean))].sort();

  return (
    <KitchenView
      branchId={branchId}
      branchName={branch.name}
      initialOrders={(orders ?? []) as never}
      stations={stations}
      activeStation={station ?? null}
    />
  );
}
