import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
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
import {
  DEFAULT_UI_LOCALE,
  formatCurrency,
  formatInZone,
  hasFeature,
  intlLocaleFor,
  isTrialing,
  isUiLocale,
  trialDaysLeft,
  type UiLocale,
} from '@favornoms/shared';
import { Card } from '@favornoms/ui';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import {
  readDeliveries,
  readKitchen,
  readScheduled,
  SCHEDULED_SOON_MS,
  spanSince,
  type ActionRow,
  type RowAge,
  type RowReason,
  type Span,
} from './_components/action-model';
import {
  ActionRequired,
  type ActionBucket,
  type ActionLine,
} from './_components/action-required';
import { AutoRefresh } from './_components/auto-refresh';
import { OverviewTiles, type OverviewTile } from './_components/overview-tiles';
import {
  paymentMethodOn,
  SetupChecklist,
  type SetupStep,
  type SetupWarning,
} from './_components/setup-checklist';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ branchId: string }>;
}

/** Action Required lists the oldest few of each bucket and links out for the rest. */
const ROWS_PER_BUCKET = 5;

/** Order statuses the catalogue can name. Anything else is printed as its code. */
const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'completed',
  'cancelled',
  'refunded',
] as const;
type KnownOrderStatus = (typeof ORDER_STATUSES)[number];
const isKnownOrderStatus = (s: string): s is KnownOrderStatus =>
  (ORDER_STATUSES as readonly string[]).includes(s);

