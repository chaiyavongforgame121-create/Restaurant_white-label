'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
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
  CreditCard,
  Landmark,
  Lock,
  RefreshCw,
  ShoppingBag,
  Store,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { Button, Card, RiderIcon } from '@favornoms/ui';
import { DEFAULT_UI_LOCALE, formatCurrency, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import type { RestaurantReports } from '@favornoms/database/queries';

interface Props {
  branchId: string;
  initialMonths: number;
  reports: RestaurantReports | null;
  error?: string | null;
}

/** Order channels with a label in hq.channels.names; anything else is shown as stored. */
const KNOWN_CHANNELS = new Set(['dine_in', 'pickup', 'delivery', 'qr_ordering']);

/** '2026-03-01' → "Mar 26" (in the viewer's language). Built from the year and month by hand
 *  and formatted in UTC on purpose: `new Date('2026-03-01')` is parsed as UTC midnight, which
 *  renders as *February* for every merchant west of Greenwich — i.e. all of them, this being a
 *  US-only product. */
function monthLabel(iso: string, format: Intl.DateTimeFormat) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (!y || !m || m < 1 || m > 12) return iso;
  return format.format(new Date(Date.UTC(y, m - 1, 1)));
}

const BRANCH_COLORS = ['#FF6B35', '#F7B538', '#2EC4B6', '#C73E1D', '#7B5EA7', '#3A86FF'];

