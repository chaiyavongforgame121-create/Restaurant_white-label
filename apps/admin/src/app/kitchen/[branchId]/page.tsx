import { listBranchRiders } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { KitchenView } from './_components/kitchen-view';
import { KITCHEN_ORDER_SELECT, toDriverLite, type DriverLite, type SoldOutItem } from './_components/kitchen-model';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ station?: string }>;
}

export default async function KitchenPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const { station } = await searchParams;
  // The layout already refused anyone without kitchen.access; this call is for the finer
  // capabilities the board renders by (and 404s an unknown branch).
  const { supabase, branch, can } = await getBranchAccess(branchId, `/kitchen/${branchId}`);
  // staff_assign_driver and list_branch_riders both require delivery.manage, which the kitchen
  // role does not hold: offering the picker to a cook only ever ended in "can't assign riders".
  const canAssign = can('delivery.manage');

  const [{ data: branchRow }, { data: orders, error: ordersError }, { data: menu }, { data: soldOut }, riders] = await Promise.all([
    supabase.from('branches').select('timezone').eq('id', branchId).maybeSingle(),
    supabase
      .from('orders')
      .select(KITCHEN_ORDER_SELECT)
      .eq('branch_id', branchId)
      .in('status', ['pending', 'confirmed', 'preparing', 'ready'])
      .order('created_at', { ascending: false }), // newest first
    supabase
      .from('menu_items')
      .select('station')
      .eq('branch_id', branchId)
      .not('station', 'is', null),
    // Dishes 86'd at this branch right now, for the board's "Sold out" strip. Only dishes on the
    // menu: an inactive dish is hidden from diners anyway, and "Back on sale" would not show it.
    // (The view's reload() reads the same list again; keep the two in step.)
    supabase
      .from('menu_items')
      .select('id, name, sold_out_until')
      .eq('branch_id', branchId)
      .eq('is_active', true)
      .gt('sold_out_until', new Date().toISOString())
      .order('name'),
    // Per-branch online state comes from list_branch_riders (driver_branch_availability), the
    // same source dispatch reads; drivers.is_online is global and said "online" for a rider who
    // was working another branch.
    canAssign ? listBranchRiders(supabase, branchId).catch(() => []) : Promise.resolve([]),
  ]);
  // A refused read (the select names a column this database does not have yet, a policy error)
  // used to paint an empty, healthy-looking board. The view is told, says so, and keeps asking.
  if (ordersError) console.error('kitchen: orders read failed', ordersError.message);
  const stations = [...new Set((menu ?? []).map((m) => m.station as string).filter(Boolean))].sort();

  const drivers: DriverLite[] = riders.map(toDriverLite);

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
      branchTimezone={branchRow?.timezone ?? null}
      initialOrders={normalizedOrders as never}
      initialReadFailed={ordersError != null}
      stations={stations}
      activeStation={station ?? null}
      drivers={drivers}
      canAssign={canAssign}
      initialSoldOut={(soldOut ?? []) as SoldOutItem[]}
    />
  );
}
