import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Bike, CalendarClock, ChefHat, DollarSign, Receipt, Sparkles } from 'lucide-react';
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
import { deliveryPlanHref, resolveDeliveryWindDown } from '@/lib/delivery-gate';
import { AccessDenied } from '@/components/access-denied';
import {
  BOOKING_LATE_WINDOW_MS,
  BOOKING_ROWS_SHOWN,
  bookingPaymentMethods,
  heldOrderIds,
  leadTimeMs,
  ordersListedIn,
  readDeliveries,
  readKitchen,
  readScheduled,
  readScheduledDeliveries,
  SCHEDULED_SOON_MS,
  spanOf,
  spanSince,
  type ActionRow,
  type BookingPaymentMethod,
  type BookingRow,
  type BookingState,
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
  transferOnWithoutQr,
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
  // Resolved FOR this branch, so `delivery` is this branch's answer and not the
  // restaurant's: delivery is bought per branch (docs/PACKAGING-2026-09-23.md §2). Every
  // delivery thing on this page — the rider and withdrawal reads, the no-pin and no-riders
  // warnings, the Deliveries tile, the bookings bucket — hangs off this one value, so they
  // all follow the branch switcher together.
  const deliverySold = hasFeature(entitlements, 'delivery');
  // Switched off here, but riders still out or still owed. The Live deliveries board and
  // Driver payouts stay open for that (their own pages decide it again), and the Schedule
  // Delivery bookings bucket already had the same exception a few hundred lines below — but
  // the Deliveries tile pointed at the plan page and showed "—", and the delivery-failed /
  // delivery-unaccepted buckets vanished, because loadBranchDashboard was told delivery was
  // off and never issued the read. A rider failing on an in-flight run was then surfaced
  // nowhere at all. A few head counts, and only while delivery is off.
  const windDown = await resolveDeliveryWindDown(supabase, branchId, deliverySold);
  // The Live deliveries board is open: the add-on, or runs it still shows (the page's own
  // rule, hasRunsOut). The Deliveries tile and the delivery-failed / delivery-unaccepted
  // alerts follow it and link to it, so none of them ever leads to a locked screen.
  const deliveryBoardOpen = deliverySold || windDown.runsOut;
  // What the delivery READS cover: the board's runs, and the withdrawals riders are still
  // waiting on — Driver payouts stays open for those with no run out at all.
  const deliveryEnabled = deliveryBoardOpen || windDown.ridersOwed;

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
      scheduledDeliveryLateWindowMs: BOOKING_LATE_WINDOW_MS,
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
          supabase.from('branches').select('geo_lat, geo_lng, sales_tax_rate').eq('id', branchId).maybeSingle(),
          // This branch's own team: cashier, kitchen, managers. Owner rows cover every branch and
          // are not counted. Only asked of someone who can read the roster and invite (staff.manage).
          can('staff.manage')
            ? supabase
                .from('staff_members')
                .select('id', { count: 'exact', head: true })
                .eq('branch_id', branchId)
                .neq('role', 'owner')
                .in('status', ['active', 'pending'])
            : Promise.resolve(null),
          // Riders approved for THIS branch: dispatch only offers an order to those
          // (find_dispatch_candidates), and a new branch starts with none. Read only for the
          // no-riders warning, which follows deliverySold.
          deliverySold
            ? supabase
                .from('driver_approvals')
                .select('id', { count: 'exact', head: true })
                .eq('branch_id', branchId)
                .eq('status', 'approved')
            : Promise.resolve(null),
        ])
      : null,
  ]);

  const { currency, settings, timezone: tz } = snapshot;

  // How each unpaid booking is being paid. The bookings read carries no payment method, and an
  // unpaid storefront card booking is waiting on the diner's own card, not on a transfer the
  // restaurant has to check. Asked only for the unpaid rows, and only of someone who may read
  // payments (payments.view); without an answer the booking is worded neutrally.
  const unpaidBookingIds = snapshot.scheduledDeliveries.rows.filter((o) => o.awaiting_payment).map((o) => o.id);
  let bookingMethods = new Map<string, BookingPaymentMethod>();
  if (unpaidBookingIds.length > 0 && can('payments.view')) {
    const { data: payRows, error: payErr } = await supabase
      .from('payments')
      .select('order_id, method, gateway')
      .eq('branch_id', branchId)
      .in('order_id', unpaidBookingIds);
    if (payErr) console.error(`[dashboard] booking payments read failed for branch ${branchId}:`, payErr.message);
    else bookingMethods = bookingPaymentMethods((payRows ?? []) as Array<{ order_id: string; method: string; gateway: string | null }>);
  }

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
    scheduledDeliveries: snapshot.scheduledDeliveries.error,
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
  // Same rule as the plan page and request_package_change: only whoever holds billing.manage
  // (the owner, in the role matrix) can buy or renew. Anyone else is told to ask the owner
  // rather than sent to a plan page that would only say the same.
  const canRenew = can('billing.manage');

  const branchSettingsHref = `/b/${branchId}/branch`;
  const [menuRes, hoursRes, geoRes, staffRes, ridersRes] = setup ?? [null, null, null, null, null];
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
              // deliverySold, not deliveryEnabled: this asks which payment methods the
              // branch needs for the delivery it SELLS. A branch winding down is not being
              // set up for anything.
              deliverySold && settings.scheduling_enabled !== false,
            ),
            href: branchSettingsHref,
            hrefLabel: t('setup.payment.link'),
          },
          // A new branch used to start at 0% and its first orders went out untaxed. 0% can be
          // right (prices that already include VAT), so this only asks: it is done once a rate
          // is saved, or once "0% is correct" is ticked under Sales tax. Only asked of someone
          // who can change the rate (branch.settings); a manager could never tick it off.
          ...(can('branch.settings')
            ? [
                {
                  id: 'tax',
                  label: t('setup.tax.label'),
                  why: t('setup.tax.why'),
                  done:
                    Number(geoRes.data?.sales_tax_rate ?? 0) > 0 ||
                    settings.sales_tax_zero_confirmed === true,
                  href: branchSettingsHref,
                  hrefLabel: t('setup.tax.link'),
                  error: setupError('tax', geoRes.error),
                },
              ]
            : []),
          ...(staffRes
            ? [
                {
                  id: 'staff',
                  label: t('setup.staff.label'),
                  why: t('setup.staff.why'),
                  done: (staffRes.count ?? 0) > 0,
                  href: `/b/${branchId}/staff`,
                  hrefLabel: t('setup.staff.link'),
                  error: setupError('staff', staffRes.error),
                },
              ]
            : []),
        ]
      : [];
  // Its own row, not just the unticked pin step: a store selling delivery with no pin takes
  // orders that no rider will ever be offered, which costs a customer, not only a setup tick.
  const setupWarnings: SetupWarning[] = [];
  // Setup nags follow deliverySold too: telling a branch that just switched delivery off to
  // drop a map pin or recruit riders is advice for a business it no longer runs.
  if (deliverySold && geoRes && !geoRes.error && !hasPin) {
    setupWarnings.push({
      id: 'delivery-no-pin',
      label: t('setup.noPin.label'),
      why: t('setup.noPin.why'),
      href: branchSettingsHref,
      hrefLabel: t('setup.noPin.link'),
    });
  }
  if (setup && transferOnWithoutQr(settings)) {
    setupWarnings.push({
      id: 'transfer-no-qr',
      label: t('setup.transferNoQr.label'),
      why: t('setup.transferNoQr.why'),
      href: branchSettingsHref,
      hrefLabel: t('setup.transferNoQr.link'),
    });
  }
  // Platform delivery only: a branch whose own staff deliver needs no approved riders.
  if (
    deliverySold &&
    settings.delivery_mode !== 'self' &&
    ridersRes &&
    !ridersRes.error &&
    (ridersRes.count ?? 0) === 0
  ) {
    setupWarnings.push({
      id: 'delivery-no-riders',
      label: t('setup.noRiders.label'),
      why: t('setup.noRiders.why'),
      href: `/b/${branchId}/drivers`,
      hrefLabel: t('setup.noRiders.link'),
    });
  }
  if (ridersRes?.error) setupError('riders', ridersRes.error);
  const setupPending =
    setupWarnings.length > 0 || setupSteps.some((s) => !s.done || Boolean(s.error));
  const selfDelivery = settings.delivery_mode === 'self';
  const leadMs = leadTimeMs(settings);

  const kitchen = readKitchen(snapshot.kitchen.rows, now, leadMs, branchId);
  // Both reads carry the held flag; the kitchen one covers more orders, the bookings one more
  // time ahead.
  const deliveries = readDeliveries(
    snapshot.deliveries.rows,
    now,
    selfDelivery,
    branchId,
    heldOrderIds(snapshot.kitchen.rows, snapshot.scheduledDeliveries.rows),
  );
  const scheduled = readScheduled(snapshot.scheduled.rows, now, leadMs, branchId);
  const bookings = readScheduledDeliveries(
    snapshot.scheduledDeliveries.rows,
    now,
    leadMs,
    branchId,
    ordersListedIn(
      [kitchen.kitchenLate, kitchen.customersWaiting, deliveries.unaccepted, deliveries.failed],
      snapshot.proofs.rows.map((p) => p.order_id),
    ),
    bookingMethods,
  );

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
      // Straight to this branch's Delivery switch, not the bare plan page: the merchant
      // may already deliver from another branch, so "add delivery" is a question about
      // which branch.
      href: deliveryBoardOpen ? `/b/${branchId}/deliveries` : deliveryPlanHref(branchId),
      value: !deliveryBoardOpen || snapshot.deliveries.error ? '—' : deliveries.inFlight.toString(),
      // Without the stalled line a truthful 0 reads as a broken tile: one branch carries
      // thirteen June test runs that the board itself parks as forgotten.
      sub: !deliveryBoardOpen
        ? t('overview.deliveries.notOffered')
        : snapshot.deliveries.error
          ? t('overview.deliveries.failed')
          : !deliverySold
            ? // Delivery is off but the count above is real: say which it is, or the tile
              // reads as if the merchant never turned it off.
              t('overview.deliveries.windingDown')
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

  // --- Schedule Delivery bookings -------------------------------------------------------
  // Due times are the branch's wall clock, like everything else on this page: a New York
  // merchant reading a UTC host's "22:00" for a 6 pm delivery is how a booking gets missed.
  const clock = new Intl.DateTimeFormat(intlLocale, {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });
  const dayAndMonth = new Intl.DateTimeFormat(intlLocale, {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const bookedFor = (ms: number): string => {
    const at = new Date(ms);
    const time = clock.format(at);
    const day = branchDayKey(at, tz);
    if (day === todayKey) return t('bookings.at.today', { time });
    if (day === shiftDayKey(todayKey, 1)) return t('bookings.at.tomorrow', { time });
    if (day === yesterdayKey) return t('bookings.at.yesterday', { time });
    return t('bookings.at.date', { date: dayAndMonth.format(at), time });
  };
  const BOOKING_PILL: Record<BookingState, NonNullable<ActionLine['pill']>['tone']> = {
    unpaid: 'warning',
    stuckHeld: 'danger',
    notAccepted: 'warning',
    accepted: 'success',
    inKitchen: 'info',
    ready: 'info',
    onTheWay: 'neutral',
  };
  const bookingWhy = (b: BookingRow): string => {
    switch (b.state) {
      case 'unpaid':
        // "unpaid" is the transfer wording, as it always was; a card booking and one whose method
        // this reader may not see get their own.
        if (b.unpaidBy === 'card') return t('bookings.why.unpaidCard');
        return b.unpaidBy === 'transfer' ? t('bookings.why.unpaid') : t('bookings.why.unpaidAny');
      case 'stuckHeld':
        return t('rows.bookingStillHeld');
      case 'notAccepted':
        return t('rows.bookingNotAccepted');
      case 'accepted':
        return t('bookings.why.releasesAt', { time: clock.format(new Date(b.releaseMs)) });
      default:
        // Cooking, ready or on the road: the pill already says it, and the time column says
        // whether it is late.
        return '';
    }
  };
  const bookingLines: ActionLine[] = bookings.rows.slice(0, BOOKING_ROWS_SHOWN).map((b) => ({
    key: b.key,
    title: `#${b.orderNumber}`,
    // The diner's name as they typed it.
    who: b.customerName,
    pill: { label: t(`bookings.state.${b.state}`), tone: BOOKING_PILL[b.state] },
    why: bookingWhy(b),
    at: bookedFor(b.dueMs),
    age:
      b.untilDueMs >= 0
        ? t('age.dueIn', { span: spanText(spanOf(b.untilDueMs)) })
        : t('age.late', { span: spanText(spanOf(-b.untilDueMs)) }),
    ageAlarm: b.late,
    weight: b.weight,
    href: b.href,
  }));
  const bookingsLate = bookings.rows.some((b) => b.late || b.state === 'stuckHeld');

  const cap = (rows: ActionLine[]) => rows.slice(0, ROWS_PER_BUCKET);
  // Every key the page read, listed or not: the new-item alert watches all of them.
  const keysOf = (rows: readonly { key: string }[]) => rows.map((r) => r.key);
  const deliveriesUnavailable = !snapshot.deliveries.available;
  const buckets: ActionBucket[] = [
    {
      id: 'proofs',
      label: t('buckets.proofs'),
      icon: 'banknote',
      tone: 'danger',
      count: snapshot.proofs.total,
      rows: cap(proofRows),
      keys: keysOf(proofRows),
      href: `/b/${branchId}/orders`,
      destination: 'orders',
      failed: Boolean(snapshot.proofs.error),
      hidden: !snapshot.proofs.available,
    },
    {
      id: 'refunds',
      label: t('buckets.refunds'),
      icon: 'rotateCcw',
      tone: 'danger',
      // The read's total, not the rows kept: it only rises when an order really joins the list,
      // which is what stops a row coming into the read from being announced as new.
      count: snapshot.refundable.total,
      rows: cap(refundRows),
      keys: keysOf(refundRows),
      href: `/b/${branchId}/orders?status=cancelled`,
      destination: 'orders',
      failed: Boolean(snapshot.refundable.error),
      hidden: !snapshot.refundable.available,
    },
    {
      id: 'delivery-failed',
      label: t('buckets.deliveryFailed'),
      icon: 'alertTriangle',
      tone: 'danger',
      count: deliveries.failed.length,
      rows: lines(deliveries.failed),
      keys: keysOf(deliveries.failed),
      href: `/b/${branchId}/orders`,
      destination: 'orders',
      failed: Boolean(snapshot.deliveries.error),
      hidden: deliveriesUnavailable,
    },
    {
      id: 'delivery-unaccepted',
      label: t('buckets.deliveryUnaccepted'),
      icon: 'bike',
      tone: 'warning',
      count: deliveries.unaccepted.length,
      rows: lines(deliveries.unaccepted),
      keys: keysOf(deliveries.unaccepted),
      href: `/b/${branchId}/deliveries`,
      destination: 'deliveries',
      failed: Boolean(snapshot.deliveries.error),
      hidden: deliveriesUnavailable,
    },
    {
      id: 'customers-waiting',
      label: t('buckets.customersWaiting'),
      icon: 'clock',
      tone: 'warning',
      count: kitchen.customersWaiting.length,
      rows: lines(kitchen.customersWaiting),
      keys: keysOf(kitchen.customersWaiting),
      href: `/kitchen/${branchId}`,
      destination: 'kitchen',
      failed: Boolean(snapshot.kitchen.error),
    },
    {
      id: 'kitchen-late',
      label: t('buckets.kitchenLate'),
      icon: 'timer',
      tone: 'warning',
      count: kitchen.kitchenLate.length,
      rows: lines(kitchen.kitchenLate),
      keys: keysOf(kitchen.kitchenLate),
      href: `/kitchen/${branchId}`,
      destination: 'kitchen',
      failed: Boolean(snapshot.kitchen.error),
    },
    {
      // The owner asked for these by name (2026-09-19). Every booking still to go out is
      // listed, not only the ones in trouble, so this bucket's count is "coming up" and only
      // `attention` — the ones nobody has accepted, stuck or late — is "waiting on you". Of
      // those, a booking another bucket already lists (late in the kitchen, a slip to approve)
      // is drawn strong here but counted there.
      id: 'scheduled-deliveries',
      label: t('buckets.scheduledDeliveries'),
      icon: 'truck',
      tone: bookingsLate ? 'danger' : bookings.needsAction > 0 ? 'warning' : 'info',
      count: snapshot.scheduledDeliveries.total,
      attention: bookings.needsAction,
      addsToTotal: bookings.needsActionOnlyHere,
      rows: bookingLines,
      keys: keysOf(bookings.rows),
      href: `/b/${branchId}/orders?when=scheduled&channel=delivery`,
      destination: 'bookings',
      failed: Boolean(snapshot.scheduledDeliveries.error),
      // A branch that does not deliver has nothing to book, but a booking taken before
      // delivery was switched off here still has to go out, so an existing one keeps the
      // bucket on screen. Same rule as dispatch-driver: never strand work in flight.
      hidden: !deliveryEnabled && bookings.rows.length === 0,
    },
    {
      id: 'scheduled',
      label: t('buckets.scheduled'),
      icon: 'calendarClock',
      tone: 'warning',
      count: scheduled.length,
      rows: lines(scheduled),
      keys: keysOf(scheduled),
      href: `/b/${branchId}/orders?when=scheduled`,
      destination: 'orders',
      failed: Boolean(snapshot.scheduled.error),
    },
    {
      id: 'stock',
      label: t('buckets.stock'),
      icon: 'package',
      tone: 'warning',
      count: snapshot.lowStock.total,
      rows: cap(stockRows),
      keys: keysOf(stockRows),
      href: `/b/${branchId}/inventory`,
      destination: 'inventory',
      failed: Boolean(snapshot.lowStock.error),
      hidden: !snapshot.lowStock.available,
    },
    {
      id: 'riders',
      label: t('buckets.riders'),
      icon: 'userPlus',
      tone: 'info',
      count: riderRows.length,
      rows: cap(riderRows),
      keys: keysOf(riderRows),
      href: `/b/${branchId}/drivers`,
      destination: 'drivers',
      failed: Boolean(snapshot.riderQueue.error),
      // Rider applications go to the Drivers page, which has no wind-down: it is locked the
      // moment delivery is off here, so an application is not something to act on then.
      hidden: !snapshot.riderQueue.available || !deliverySold,
    },
    {
      id: 'withdrawals',
      label: t('buckets.withdrawals'),
      icon: 'wallet',
      tone: 'info',
      count: snapshot.withdrawals.total,
      rows: cap(withdrawalRows),
      keys: keysOf(withdrawalRows),
      href: `/b/${branchId}/payouts`,
      destination: 'payouts',
      failed: Boolean(snapshot.withdrawals.error),
      hidden: !snapshot.withdrawals.available,
    },
    {
      // Not on the owner's list, but a board carrying twenty-two forgotten tickets while
      // this page says "nothing needs you" is the one way the section loses its credit.
      // No keys: abandoned tickets are not news, so they never raise the new-item alert.
      id: 'stalled',
      label: t('buckets.stalled'),
      icon: 'hourglass',
      tone: 'info',
      count: kitchen.abandoned,
      rows: [],
      keys: [],
      href: `/kitchen/${branchId}`,
      destination: 'kitchen',
      failed: Boolean(snapshot.kitchen.error),
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

      <ActionRequired branchId={branchId} buckets={buckets} checkedAt={checkedAt} />

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

      <AutoRefresh branchId={branchId} />
    </div>
  );
}
