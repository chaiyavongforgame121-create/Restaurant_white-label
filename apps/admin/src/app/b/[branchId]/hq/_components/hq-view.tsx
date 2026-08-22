'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  ArrowUpRight,
  Bike,
  CreditCard,
  Landmark,
  Lock,
  RefreshCw,
  ShoppingBag,
  Store,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { formatCurrency } from '@favornoms/shared';
import type { RestaurantReports } from '@favornoms/database/queries';

interface Props {
  branchId: string;
  initialMonths: number;
  reports: RestaurantReports | null;
  error?: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-03-01' → "Mar 26". Sliced by hand on purpose: `new Date('2026-03-01')`
 *  is parsed as UTC midnight, which renders as *February* for every merchant
 *  west of Greenwich — i.e. all of them, this being a US-only product. */
function monthLabel(iso: string) {
  const m = Number(iso.slice(5, 7));
  return `${MONTHS[m - 1] ?? iso} ${iso.slice(2, 4)}`;
}

const BRANCH_COLORS = ['#FF6B35', '#F7B538', '#2EC4B6', '#C73E1D', '#7B5EA7', '#3A86FF'];

export function HqView({ branchId, initialMonths, reports, error }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [months, setMonths] = React.useState(initialMonths);

  const setRange = (n: number) => {
    setMonths(n);
    router.replace(`${pathname}?months=${n}`);
  };

  const header = (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3 px-2 pl-16 lg:px-0">
      <div>
        <h1 className="flex items-center gap-2 font-display text-3xl font-bold">
          <Landmark className="h-7 w-7 text-primary" /> Head office
        </h1>
        <p className="mt-1 text-muted-foreground">
          {reports ? `${reports.restaurant_name} · ` : ''}
          Every branch, last {months} months
        </p>
      </div>
      <div className="inline-flex rounded-full border border-border bg-card p-1">
        {[3, 6, 12].map((n) => (
          <button
            key={n}
            onClick={() => setRange(n)}
            className={`focus-ring rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
              months === n ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
            }`}
          >
            {n}m
          </button>
        ))}
      </div>
    </header>
  );

  if (!reports) {
    // get_restaurant_reports raises 42501 rather than returning an empty rollup,
    // so a manager who lacks head-office access gets told that in words instead
    // of a dashboard of zeroes they'd report as a bug.
    const ownerOnly = (error ?? '').includes('42501');
    return (
      <div className="container max-w-6xl py-8">
        {header}
        <Card className="p-6">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-destructive">
            {ownerOnly ? <Lock className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
            {ownerOnly ? 'Owner access only' : 'Head office data could not be loaded'}
          </h2>
          {ownerOnly ? (
            <p className="mt-2 text-sm text-muted-foreground">
              This page rolls up sales and costs for <em>every</em> branch, so it is limited to the
              restaurant owner. Managers can still see their own branch under Reports. Ask the owner
              to change your staff role if you need it.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                Your sales data is safe — this is a problem reading it. Reload the page; if it keeps
                happening, send the message below to support.
              </p>
              <p className="mt-3 break-words rounded-xl bg-destructive/10 px-4 py-3 font-mono text-xs text-destructive">
                {error ?? 'Unknown error from get_restaurant_reports.'}
              </p>
            </>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {!ownerOnly && (
              <Button
                variant="outline"
                leftIcon={<RefreshCw className="h-4 w-4" />}
                onClick={() => router.refresh()}
              >
                Try again
              </Button>
            )}
            <Link href={`/b/${branchId}/reports`}>
              <Button variant="outline">Go to branch reports</Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const { totals, monthly, branches, branch_monthly, by_channel } = reports;
  const knownCosts = totals.driver_payouts + totals.subscription_billed;
  const afterCosts = totals.revenue - knownCosts;

  // Stacked per-branch revenue only earns its space once there is more than one
  // branch — otherwise it is the total chart drawn a second time.
  // Plain derivation, not useMemo: this sits below an early `return` for the
  // error state, and a hook there would change the hook count between renders.
  // At most 24 months x a handful of branches, so the pivot is free.
  const multi = branches.length > 1;
  const stacked: Record<string, string | number>[] = [];
  if (multi) {
    const byMonth = new Map<string, Record<string, string | number>>();
    for (const m of monthly) byMonth.set(m.month, { month: m.month });
    for (const row of branch_monthly) {
      const bucket = byMonth.get(row.month) ?? { month: row.month };
      bucket[row.branch_id] = row.revenue;
      byMonth.set(row.month, bucket);
    }
    stacked.push(...byMonth.values());
  }

  if (totals.orders === 0 && knownCosts === 0) {
    return (
      <div className="container max-w-6xl py-8">
        {header}
        <Card className="p-6 text-center">
          <h2 className="font-display text-lg font-semibold">
            Nothing to roll up in the last {months} months
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The rollup loaded fine — your {reports.branch_count === 1 ? 'branch has' : `${reports.branch_count} branches have`}{' '}
            just not taken an order in this window. Try a wider range above.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-6xl py-8">
      {header}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={<TrendingUp className="h-5 w-5" />} label="Revenue" value={formatCurrency(totals.revenue)} />
        <Kpi icon={<ShoppingBag className="h-5 w-5" />} label="Orders" value={totals.orders.toLocaleString()} />
        <Kpi
          icon={<Store className="h-5 w-5" />}
          label={reports.branch_count === 1 ? 'Branch' : 'Branches'}
          value={reports.branch_count.toString()}
          hint={`Avg order ${formatCurrency(totals.avg_order_value)}`}
        />
        <Kpi
          icon={<Wallet className="h-5 w-5" />}
          label="Known costs"
          value={formatCurrency(knownCosts)}
          hint="Driver payouts + subscription"
        />
      </section>

      <section className="mt-6">
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">Revenue vs known costs</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Months are bucketed in head-office time ({reports.timezone}).
          </p>
          <div className="mt-3 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={monthly}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="month"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickFormatter={monthLabel}
                />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 12,
                  }}
                  labelFormatter={(v) => (typeof v === 'string' ? monthLabel(v) : v)}
                  formatter={(v: number, name: string) => [formatCurrency(v), name]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar name="Revenue" dataKey="revenue" fill="hsl(var(--primary))" radius={[8, 8, 0, 0]} />
                <Line
                  name="Driver payouts"
                  type="monotone"
                  dataKey="driver_payouts"
                  stroke="#2EC4B6"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  name="Subscription"
                  type="monotone"
                  dataKey="subscription"
                  stroke="#C73E1D"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">Branches</h2>
            <p className="text-xs text-muted-foreground">Ranked by revenue</p>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Branch</th>
                  <th className="py-2 pr-3 text-right font-medium">Orders</th>
                  <th className="py-2 pr-3 text-right font-medium">Revenue</th>
                  <th className="py-2 pr-3 text-right font-medium">Avg order</th>
                  <th className="py-2 pr-3 text-right font-medium">Payouts</th>
                  <th className="py-2 pr-3 text-right font-medium">Share</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {branches.map((b, i) => {
                  const share = totals.revenue > 0 ? b.revenue / totals.revenue : 0;
                  return (
                    <tr key={b.branch_id} className="border-b border-border/50 last:border-0">
                      <td className="py-2.5 pr-3">
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: BRANCH_COLORS[i % BRANCH_COLORS.length] }}
                          />
                          <span className="font-semibold">{b.name}</span>
                          {!b.is_active && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              Inactive
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{b.orders}</td>
                      <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">
                        {formatCurrency(b.revenue)}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {formatCurrency(b.avg_order_value)}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                        {formatCurrency(b.driver_payouts)}
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        <span className="flex items-center justify-end gap-2">
                          <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block">
                            <span
                              className="block h-full rounded-full bg-primary"
                              style={{ width: `${Math.round(share * 100)}%` }}
                            />
                          </span>
                          <span className="tabular-nums">{Math.round(share * 100)}%</span>
                        </span>
                      </td>
                      <td className="py-2.5 text-right">
                        <Link
                          href={`/b/${b.branch_id}/reports`}
                          className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10"
                        >
                          Open <ArrowUpRight className="h-3.5 w-3.5" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">Costs we can see</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex items-start justify-between gap-3">
              <span className="flex items-center gap-2">
                <Bike className="h-4 w-4 text-muted-foreground" /> Driver payouts
              </span>
              <span className="font-semibold tabular-nums">{formatCurrency(totals.driver_payouts)}</span>
            </li>
            <li className="flex items-start justify-between gap-3">
              <span className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-muted-foreground" /> Favornoms subscription
              </span>
              <span className="font-semibold tabular-nums">
                {reports.has_invoices ? formatCurrency(totals.subscription_billed) : '—'}
              </span>
            </li>
          </ul>
          {!reports.has_invoices && (
            // Multiplying the current rate by the number of months would invent a
            // billing history that does not exist. State the rate instead.
            <p className="mt-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              No invoices recorded yet. Your current rate is{' '}
              <strong className="text-foreground">{formatCurrency(reports.subscription_monthly)}/month</strong>
              {reports.subscription_plan ? (
                <>
                  {' '}
                  on the <span className="capitalize">{reports.subscription_plan}</span> plan
                </>
              ) : null}
              .
            </p>
          )}
          <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total known costs</span>
              <span className="font-semibold tabular-nums">{formatCurrency(knownCosts)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Revenue after them</span>
              <span className="font-display text-lg font-bold tabular-nums">
                {formatCurrency(afterCosts)}
              </span>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            These are the only costs Favornoms records. Food, staff wages, rent and card fees are
            not included, so this is not your profit.
          </p>
        </Card>
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h2 className="font-display text-lg font-semibold">Month by month</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Month</th>
                  <th className="py-2 pr-3 text-right font-medium">Orders</th>
                  <th className="py-2 pr-3 text-right font-medium">Revenue</th>
                  <th className="py-2 pr-3 text-right font-medium">Payouts</th>
                  <th className="py-2 pr-3 text-right font-medium">Subscription</th>
                  <th className="py-2 text-right font-medium">After costs</th>
                </tr>
              </thead>
              <tbody>
                {[...monthly].reverse().map((m) => (
                  <tr key={m.month} className="border-b border-border/50 last:border-0">
                    <td className="py-2.5 pr-3 font-semibold">{monthLabel(m.month)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{m.orders}</td>
                    <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">
                      {formatCurrency(m.revenue)}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {formatCurrency(m.driver_payouts)}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {formatCurrency(m.subscription)}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {formatCurrency(m.revenue - m.driver_payouts - m.subscription)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">By channel</h2>
          <p className="mt-1 text-xs text-muted-foreground">All branches combined</p>
          {by_channel.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No orders yet.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {by_channel.map((c) => {
                const share = totals.revenue > 0 ? c.revenue / totals.revenue : 0;
                return (
                  <li key={c.channel}>
                    <div className="flex items-center justify-between">
                      <span className="capitalize">{c.channel.replace('_', ' ')}</span>
                      <span className="font-semibold tabular-nums">{formatCurrency(c.revenue)}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.round(share * 100)}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{c.orders} orders</p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      {multi && (
        <section className="mt-6">
          <Card className="p-5">
            <h2 className="font-display text-lg font-semibold">Revenue by branch, by month</h2>
            <div className="mt-3 h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stacked}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="month"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickFormatter={(v) => (typeof v === 'string' ? monthLabel(v) : v)}
                  />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 12,
                    }}
                    labelFormatter={(v) => (typeof v === 'string' ? monthLabel(v) : v)}
                    formatter={(v: number) => formatCurrency(v)}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {branches.map((b, i) => (
                    <Bar
                      key={b.branch_id}
                      name={b.name}
                      dataKey={b.branch_id}
                      stackId="rev"
                      fill={BRANCH_COLORS[i % BRANCH_COLORS.length]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-display text-xl font-bold">{value}</p>
        {hint && <p className="truncate text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    </Card>
  );
}
