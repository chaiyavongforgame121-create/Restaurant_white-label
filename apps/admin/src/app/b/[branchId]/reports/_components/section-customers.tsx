'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Gift, Repeat, Sparkles, Ticket, UserPlus, Users } from 'lucide-react';
import { Badge, Card } from '@favornoms/ui';
import { formatCurrency } from '@favornoms/shared';
import { Kpi } from './kpi';
import { Caption, EmptyNote, SectionFrame } from './section-frame';
import type { CustomersReport, SectionResult } from './report-queries';

/** The ledger lines get_branch_customers_report added (20260918210000): optional so a response
 *  from before that migration still renders. Together with earned, redeemed and manual they cover
 *  every ledger row of the branch, so the card adds up to the net change in points. */
type LedgerTotals = CustomersReport['totals'] & {
  /** Signed: points given back on cancelled or refunded orders, less any taken again on reopen. */
  points_returned?: number;
  points_birthday?: number;
};

/** "+12", "−12" (true minus sign) or "0". */
function signedPoints(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return '0';
}

export function SectionCustomers({
  result,
  currency,
  tierLabels,
}: {
  result: SectionResult<CustomersReport>;
  currency: string;
  /** This branch’s own names for its tiers, so this report agrees with the badge the
   *  customer sees. Empty until the programme loads, and for a tier never renamed. */
  tierLabels?: Record<string, string>;
}) {
  const t = useTranslations('reports.customers');
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);
  const ledger: LedgerTotals | null = data ? data.totals : null;

  return (
    <SectionFrame
      id="customers"
      title={t('title')}
      icon={<Users className="h-5 w-5" />}
      caption={t('caption')}
      error={result.error ?? (data ? null : { code: 'emptyResponse', ref: null })}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi
              icon={<Users className="h-5 w-5" />}
              label={t('onFile')}
              value={data.totals.total_customers.toString()}
              hint={t('onFileHint')}
            />
            <Kpi
              icon={<Sparkles className="h-5 w-5" />}
              label={t('active')}
              value={data.totals.active_customers.toString()}
              hint={t('activeHint', { count: data.totals.repeat_customers })}
            />
            <Kpi
              icon={<UserPlus className="h-5 w-5" />}
              label={t('new')}
              value={data.totals.new_customers.toString()}
              hint={t('newHint')}
              tone="success"
            />
            <Kpi
              icon={<Repeat className="h-5 w-5" />}
              label={t('returning')}
              value={data.totals.returning_customers.toString()}
              hint={t('returningHint')}
            />
            <Kpi
              icon={<Sparkles className="h-5 w-5" />}
              label={t('ordersPerCustomer')}
              value={data.totals.avg_orders_per_customer.toFixed(2)}
              hint={t('ordersPerCustomerHint', {
                amount: money(data.totals.avg_spend_per_customer),
              })}
            />
          </div>

          {data.totals.guest_orders > 0 ? (
            <Caption>{t('guestOrders', { count: data.totals.guest_orders })}</Caption>
          ) : null}

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <h3 className="font-display text-lg font-semibold">{t('top')}</h3>
              {data.top_customers.length === 0 ? (
                <EmptyNote>{t('topEmpty')}</EmptyNote>
              ) : (
                <div className="mt-3 max-h-96 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="pb-1 font-normal">{t('col.customer')}</th>
                        <th className="pb-1 text-right font-normal">{t('col.orders')}</th>
                        <th className="pb-1 text-right font-normal">{t('col.spend')}</th>
                        <th className="pb-1 text-right font-normal">{t('col.lifetime')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.top_customers.map((c) => (
                        <tr key={c.customer_id} className="border-t border-border">
                          <td className="max-w-[14rem] truncate py-1.5 pr-2 font-medium">
                            {/* has_name false: the report's stand-in for a customer with no name on file. */}
                            {c.has_name === false ? t('unnamedCustomer') : c.name}
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
              <Caption>{t('topCaption')}</Caption>
            </Card>

            <div className="space-y-4">
              <Card className="p-5">
                <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
                  <Gift className="h-4 w-4" /> {t('points')}
                </h3>
                <dl className="mt-3 space-y-1.5 text-sm">
                  <PointRow
                    label={t('earned')}
                    value={signedPoints(data.totals.points_earned)}
                    tone="success"
                  />
                  <PointRow
                    label={t('redeemed')}
                    value={signedPoints(-data.totals.points_redeemed)}
                    tone="warning"
                  />
                  {ledger?.points_returned != null ? (
                    <PointRow label={t('returned')} value={signedPoints(ledger.points_returned)} />
                  ) : null}
                  {ledger?.points_birthday != null ? (
                    <PointRow
                      label={t('birthday')}
                      value={signedPoints(ledger.points_birthday)}
                      tone={ledger.points_birthday > 0 ? 'success' : undefined}
                    />
                  ) : null}
                  <PointRow label={t('manual')} value={signedPoints(data.totals.points_manual)} />
                </dl>
                <Caption>{t('pointsCaption')}</Caption>
              </Card>

              <Card className="p-5">
                <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
                  <Ticket className="h-4 w-4" /> {t('coupons')}
                </h3>
                {data.by_coupon.length === 0 ? (
                  <EmptyNote>{t('couponsEmpty')}</EmptyNote>
                ) : (
                  <table className="mt-3 w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="pb-1 font-normal">{t('col.code')}</th>
                        <th className="pb-1 text-right font-normal">{t('col.uses')}</th>
                        <th className="pb-1 text-right font-normal">{t('col.givenAway')}</th>
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
                  {t('couponsCaption', {
                    count: data.totals.coupon_uses,
                    amount: money(data.totals.coupon_discount),
                  })}
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
