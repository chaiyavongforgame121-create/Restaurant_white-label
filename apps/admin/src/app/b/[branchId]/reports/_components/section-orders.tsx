'use client';

import * as React from 'react';
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
import { CalendarClock, CheckCircle2, ShoppingBag, Timer, XCircle } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { formatCurrency } from '@favornoms/shared';
import { Kpi } from './kpi';
import { Caption, EmptyNote, SectionFrame } from './section-frame';
import type { OrdersReport, SectionResult } from './report-queries';

const CHANNEL_COLORS: Record<string, string> = {
  delivery: '#FF6B35',
  pickup: '#F7B538',
  dine_in: '#C73E1D',
  qr_ordering: '#2EC4B6',
};

const DOW_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function SectionOrders({
  result,
  currency,
  timezone,
}: {
  result: SectionResult<OrdersReport>;
  currency: string;
  timezone: string;
}) {
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);
  const maxHeat = Math.max(1, ...(data?.hour_heatmap ?? []).map((h) => h.orders));

  return (
    <SectionFrame
      id="orders"
      title="Orders"
      icon={<ShoppingBag className="h-5 w-5" />}
      caption="Every order in the range, cancellations included — so the rates below have an honest denominator."
      error={result.error ?? (data ? null : 'No orders payload was returned.')}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi
              icon={<ShoppingBag className="h-5 w-5" />}
              label="Total orders"
              value={data.totals.orders.toString()}
              hint={`${data.totals.in_progress} still in progress`}
            />
            <Kpi
              icon={<CheckCircle2 className="h-5 w-5" />}
              label="Completed"
              value={`${data.totals.completed} · ${data.totals.completion_rate_pct}%`}
              tone="success"
            />
            <Kpi
              icon={<XCircle className="h-5 w-5" />}
              label="Cancelled"
              value={`${data.totals.cancelled} · ${data.totals.cancel_rate_pct}%`}
              tone={data.totals.cancel_rate_pct >= 15 ? 'danger' : 'neutral'}
            />
            <Kpi
              icon={<Timer className="h-5 w-5" />}
              label="Average order"
              value={money(data.totals.avg_order_value)}
              hint={
                data.totals.avg_fulfil_min > 0
                  ? `${data.totals.avg_fulfil_min} min to fulfil`
                  : undefined
              }
            />
            <Kpi
              icon={<CalendarClock className="h-5 w-5" />}
              label="Scheduled"
              value={data.scheduled.total.toString()}
              hint={`${data.scheduled.upcoming} still upcoming`}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <h3 className="font-display text-lg font-semibold">Orders by hour</h3>
              <p className="mt-1 text-xs text-muted-foreground">Branch clock ({timezone})</p>
              <div className="mt-3 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.by_hour}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(var(--border))"
                      vertical={false}
                    />
                    <XAxis dataKey="hour" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        background: 'hsl(var(--card))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 12,
                      }}
                      labelFormatter={(h) => `${h}:00`}
                      formatter={(v: number) => `${v} orders`}
                    />
                    <Bar dataKey="orders" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">By channel</h3>
              {data.by_channel.length === 0 ? (
                <EmptyNote>No orders in this range.</EmptyNote>
              ) : (
                <>
                  <div className="mt-3 h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={data.by_channel}
                          dataKey="revenue"
                          nameKey="channel"
                          innerRadius={40}
                          outerRadius={72}
                          paddingAngle={2}
                        >
                          {data.by_channel.map((c) => (
                            <Cell key={c.channel} fill={CHANNEL_COLORS[c.channel] ?? '#999'} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: 'hsl(var(--card))',
                            border: '1px solid hsl(var(--border))',
                            borderRadius: 12,
                          }}
                          formatter={(v: number) => money(v)}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {data.by_channel.map((c) => (
                      <li key={c.channel} className="flex items-center justify-between gap-2">
                        <span className="inline-flex min-w-0 items-center gap-2 capitalize">
                          <span
                            className="h-3 w-3 shrink-0 rounded-full"
                            style={{ background: CHANNEL_COLORS[c.channel] ?? '#999' }}
                          />
                          <span className="truncate">{c.channel.replace('_', ' ')}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="text-xs text-muted-foreground">
                            {c.orders}
                            {c.cancelled > 0 ? ` (${c.cancelled} cx)` : ''} ·{' '}
                          </span>
                          <span className="font-semibold tabular-nums">{money(c.revenue)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">Where orders came from</h3>
              {data.by_source.length === 0 ? (
                <EmptyNote>No orders in this range.</EmptyNote>
              ) : (
                <ul className="mt-3 space-y-1.5 text-sm">
                  {data.by_source.map((s) => (
                    <li
                      key={s.source}
                      className="flex items-center justify-between gap-2 rounded-xl bg-muted/40 px-3 py-2"
                    >
                      <span className="truncate capitalize">{s.source}</span>
                      <span className="shrink-0 text-right">
                        <span className="text-xs text-muted-foreground">{s.orders} · </span>
                        <span className="font-semibold tabular-nums">{money(s.revenue)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">By status</h3>
              {data.by_status.length === 0 ? (
                <EmptyNote>No orders in this range.</EmptyNote>
              ) : (
                <ul className="mt-3 space-y-1.5 text-sm">
                  {data.by_status.map((s) => (
                    <li
                      key={s.status}
                      className="flex items-center justify-between gap-2 rounded-xl bg-muted/40 px-3 py-2"
                    >
                      <span className="truncate capitalize">{s.status.replace(/_/g, ' ')}</span>
                      <span className="font-semibold tabular-nums">{s.orders}</span>
                    </li>
                  ))}
                </ul>
              )}
              <Caption>
                This list was fetched but never drawn before, so a cancelled order had
                nowhere to appear.
              </Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">Scheduled orders</h3>
              <dl className="mt-3 space-y-1.5 text-sm">
                <ScheduleRow label="Booked in advance" value={data.scheduled.total} />
                <ScheduleRow label="Still upcoming" value={data.scheduled.upcoming} />
                <ScheduleRow label="Fulfilled" value={data.scheduled.fulfilled} />
                <ScheduleRow label="Cancelled" value={data.scheduled.cancelled} />
              </dl>
              <Caption>
                Counted by when the order was placed, not by the slot it was booked into.
              </Caption>
            </Card>
          </div>

          <Card className="mt-4 p-5">
            <h3 className="font-display text-lg font-semibold">Peak-hour heatmap</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Orders per hour-of-day × day-of-week ({timezone})
            </p>
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
                        const cell = data.hour_heatmap.find((c) => c.dow === d && c.hour === h);
                        const intensity = cell ? cell.orders / maxHeat : 0;
                        return (
                          <td
                            key={h}
                            title={
                              cell
                                ? `${cell.orders} orders · ${money(cell.revenue)}`
                                : '0 orders'
                            }
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
        </>
      ) : null}
    </SectionFrame>
  );
}

function ScheduleRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
