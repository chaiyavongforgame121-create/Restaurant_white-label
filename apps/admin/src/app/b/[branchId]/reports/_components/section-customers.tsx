'use client';

import * as React from 'react';
import { Gift, Repeat, Sparkles, Ticket, UserPlus, Users } from 'lucide-react';
import { Badge, Card } from '@favornoms/ui';
import { formatCurrency } from '@favornoms/shared';
import { Kpi } from './kpi';
import { Caption, EmptyNote, SectionFrame } from './section-frame';
import type { CustomersReport, SectionResult } from './report-queries';

export function SectionCustomers({
  result,
  currency,
  tierLabels,
}: {
  result: SectionResult<CustomersReport>;
  currency: string;
  /** The restaurant’s own names for its tiers, so this report agrees with the badge the
   *  customer sees. Empty until the programme loads, and for a tier never renamed. */
  tierLabels?: Record<string, string>;
}) {
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);

  return (
    <SectionFrame
      id="customers"
      title="Customers & loyalty"
      icon={<Users className="h-5 w-5" />}
      caption="Who ordered in this range, whether they had been here before, and what loyalty cost."
      error={result.error ?? (data ? null : 'No customers payload was returned.')}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi
              icon={<Users className="h-5 w-5" />}
              label="Customers on file"
              value={data.totals.total_customers.toString()}
              hint="All time, not this range"
            />
            <Kpi
              icon={<Sparkles className="h-5 w-5" />}
              label="Ordered in range"
              value={data.totals.active_customers.toString()}
              hint={`${data.totals.repeat_customers} ordered twice or more`}
            />
            <Kpi
              icon={<UserPlus className="h-5 w-5" />}
              label="New"
              value={data.totals.new_customers.toString()}
              hint="First ever order here"
              tone="success"
            />
            <Kpi
              icon={<Repeat className="h-5 w-5" />}
              label="Returning"
              value={data.totals.returning_customers.toString()}
              hint="Had ordered before this range"
            />
            <Kpi
              icon={<Sparkles className="h-5 w-5" />}
              label="Orders per customer"
              value={data.totals.avg_orders_per_customer.toFixed(2)}
              hint={`${money(data.totals.avg_spend_per_customer)} each`}
            />
          </div>

          {data.totals.guest_orders > 0 ? (
            <Caption>
              {data.totals.guest_orders} order
              {data.totals.guest_orders === 1 ? ' was' : 's were'} placed without an account,
              so new and returning will not add up to the order count.
            </Caption>
          ) : null}

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <h3 className="font-display text-lg font-semibold">Top customers</h3>
              {data.top_customers.length === 0 ? (
                <EmptyNote>No signed-in diner ordered in this range.</EmptyNote>
              ) : (
                <div className="mt-3 max-h-96 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="pb-1 font-normal">Customer</th>
                        <th className="pb-1 text-right font-normal">Orders</th>
                        <th className="pb-1 text-right font-normal">Spend</th>
                        <th className="pb-1 text-right font-normal">Lifetime</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.top_customers.map((c) => (
                        <tr key={c.customer_id} className="border-t border-border">
                          <td className="max-w-[14rem] truncate py-1.5 pr-2 font-medium">
                            {c.name}
                            {c.tier ? (
                              <Badge
                                variant="muted"
                                className={`ml-2${tierLabels?.[c.tier] ? '' : ' capitalize'}`}
                              >
                                {tierLabels?.[c.tier] ?? c.tier}
                              </Badge>
                            ) : null}
                          </td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">{c.orders}</td>
                          <td className="py-1.5 pr-2 text-right font-semibold tabular-nums">
                            {money(c.spend)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                            {money(Number(c.lifetime_spent ?? 0))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Caption>
                Spend is this range only. Lifetime is every order the diner has ever placed
                with this restaurant.
              </Caption>
            </Card>

            <div className="space-y-4">
              <Card className="p-5">
                <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
                  <Gift className="h-4 w-4" /> Loyalty points
                </h3>
                <dl className="mt-3 space-y-1.5 text-sm">
                  <PointRow label="Earned" value={`+${data.totals.points_earned}`} tone="success" />
                  <PointRow
                    label="Redeemed"
                    value={`−${data.totals.points_redeemed}`}
                    tone="warning"
                  />
                  <PointRow label="Manual adjustments" value={`${data.totals.points_manual}`} />
                </dl>
                <Caption>
                  Points follow the diner across every branch of this restaurant, so an
                  adjustment made elsewhere is reported on its own line rather than folded in.
                </Caption>
              </Card>

              <Card className="p-5">
                <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
                  <Ticket className="h-4 w-4" /> Coupons used
                </h3>
                {data.by_coupon.length === 0 ? (
                  <EmptyNote>No coupon was used in this range.</EmptyNote>
                ) : (
                  <table className="mt-3 w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="pb-1 font-normal">Code</th>
                        <th className="pb-1 text-right font-normal">Uses</th>
                        <th className="pb-1 text-right font-normal">Given away</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_coupon.map((c) => (
                        <tr key={c.code} className="border-t border-border">
                          <td className="py-1.5 font-mono text-xs uppercase">{c.code}</td>
                          <td className="py-1.5 text-right tabular-nums">{c.uses}</td>
                          <td className="py-1.5 text-right font-semibold tabular-nums">
                            {money(c.discount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <Caption>
                  {data.totals.coupon_uses} order
                  {data.totals.coupon_uses === 1 ? '' : 's'} carried a code, worth{' '}
                  {money(data.totals.coupon_discount)}.
                </Caption>
              </Card>
            </div>
          </div>
        </>
      ) : null}
    </SectionFrame>
  );
}

function PointRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'warning';
}) {
  const toneClass =
    tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : '';
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-semibold tabular-nums ${toneClass}`}>{value}</dd>
    </div>
  );
}
