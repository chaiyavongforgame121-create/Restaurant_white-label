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
  const { data: { user } } = await supabase.auth.getUser();

  // Resolve the diner's own customer row, then filter on it explicitly.
  //
  // RLS is NOT the boundary here. Policies are OR'd, and `orders` carries
  // `orders_staff` USING (branch_id IN private.user_branch_ids()) for cmd=ALL,
  // which covers SELECT — so a branch-filtered query run by an owner, a staff
  // member, or a platform admin returned every diner's orders on this page,
  // under the heading "Your orders", with a Reorder button that loaded a
  // stranger's basket into the cart.
  //
  // Read-only on purpose: this must not call get_or_create_my_customer, or
  // merely opening the page would write a customers row. Scoped by
  // restaurant_id because identity is per restaurant
  // (customers_restaurant_user_uidx), not per branch.
  const customerId = user
    ? (
        await supabase
          .from('customers')
          .select('id')
          .eq('user_id', user.id)
          .eq('restaurant_id', tenant.restaurant.id)
          .maybeSingle()
      ).data?.id ?? null
    : null;

  const { data: orders } = customerId
    ? await supabase
        .from('orders')
        .select(
          'id, order_number, total, status, channel, created_at, order_items(id, menu_item_id, combo_id, item_name, quantity, notes, modifiers)',
        )
        .eq('customer_id', customerId)
        .eq('branch_id', tenant.branch.id)
        .order('created_at', { ascending: false })
        .limit(20)
    : { data: null };

  if (!orders || orders.length === 0) {
    return (
      <div className="container pt-6">
        <h1 className="font-display text-2xl font-bold">Your orders</h1>
        <EmptyState
          icon={<Receipt className="h-7 w-7" />}
          title="No orders yet"
          description={user
            ? 'Order something tasty and it will show up here'
            : 'Your past and active orders will appear here once you sign in'}
        />
      </div>
    );
  }

  return <OrdersList orders={orders as never[]} base={base} branchId={tenant.branch.id} />;
}
