import Link from 'next/link';
import {
  AlertTriangle,
  Banknote,
  Bike,
  CalendarClock,
  ChefHat,
  Clock,
  DollarSign,
  Hourglass,
  Package,
  Receipt,
  RotateCcw,
  Sparkles,
  Timer,
  UserPlus,
  Wallet,
} from 'lucide-react';
import {
  branchDayKey,
  getEntitlementsForBranch,
  loadBranchDashboard,
  shiftDayKey,
} from '@favornoms/database/queries';
import { formatCurrency, hasFeature, trialDaysLeft } from '@favornoms/shared';
import { Card } from '@favornoms/ui';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import {
  ageLabel,
  readDeliveries,
  readKitchen,
  readScheduled,
  SCHEDULED_SOON_MS,
  type ActionRow,
} from './_components/action-model';
import { ActionRequired, type ActionBucket } from './_components/action-required';
import { AutoRefresh } from './_components/auto-refresh';
import { OverviewTiles, type OverviewTile } from './_components/overview-tiles';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ branchId: string }>;
}

/** Action Required lists the oldest few of each bucket and links out for the rest. */
const ROWS_PER_BUCKET = 5;

export default async function DashboardPage({ params }: Props) {
  const { branchId } = await params;
  // This page used to take a raw server client, so it had no capability set and no branch
  // name — it could neither hide a bucket a narrower role may not read nor say whose
  // branch it was reporting on.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/dashboard`);
  if (!can('dashboard.view')) {
    return (
      <AccessDenied
        title="No dashboard access"
        reason={`Your role cannot see the dashboard for ${branch.name}.`}
      />
    );
  }

  // No item cap and no orders/month cap exist any more (owner decision
  // 2026-07-25), so the old "10/30 items used" nag is gone. What is worth
  // surfacing here is the trial clock — it is the only thing that expires.
  const entitlements = await getEntitlementsForBranch(supabase, branchId);
  const trialDays = trialDaysLeft(entitlements);
  const deliveryEnabled = hasFeature(entitlements, 'delivery');

  const now = Date.now();
  const yesterdaySameTime = now - 24 * 60 * 60 * 1000;

  // The capability set has to be resolved before the reads: it decides which of them are
  // issued at all, and firing everything at once on a freshly-expired token races the
  // refresh the awaits above have already settled.
  const snapshot = await loadBranchDashboard(supabase, branchId, {
    canViewPayments: can('payments.view'),
    canRefund: can('orders.refund'),
    canManageInventory: can('inventory.manage'),
    canManageDrivers: can('drivers.manage'),
    deliveryEnabled,
    now,
    scheduledWithinMs: SCHEDULED_SOON_MS,
  });

  const { currency, settings, timezone: tz } = snapshot;
  const selfDelivery = settings.delivery_mode === 'self';
  // place-order's own fallback order: the explicit lead time, then the prep time, then 15.
  const leadMs =
    60_000 * (Number(settings.schedule_lead_time_min) || Number(settings.prep_time_min) || 15);

  const kitchen = readKitchen(snapshot.kitchen.rows, now, leadMs, branchId);
  const deliveries = readDeliveries(snapshot.deliveries.rows, now, selfDelivery, branchId);
  const scheduled = readScheduled(snapshot.scheduled.rows, now, leadMs, branchId);

  // "Today" has to mean the branch's today. This used to bucket on the server's
  // clock, so a New York merchant on a UTC host watched their day roll over at
  // 8pm — mid-dinner-service.
  const earning = (s: string) =>
    ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed'].includes(s);

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const todayKey = branchDayKey(new Date(now), tz);
  const trend: { key: string; label: string; revenue: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const key = shiftDayKey(todayKey, -i);
    trend.push({
      key,
      label: i === 0 ? 'Today' : (DOW[new Date(`${key}T12:00:00Z`).getUTCDay()] ?? ''),
      revenue: 0,
    });
  }
  const yesterdayKey = shiftDayKey(todayKey, -1);

  let todayOrders = 0;
  let yOrders = 0;
  let yRevenue = 0;
  for (const o of snapshot.trend.rows) {
    const at = new Date(o.created_at);
    const key = branchDayKey(at, tz);
    const bucket = trend.find((t) => t.key === key);
    if (bucket && earning(o.status)) bucket.revenue += o.total;
    if (key === todayKey) todayOrders += 1;
    // Same clock time yesterday, not all of yesterday: comparing a morning's
    // takings against a full previous day shows a red arrow until late afternoon.
    if (key === yesterdayKey && at.getTime() < yesterdaySameTime) {
      yOrders += 1;
      if (earning(o.status)) yRevenue += o.total;
    }
  }
  const totalRevenue = trend[6]?.revenue ?? 0;
  const trendMax = Math.max(1, ...trend.map((t) => t.revenue));

  // undefined, not 0, when there is no baseline: "+0.0%" against a day with no
  // trade is a number the merchant would act on, and it means nothing.
  const delta = (a: number, prev: number) => (prev > 0 ? ((a - prev) / prev) * 100 : undefined);

  const salesFailed = !!snapshot.trend.error;
  const tiles: OverviewTile[] = [
    {
      label: "Today's Sales",
      // Reports offers 7/30/90 days only, so ?days=1 would land on a range with no pill
      // selected. The plain screen is the one that answers "show me the money".
      href: `/b/${branchId}/reports`,
      value: salesFailed ? '—' : formatCurrency(totalRevenue, currency),
      sub: salesFailed ? 'Could not read sales' : null,
      delta: salesFailed ? undefined : delta(totalRevenue, yRevenue),
      deltaLabel: 'vs same time yesterday',
      icon: DollarSign,
      tone: 'primary',
    },
    {
      label: 'Orders Today',
      href: `/b/${branchId}/orders?range=today`,
      value: salesFailed ? '—' : todayOrders.toString(),
      sub: salesFailed ? 'Could not read orders' : null,
      delta: salesFailed ? undefined : delta(todayOrders, yOrders),
      deltaLabel: 'vs same time yesterday',
      icon: Receipt,
      tone: 'accent',
    },
    {
      label: 'Kitchen Queue',
      href: `/kitchen/${branchId}`,
      value: snapshot.kitchen.error ? '—' : (kitchen.waiting + kitchen.cooking).toString(),
      // The old "In kitchen" tile counted confirmed+preparing and ignored held and
      // awaiting_payment, so it never matched the board it was describing.
      sub: snapshot.kitchen.error
        ? 'Could not read the kitchen'
        : `${kitchen.waiting} waiting · ${kitchen.cooking} cooking` +
          (kitchen.abandoned > 0 ? ` · ${kitchen.abandoned} stalled` : ''),
      icon: ChefHat,
      tone: 'warning',
    },
    {
      label: 'Active Deliveries',
      href: deliveryEnabled ? `/b/${branchId}/deliveries` : `/b/${branchId}/settings/plan`,
      value: !deliveryEnabled || snapshot.deliveries.error ? '—' : deliveries.inFlight.toString(),
      // Without the stalled line a truthful 0 reads as a broken tile: one branch carries
      // thirteen June test runs that the board itself parks as forgotten.
      sub: !deliveryEnabled
        ? "Delivery isn't on your plan"
        : snapshot.deliveries.error
          ? 'Could not read deliveries'
          : deliveries.stalled > 0
            ? `${deliveries.stalled} stalled`
            : null,
      icon: Bike,
      tone: 'success',
    },
  ];

  const cap = (rows: ActionRow[]) => rows.slice(0, ROWS_PER_BUCKET);

  const proofRows: ActionRow[] = snapshot.proofs.rows.map((p) => {
    const at = p.submitted_at ?? p.created_at;
    return {
      key: p.payment_id,
      title: `#${p.order_number}`,
      why:
        `${formatCurrency(p.amount, currency)} slip waiting — ` +
        'the kitchen cannot start until you decide',
      age: ageLabel(at, now),
      ageMs: now - Date.parse(at),
      href: `/b/${branchId}/orders`,
    };
  });

  const refundRows: ActionRow[] = snapshot.refundable.rows.map((o) => ({
    key: o.id,
    title: `#${o.order_number}`,
    why: `Cancelled with ${formatCurrency(o.total, currency)} still taken`,
    age: ageLabel(o.created_at, now),
    ageMs: now - Date.parse(o.created_at),
    href: `/b/${branchId}/orders?q=${encodeURIComponent(o.order_number)}`,
  }));

  const stockRows: ActionRow[] = snapshot.lowStock.rows.map((i) => ({
    key: i.id,
    title: i.name,
    why: i.is_sold_out
      ? 'Sold out — diners cannot order it'
      : `${i.stock_quantity ?? 0} left (alerts at ${i.low_stock_threshold ?? 0})`,
    // Stock has no waiting clock of its own: nothing records when an item ran down.
    age: '',
    ageMs: 0,
    href: `/b/${branchId}/inventory`,
  }));

  // One row per rider, not one per reason: a new applicant whose documents are also
  // unverified is one person to look at, not two jobs.
  const riderRows: ActionRow[] = [];
  for (const r of snapshot.riderQueue.rows) {
    const reasons: string[] = [];
    if (r.approval_status === 'pending') reasons.push('waiting for your decision');
    if (r.kyc_status === 'pending') reasons.push('documents not verified yet');
    if (reasons.length === 0) continue;
    const at = r.applied_at;
    riderRows.push({
      key: r.id,
      title: r.driver_name,
      why: `Applied — ${reasons.join(' · ')}`,
      age: at ? ageLabel(at, now) : '',
      ageMs: at ? now - Date.parse(at) : 0,
      href: `/b/${branchId}/drivers`,
    });
  }
  riderRows.sort((a, b) => b.ageMs - a.ageMs);

  const withdrawalRows: ActionRow[] = snapshot.withdrawals.rows.map((w) => ({
    key: w.id,
    title: w.driver_name,
    why: `Requested ${formatCurrency(w.amount, currency)}`,
    age: ageLabel(w.created_at, now),
    ageMs: now - Date.parse(w.created_at),
    href: `/b/${branchId}/payouts`,
  }));

  const deliveriesUnavailable = !snapshot.deliveries.available;
  const buckets: ActionBucket[] = [
    {
      id: 'proofs',
      label: 'Payment slips to approve',
      icon: Banknote,
      tone: 'danger',
      count: snapshot.proofs.total,
      rows: cap(proofRows),
      href: `/b/${branchId}/orders`,
      hrefLabel: 'Orders',
      error: snapshot.proofs.error,
      hidden: !snapshot.proofs.available,
    },
    {
      id: 'refunds',
      label: 'Refunds owed',
      icon: RotateCcw,
      tone: 'danger',
      count: refundRows.length,
      rows: cap(refundRows),
      href: `/b/${branchId}/orders?status=cancelled`,
      hrefLabel: 'Orders',
      error: snapshot.refundable.error,
      hidden: !snapshot.refundable.available,
    },
    {
      id: 'delivery-failed',
      label: 'Riders reporting a problem',
      icon: AlertTriangle,
      tone: 'danger',
      count: deliveries.failed.length,
      rows: cap(deliveries.failed),
      href: `/b/${branchId}/orders`,
      hrefLabel: 'Orders',
      error: snapshot.deliveries.error,
      hidden: deliveriesUnavailable,
    },
    {
      id: 'delivery-unaccepted',
      label: 'Deliveries nobody has taken',
      icon: Bike,
      tone: 'warning',
      count: deliveries.unaccepted.length,
      rows: cap(deliveries.unaccepted),
      href: `/b/${branchId}/deliveries`,
      hrefLabel: 'Live deliveries',
      error: snapshot.deliveries.error,
      hidden: deliveriesUnavailable,
    },
    {
      id: 'customers-waiting',
      label: 'Customers waiting',
      icon: Clock,
      tone: 'warning',
      count: kitchen.customersWaiting.length,
      rows: cap(kitchen.customersWaiting),
      href: `/kitchen/${branchId}`,
      hrefLabel: 'the kitchen display',
      error: snapshot.kitchen.error,
    },
    {
      id: 'kitchen-late',
      label: 'Kitchen running late',
      icon: Timer,
      tone: 'warning',
      count: kitchen.kitchenLate.length,
      rows: cap(kitchen.kitchenLate),
      href: `/kitchen/${branchId}`,
      hrefLabel: 'the kitchen display',
      error: snapshot.kitchen.error,
    },
    {
      id: 'scheduled',
      label: 'Pre-orders due soon',
      icon: CalendarClock,
      tone: 'warning',
      count: scheduled.length,
      rows: cap(scheduled),
      href: `/b/${branchId}/orders?when=scheduled`,
      hrefLabel: 'Orders',
      error: snapshot.scheduled.error,
    },
    {
      id: 'stock',
      label: 'Menu items out or running low',
      icon: Package,
      tone: 'warning',
      count: snapshot.lowStock.total,
      rows: cap(stockRows),
      href: `/b/${branchId}/inventory`,
      hrefLabel: 'Inventory',
      error: snapshot.lowStock.error,
      hidden: !snapshot.lowStock.available,
    },
    {
      id: 'riders',
      label: 'Riders waiting on you',
      icon: UserPlus,
      tone: 'info',
      count: riderRows.length,
      rows: cap(riderRows),
      href: `/b/${branchId}/drivers`,
      hrefLabel: 'Drivers',
      error: snapshot.riderQueue.error,
      hidden: !snapshot.riderQueue.available,
    },
    {
      id: 'withdrawals',
      label: 'Withdrawals to pay',
      icon: Wallet,
      tone: 'info',
      count: snapshot.withdrawals.total,
      rows: cap(withdrawalRows),
      href: `/b/${branchId}/payouts`,
      hrefLabel: 'Driver payouts',
      error: snapshot.withdrawals.error,
      hidden: !snapshot.withdrawals.available,
    },
    {
      // Not on the owner's list, but a board carrying twenty-two forgotten tickets while
      // this page says "nothing needs you" is the one way the section loses its credit.
      id: 'stalled',
      label: 'Stalled kitchen tickets',
      icon: Hourglass,
      tone: 'info',
      count: kitchen.abandoned,
      rows: [],
      href: `/kitchen/${branchId}`,
      hrefLabel: 'the kitchen display',
      error: snapshot.kitchen.error,
    },
  ];

  const checkedAt = new Date(now).toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Today at a glance</h1>
        <p className="mt-1 text-muted-foreground">Live metrics from {branch.name}</p>
      </header>

      {trialDays !== null && (
        <Card className="mb-6 flex items-center justify-between gap-4 border-amber-500/40 bg-amber-500/5 p-4 px-2 lg:px-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-500/15 text-amber-600">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold">
                {trialDays === 0
                  ? 'Your free trial ends today'
                  : `${trialDays} day${trialDays === 1 ? '' : 's'} left in your free trial`}
              </p>
              <p className="text-xs text-muted-foreground">
                Everything is unlocked. Choose a package to keep it — no card needed until then.
              </p>
            </div>
          </div>
          <Link
            href={`/b/${branchId}/settings/plan`}
            className="focus-ring inline-flex items-center rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-soft hover:bg-amber-600"
          >
            Choose a package
          </Link>
        </Card>
      )}

      <section>
        <h2 className="mb-3 px-2 font-display text-xl font-semibold lg:px-0">Business overview</h2>
        <OverviewTiles tiles={tiles} />
      </section>

      <ActionRequired buckets={buckets} checkedAt={checkedAt} />

      <div className="mt-8 px-2 lg:px-0">
        <Card className="p-6">
          <h2 className="font-display text-lg font-semibold">Sales trend</h2>
          <p className="text-sm text-muted-foreground">Last 7 days</p>
          {/* Real revenue per day. This was a fixed array of made-up figures
              (6200, 7800, 9100 …) that every branch saw as its own trade, with
              weekday labels that never matched the actual days either. */}
          <div className="mt-4 flex h-40 items-end gap-2">
            {trend.map((t) => {
              const h = Math.round((t.revenue / trendMax) * 100);
              return (
                <div key={t.key} className="flex flex-1 flex-col items-center gap-2">
                  <div
                    className="relative w-full overflow-hidden rounded-lg bg-muted"
                    style={{ height: '128px' }}
                    title={`${t.label} · ${formatCurrency(t.revenue, currency)}`}
                  >
                    <div
                      className="absolute inset-x-0 bottom-0 rounded-lg bg-gradient-warm"
                      style={{ height: `${h}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground">{t.label}</span>
                </div>
              );
            })}
          </div>
          {salesFailed ? (
            <p role="alert" className="mt-2 text-xs text-warning">
              Couldn’t read this branch’s sales — {snapshot.trend.error}
            </p>
          ) : (
            trendMax === 1 && (
              <p className="mt-2 text-xs text-muted-foreground">No sales in the last 7 days yet.</p>
            )
          )}
        </Card>
      </div>

      <AutoRefresh />
    </div>
  );
}
