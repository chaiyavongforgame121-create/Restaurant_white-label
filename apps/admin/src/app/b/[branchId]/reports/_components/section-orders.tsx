'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
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

// These are the `to_char(…, 'Dy')` values get_branch_orders_report returns, so they are
// matched as-is; only the row label is translated, from reports.orders.dow.
const DOW_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function SectionOrders({
  result,
  currency,
  timezone,
}: {
  result: SectionResult<OrdersReport>;
  currency: string;
  timezone: string;
}) {
  const t = useTranslations('reports.orders');
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);
  const maxHeat = Math.max(1, ...(data?.hour_heatmap ?? []).map((h) => h.orders));

  // Channel, source and status are open-ended codes from the RPC. A known one gets its
  // translated name; anything new still shows, as the raw code.
  const channelName = (channel: string) =>
    t.has(`channel.${channel}`) ? t(`channel.${channel}`) : null;
  const sourceName = (source: string) => (t.has(`source.${source}`) ? t(`source.${source}`) : null);
  const statusName = (status: string) => (t.has(`status.${status}`) ? t(`status.${status}`) : null);

  return (
    <SectionFrame
      id="orders"
      title={t('title')}
      icon={<ShoppingBag className="h-5 w-5" />}
      caption={t('caption')}
      error={result.error ?? (data ? null : { code: 'emptyResponse', ref: null })}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi
              icon={<ShoppingBag className="h-5 w-5" />}
              label={t('total')}
              value={data.totals.orders.toString()}
              hint={t('totalHint', { count: data.totals.in_progress })}
            />
            <Kpi
              icon={<CheckCircle2 className="h-5 w-5" />}
              label={t('completed')}
              value={`${data.totals.completed} · ${data.totals.completion_rate_pct}%`}
              tone="success"
            />
            <Kpi
              icon={<XCircle className="h-5 w-5" />}
              label={t('cancelled')}
              value={`${data.totals.cancelled} · ${data.totals.cancel_rate_pct}%`}
              tone={data.totals.cancel_rate_pct >= 15 ? 'danger' : 'neutral'}
            />
            <Kpi
              icon={<Timer className="h-5 w-5" />}
              label={t('averageOrder')}
              value={money(data.totals.avg_order_value)}
              hint={
                data.totals.avg_fulfil_min > 0
                  ? t('fulfilHint', { minutes: data.totals.avg_fulfil_min })
                  : undefined
              }
            />
            <Kpi
              icon={<CalendarClock className="h-5 w-5" />}
              label={t('scheduled')}
              value={data.scheduled.total.toString()}
              hint={t('scheduledHint', { count: data.scheduled.upcoming })}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <h3 className="font-display text-lg font-semibold">{t('byHour')}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('branchClock', { timezone })}
              </p>
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
                      labelFormatter={(h) => t('hourLabel', { hour: String(h) })}
                      formatter={(v: number) => t('ordersCount', { count: v })}
                    />
                    <Bar
                      dataKey="orders"
                      name={t('title')}
                      fill="hsl(var(--primary))"
                      radius={[6, 6, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('byChannel')}</h3>
              {data.by_channel.length === 0 ? (
                <EmptyNote>{t('empty')}</EmptyNote>
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
                          formatter={(v: number, name: string) => [
                            money(v),
                            channelName(String(name)) ?? name,
                          ]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {data.by_channel.map((c) => {
                      const label = channelName(c.channel);
                      return (
                        <li key={c.channel} className="flex items-center justify-between gap-2">
                          <span
                            className={`inline-flex min-w-0 items-center gap-2${label ? '' : ' capitalize'}`}
                          >
                            <span
                              className="h-3 w-3 shrink-0 rounded-full"
                              style={{ background: CHANNEL_COLORS[c.channel] ?? '#999' }}
                            />
                            <span className="truncate">{label ?? c.channel.replace('_', ' ')}</span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="text-xs text-muted-foreground">
                              {c.orders}
                              {c.cancelled > 0
                                ? ` ${t('channelCancelled', { count: c.cancelled })}`
                                : ''}{' '}
                              ·{' '}
                            </span>
                            <span className="font-semibold tabular-nums">{money(c.revenue)}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('whereFrom')}</h3>
              {data.by_source.length === 0 ? (
                <EmptyNote>{t('empty')}</EmptyNote>
              ) : (
                <ul className="mt-3 space-y-1.5 text-sm">
                  {data.by_source.map((s) => {
                    const label = sourceName(s.source);
                    return (
                      <li
                        key={s.source}
                        className="flex items-center justify-between gap-2 rounded-xl bg-muted/40 px-3 py-2"
                      >
                        <span className={`truncate${label ? '' : ' capitalize'}`}>
                          {label ?? s.source}
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="text-xs text-muted-foreground">{s.orders} · </span>
                          <span className="font-semibold tabular-nums">{money(s.revenue)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('byStatus')}</h3>
              {data.by_status.length === 0 ? (
                <EmptyNote>{t('empty')}</EmptyNote>
              ) : (
                <ul className="mt-3 space-y-1.5 text-sm">
                  {data.by_status.map((s) => {
                    const label = statusName(s.status);
                    return (
                      <li
                        key={s.status}
                        className="flex items-center justify-between gap-2 rounded-xl bg-muted/40 px-3 py-2"
                      >
                        <span className={`truncate${label ? '' : ' capitalize'}`}>
                          {label ?? s.status.replace(/_/g, ' ')}
                        </span>
                        <span className="font-semibold tabular-nums">{s.orders}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <Caption>{t('byStatusCaption')}</Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('scheduledOrders')}</h3>
              <dl className="mt-3 space-y-1.5 text-sm">
                <ScheduleRow label={t('bookedInAdvance')} value={data.scheduled.total} />
                <ScheduleRow label={t('stillUpcoming')} value={data.scheduled.upcoming} />
                <ScheduleRow label={t('fulfilled')} value={data.scheduled.fulfilled} />
                <ScheduleRow label={t('cancelled')} value={data.scheduled.cancelled} />
              </dl>
              <Caption>{t('scheduledCaption')}</Caption>
            </Card>
          </div>

          <Card className="mt-4 p-5">
            <h3 className="font-display text-lg font-semibold">{t('heatmap')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('heatmapCaption', { timezone })}
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
                      <td className="whitespace-nowrap pr-1 text-left text-xs font-semibold">
                        {t(`dow.${d}`)}
                      </td>
                      {Array.from({ length: 24 }, (_, h) => {
                        const cell = data.hour_heatmap.find((c) => c.dow === d && c.hour === h);
                        const intensity = cell ? cell.orders / maxHeat : 0;
                        return (
                          <td
                            key={h}
                            title={
                              cell
                                ? t('heatmapCell', {
                                    count: cell.orders,
                                    amount: money(cell.revenue),
                                  })
                                : t('ordersCount', { count: 0 })
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
