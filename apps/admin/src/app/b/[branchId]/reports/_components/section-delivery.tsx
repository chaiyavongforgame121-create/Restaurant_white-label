'use client';

import * as React from 'react';
import Link from 'next/link';
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
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);
  const maxStars = Math.max(1, ...(data?.star_distribution ?? []).map((s) => s.count));

  return (
    <SectionFrame
      id="delivery"
      title="Delivery"
      icon={<Bike className="h-5 w-5" />}
      caption="Deliveries for orders taken in this range, timed from the rider's own stamps."
      error={result.error ?? (data ? null : 'No delivery payload was returned.')}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Kpi
              icon={<Bike className="h-5 w-5" />}
              label="Delivered"
              value={data.totals.completed.toString()}
              hint={`${data.totals.deliveries} dispatched`}
              tone="success"
            />
            <Kpi
              icon={<Timer className="h-5 w-5" />}
              label="Ride time"
              value={data.totals.avg_ride_min > 0 ? `${data.totals.avg_ride_min} min` : '—'}
              hint="Pickup to doorstep"
            />
            <Kpi
              icon={<Clock className="h-5 w-5" />}
              label="Door to door"
              value={data.totals.avg_total_min > 0 ? `${data.totals.avg_total_min} min` : '—'}
              hint="Order placed to delivered"
            />
            <Kpi
              icon={<Star className="h-5 w-5" />}
              label="Delivery rating"
              value={data.totals.rating_count > 0 ? `${data.totals.avg_stars} ★` : '—'}
              hint={`${data.totals.rating_count} rated`}
            />
            <Kpi
              icon={<Coins className="h-5 w-5" />}
              label="Delivery fees"
              value={money(data.totals.delivery_fees)}
              hint="Charged to the diner"
            />
            <Kpi
              icon={<Coins className="h-5 w-5" />}
              label="Tips"
              value={money(data.totals.tips_charged)}
              hint={`${money(data.totals.tips_to_riders)} to riders`}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">How it went</h3>
              <dl className="mt-3 space-y-1.5 text-sm">
                <StatRow label="Delivered" value={data.totals.completed.toString()} />
                <StatRow label="Still out" value={data.totals.in_flight.toString()} />
                <StatRow label="Failed" value={data.totals.failed.toString()} />
                <StatRow label="Cancelled" value={data.totals.cancelled.toString()} />
                <div className="my-2 border-t border-border" />
                <StatRow
                  label="Average distance"
                  value={data.totals.avg_distance_km > 0 ? `${data.totals.avg_distance_km} km` : '—'}
                />
                <StatRow
                  label="Time to accept an offer"
                  value={
                    data.totals.avg_accept_min > 0 ? `${data.totals.avg_accept_min} min` : '—'
                  }
                />
                <StatRow label="Rider payouts" value={money(data.totals.rider_payouts)} />
                <StatRow label="Tips kept by the house" value={money(data.totals.tips_to_house)} />
              </dl>
              <Caption>
                On-time percentage is not shown: no promised-delivery time is recorded
                anywhere, so there is nothing honest to measure lateness against.
              </Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">Delivery stars</h3>
              {data.totals.rating_count === 0 ? (
                <EmptyNote>No diner rated a delivery in this range.</EmptyNote>
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
                <Link href={`/b/${branchId}/ratings`} className="focus-ring underline">
                  Full reviews live on the Ratings page
                </Link>
                .
              </Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">By rider</h3>
              {data.by_driver.length === 0 ? (
                <EmptyNote>No rider took a delivery in this range.</EmptyNote>
              ) : (
                <div className="mt-3 max-h-72 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="pb-1 font-normal">Rider</th>
                        <th className="pb-1 text-right font-normal">Done</th>
                        <th className="pb-1 text-right font-normal">Ride</th>
                        <th className="pb-1 text-right font-normal">Tips</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_driver.map((d) => (
                        <tr key={d.driver_id} className="border-t border-border">
                          <td className="max-w-[10rem] truncate py-1.5 pr-2 font-medium">
                            {d.name}
                            {d.avg_stars > 0 ? (
                              <span className="ml-1 text-xs text-muted-foreground">
                                {d.avg_stars} ★
                              </span>
                            ) : null}
                          </td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">{d.delivered}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                            {d.avg_ride_min > 0 ? `${d.avg_ride_min}m` : '—'}
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
