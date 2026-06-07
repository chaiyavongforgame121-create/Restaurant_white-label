import { getServerClient } from '@favornoms/database/server';
import { formatCurrency } from '@favornoms/shared';
import { Card, EmptyState } from '@favornoms/ui';
import { UserRound } from 'lucide-react';

interface Props { params: Promise<{ branchId: string }> }

export default async function CustomersPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: customers } = await supabase
    .from('customers')
    .select('id, full_name, phone, total_orders, total_spent, last_order_at')
    .eq('branch_id', branchId)
    .order('total_spent', { ascending: false })
    .limit(100);

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Customers</h1>
        <p className="mt-1 text-muted-foreground">{customers?.length ?? 0} customers at this branch</p>
      </header>
      {(!customers || customers.length === 0) ? (
        <EmptyState
          icon={<UserRound className="h-7 w-7" />}
          title="No customers yet"
          description="Once people order via the customer web app they'll appear here."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-5 py-3">Name</th>
                <th className="px-5 py-3">Phone</th>
                <th className="px-5 py-3 text-right">Orders</th>
                <th className="px-5 py-3 text-right">Lifetime spend</th>
                <th className="px-5 py-3">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-t border-border/40 hover:bg-muted/30">
                  <td className="px-5 py-3 font-medium">{c.full_name ?? '—'}</td>
                  <td className="px-5 py-3">{c.phone}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{c.total_orders}</td>
                  <td className="px-5 py-3 text-right font-semibold text-primary">
                    {formatCurrency(Number(c.total_spent))}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {c.last_order_at ? new Date(c.last_order_at).toLocaleDateString() : 'Never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}
    </div>
  );
}