export function HqView({ branchId, initialMonths, reports, error }: Props) {
  const t = useTranslations('hq');
  const rawLocale = useLocale();
  const intlLocale = intlLocaleFor(isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE);
  const monthFormat = React.useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { month: 'short', year: '2-digit', timeZone: 'UTC' }),
    [intlLocale],
  );
  const router = useRouter();
  const pathname = usePathname();
  const [months, setMonths] = React.useState(initialMonths);

  // get_restaurant_reports raises 42501 rather than returning an empty rollup, so a manager
  // who lacks head-office access is told that in words; any other failure is raw database
  // text, which belongs in the console rather than in front of the merchant.
  React.useEffect(() => {
    if (!reports && error && !error.includes('42501')) {
      console.error('get_restaurant_reports failed', error);
    }
  }, [reports, error]);

  const setRange = (n: number) => {
    setMonths(n);
    router.replace(`${pathname}?months=${n}`);
  };

  const header = (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3 px-2 pl-16 lg:px-0">
      <div>
        <h1 className="flex items-center gap-2 font-display text-3xl font-bold">
          <Landmark className="h-7 w-7 text-primary" /> {t('title')}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {reports
            ? t('subtitleWithRestaurant', { restaurant: reports.restaurant_name, months })
            : t('subtitle', { months })}
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
            {t('rangeShort', { months: n })}
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
            {ownerOnly ? t('ownerOnly.title') : t('loadError.title')}
          </h2>
          {ownerOnly ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {t.rich('ownerOnly.body', { em: (chunks) => <em>{chunks}</em> })}
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">{t('loadError.body')}</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {!ownerOnly && (
              <Button
                variant="outline"
                leftIcon={<RefreshCw className="h-4 w-4" />}
                onClick={() => router.refresh()}
              >
                {t('tryAgain')}
              </Button>
            )}
            <Link href={`/b/${branchId}/reports`}>
              <Button variant="outline">{t('goToBranchReports')}</Button>
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
          <h2 className="font-display text-lg font-semibold">{t('empty.title', { months })}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('empty.body', { count: reports.branch_count })}
          </p>
        </Card>
      </div>
    );
  }

  const revenueName = t('chart.revenue');
  const payoutsName = t('chart.driverPayouts');
  const subscriptionName = t('chart.subscription');

  return (
    <div className="container max-w-6xl py-8">
      {header}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={<TrendingUp className="h-5 w-5" />} label={t('kpi.revenue')} value={formatCurrency(totals.revenue)} />
        <Kpi
          icon={<ShoppingBag className="h-5 w-5" />}
          label={t('kpi.orders')}
          value={totals.orders.toLocaleString(intlLocale)}
        />
        <Kpi
          icon={<Store className="h-5 w-5" />}
          label={reports.branch_count === 1 ? t('kpi.branch') : t('kpi.branches')}
          value={reports.branch_count.toString()}
          hint={t('kpi.avgOrder', { amount: formatCurrency(totals.avg_order_value) })}
        />
        <Kpi
          icon={<Wallet className="h-5 w-5" />}
          label={t('kpi.knownCosts')}
          value={formatCurrency(knownCosts)}
          hint={t('kpi.knownCostsHint')}
        />
      </section>

      <section className="mt-6">
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('chart.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('chart.timezone', { timezone: reports.timezone })}
          </p>
          <div className="mt-3 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={monthly}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="month"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickFormatter={(v: string) => monthLabel(v, monthFormat)}
                />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 12,
                  }}
                  labelFormatter={(v) => (typeof v === 'string' ? monthLabel(v, monthFormat) : v)}
                  formatter={(v: number, name: string) => [formatCurrency(v), name]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar name={revenueName} dataKey="revenue" fill="hsl(var(--primary))" radius={[8, 8, 0, 0]} />
                <Line
                  name={payoutsName}
                  type="monotone"
                  dataKey="driver_payouts"
                  stroke="#2EC4B6"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  name={subscriptionName}
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
            <h2 className="font-display text-lg font-semibold">{t('branches.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('branches.ranked')}</p>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('branches.columns.branch')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('branches.columns.orders')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('branches.columns.revenue')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('branches.columns.avgOrder')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('branches.columns.payouts')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('branches.columns.share')}</th>
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
                              {t('branches.inactive')}
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
                          {t('branches.open')} <ArrowUpRight className="h-3.5 w-3.5" />
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
          <h2 className="font-display text-lg font-semibold">{t('costs.title')}</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex items-start justify-between gap-3">
              <span className="flex items-center gap-2">
                <RiderIcon className="h-4 w-4 text-muted-foreground" /> {t('costs.driverPayouts')}
              </span>
              <span className="font-semibold tabular-nums">{formatCurrency(totals.driver_payouts)}</span>
            </li>
            <li className="flex items-start justify-between gap-3">
              <span className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-muted-foreground" /> {t('costs.subscription')}
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
              {reports.subscription_plan
                ? t.rich('costs.noInvoicesWithPlan', {
                    rate: formatCurrency(reports.subscription_monthly),
                    plan: reports.subscription_plan,
                    strong: (chunks) => <strong className="text-foreground">{chunks}</strong>,
                    planName: (chunks) => <span className="capitalize">{chunks}</span>,
                  })
                : t.rich('costs.noInvoices', {
                    rate: formatCurrency(reports.subscription_monthly),
                    strong: (chunks) => <strong className="text-foreground">{chunks}</strong>,
                  })}
            </p>
          )}
          <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('costs.totalKnown')}</span>
              <span className="font-semibold tabular-nums">{formatCurrency(knownCosts)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('costs.afterCosts')}</span>
              <span className="font-display text-lg font-bold tabular-nums">
                {formatCurrency(afterCosts)}
              </span>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t('costs.disclaimer')}</p>
        </Card>
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h2 className="font-display text-lg font-semibold">{t('monthly.title')}</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('monthly.columns.month')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('monthly.columns.orders')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('monthly.columns.revenue')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('monthly.columns.payouts')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('monthly.columns.subscription')}</th>
                  <th className="py-2 text-right font-medium">{t('monthly.columns.afterCosts')}</th>
                </tr>
              </thead>
              <tbody>
                {[...monthly].reverse().map((m) => (
                  <tr key={m.month} className="border-b border-border/50 last:border-0">
                    <td className="py-2.5 pr-3 font-semibold">{monthLabel(m.month, monthFormat)}</td>
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
          <h2 className="font-display text-lg font-semibold">{t('channels.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('channels.subtitle')}</p>
          {by_channel.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">{t('channels.empty')}</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {by_channel.map((c) => {
                const share = totals.revenue > 0 ? c.revenue / totals.revenue : 0;
                const known = KNOWN_CHANNELS.has(c.channel);
                return (
                  <li key={c.channel}>
                    <div className="flex items-center justify-between">
                      <span className={known ? undefined : 'capitalize'}>
                        {known ? t(`channels.names.${c.channel}`) : c.channel.replace('_', ' ')}
                      </span>
                      <span className="font-semibold tabular-nums">{formatCurrency(c.revenue)}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.round(share * 100)}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('channels.orders', { count: c.orders })}
                    </p>
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
            <h2 className="font-display text-lg font-semibold">{t('stacked.title')}</h2>
            <div className="mt-3 h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stacked}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="month"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickFormatter={(v) => (typeof v === 'string' ? monthLabel(v, monthFormat) : v)}
                  />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 12,
                    }}
                    labelFormatter={(v) => (typeof v === 'string' ? monthLabel(v, monthFormat) : v)}
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
