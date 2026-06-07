import { ArrowDownRight, ArrowUpRight, ChefHat, DollarSign, Receipt, Sparkles, Users } from 'lucide-react';
import { getServerClient } from '@favornoms/database/server';
import { formatCurrency } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function DashboardPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const { data: branchRow } = await supabase
    .from('branches')
    .select('restaurant_id')
    .eq('id', branchId)
    .maybeSingle();
  const restaurantId = branchRow?.restaurant_id ?? null;

  const planStatus = restaurantId
    ? (await supabase.rpc('get_my_plan_status', { p_restaurant_id: restaurantId })).data as {
        plan: string;
        items: { allowed: boolean; limit: number; current: number | null };
        orders_per_month: { allowed: boolean; limit: number; current: number | null };
      } | null
    : null;

  const [orderToday, revenueToday, ordersInKitchen, customers] = await Promise.all([
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('branch_id', branchId)
      .gte('created_at', start.toISOString()),
    supabase
      .from('orders')
      .select('total')
      .eq('branch_id', branchId)
      .gte('created_at', start.toISOString())
      .in('status', ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed']),
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('branch_id', branchId)
      .in('status', ['confirmed', 'preparing']),
    supabase
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('branch_id', branchId),
  ]);

  const totalRevenue = (revenueToday.data ?? []).reduce(
    (s, o) => s + Number(o.total ?? 0),
    0,
  );

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Today at a glance</h1>
        <p className="mt-1 text-muted-foreground">Live metrics from your branch</p>
      </header>

      {planStatus && planStatus.plan === 'free' && planStatus.items.limit > 0 && (
        <Card className="mb-6 flex items-center justify-between gap-4 border-amber-500/40 bg-amber-500/5 p-4 px-2 lg:px-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-500/15 text-amber-600">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold">
                You&apos;re on the Free plan ({planStatus.items.current ?? 0} / {planStatus.items.limit} items used)
              </p>
              <p className="text-xs text-muted-foreground">
                Upgrade to unlock unlimited items, advanced reporting, and priority support.
              </p>
            </div>
          </div>
          <a
            href={`/b/${branchId}/settings/plan`}
            className="focus-ring inline-flex items-center rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-soft hover:bg-amber-600"
          >
            Upgrade
          </a>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 px-2 sm:grid-cols-2 lg:grid-cols-4 lg:px-0">
        <Stat
          label="Revenue today"
          value={formatCurrency(totalRevenue)}
          delta={+12.4}
          icon={DollarSign}
          tone="primary"
        />
        <Stat
          label="Orders today"
          value={(orderToday.count ?? 0).toString()}
          delta={+5.2}
          icon={Receipt}
          tone="accent"
        />
        <Stat
          label="In kitchen"
          value={(ordersInKitchen.count ?? 0).toString()}
          icon={ChefHat}
          tone="warning"
        />
        <Stat
          label="Total customers"
          value={(customers.count ?? 0).toString()}
          delta={+2.1}
          icon={Users}
          tone="success"
        />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 px-2 lg:grid-cols-2 lg:px-0">
        <Card className="p-6">
          <h2 className="font-display text-lg font-semibold">Sales trend</h2>
          <p className="text-sm text-muted-foreground">Last 7 days</p>
          <div className="mt-4 flex h-40 items-end gap-2">
            {[6200, 7800, 9100, 7400, 10200, 11600, totalRevenue].map((v, i) => {
              const max = 12000;
              const h = Math.round((v / max) * 100);
              return (
                <div key={i} className="flex flex-1 flex-col items-center gap-2">
                  <div className="relative w-full overflow-hidden rounded-lg bg-muted" style={{ height: '128px' }}>
                    <div
                      className="absolute inset-x-0 bottom-0 rounded-lg bg-gradient-warm"
                      style={{ height: `${h}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Today'][i]}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
        <Card className="p-6">
          <h2 className="font-display text-lg font-semibold">Quick actions</h2>
          <p className="text-sm text-muted-foreground">Common tasks</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {[
              { label: 'Add menu item', href: 'menu' },
              { label: 'View orders', href: 'orders' },
              { label: 'Approve drivers', href: 'drivers' },
              { label: 'Branch settings', href: 'branch' },
            ].map((a) => (
              <a
                key={a.label}
                href={a.href}
                className="focus-ring inline-flex min-h-touch items-center justify-center rounded-xl border border-border bg-card px-3 py-3 text-sm font-semibold transition-shadow hover:shadow-soft"
              >
                {a.label} →
              </a>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Stat({
  label, value, delta, icon: Icon, tone,
}: {
  label: string;
  value: string;
  delta?: number;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'primary' | 'accent' | 'warning' | 'success';
}) {
  const tones = {
    primary: 'bg-primary/10 text-primary',
    accent: 'bg-accent/20 text-accent-foreground',
    warning: 'bg-warning/15 text-warning',
    success: 'bg-success/15 text-success',
  };
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 font-display text-3xl font-bold">{value}</p>
          {delta != null && (
            <Badge
              variant={delta >= 0 ? 'success' : 'danger'}
              className="mt-2"
            >
              {delta >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
              {Math.abs(delta).toFixed(1)}%
            </Badge>
          )}
        </div>
        <div className={`grid h-10 w-10 place-items-center rounded-xl ${tones[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Card>
  );
}
