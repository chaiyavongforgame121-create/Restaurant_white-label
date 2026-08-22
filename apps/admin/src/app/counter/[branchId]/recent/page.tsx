import { getServerClient } from '@favornoms/database/server';
import { RecentOrders } from './_components/recent-orders';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function RecentOrdersPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // A pickup ordered three days ago for today is the counter's problem today, so
  // a flat 24h floor on created_at hid exactly the orders staff most need to see.
  // Keep it in the list while its scheduled slot is recent or still ahead.
  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_number, status, total, customer_name, created_at, channel, scheduled_for, held')
    .eq('branch_id', branchId)
    .or(`created_at.gte.${since},scheduled_for.gte.${since}`)
    .order('created_at', { ascending: false })
    .limit(50);

  // Order by the time the food is wanted, not the time it was typed in, so a
  // pre-order sits among today's tickets instead of at the bottom of the page.
  const sorted = [...(orders ?? [])].sort(
    (a, b) =>
      new Date(b.scheduled_for ?? b.created_at).getTime() -
      new Date(a.scheduled_for ?? a.created_at).getTime(),
  );

  return <RecentOrders branchId={branchId} orders={sorted as never[]} />;
}
