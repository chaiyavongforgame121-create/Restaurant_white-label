'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, Coins, Percent, TrendingUp, Undo2 } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { formatCurrency } from '@favornoms/shared';
import { Kpi } from './kpi';
import { Caption, EmptyNote, SectionFrame } from './section-frame';
import type { SalesReport, SectionResult } from './report-queries';

export function SectionSales({
  result,
  currency,
}: {
  result: SectionResult<SalesReport>;
  currency: string;
}) {
  const t = useTranslations('reports.sales');
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);

  return (
    <SectionFrame
      id="sales"
      title={t('title')}
      icon={<TrendingUp className="h-5 w-5" />}
      caption={t('caption')}
      error={result.error ?? (data ? null : { code: 'emptyResponse', ref: null })}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi
              icon={<TrendingUp className="h-5 w-5" />}
              label={t('grossSales')}
              value={money(data.totals.gross_sales)}
              hint={t('grossSalesHint')}
            />
            <Kpi
              icon={<Percent className="h-5 w-5" />}
              label={t('discounts')}
              value={money(data.totals.discounts)}
              hint={t('discountsHint', { amount: money(data.totals.promo_discounts) })}
              tone="warning"
            />
            <Kpi
              icon={<Undo2 className="h-5 w-5" />}
              label={t('refunds')}
              value={money(data.totals.refunds)}
              hint={t('refundsHint', { count: data.totals.refund_count })}
              tone="danger"
            />
            <Kpi
              icon={<Coins className="h-5 w-5" />}
              label={t('netSales')}
              value={money(data.totals.net_sales)}
              hint={t('netSalesHint')}
              tone="success"
            />
            <Kpi
              icon={<BarChart3 className="h-5 w-5" />}
              label={t('averageOrder')}
              value={money(data.totals.avg_order_value)}
              hint={t('ordersCount', { count: data.totals.orders })}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <h3 className="font-display text-lg font-semibold">{t('byDay')}</h3>
              {data.daily.length === 0 ? (
                <EmptyNote>{t('byDayEmpty')}</EmptyNote>
              ) : (
                <div className="mt-3 h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.daily}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="hsl(var(--border))"
                        vertical={false}
                      />
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
                        formatter={(v: number) => money(v)}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar
                        dataKey="gross_sales"
                        name={t('grossSales')}
                        fill="hsl(var(--primary))"
                        radius={[8, 8, 0, 0]}
                      />
                      <Bar
                        dataKey="refunds"
                        name={t('refunds')}
                        fill="hsl(var(--danger))"
                        radius={[8, 8, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <Caption>{t('byDayCaption')}</Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('breakdown')}</h3>
              <dl className="mt-3 space-y-1.5 text-sm">
                <Row label={t('grossSales')} value={money(data.totals.gross_sales)} />
                <Row
                  label={t('promoDiscounts')}
                  value={`− ${money(data.totals.promo_discounts)}`}
                />
                <Row
                  label={t('otherDiscounts')}
                  value={`− ${money(data.totals.other_discounts)}`}
                />
                <Row label={t('refunds')} value={`− ${money(data.totals.refunds)}`} />
                <Row label={t('netSales')} value={money(data.totals.net_sales)} emphasise />
                <div className="my-2 border-t border-border" />
                <Row label={t('tax')} value={money(data.totals.tax)} />
                <Row label={t('deliveryFees')} value={money(data.totals.delivery_fees)} />
                <Row label={t('serviceFees')} value={money(data.totals.service_fees)} />
                <Row label={t('tips')} value={money(data.totals.tips)} />
                <Row
                  label={t('grossReceipts')}
                  value={money(data.totals.gross_receipts)}
                  emphasise
                />
              </dl>
              <Caption>{t('breakdownCaption')}</Caption>
            </Card>
          </div>
        </>
      ) : null}
    </SectionFrame>
  );
}

function Row({
  label,
  value,
  emphasise,
}: {
  label: string;
  value: string;
  emphasise?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={emphasise ? 'font-semibold' : 'text-muted-foreground'}>{label}</dt>
      <dd className={`tabular-nums ${emphasise ? 'font-display font-bold' : 'font-medium'}`}>
        {value}
      </dd>
    </div>
  );
}
