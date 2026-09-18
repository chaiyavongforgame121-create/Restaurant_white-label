import { Receipt } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
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
  const t = await getTranslations('orders');
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
  // merely opening the page would write a customers row. Scoped by branch_id
  // because each branch keeps its own record of the diner
  // (customers_branch_user_uidx): this branch's orders hang off this branch's row.
  const customerId = user
    ? (
        await supabase
          .from('customers')
          .select('id')
          .eq('user_id', user.id)
          .eq('branch_id', tenant.branch.id)
          .maybeSingle()
      ).data?.id ?? null
    : null;

  const { data: orders, error: ordersError } = customerId
    ? await supabase
        .from('orders')
        .select(
          'id, order_number, total, status, channel, created_at, order_items(id, menu_item_id, combo_id, item_name, quantity, notes, modifiers)',
        )
        .eq('customer_id', customerId)
        .eq('branch_id', tenant.branch.id)
        .order('created_at', { ascending: false })
        .limit(20)
    : { data: null, error: null };

  // A failed query must NOT read as "No orders yet" — that is what made a just-placed
  // order look missing when the request errored (auth mid-refresh, a slow cold DB). Tell
  // the diner it couldn't load and let them retry, rather than telling them they have none.
  if (ordersError) {
    return (
      <div className="container pt-6">
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        <EmptyState
          icon={<Receipt className="h-7 w-7" />}
          title={t('loadError.title')}
          description={t('loadError.description')}
        />
      </div>
    );
  }

  if (!orders || orders.length === 0) {
    return (
      <div className="container pt-6">
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        <EmptyState
          icon={<Receipt className="h-7 w-7" />}
          title={t('empty.title')}
          description={user ? t('empty.signedIn') : t('empty.guest')}
        />
      </div>
    );
  }

  return <OrdersList orders={orders as never[]} base={base} branchId={tenant.branch.id} />;
}
