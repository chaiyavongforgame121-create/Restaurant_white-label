'use client';

// Merchant package-change queue.
//
// Approving calls decide_billing_request, which applies the package in the same
// transaction that marks the request approved — so the queue can never report
// "approved" for a package that failed to apply.
//
// Approving also REPLACES the whole package: billing_apply_selection deletes every
// line item the request does not name and restarts the month from now(). The card
// used to show only the request, so an old "Base, 3 seats" request read like an
// upgrade while it would have stripped Delivery and AI Suite from a store paying
// for both. Each pending card now shows what the store has today and what approving
// takes away, and a removal has to be confirmed by name.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  decideBillingRequest,
  type BillingRequest,
  type RestaurantSubscriptionRow,
} from '@favornoms/database/queries';
import {
  DEFAULT_UI_LOCALE,
  FEATURE_KEYS,
  featureLabel,
  intlLocaleFor,
  isUiLocale,
  packageMonthlyTotal,
  selectionFeatures,
  type BillingProduct,
  type PackageSelection,
  type UiLocale,
} from '@favornoms/shared';
import { Badge, Button, Card, useConfirm } from '@favornoms/ui';
import { PlatformNav } from '../../../_components/platform-nav';
import { addOneMonthUtc } from '../../../_components/tenant-health';

type T = ReturnType<typeof useTranslations<'platformBilling'>>;

const money = (n: number) => `$${Number(n ?? 0).toFixed(0)}`;

const DAY = 86_400_000;

