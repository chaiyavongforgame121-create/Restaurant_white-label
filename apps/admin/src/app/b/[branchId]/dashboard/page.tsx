import { ArrowDownRight, ArrowUpRight, ChefHat, DollarSign, Receipt, Sparkles, Users } from 'lucide-react';
import { getServerClient } from '@favornoms/database/server';
import { getEntitlementsForBranch } from '@favornoms/database/queries';
import { formatCurrency, trialDaysLeft } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function DashboardPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  // No item cap and no orders/month cap exist any more (owner decision
  // 2026-07-25), so the old "10/30 items used" nag is gone. What is worth
  // surfacing here is the trial clock — it is the only thing that expires.
  const entitlements = await getEntitlementsForBranch(supabase, branchId);
  const trialDays = trialDaysLeft(entitlements);

  const now = Date.now();
  const yesterdaySameTime = now - 24 * 60 * 60 * 1000;

  const [branch, weekOrders, ordersInKitchen, customers] = await Promise.all([
    supabase.from('branches').select('timezone').eq('id', branchId).maybeSingle(),
    // Eight days, not seven: the branch's local day can start up to a day away
    // from the server's, and over-fetching one day is cheaper than a wrong bar.
    supabase
      .from('orders')
      .select('created_at, total, status')
      .eq('branch_id', branchId)
      .gte('created_at', new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString()),
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

  // "Today" has to mean the branch's today. This used to bucket on the server's
  // clock, so a New York merchant on a UTC host watched their day roll over at
  // 8pm — mid-dinner-service.
  const tz = branch.data?.timezone ?? 'America/New_York';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dayKey = (d: Date) => fmt.format(d);

  const earning = (s: string | null) =>
    ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed'].includes(s ?? '');

  // Date arithmetic at noon UTC on the branch's calendar date: stepping whole
  // days from midday can't be pushed across a boundary by a DST shift.
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const anchor = new Date(`${dayKey(new Date(now))}T12:00:00Z`);
  const trend: { key: string; label: string; revenue: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() - i);
    trend.push({
      key: d.toISOString().slice(0, 10),
      label: i === 0 ? 'Today' : DOW[d.getUTCDay()] ?? '',
      revenue: 0,
    });
  }
  const todayKey = trend[6]?.key ?? '';
  const yesterdayKey = trend[5]?.key ?? '';

  let todayOrders = 0;
  let yOrders = 0;
  let yRevenue = 0;
  for (const o of weekOrders.data ?? []) {
    const at = new Date(o.created_at as string);
    const key = dayKey(at);
    const bucket = trend.find((t) => t.key === key);
    if (bucket && earning(o.status as string)) bucket.revenue += Number(o.total ?? 0);
    if (key === todayKey) todayOrders += 1;
    // Same clock time yesterday, not all of yesterday: comparing a morning's
    // takings against a full previous day shows a red arrow until late afternoon.
    if (key === yesterdayKey && at.getTime() < yesterdaySameTime) {
      yOrders += 1;
      if (earning(o.status as string)) yRevenue += Number(o.total ?? 0);
    }
  }
  const totalRevenue = trend[6]?.revenue ?? 0;
  const trendMax = Math.max(1, ...trend.map((t) => t.revenue));

  // undefined, not 0, when there is no baseline: "+0.0%" against a day with no
  // trade is a number the merchant would act on, and it means nothing.
  const delta = (a: number, prev: number) => (prev > 0 ? ((a - prev) / prev) * 100 : undefined);

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Today at a glance</h1>
        <p className="mt-1 text-muted-foreground">Live metrics from your branch</p>
      </header>

      {trialDays !== null && (
        <Card className="mb-6 flex items-center justify-between gap-4 border-amber-500/40 bg-amber-500/5 p-4 px-2 lg:px-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-500/15 text-amber-600">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold">
                {trialDays === 0
                  ? 'Your free trial ends today'
                  : `${trialDays} day${trialDays === 1 ? '' : 's'} left in your free trial`}
              </p>
              <p className="text-xs text-muted-foreground">
                Everything is unlocked. Choose a package to keep it — no card needed until then.
              </p>
            </div>
          </div>
          <a
            href={`/b/${branchId}/settings/plan`}
            className="focus-ring inline-flex items-center rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-soft hover:bg-amber-600"
          >
            Choose a package
          </a>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 px-2 sm:grid-cols-2 lg:grid-cols-4 lg:px-0">
        {/* Deltas compare today-so-far with the same hours yesterday. They used
            to be the literals +12.4 / +5.2 / +2.1 on every branch, every day. */}
        <Stat
          label="Revenue today"
          value={formatCurrency(totalRevenue)}
          delta={delta(totalRevenue, yRevenue)}
          deltaLabel="vs same time yesterday"
          icon={DollarSign}
          tone="primary"
        />
        <Stat
          label="Orders today"
          value={todayOrders.toString()}
          delta={delta(todayOrders, yOrders)}
          deltaLabel="vs same time yesterday"
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
          icon={Users}
          tone="success"
        />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 px-2 lg:grid-cols-2 lg:px-0">
        <Card className="p-6">
          <h2 className="font-display text-lg font-semibold">Sales trend</h2>
          <p className="text-sm text-muted-foreground">Last 7 days</p>
          {/* Real revenue per day. This was a fixed array of made-up figures
              (6200, 7800, 9100 …) that every branch saw as its own trade, with
              weekday labels that never matched the actual days either. */}
          <div className="mt-4 flex h-40 items-end gap-2">
            {trend.map((t) => {
              const h = Math.round((t.revenue / trendMax) * 100);
              return (
                <div key={t.key} className="flex flex-1 flex-col items-center gap-2">
                  <div
                    className="relative w-full overflow-hidden rounded-lg bg-muted"
                    style={{ height: '128px' }}
                    title={`${t.label} · ${formatCurrency(t.revenue)}`}
                  >
                    <div
                      className="absolute inset-x-0 bottom-0 rounded-lg bg-gradient-warm"
                      style={{ height: `${h}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground">{t.label}</span>
                </div>
              );
            })}
          </div>
          {trendMax === 1 && (
            <p className="mt-2 text-xs text-muted-foreground">No sales in the last 7 days yet.</p>
          )}
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
  label, value, delta, deltaLabel, icon: Icon, tone,
}: {
  label: string;
  value: string;
  /** undefined when there is no baseline to compare against — the badge then
   *  hides rather than claiming 0%. */
  delta?: number;
  deltaLabel?: string;
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
            <>
              <Badge
                variant={delta >= 0 ? 'success' : 'danger'}
                className="mt-2"
              >
                {delta >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                {Math.abs(delta).toFixed(1)}%
              </Badge>
              {deltaLabel && (
                <p className="mt-1 text-[10px] text-muted-foreground">{deltaLabel}</p>
              )}
            </>
          )}
        </div>
        <div className={`grid h-10 w-10 place-items-center rounded-xl ${tones[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Card>
  );
}
