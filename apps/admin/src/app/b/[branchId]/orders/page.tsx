import { getServerClient } from '@favornoms/database/server';
import { formatCurrency } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';
import { OrderRowActions } from './_components/order-row-actions';
import { OrderFilters } from './_components/order-filters';
import { DeliveryIssues, type DeliveryIssue } from './_components/delivery-issues';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ q?: string; status?: string; channel?: string }>;
}

const statusVariant = (status: string) => {
  if (['pending'].includes(status)) return 'muted';
  if (['confirmed', 'preparing'].includes(status)) return 'warning';
  if (['ready', 'out_for_delivery'].includes(status)) return 'default';
  if (status === 'completed') return 'success';
  return 'danger';
};

export default async function OrdersPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const { q, status, channel } = await searchParams;
  const supabase = await getServerClient();

  let query = supabase
    .from('orders')
    .select('id, order_number, channel, status, total, customer_name, customer_phone, created_at')
    .eq('branch_id', branchId);

  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    query = query.or(
      `order_number.ilike.${term},customer_name.ilike.${term},customer_phone.ilike.${term}`,
    );
  }
  if (status && status !== 'all') query = query.eq('status', status);
  if (channel && channel !== 'all') query = query.eq('channel', channel);

  const { data: orders } = await query.order('created_at', { ascending: false }).limit(100);

  // Failed deliveries that need staff attention (re-dispatch or refund).
  const { data: failedRows } = await supabase
    .from('deliveries')
    .select('id, order_id, failed_reason, failed_photo_url, orders!inner(order_number, customer_name, customer_phone)')
    .eq('branch_id', branchId)
    .eq('status', 'failed')
    .limit(20);
  const issues: DeliveryIssue[] = (failedRows ?? []).map((d) => {
    const o = (Array.isArray(d.orders) ? d.orders[0] : d.orders) as {
      order_number: string;
      customer_name: string | null;
      customer_phone: string | null;
    };
    return {
      id: d.id,
      order_id: d.order_id,
      failed_reason: d.failed_reason,
      failed_photo_url: d.failed_photo_url,
      order_number: o?.order_number ?? '—',
      customer_name: o?.customer_name ?? null,
      customer_phone: o?.customer_phone ?? null,
    };
  });

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Orders</h1>
        <p className="mt-1 text-muted-foreground">{orders?.length ?? 0} matching</p>
      </header>

      <div className="px-2 lg:px-0">
        <DeliveryIssues issues={issues} />
      </div>

      <div className="mb-4 px-2 lg:px-0">
        <OrderFilters defaultQ={q ?? ''} defaultStatus={status ?? 'all'} defaultChannel={channel ?? 'all'} />
      </div>

      {/* Desktop table */}
      <Card className="hidden overflow-hidden md:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-5 py-3">Order #</th>
              <th className="px-5 py-3">Channel</th>
              <th className="px-5 py-3">Customer</th>
              <th className="px-5 py-3">Created</th>
              <th className="px-5 py-3 text-right">Total</th>
              <th className="px-5 py-3 text-center">Status</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody>
            {(orders ?? []).map((o) => (
              <tr key={o.id} className="border-t border-border/40 hover:bg-muted/30">
                <td className="px-5 py-3 font-mono text-xs">{o.order_number}</td>
                <td className="px-5 py-3 capitalize">{o.channel.replace('_', ' ')}</td>
                <td className="px-5 py-3">
                  <div>
                    <p className="font-medium">{o.customer_name ?? '—'}</p>
                    <p className="text-xs text-muted-foreground">{o.customer_phone ?? ''}</p>
                  </div>
                </td>
                <td className="px-5 py-3 text-muted-foreground">
                  {new Date(o.created_at).toLocaleString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    month: 'short',
                    day: 'numeric',
                  })}
                </td>
                <td className="px-5 py-3 text-right font-display text-base font-semibold text-primary">
                  {formatCurrency(Number(o.total))}
                </td>
                <td className="px-5 py-3 text-center">
                  <Badge variant={statusVariant(o.status) as never}>{o.status.replace('_', ' ')}</Badge>
                </td>
                <td className="px-5 py-3">
                  <OrderRowActions
                    orderId={o.id}
                    orderTotal={Number(o.total)}
                    orderStatus={o.status}
                  />
                </td>
              </tr>
            ))}
            {(!orders || orders.length === 0) && (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
                  No orders match your filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Mobile cards */}
      <ul className="space-y-3 px-2 md:hidden">
        {(orders ?? []).map((o) => (
          <li key={o.id}>
            <Card className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-xs text-muted-foreground">{o.order_number}</p>
                  <p className="mt-1 font-semibold">{o.customer_name ?? 'Walk-in'}</p>
                  <p className="text-xs text-muted-foreground capitalize">{o.channel.replace('_', ' ')}</p>
                </div>
                <div className="text-right">
                  <p className="font-display text-lg font-bold text-primary">
                    {formatCurrency(Number(o.total))}
                  </p>
                  <Badge variant={statusVariant(o.status) as never} className="mt-1">
                    {o.status.replace('_', ' ')}
                  </Badge>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