// Same day on server and browser: Vercel runs in UTC and the operator's browser does not.
const fmtDate = (v: string | null | undefined, locale: UiLocale) =>
  v
    ? new Intl.DateTimeFormat(intlLocaleFor(locale), {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date(v))
    : '—';

/** Filter values go in the URL; the label is requests.filters.<key>. */
const FILTERS = [
  { value: 'pending', key: 'pending' },
  { value: 'approved', key: 'approved' },
  { value: 'rejected', key: 'rejected' },
  { value: '', key: 'all' },
] as const;

const REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
const isRequestStatus = (s: string): s is (typeof REQUEST_STATUSES)[number] =>
  (REQUEST_STATUSES as readonly string[]).includes(s);

/** Raw PostgREST text is for the logs, never the screen. */
function decisionErrorKey(raw: string | undefined): string {
  if (!raw) return 'errors.decisionFailed';
  console.error('[platform/requests] decide_billing_request failed:', raw);
  if (/forbidden|not[ _]authori[sz]ed|permission denied|platform[ _]admin/i.test(raw)) {
    return 'errors.permission';
  }
  if (/failed to fetch|fetch failed|networkerror|network request failed/i.test(raw)) {
    return 'errors.network';
  }
  return 'errors.decisionFailed';
}

function useUiLocale(): UiLocale {
  const rawLocale = useLocale();
  return isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
}

export function RequestsView({
  requests,
  status,
  packages,
  catalog,
  nowMs,
}: {
  requests: BillingRequest[];
  status: string;
  /** Each requesting restaurant's package today, keyed by restaurant id. A missing
   *  key means the read failed, not that the store has no package. */
  packages: Record<string, RestaurantSubscriptionRow>;
  /** The full catalog, inactive products included, priced the way the RPC prices. */
  catalog: BillingProduct[];
  /** The server clock, so dates render identically on both sides. */
  nowMs: number;
}) {
  const router = useRouter();
  const t = useTranslations('platformBilling');
  const [error, setError] = React.useState<string | null>(null);

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-2">
        <h1 className="font-display text-3xl font-bold">{t('requests.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('requests.subtitle')}</p>
      </header>
      <PlatformNav />

      <div className="mb-4 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() =>
              router.push(`/platform/subscriptions/requests${f.value ? `?status=${f.value}` : ''}`)
            }
            className={`focus-ring rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              status === f.value
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {t(`requests.filters.${f.key}`)}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {requests.length === 0 ? (
        <p className="py-16 text-center text-muted-foreground">{t('requests.empty')}</p>
      ) : (
        <div className="space-y-4">
          {requests.map((r) => (
            <RequestCard
              key={r.id}
              request={r}
              current={packages[r.restaurant_id] ?? null}
              catalog={catalog}
              nowMs={nowMs}
              onError={setError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RequestCard({
  request,
  current,
  catalog,
  nowMs,
  onError,
}: {
  request: BillingRequest;
  current: RestaurantSubscriptionRow | null;
  catalog: BillingProduct[];
  nowMs: number;
  onError: (m: string | null) => void;
}) {
  const router = useRouter();
  const t = useTranslations('platformBilling');
  const locale = useUiLocale();
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = React.useState('');

  const pending = request.status === 'pending';
  const name = request.restaurant_name ?? t('requests.thisRestaurant');
  const noPackage = t('requests.noPackage');
  const diff = React.useMemo(
    () =>
      pending && current ? packageDiff(request, current, catalog, nowMs, locale, noPackage) : null,
    [pending, request, current, catalog, nowMs, locale, noPackage],
  );

  const perMonth = (amount: string) =>
    t.rich('perMonth', {
      amount,
      unit: (chunks) => <span className="ml-1 text-sm font-normal text-muted-foreground">{chunks}</span>,
    });

  const decide = async (approve: boolean) => {
    if (approve) {
      const question = approvalQuestion(name, diff, t, locale);
      if (question && !(await confirm(question))) return;
    }
    setBusy(approve ? 'approve' : 'reject');
    onError(null);
    const res = await decideBillingRequest(
      getBrowserClient(),
      request.id,
      approve,
      note.trim() || undefined,
    );
    setBusy(null);
    if (res.ok !== true) {
      onError(t(decisionErrorKey(res.error)));
      return;
    }
    router.refresh();
  };

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">
            {request.restaurant_name ?? request.restaurant_id}
          </h2>
          <p className="text-xs text-muted-foreground">
            {new Date(request.created_at).toLocaleString(intlLocaleFor(locale))}
          </p>
        </div>
        <Badge
          variant={
            request.status === 'pending'
              ? 'warning'
              : request.status === 'approved'
                ? 'success'
                : 'muted'
          }
        >
          {isRequestStatus(request.status) ? t(`requests.status.${request.status}`) : request.status}
        </Badge>
      </div>

      {pending && (
        <p className="mt-3 text-xs uppercase tracking-wider text-muted-foreground">
          {t('requests.requested')}
        </p>
      )}
      <div className={`${pending ? 'mt-1.5' : 'mt-3'} flex flex-wrap items-center gap-2 text-sm`}>
        <Badge variant="outline">{request.plan_code}</Badge>
        {(request.addons ?? []).map((a) => (
          <Badge key={a} variant="default">
            {a}
          </Badge>
        ))}
        <Badge variant="muted">{t('requests.seatCount', { count: request.branch_seats })}</Badge>
        <span className="ml-auto font-display text-xl font-bold">
          {perMonth(money(request.monthly_total))}
        </span>
      </div>

      {request.note && (
        <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-sm">{request.note}</p>
      )}
      {request.decision_note && (
        <p className="mt-3 text-sm text-muted-foreground">
          {t('requests.decisionNote', { note: request.decision_note })}
        </p>
      )}

      {pending &&
        (diff ? (
          <PackageComparison diff={diff} />
        ) : (
          <p className="mt-4 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">
            {t('requests.loadFailed', { name })}
          </p>
        ))}

      {pending && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('requests.notePlaceholder')}
            className="h-10 min-w-[12rem] flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-none focus-visible:border-primary"
          />
          <Button
            size="sm"
            loading={busy === 'approve'}
            disabled={busy !== null}
            onClick={() => decide(true)}
            leftIcon={<Check className="h-4 w-4" />}
          >
            {t('requests.approve')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'reject'}
            disabled={busy !== null}
            onClick={() => decide(false)}
            leftIcon={<X className="h-4 w-4" />}
          >
            {t('requests.reject')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function PackageComparison({ diff }: { diff: PackageDiff }) {
  const t = useTranslations('platformBilling');
  const locale = useUiLocale();
  const seatClass =
    diff.seatsTo < diff.seatsFrom ? 'text-danger' : diff.seatsTo > diff.seatsFrom ? 'text-success' : '';
  const bold = (chunks: React.ReactNode) => <span className="font-semibold">{chunks}</span>;
  const paidFrom = diff.paidFrom ? fmtDate(diff.paidFrom, locale) : t('requests.lapsed');
  const paidTo = fmtDate(diff.paidTo, locale);
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {t('requests.currently')}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Badge variant="outline">{diff.planFrom}</Badge>
          {diff.currentAddons.map((a) => (
            <Badge key={a} variant="default">
              {a}
            </Badge>
          ))}
          <Badge variant="muted">{t('requests.seatCount', { count: diff.seatsFrom })}</Badge>
          <span className="ml-auto font-display text-lg font-bold">
            {t.rich('perMonth', {
              amount: money(diff.totalFrom),
              unit: (chunks) => (
                <span className="ml-1 text-sm font-normal text-muted-foreground">{chunks}</span>
              ),
            })}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {diff.paidFrom
            ? t('requests.paidThroughDate', { date: fmtDate(diff.paidFrom, locale) })
            : t('requests.notLive')}
        </p>
      </div>

      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {t('requests.approving')}
        </p>
        <ul className="mt-1.5 space-y-1">
          {diff.removes.length > 0 && (
            <li className="font-semibold text-danger">
              {t('requests.removes', { items: diff.removes.join(', ') })}
            </li>
          )}
          {diff.adds.length > 0 && (
            <li className="font-semibold text-success">
              {t('requests.adds', { items: diff.adds.join(', ') })}
            </li>
          )}
          {diff.planFrom !== diff.planTo && (
            <li>{t('requests.planChange', { from: diff.planFrom, to: diff.planTo })}</li>
          )}
          <li className={seatClass}>
            {diff.seatsFrom === diff.seatsTo
              ? t('requests.seatsSame', { count: diff.seatsTo })
              : t('requests.seatsChange', { from: diff.seatsFrom, to: diff.seatsTo })}
          </li>
          <li>
            {diff.totalTo !== diff.requestedTotal
              ? t.rich('requests.newTotalRequested', {
                  to: money(diff.totalTo),
                  from: money(diff.totalFrom),
                  requested: money(diff.requestedTotal),
                  b: bold,
                })
              : t.rich('requests.newTotal', {
                  to: money(diff.totalTo),
                  from: money(diff.totalFrom),
                  b: bold,
                })}
          </li>
          <li className={diff.daysLost > 0 ? 'text-danger' : ''}>
            {diff.daysLost > 0
              ? t('requests.paidThroughChangeFewer', { from: paidFrom, to: paidTo, days: diff.daysLost })
              : t('requests.paidThroughChange', { from: paidFrom, to: paidTo })}
          </li>
        </ul>
      </div>
    </div>
  );
}

interface PackageDiff {
  planFrom: string;
  planTo: string;
  currentAddons: string[];
  /** Add-on names and feature labels the store has now and will not have after. */
  removes: string[];
  adds: string[];
  seatsFrom: number;
  seatsTo: number;
  totalFrom: number;
  totalTo: number;
  requestedTotal: number;
  /** The current deadline, only while it is still ahead. */
  paidFrom: string | null;
  paidTo: string;
  daysLost: number;
}

function productName(catalog: BillingProduct[], code: string, locale: UiLocale): string {
  return catalog.find((p) => p.code === code)?.name ?? featureLabel(code, locale);
}

function planName(catalog: BillingProduct[], code: string, noPackage: string): string {
  if (code === 'none') return noPackage;
  return catalog.find((p) => p.code === code)?.name ?? code;
}

function packageDiff(
  request: BillingRequest,
  current: RestaurantSubscriptionRow,
  catalog: BillingProduct[],
  nowMs: number,
  locale: UiLocale,
  /** The reader's words for plan code 'none'. */
  noPackage: string,
): PackageDiff {
  const ent = current.entitlements;
  const requestedAddons = request.addons ?? [];
  const next: PackageSelection = {
    planCode: request.plan_code,
    addons: requestedAddons,
    branchSeats: Math.max(1, Math.trunc(request.branch_seats || 1)),
  };

  const removedAddons = ent.addons.filter((a) => !requestedAddons.includes(a));
  const addedAddons = requestedAddons.filter((a) => !ent.addons.includes(a));

  // Feature-level loss catches what the add-on list cannot: a trialing store has
  // every feature through the trial PLAN and no add-ons at all, so a Base request
  // switches off Delivery without removing a single add-on. Skipped when the
  // catalog did not load — every feature would then read as removed.
  let lostFeatures: string[] = [];
  let gainedFeatures: string[] = [];
  if (catalog.length > 0) {
    const after = selectionFeatures(next, catalog);
    // billing_compute applies the platform switch last, so an On/Off override
    // survives approval and must not be reported as a change.
    for (const [key, on] of Object.entries(current.feature_overrides)) {
      if (on) after.add(key);
      else after.delete(key);
    }
    const grantedBy = (codes: string[]) =>
      new Set(codes.flatMap((c) => Object.keys(catalog.find((p) => p.code === c)?.features ?? {})));
    // A removed add-on already names its own feature; listing both reads as two losses.
    const namedOut = grantedBy(removedAddons);
    const namedIn = grantedBy(addedAddons);
    lostFeatures = FEATURE_KEYS.filter(
      (k) => ent.features[k] === true && !after.has(k) && !namedOut.has(k),
    );
    gainedFeatures = FEATURE_KEYS.filter(
      (k) => ent.features[k] !== true && after.has(k) && !namedIn.has(k),
    );
  }

  // What billing_apply_selection writes on approval: start = now(), end = the
  // plan's trial length or now() + 1 month, whatever the store had before.
  const trialDays = catalog.find((p) => p.code === next.planCode)?.trial_days ?? 0;
  const paidTo = trialDays > 0 ? new Date(nowMs + trialDays * DAY) : addOneMonthUtc(nowMs);
  const deadline = ent.entitledThrough ? Date.parse(ent.entitledThrough) : NaN;
  const live = Number.isFinite(deadline) && deadline > nowMs;
  const daysLost = live ? Math.max(0, Math.floor((deadline - paidTo.getTime()) / DAY)) : 0;

  return {
    planFrom: planName(catalog, ent.planCode, noPackage),
    planTo: planName(catalog, next.planCode, noPackage),
    currentAddons: ent.addons.map((a) => productName(catalog, a, locale)),
    removes: [
      ...removedAddons.map((a) => productName(catalog, a, locale)),
      ...lostFeatures.map((k) => featureLabel(k, locale)),
    ],
    adds: [
      ...addedAddons.map((a) => productName(catalog, a, locale)),
      ...gainedFeatures.map((k) => featureLabel(k, locale)),
    ],
    seatsFrom: ent.branchSeats,
    seatsTo: next.branchSeats,
    totalFrom: ent.monthlyTotal,
    totalTo:
      catalog.length > 0 ? packageMonthlyTotal(next, catalog) : Number(request.monthly_total ?? 0),
    requestedTotal: Number(request.monthly_total ?? 0),
    paidFrom: live ? ent.entitledThrough : null,
    paidTo: paidTo.toISOString(),
    daysLost,
  };
}

/** The question "Approve & activate" must ask first, or null when nothing is lost. */
function approvalQuestion(
  name: string,
  diff: PackageDiff | null,
  t: T,
  locale: UiLocale,
): { title: string; body: string; confirmLabel: string; destructive: true } | null {
  if (!diff) {
    return {
      title: t('requests.confirm.blindTitle', { name }),
      body: t('requests.confirm.blindBody'),
      confirmLabel: t('requests.confirm.approveAnyway'),
      destructive: true,
    };
  }

  const removes = diff.removes.length > 0;
  const cutsSeats = diff.seatsTo < diff.seatsFrom;
  const shortens = diff.daysLost > 0 && diff.paidFrom !== null;
  if (!removes && !cutsSeats && !shortens) return null;

  const items = diff.removes.join(', ');
  return {
    title: removes
      ? t('requests.confirm.removeTitle', { items })
      : t('requests.confirm.smallerTitle'),
    body: t('requests.confirm.body', {
      name,
      removes: removes ? 'yes' : 'no',
      items,
      seats: cutsSeats ? 'yes' : 'no',
      seatsFrom: diff.seatsFrom,
      seatsTo: diff.seatsTo,
      shortens: shortens ? 'yes' : 'no',
      paidFrom: fmtDate(diff.paidFrom, locale),
      paidTo: fmtDate(diff.paidTo, locale),
      days: diff.daysLost,
    }),
    confirmLabel: t('requests.confirm.approveRemove'),
    destructive: true,
  };
}
