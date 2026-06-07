'use client';

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, ShoppingBag, TrendingUp, Trophy } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { formatCurrency } from '@favornoms/shared';
import type { BranchReports } from '@favornoms/database/queries';
import { ExportButtons } from './export-buttons';

interface Props {
  branchId: string;
  initialDays: number;
  reports: BranchReports | null;
  timezone?: string;
}

const channelColors: Record<string, string> = {
  delivery: '#FF6B35',
  pickup: '#F7B538',
  dine_in: '#C73E1D',
  qr_ordering: '#2EC4B6',
};

const DOW_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function ReportsView({ branchId, initialDays, reports, timezone }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [days, setDays] = React.useState(initialDays);

  const setRange = (n: number) => {
    setDays(n);
    router.replace(`${pathname}?days=${n}`);
  };

  if (!reports) {
    return (
      <div className="container max-w-6xl py-8">
        <h1 className="font-display text-3xl font-bold">Reports</h1>
        <p className="mt-1 text-muted-foreground">No data — try again later.</p>
      </div>
    );
  }

  const { totals, daily, by_channel, top_items, by_category, hour_heatmap } = reports;
  const maxHeat = Math.max(1, ...hour_heatmap.map((h) => h.orders));

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">Reports</h1>
          <p className="mt-1 text-muted-foreground">Last {days} days</p>
        </div>
        <ExportButtons branchId={branchId} />
        <div className="inline-flex rounded-full border border-border bg-card p-1">
          {[7, 30, 90].map((n) => (
            <button
              key={n}
              onClick={() => setRange(n)}
              className={`focus-ring rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                days === n ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
              }`}
            >
              {n}d
            </button>
          ))}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          icon={<TrendingUp className="h-5 w-5" />}
          label="Revenue"
          value={formatCurrency(totals.revenue)}
        />
        <Kpi
          icon={<ShoppingBag className="h-5 w-5" />}
          label="Orders"
          value={totals.orders.toString()}
        />
        <Kpi
          icon={<BarChart3 className="h-5 w-5" />}
          label="Avg order"
          value={formatCurrency(totals.avg_order_value)}
        />
        <Kpi
          icon={<Trophy className="h-5 w-5" />}
          label="Completed"
          value={`${Math.round((totals.completed_orders / Math.max(1, totals.orders)) * 100)}%`}
        />
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h2 className="font-display text-lg font-semibold">Daily revenue</h2>
          <div className="mt-3 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="day"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickFormatter={(v) => (typeof v === 'string' ? v.slice(5) : v)}
                />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 12,
                  }}
                  formatter={(v: number) => formatCurrency(v)}
                />
                <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">By channel</h2>
          <div className="mt-3 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={by_channel}
                  dataKey="revenue"
                  nameKey="channel"
                  innerRadius={48}
                  outerRadius={86}
                  paddingAngle={2}
                >
                  {by_channel.map((c) => (
                    <Cell key={c.channel} fill={channelColors[c.channel] ?? '#999'} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 12,
                  }}
                  formatter={(v: number) => formatCurrency(v)}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            {by_channel.map((c) => (
              <li key={c.channel} className="flex items-center justify-between">
                <span className="inline-flex items-center gap-2 capitalize">
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{ background: channelColors[c.channel] ?? '#999' }}
                  />
                  {c.channel.replace('_', ' ')}
                </span>
                <span className="font-semibold tabular-nums">{formatCurrency(c.revenue)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">Top 10 items</h2>
          {top_items.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No sales yet.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {top_items.map((i, idx) => (
                <li key={i.name} className="flex items-center justify-between rounded-xl bg-muted/40 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2 truncate">
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                      {idx + 1}
                    </span>
                    <span className="truncate font-semibold">{i.name}</span>
                  </span>
                  <span className="ml-2 shrink-0 text-right">
                    <span className="text-xs text-muted-foreground">{i.quantity}x · </span>
                    <span className="font-semibold tabular-nums">{formatCurrency(i.revenue)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">By category</h2>
          {by_category.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No category data.</p>
          ) : (
            <div className="mt-3 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={by_category} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis
                    type="category"
                    dataKey="category"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    width={100}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 12,
                    }}
                    formatter={(v: number) => formatCurrency(v)}
                  />
                  <Bar dataKey="revenue" fill="hsl(var(--accent))" radius={[0, 8, 8, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </section>

      <section className="mt-6">
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">Peak-hour heatmap</h2>
          <p className="mt-1 text-xs text-muted-foreground">Order count per hour-of-day × day-of-week ({timezone ?? 'America/New_York'})</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-separate border-spacing-1 text-center text-[10px]">
              <thead>
                <tr>
                  <th className="text-left text-xs font-semibold"></th>
                  {Array.from({ length: 24 }, (_, h) => (
                    <th key={h} className="text-xs font-normal text-muted-foreground">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DOW_ORDER.map((d) => (
                  <tr key={d}>
                    <td className="pr-1 text-left text-xs font-semibold">{d}</td>
                    {Array.from({ length: 24 }, (_, h) => {
                      const cell = hour_heatmap.find((c) => c.dow === d && c.hour === h);
                      const intensity = cell ? cell.orders / maxHeat : 0;
                      return (
                        <td
                          key={h}
                          title={cell ? `${cell.orders} orders · ${formatCurrency(cell.revenue)}` : '0 orders'}
                          className="h-6 w-6 rounded"
                          style={{
                            background: intensity
                              ? `hsl(var(--primary) / ${Math.max(0.15, intensity)})`
                              : 'hsl(var(--muted) / 0.6)',
                          }}
                        >
                          {cell?.orders || ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">{icon}</div>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-display text-xl font-bold">{value}</p>
      </div>
    </Card>
  );
}