export default async function DashboardPage({ params }: Props) {
  const { branchId } = await params;
  // This page used to take a raw server client, so it had no capability set and no branch
  // name — it could neither hide a bucket a narrower role may not read nor say whose
  // branch it was reporting on.
  const { supabase, branch, can, role } = await getBranchAccess(
    branchId,
    `/b/${branchId}/dashboard`,
  );
  const [t, requestLocale] = await Promise.all([getTranslations('dashboard'), getLocale()]);
  const locale: UiLocale = isUiLocale(requestLocale) ? requestLocale : DEFAULT_UI_LOCALE;
  const intlLocale = intlLocaleFor(locale);
  if (!can('dashboard.view')) {
    return (
      <AccessDenied
        title={t('accessDenied.title')}
        reason={t('accessDenied.reason', { branch: branch.name })}
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
  // menu.manage is held by exactly owner, admin and manager: the people who can act on the
  // setup checklist. A cashier or kitchen account has nothing to do with a map pin.
  const showSetup = can('menu.manage');

  const [snapshot, setup] = await Promise.all([
    loadBranchDashboard(supabase, branchId, {
      canViewPayments: can('payments.view'),
      canRefund: can('orders.refund'),
      canManageInventory: can('inventory.manage'),
      canManageDrivers: can('drivers.manage'),
      deliveryEnabled,
      now,
      scheduledWithinMs: SCHEDULED_SOON_MS,
    }),
    // Two head-only counts and one two-column row. This page auto-refreshes, and the
    // checklist keeps asking on every refresh until the store is ready, so it must stay
    // cheaper than the reads it sits next to.
    showSetup
      ? Promise.all([
          supabase
            .from('menu_items')
            .select('id', { count: 'exact', head: true })
            .eq('branch_id', branchId)
            .eq('is_active', true),
          supabase
            .from('branch_hours')
            .select('id', { count: 'exact', head: true })
            .eq('branch_id', branchId),
          supabase.from('branches').select('geo_lat, geo_lng').eq('id', branchId).maybeSingle(),
        ])
      : null,
  ]);

  const { currency, settings, timezone: tz } = snapshot;

  // Raw database text belongs in the server log, not on a merchant's screen: every card that
  // depends on a failed read says "couldn't check" in the reader's language instead.
  const reads = {
    trend: snapshot.trend.error,
    kitchen: snapshot.kitchen.error,
    deliveries: snapshot.deliveries.error,
    proofs: snapshot.proofs.error,
    refundable: snapshot.refundable.error,
    lowStock: snapshot.lowStock.error,
    riderQueue: snapshot.riderQueue.error,
    withdrawals: snapshot.withdrawals.error,
    scheduled: snapshot.scheduled.error,
  };
  for (const [read, error] of Object.entries(reads)) {
    if (error) console.error(`[dashboard] ${read} read failed for branch ${branchId}:`, error);
  }
  const setupError = (check: string, error: { message: string } | null | undefined) => {
    if (!error) return null;
    console.error(`[dashboard] setup check "${check}" failed for branch ${branchId}:`, error.message);
    return error.message;
  };

  // A paid package runs for a fixed month and the expiry job switches the store off at the
  // deadline, mid-service if that is when it falls. Nothing warned anyone before it
  // happened, so this counts down the last week. Trials already have their own banner.
  const EXPIRY_WARN_DAYS = 7;
  const paidThroughMs = entitlements.entitledThrough
    ? Date.parse(entitlements.entitledThrough)
    : Number.NaN;
  const expiryDaysLeft =
    entitlements.entitled &&
    !isTrialing(entitlements) &&
    Number.isFinite(paidThroughMs) &&
    paidThroughMs - now <= EXPIRY_WARN_DAYS * 86_400_000
      ? Math.max(0, Math.ceil((paidThroughMs - now) / 86_400_000))
      : null;
  // Same rule as the plan page: billing.manage is owner-only in the matrix, but the owner's
  // admin may file package requests too.
  const canRenew = can('billing.manage') || role === 'admin';

  const branchSettingsHref = `/b/${branchId}/branch`;
  const [menuRes, hoursRes, geoRes] = setup ?? [null, null, null];
  const hasPin = geoRes?.data?.geo_lat != null && geoRes.data.geo_lng != null;
  const setupSteps: SetupStep[] =
    menuRes && hoursRes && geoRes
      ? [
          {
            id: 'menu',
            label: t('setup.menu.label'),
            why: t('setup.menu.why'),
            done: (menuRes.count ?? 0) > 0,
            href: `/b/${branchId}/menu`,
            hrefLabel: t('setup.menu.link'),
            error: setupError('menu', menuRes.error),
          },
          {
            id: 'pin',
            label: t('setup.pin.label'),
            why: t('setup.pin.why'),
            done: hasPin,
            href: branchSettingsHref,
            hrefLabel: t('setup.pin.link'),
            error: setupError('pin', geoRes.error),
          },
          {
            id: 'hours',
            label: t('setup.hours.label'),
            why: t('setup.hours.why'),
            done: (hoursRes.count ?? 0) > 0,
            href: branchSettingsHref,
            hrefLabel: t('setup.hours.link'),
            error: setupError('hours', hoursRes.error),
          },
          {
            id: 'payment',
            label: t('setup.payment.label'),
            why: t('setup.payment.why'),
            done: paymentMethodOn(
              settings,
              hasFeature(entitlements, 'card_payment'),
              deliveryEnabled && settings.scheduling_enabled !== false,
            ),
            href: branchSettingsHref,
            hrefLabel: t('setup.payment.link'),
          },
        ]
      : [];
  // Its own row, not just the unticked pin step: a store selling delivery with no pin takes
  // orders that no rider will ever be offered, which costs a customer, not only a setup tick.
  const setupWarnings: SetupWarning[] =
    deliveryEnabled && geoRes && !geoRes.error && !hasPin
      ? [
          {
            id: 'delivery-no-pin',
            label: t('setup.noPin.label'),
            why: t('setup.noPin.why'),
            href: branchSettingsHref,
            hrefLabel: t('setup.noPin.link'),
          },
        ]
      : [];
  const setupPending =
    setupWarnings.length > 0 || setupSteps.some((s) => !s.done || Boolean(s.error));
  const selfDelivery = settings.delivery_mode === 'self';
  // place-order's own fallback order: the explicit lead time, then the prep time, then 15.
  const leadMs =
    60_000 * (Number(settings.schedule_lead_time_min) || Number(settings.prep_time_min) || 15);

  const kitchen = readKitchen(snapshot.kitchen.rows, now, leadMs, branchId);
  const deliveries = readDeliveries(snapshot.deliveries.rows, now, selfDelivery, branchId);
  const scheduled = readScheduled(snapshot.scheduled.rows, now, leadMs, branchId);

  // --- Words for the model's codes -------------------------------------------------------
  const spanText = (span: Span): string => {
    switch (span.unit) {
      case 'unknown':
        return t('age.unknown');
      case 'underMinute':
        return t('age.underMinute');
      case 'minutes':
        return t('age.minutes', { minutes: span.minutes });
      case 'hours':
        return span.minutes
          ? t('age.hoursMinutes', { hours: span.hours, minutes: span.minutes })
          : t('age.hours', { hours: span.hours });
      case 'days':
        return t('age.days', { days: span.days });
    }
  };
  const ageText = (age: RowAge): string => {
    if (!age) return '';
    return age.kind === 'dueIn' ? t('age.dueIn', { span: spanText(age.span) }) : spanText(age.span);
  };
  const reasonText = (why: RowReason): string => {
    switch (why.code) {
      case 'cookingLong':
        return t('rows.cookingLong', { minutes: why.minutes });
      case 'deliveryKitchenStatus':
        return t('rows.deliveryKitchenStatus', {
          status: isKnownOrderStatus(why.status)
            ? t(`orderStatus.${why.status}`)
            : why.status.replace(/_/g, ' '),
        });
      case 'deliveryAskedRiders':
        return t('rows.deliveryAskedRiders', { count: why.count });
      case 'deliveryFailed':
        // The rider's own words are shown as typed.
        return t('rows.deliveryFailed', {
          reason: why.reason ?? t('rows.noReason'),
          age: spanText(why.startedAgo),
        });
      default:
        return t(`rows.${why.code}`);
    }
  };
  const toLine = (row: ActionRow): ActionLine => ({
    key: row.key,
    title: row.title ?? t('rows.deliveryTitle'),
    why: reasonText(row.why),
    age: ageText(row.age),
    href: row.href,
  });
  const lines = (rows: ActionRow[]) => rows.slice(0, ROWS_PER_BUCKET).map(toLine);

  // "Today" has to mean the branch's today. This used to bucket on the server's
  // clock, so a New York merchant on a UTC host watched their day roll over at
  // 8pm — mid-dinner-service.
  const earning = (s: string) =>
    ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed'].includes(s);

  // Noon UTC of a day key names that calendar day in every zone, so the weekday is read in UTC.
  const weekday = new Intl.DateTimeFormat(intlLocale, { weekday: 'short', timeZone: 'UTC' });
  const todayKey = branchDayKey(new Date(now), tz);
  const trend: { key: string; label: string; revenue: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const key = shiftDayKey(todayKey, -i);
    const noon = new Date(`${key}T12:00:00Z`);
    trend.push({
      key,
      label:
        i === 0 ? t('trend.today') : Number.isNaN(noon.getTime()) ? '' : weekday.format(noon),
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
    const bucket = trend.find((d) => d.key === key);
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
  const trendMax = Math.max(1, ...trend.map((d) => d.revenue));

  // undefined, not 0, when there is no baseline: "+0.0%" against a day with no
  // trade is a number the merchant would act on, and it means nothing.
  const delta = (a: number, prev: number) => (prev > 0 ? ((a - prev) / prev) * 100 : undefined);

  const salesFailed = !!snapshot.trend.error;
  const tiles: OverviewTile[] = [
    {
      label: t('overview.sales.label'),
      // Reports offers 7/30/90 days only, so ?days=1 would land on a range with no pill
      // selected. The plain screen is the one that answers "show me the money".
      href: `/b/${branchId}/reports`,
      value: salesFailed ? '—' : formatCurrency(totalRevenue, currency),
      sub: salesFailed ? t('overview.sales.failed') : null,
      delta: salesFailed ? undefined : delta(totalRevenue, yRevenue),
      deltaLabel: t('overview.vsYesterday'),
      icon: DollarSign,
      tone: 'primary',
    },
    {
      label: t('overview.orders.label'),
      href: `/b/${branchId}/orders?range=today`,
      value: salesFailed ? '—' : todayOrders.toString(),
      sub: salesFailed ? t('overview.orders.failed') : null,
      delta: salesFailed ? undefined : delta(todayOrders, yOrders),
      deltaLabel: t('overview.vsYesterday'),
      icon: Receipt,
      tone: 'accent',
    },
    {
      label: t('overview.kitchen.label'),
      href: `/kitchen/${branchId}`,
      value: snapshot.kitchen.error ? '—' : (kitchen.waiting + kitchen.cooking).toString(),
      // The old "In kitchen" tile counted confirmed+preparing and ignored held and
      // awaiting_payment, so it never matched the board it was describing.
      sub: snapshot.kitchen.error
        ? t('overview.kitchen.failed')
        : kitchen.abandoned > 0
          ? t('overview.kitchen.subStalled', {
              waiting: kitchen.waiting,
              cooking: kitchen.cooking,
              stalled: kitchen.abandoned,
            })
          : t('overview.kitchen.sub', { waiting: kitchen.waiting, cooking: kitchen.cooking }),
      icon: ChefHat,
      tone: 'warning',
    },
    {
      label: t('overview.deliveries.label'),
      href: deliveryEnabled ? `/b/${branchId}/deliveries` : `/b/${branchId}/settings/plan`,
      value: !deliveryEnabled || snapshot.deliveries.error ? '—' : deliveries.inFlight.toString(),
      // Without the stalled line a truthful 0 reads as a broken tile: one branch carries
      // thirteen June test runs that the board itself parks as forgotten.
      sub: !deliveryEnabled
        ? t('overview.deliveries.notOnPlan')
        : snapshot.deliveries.error
          ? t('overview.deliveries.failed')
          : deliveries.stalled > 0
            ? t('overview.deliveries.stalled', { count: deliveries.stalled })
            : null,
      icon: Bike,
      tone: 'success',
    },
  ];

  const proofRows: ActionLine[] = snapshot.proofs.rows.map((p) => {
    const at = p.submitted_at ?? p.created_at;
    return {
      key: p.payment_id,
      title: `#${p.order_number}`,
      why: t('rows.proof', { amount: formatCurrency(p.amount, currency) }),
      age: spanText(spanSince(at, now)),
      href: `/b/${branchId}/orders`,
    };
  });

  const refundRows: ActionLine[] = snapshot.refundable.rows.map((o) => ({
    key: o.id,
    title: `#${o.order_number}`,
    why: t('rows.refund', { amount: formatCurrency(o.total, currency) }),
    age: spanText(spanSince(o.created_at, now)),
    href: `/b/${branchId}/orders?q=${encodeURIComponent(o.order_number)}`,
  }));

  const stockRows: ActionLine[] = snapshot.lowStock.rows.map((i) => ({
    key: i.id,
    // The item's name as the merchant typed it.
    title: i.name,
    why: i.is_sold_out
      ? t('rows.soldOut')
      : t('rows.lowStock', {
          left: i.stock_quantity ?? 0,
          threshold: i.low_stock_threshold ?? 0,
        }),
    // Stock has no waiting clock of its own: nothing records when an item ran down.
    age: '',
    href: `/b/${branchId}/inventory`,
  }));

  // One row per rider, not one per reason: a new applicant whose documents are also
  // unverified is one person to look at, not two jobs.
  const riderQueue: { line: ActionLine; ageMs: number }[] = [];
  for (const r of snapshot.riderQueue.rows) {
    const awaitingDecision = r.approval_status === 'pending';
    const documentsPending = r.kyc_status === 'pending';
    if (!awaitingDecision && !documentsPending) continue;
    const at = r.applied_at;
    riderQueue.push({
      ageMs: at ? now - Date.parse(at) : 0,
      line: {
        key: r.id,
        title: r.driver_name,
        why: t(
          awaitingDecision && documentsPending
            ? 'rows.riderBoth'
            : awaitingDecision
              ? 'rows.riderDecision'
              : 'rows.riderDocuments',
        ),
        age: at ? spanText(spanSince(at, now)) : '',
        href: `/b/${branchId}/drivers`,
      },
    });
  }
  riderQueue.sort((a, b) => b.ageMs - a.ageMs);
  const riderRows = riderQueue.map((r) => r.line);

  const withdrawalRows: ActionLine[] = snapshot.withdrawals.rows.map((w) => ({
    key: w.id,
    title: w.driver_name,
    why: t('rows.withdrawal', { amount: formatCurrency(w.amount, currency) }),
    age: spanText(spanSince(w.created_at, now)),
    href: `/b/${branchId}/payouts`,
  }));

  const cap = (rows: ActionLine[]) => rows.slice(0, ROWS_PER_BUCKET);
  const deliveriesUnavailable = !snapshot.deliveries.available;
  const buckets: ActionBucket[] = [
    {
      id: 'proofs',
      label: t('buckets.proofs'),
      icon: Banknote,
      tone: 'danger',
      count: snapshot.proofs.total,
      rows: cap(proofRows),
      href: `/b/${branchId}/orders`,
      destination: 'orders',
      error: snapshot.proofs.error,
      hidden: !snapshot.proofs.available,
    },
    {
      id: 'refunds',
      label: t('buckets.refunds'),
      icon: RotateCcw,
      tone: 'danger',
      count: refundRows.length,
      rows: cap(refundRows),
      href: `/b/${branchId}/orders?status=cancelled`,
      destination: 'orders',
      error: snapshot.refundable.error,
      hidden: !snapshot.refundable.available,
    },
    {
      id: 'delivery-failed',
      label: t('buckets.deliveryFailed'),
      icon: AlertTriangle,
      tone: 'danger',
      count: deliveries.failed.length,
      rows: lines(deliveries.failed),
      href: `/b/${branchId}/orders`,
      destination: 'orders',
      error: snapshot.deliveries.error,
      hidden: deliveriesUnavailable,
    },
    {
      id: 'delivery-unaccepted',
      label: t('buckets.deliveryUnaccepted'),
      icon: Bike,
      tone: 'warning',
      count: deliveries.unaccepted.length,
      rows: lines(deliveries.unaccepted),
      href: `/b/${branchId}/deliveries`,
      destination: 'deliveries',
      error: snapshot.deliveries.error,
      hidden: deliveriesUnavailable,
    },
    {
      id: 'customers-waiting',
      label: t('buckets.customersWaiting'),
      icon: Clock,
      tone: 'warning',
      count: kitchen.customersWaiting.length,
      rows: lines(kitchen.customersWaiting),
      href: `/kitchen/${branchId}`,
      destination: 'kitchen',
      error: snapshot.kitchen.error,
    },
    {
      id: 'kitchen-late',
      label: t('buckets.kitchenLate'),
      icon: Timer,
      tone: 'warning',
      count: kitchen.kitchenLate.length,
      rows: lines(kitchen.kitchenLate),
      href: `/kitchen/${branchId}`,
      destination: 'kitchen',
      error: snapshot.kitchen.error,
    },
    {
      id: 'scheduled',
      label: t('buckets.scheduled'),
      icon: CalendarClock,
      tone: 'warning',
      count: scheduled.length,
      rows: lines(scheduled),
      href: `/b/${branchId}/orders?when=scheduled`,
      destination: 'orders',
      error: snapshot.scheduled.error,
    },
    {
      id: 'stock',
      label: t('buckets.stock'),
      icon: Package,
      tone: 'warning',
      count: snapshot.lowStock.total,
      rows: cap(stockRows),
      href: `/b/${branchId}/inventory`,
      destination: 'inventory',
      error: snapshot.lowStock.error,
      hidden: !snapshot.lowStock.available,
    },
    {
      id: 'riders',
      label: t('buckets.riders'),
      icon: UserPlus,
      tone: 'info',
      count: riderRows.length,
      rows: cap(riderRows),
      href: `/b/${branchId}/drivers`,
      destination: 'drivers',
      error: snapshot.riderQueue.error,
      hidden: !snapshot.riderQueue.available,
    },
    {
      id: 'withdrawals',
      label: t('buckets.withdrawals'),
      icon: Wallet,
      tone: 'info',
      count: snapshot.withdrawals.total,
      rows: cap(withdrawalRows),
      href: `/b/${branchId}/payouts`,
      destination: 'payouts',
      error: snapshot.withdrawals.error,
      hidden: !snapshot.withdrawals.available,
    },
    {
      // Not on the owner's list, but a board carrying twenty-two forgotten tickets while
      // this page says "nothing needs you" is the one way the section loses its credit.
      id: 'stalled',
      label: t('buckets.stalled'),
      icon: Hourglass,
      tone: 'info',
      count: kitchen.abandoned,
      rows: [],
      href: `/kitchen/${branchId}`,
      destination: 'kitchen',
      error: snapshot.kitchen.error,
    },
  ];

  const checkedAt = new Date(now).toLocaleTimeString(intlLocale, {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('header.title')}</h1>
        <p className="mt-1 text-muted-foreground">
          {t('header.subtitle', { branch: branch.name })}
        </p>
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
                  ? t('trial.endsToday')
                  : t('trial.daysLeft', { days: trialDays })}
              </p>
              <p className="text-xs text-muted-foreground">{t('trial.body')}</p>
            </div>
          </div>
          <Link
            href={`/b/${branchId}/settings/plan`}
            className="focus-ring inline-flex items-center rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-soft hover:bg-amber-600"
          >
            {t('trial.cta')}
          </Link>
        </Card>
      )}

      {expiryDaysLeft !== null && entitlements.entitledThrough && (
        <Card className="mb-6 flex flex-wrap items-center justify-between gap-4 border-amber-500/40 bg-amber-500/5 p-4 px-2 lg:px-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-amber-600">
              <CalendarClock className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold">
                {expiryDaysLeft <= 1
                  ? t('expiry.titleUnderDay', {
                      date: formatInZone(entitlements.entitledThrough, tz, {}, locale),
                    })
                  : t('expiry.titleDays', {
                      date: formatInZone(entitlements.entitledThrough, tz, {}, locale),
                      days: expiryDaysLeft,
                    })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('expiry.body')}{' '}
                {canRenew ? t('expiry.renewHint') : t('expiry.askOwner')}
              </p>
            </div>
          </div>
          {canRenew && (
            <Link
              href={`/b/${branchId}/settings/plan?renew=1`}
              className="focus-ring inline-flex items-center rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-soft hover:bg-amber-600"
            >
              {t('expiry.cta')}
            </Link>
          )}
        </Card>
      )}

      {setupPending && <SetupChecklist steps={setupSteps} warnings={setupWarnings} />}

      <section>
        <h2 className="mb-3 px-2 font-display text-xl font-semibold lg:px-0">
          {t('overview.title')}
        </h2>
        <OverviewTiles tiles={tiles} />
      </section>

      <ActionRequired buckets={buckets} checkedAt={checkedAt} />

      <div className="mt-8 px-2 lg:px-0">
        <Card className="p-6">
          <h2 className="font-display text-lg font-semibold">{t('trend.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('trend.subtitle')}</p>
          {/* Real revenue per day. This was a fixed array of made-up figures
              (6200, 7800, 9100 …) that every branch saw as its own trade, with
              weekday labels that never matched the actual days either. */}
          <div className="mt-4 flex h-40 items-end gap-2">
            {trend.map((d) => {
              const h = Math.round((d.revenue / trendMax) * 100);
              return (
                <div key={d.key} className="flex flex-1 flex-col items-center gap-2">
                  <div
                    className="relative w-full overflow-hidden rounded-lg bg-muted"
                    style={{ height: '128px' }}
                    title={t('trend.bar', {
                      day: d.label,
                      amount: formatCurrency(d.revenue, currency),
                    })}
                  >
                    <div
                      className="absolute inset-x-0 bottom-0 rounded-lg bg-gradient-warm"
                      style={{ height: `${h}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground">{d.label}</span>
                </div>
              );
            })}
          </div>
          {salesFailed ? (
            <p role="alert" className="mt-2 text-xs text-warning">
              {t('trend.failed')}
            </p>
          ) : (
            trendMax === 1 && (
              <p className="mt-2 text-xs text-muted-foreground">{t('trend.empty')}</p>
            )
          )}
        </Card>
      </div>

      <AutoRefresh />
    </div>
  );
}
