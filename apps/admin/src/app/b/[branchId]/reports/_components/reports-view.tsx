'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { ExportButtons } from './export-buttons';
import { RangePicker } from './range-picker';
import { SectionSales } from './section-sales';
import { SectionOrders } from './section-orders';
import { SectionMenu } from './section-menu';
import { SectionDelivery } from './section-delivery';
import { SectionCustomers } from './section-customers';
import { SectionPayments } from './section-payments';
import { reportRangeLabel, type ReportRange } from './report-range';
import type { ReportSections } from './report-queries';

interface Props {
  branchId: string;
  timezone: string;
  currency: string;
  range: ReportRange;
  /** The branch's calendar date, resolved on the server so the picker cannot disagree
   *  with the report about which day "today" is. */
  today: string;
  sections: ReportSections;
}

const ANCHORS = [
  { id: 'sales', label: 'Sales' },
  { id: 'orders', label: 'Orders' },
  { id: 'menu', label: 'Menu' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'customers', label: 'Customers' },
  { id: 'payments', label: 'Payments' },
];

export function ReportsView({
  branchId,
  timezone,
  currency,
  range,
  today,
  sections,
}: Props) {
  const router = useRouter();
  const results = Object.values(sections);
  const allFailed = results.every((r) => r.data === null);

  const title = (
    <header className="mb-3 flex flex-wrap items-end justify-between gap-3 px-2 pl-16 lg:px-0">
      <div>
        <h1 className="font-display text-3xl font-bold">Reports</h1>
        <p className="mt-1 text-muted-foreground">
          {reportRangeLabel(range)} · {range.from} to {range.to} ({timezone})
        </p>
      </div>
      {/* Export stays out of the pinned bar below: seven buttons wrap to three rows on a
          phone, which would spend a third of the screen on something clicked once. */}
      <ExportButtons branchId={branchId} range={range} />
    </header>
  );

  // The owner reads six sections in one scroll, and the controls used to scroll away with
  // the title: changing the range or jumping to Payments meant going back to the top. The
  // bar renders in the failed state too, because a merchant staring at an error still needs
  // a way to ask for a different range.
  //
  // The negative margins cancel `container`'s padding so the bar's own background hides the
  // cards passing underneath; the padding restores it, plus the `px-2` the title carries so
  // the picker stays aligned with the export buttons. z-20 keeps it under the fixed
  // hamburger (z-30), which has to stay clickable, and `pl-16` is that same hamburger —
  // without it the controls pin themselves underneath it on a phone.
  const toolbar = (withTabs: boolean) => (
    <div className="sticky top-0 z-20 -mx-4 mb-4 border-b border-border bg-background/95 px-6 py-2 backdrop-blur sm:-mx-6 sm:px-8 lg:-mx-8 lg:px-8">
      <div className="flex flex-wrap items-center justify-end gap-3 pl-16 lg:pl-0">
        <RangePicker range={range} today={today} />
      </div>
      {withTabs && (
        // overflow-x-auto belongs on the nav and never on the sticky wrapper: it resolves
        // overflow-y to auto as well, which would turn the bar into a scroll container and
        // clip the range picker's pills.
        <nav aria-label="Report sections" className="mt-2 flex gap-1 overflow-x-auto pl-16 lg:pl-0">
          {ANCHORS.map((a) => (
            <a
              key={a.id}
              href={`#${a.id}`}
              className="focus-ring whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {a.label}
            </a>
          ))}
        </nav>
      )}
    </div>
  );

  if (allFailed) {
    // Failure is not an empty week. "Try again later" is unactionable, so show the real
    // database error the merchant can quote to support.
    const first = results.find((r) => r.error)?.error;
    return (
      <div className="container max-w-6xl py-8">
        {title}
        {toolbar(false)}
        <Card className="p-6" role="alert">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-danger">
            <AlertTriangle className="h-5 w-5" /> Reports could not be loaded
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your sales data is safe — this is a problem reading it, not a problem with your
            orders. Reload the page; if it keeps happening, send the message below to support.
          </p>
          <p className="mt-3 break-words rounded-xl bg-danger/10 px-4 py-3 font-mono text-xs text-danger">
            {first ?? 'Unknown error from the reports service.'}
          </p>
          <div className="mt-4">
            <Button
              variant="outline"
              leftIcon={<RefreshCw className="h-4 w-4" />}
              onClick={() => router.refresh()}
            >
              Try again
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const orders = sections.orders.data;
  if (orders && orders.totals.orders === 0) {
    return (
      <div className="container max-w-6xl py-8">
        {title}
        {toolbar(false)}
        <Card className="p-6 text-center">
          <h2 className="font-display text-lg font-semibold">
            No orders between {range.from} and {range.to}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Reports loaded fine — this branch just hasn&apos;t taken an order in this window.
            Try a wider range above.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-6xl py-8">
      {title}
      {toolbar(true)}

      <SectionSales result={sections.sales} currency={currency} />
      <SectionOrders result={sections.orders} currency={currency} timezone={timezone} />
      <SectionMenu result={sections.menu} currency={currency} />
      <SectionDelivery result={sections.delivery} currency={currency} branchId={branchId} />
      <SectionCustomers result={sections.customers} currency={currency} />
      <SectionPayments result={sections.payments} currency={currency} branchId={branchId} />
    </div>
  );
}
