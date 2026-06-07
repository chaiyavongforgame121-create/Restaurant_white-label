import { getServerClient } from '@favornoms/database/server';
import { notFound } from 'next/navigation';
import { KdsView } from './_components/kds-view';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ station?: string }>;
}

export default async function KdsBranchPage({ params, searchParams }: Props) {
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
      'id, order_number, status, channel, created_at, customer_name, customer_notes, order_items(id, item_name, quantity, notes, prep_status, station)',
    )
    .eq('branch_id', branchId)
    .in('status', ['confirmed', 'preparing', 'ready'])
    .order('created_at', { ascending: true });

  // Discover distinct stations on this branch (from menu_items)
  const { data: menu } = await supabase
    .from('menu_items')
    .select('station')
    .eq('branch_id', branchId)
    .not('station', 'is', null);
  const stations = [...new Set((menu ?? []).map((m) => m.station as string).filter(Boolean))].sort();

  return (
    <KdsView
      branchId={branchId}
      branchName={branch.name}
      initialOrders={(orders ?? []) as never}
      stations={stations}
      activeStation={station ?? null}
    />
  );
}
