import { getServerClient } from '@favornoms/database/server';
import { RecentOrders } from './_components/recent-orders';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function RecentOrdersPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_number, status, total, customer_name, created_at, channel')
    .eq('branch_id', branchId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50);

  return <RecentOrders branchId={branchId} orders={(orders ?? []) as never[]} />;
}
