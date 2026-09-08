'use client';

import * as React from 'react';
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
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);

  return (
    <SectionFrame
      id="sales"
      title="Sales & revenue"
      icon={<TrendingUp className="h-5 w-5" />}
      caption="Gross is what the food sold for. Net takes off discounts and refunds."
      error={result.error ?? (data ? null : 'No sales payload was returned.')}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi
              icon={<TrendingUp className="h-5 w-5" />}
              label="Gross sales"
              value={money(data.totals.gross_sales)}
              hint="Menu price after options"
            />
            <Kpi
              icon={<Percent className="h-5 w-5" />}
              label="Discounts"
              value={money(data.totals.discounts)}
              hint={`${money(data.totals.promo_discounts)} promo`}
              tone="warning"
            />
            <Kpi
              icon={<Undo2 className="h-5 w-5" />}
              label="Refunds"
              value={money(data.totals.refunds)}
              hint={`${data.totals.refund_count} refunded`}
              tone="danger"
            />
            <Kpi
              icon={<Coins className="h-5 w-5" />}
              label="Net sales"
              value={money(data.totals.net_sales)}
              hint="Gross − discounts − refunds"
              tone="success"
            />
            <Kpi
              icon={<BarChart3 className="h-5 w-5" />}
              label="Average order"
              value={money(data.totals.avg_order_value)}
              hint={`${data.totals.orders} orders`}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <h3 className="font-display text-lg font-semibold">Sales by day</h3>
              {data.daily.length === 0 ? (
                <EmptyNote>No sales in this range.</EmptyNote>
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
                        name="Gross sales"
                        fill="hsl(var(--primary))"
                        radius={[8, 8, 0, 0]}
                      />
                      <Bar
                        dataKey="refunds"
                        name="Refunds"
                        fill="hsl(var(--danger))"
                        radius={[8, 8, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <Caption>
                Refunds sit on the day the money went back out, which may not be the day the
                order was taken.
              </Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">What made up the total</h3>
              <dl className="mt-3 space-y-1.5 text-sm">
                <Row label="Gross sales" value={money(data.totals.gross_sales)} />
                <Row label="Promo discounts" value={`− ${money(data.totals.promo_discounts)}`} />
                <Row
                  label="Loyalty & till discounts"
                  value={`− ${money(data.totals.other_discounts)}`}
                />
                <Row label="Refunds" value={`− ${money(data.totals.refunds)}`} />
                <Row label="Net sales" value={money(data.totals.net_sales)} emphasise />
                <div className="my-2 border-t border-border" />
                <Row label="Tax" value={money(data.totals.tax)} />
                <Row label="Delivery fees" value={money(data.totals.delivery_fees)} />
                <Row label="Service fees (card only)" value={money(data.totals.service_fees)} />
                <Row label="Tips" value={money(data.totals.tips)} />
                <Row
                  label="Gross receipts"
                  value={money(data.totals.gross_receipts)}
                  emphasise
                />
              </dl>
              <Caption>
                Gross receipts is every dollar that changed hands, tax, fees and tips
                included — the figure this screen used to call &ldquo;Revenue&rdquo;.
              </Caption>
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
