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
      'id, order_number, status, channel, created_at, customer_name, customer_notes, kitchen_notes, held, scheduled_for, table_id, tables(table_number, display_name), order_items(id, item_name, quantity, notes, prep_status, station, modifiers), deliveries(id, status, driver_id, accepted_at, batch_id, batch_seq)',
    )
    .eq('branch_id', branchId)
    .in('status', ['pending', 'confirmed', 'preparing', 'ready'])
    .order('created_at', { ascending: false }); // newest first

  const { data: menu } = await supabase
    .from('menu_items')
    .select('station')
    .eq('branch_id', branchId)
    .not('station', 'is', null);
  const stations = [...new Set((menu ?? []).map((m) => m.station as string).filter(Boolean))].sort();

  // Approved riders for this branch — feeds the kitchen's manual "assign a specific
  // rider" picker. Online riders are surfaced first client-side.
  const { data: driverRows } = await supabase
    .from('driver_approvals')
    .select('driver:drivers(id, full_name, phone, vehicle_type, is_online, cooldown_until)')
    .eq('branch_id', branchId)
    .eq('status', 'approved');
  const drivers = (driverRows ?? [])
    .map((r) => r.driver as unknown as {
      id: string;
      full_name: string;
      phone: string | null;
      vehicle_type: string;
      is_online: boolean;
      cooldown_until: string | null;
    })
    .filter((d) => d && d.id);

  // PostgREST returns the one-to-one deliveries embed as a single object (or null),
  // but the client expects an array (order.deliveries[0]) — normalise it so the
  // dispatch status + manual-assign picker work on first paint, not just after a
  // realtime update.
  const normalizedOrders = (orders ?? []).map((o) => {
    const del = (o as { deliveries?: unknown }).deliveries;
    return { ...o, deliveries: del == null ? [] : Array.isArray(del) ? del : [del] };
  });

  return (
    <KitchenView
      branchId={branchId}
      branchName={branch.name}
      initialOrders={normalizedOrders as never}
      stations={stations}
      activeStation={station ?? null}
      drivers={drivers}
    />
  );
}
