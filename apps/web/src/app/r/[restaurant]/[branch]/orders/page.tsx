import { Receipt } from 'lucide-react';
import { EmptyState } from '@favornoms/ui';
import { getServerClient } from '@favornoms/database/server';
import { resolveTenant } from '@/lib/tenant';
import { OrdersList } from './_components/orders-list';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export const dynamic = 'force-dynamic';

export default async function OrdersPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const base = `/r/${restaurant}/${branch}`;

  const supabase = await getServerClient();
  const { data: orders } = await supabase
    .from('orders')
    .select(
      'id, order_number, total, status, created_at, order_items(id, menu_item_id, item_name, quantity)',
    )
    .eq('branch_id', tenant.branch.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (!orders || orders.length === 0) {
    return (
      <div className="container pt-6">
        <h1 className="font-display text-2xl font-bold">Your orders</h1>
        <EmptyState
          icon={<Receipt className="h-7 w-7" />}
          title="No orders yet"
          description="Your past and active orders will appear here once you sign in"
        />
      </div>
    );
  }

  return <OrdersList orders={orders as never[]} base={base} branchId={tenant.branch.id} />;
}
