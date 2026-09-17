'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Bike, Clock, Coins, Star, Timer } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { formatCurrency } from '@favornoms/shared';
import { Kpi } from './kpi';
import { Caption, EmptyNote, SectionFrame } from './section-frame';
import type { DeliveryReport, SectionResult } from './report-queries';

export function SectionDelivery({
  result,
  currency,
  branchId,
}: {
  result: SectionResult<DeliveryReport>;
  currency: string;
  branchId: string;
}) {
  const t = useTranslations('reports.delivery');
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);
  const minutes = (n: number) => (n > 0 ? t('minutes', { minutes: n }) : '—');
  const maxStars = Math.max(1, ...(data?.star_distribution ?? []).map((s) => s.count));

  return (
    <SectionFrame
      id="delivery"
      title={t('title')}
      icon={<Bike className="h-5 w-5" />}
      caption={t('caption')}
      error={result.error ?? (data ? null : { code: 'emptyResponse', ref: null })}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Kpi
              icon={<Bike className="h-5 w-5" />}
              label={t('delivered')}
              value={data.totals.completed.toString()}
              hint={t('deliveredHint', { count: data.totals.deliveries })}
              tone="success"
            />
            <Kpi
              icon={<Timer className="h-5 w-5" />}
              label={t('rideTime')}
              value={minutes(data.totals.avg_ride_min)}
              hint={t('rideTimeHint')}
            />
            <Kpi
              icon={<Clock className="h-5 w-5" />}
              label={t('doorToDoor')}
              value={minutes(data.totals.avg_total_min)}
              hint={t('doorToDoorHint')}
            />
            <Kpi
              icon={<Star className="h-5 w-5" />}
              label={t('rating')}
              value={data.totals.rating_count > 0 ? `${data.totals.avg_stars} ★` : '—'}
              hint={t('ratingHint', { count: data.totals.rating_count })}
            />
            <Kpi
              icon={<Coins className="h-5 w-5" />}
              label={t('deliveryFees')}
              value={money(data.totals.delivery_fees)}
              hint={t('deliveryFeesHint')}
            />
            <Kpi
              icon={<Coins className="h-5 w-5" />}
              label={t('tips')}
              value={money(data.totals.tips_charged)}
              hint={t('tipsHint', { amount: money(data.totals.tips_to_riders) })}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('howItWent')}</h3>
              <dl className="mt-3 space-y-1.5 text-sm">
                <StatRow label={t('delivered')} value={data.totals.completed.toString()} />
                <StatRow label={t('stillOut')} value={data.totals.in_flight.toString()} />
                <StatRow label={t('failed')} value={data.totals.failed.toString()} />
                <StatRow label={t('cancelled')} value={data.totals.cancelled.toString()} />
                <div className="my-2 border-t border-border" />
                <StatRow
                  label={t('avgDistance')}
                  value={data.totals.avg_distance_km > 0 ? `${data.totals.avg_distance_km} km` : '—'}
                />
                <StatRow label={t('timeToAccept')} value={minutes(data.totals.avg_accept_min)} />
                <StatRow label={t('riderPayouts')} value={money(data.totals.rider_payouts)} />
                <StatRow label={t('houseTips')} value={money(data.totals.tips_to_house)} />
              </dl>
              <Caption>{t('howItWentCaption')}</Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('stars')}</h3>
              {data.totals.rating_count === 0 ? (
                <EmptyNote>{t('starsEmpty')}</EmptyNote>
              ) : (
                <ul className="mt-3 space-y-2">
                  {[...data.star_distribution].reverse().map((s) => (
                    <li key={s.star} className="flex items-center gap-2 text-sm">
                      <span className="w-10 shrink-0 tabular-nums">{s.star} ★</span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${(s.count / maxStars) * 100}%` }}
                        />
                      </span>
                      <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                        {s.count}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Caption>
                {t.rich('ratingsLink', {
                  link: (chunks) => (
                    <Link href={`/b/${branchId}/ratings`} className="focus-ring underline">
                      {chunks}
                    </Link>
                  ),
                })}
              </Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('byRider')}</h3>
              {data.by_driver.length === 0 ? (
                <EmptyNote>{t('byRiderEmpty')}</EmptyNote>
              ) : (
                <div className="mt-3 max-h-72 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="pb-1 font-normal">{t('col.rider')}</th>
                        <th className="pb-1 text-right font-normal">{t('col.done')}</th>
                        <th className="pb-1 text-right font-normal">{t('col.ride')}</th>
                        <th className="pb-1 text-right font-normal">{t('col.tips')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_driver.map((d) => (
                        <tr key={d.driver_id} className="border-t border-border">
                          <td className="max-w-[10rem] truncate py-1.5 pr-2 font-medium">
                            {/* has_name false: the report's stand-in for a rider with no name on file. */}
                            {d.has_name === false ? t('unnamedRider') : d.name}
                            {d.avg_stars > 0 ? (
                              <span className="ml-1 text-xs text-muted-foreground">
                                {d.avg_stars} ★
                              </span>
                            ) : null}
                          </td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">{d.delivered}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                            {d.avg_ride_min > 0
                              ? t('minutesShort', { minutes: d.avg_ride_min })
                              : '—'}
                          </td>
                          <td className="py-1.5 text-right font-semibold tabular-nums">
                            {money(d.tips)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </>
      ) : null}
    </SectionFrame>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
