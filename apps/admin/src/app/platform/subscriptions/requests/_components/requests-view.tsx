'use client';

// Merchant package-change queue.
//
// Approving calls decide_billing_request, which applies the package and marks that
// request's one-time charges paid in the same transaction that marks the request
// approved — so the queue can never report "approved" for a package that failed to
// apply. A discount code's use is not taken here: request_package_change reserved it
// when the merchant sent the request, approving keeps it and rejecting gives it back,
// so a code switched off or expired since the merchant was quoted never blocks Approve.
//
// Approving also REPLACES the whole package: billing_apply_selection deletes every
// line item the request does not name, switches delivery off at every branch the
// request does not list, and restarts the month from now(). The card used to show
// only the request, so an old "Base, 3 seats" request read like an upgrade while it
// would have stripped Delivery from a store paying for it. Each pending card shows
// what the store has today and what approving takes away, and a removal has to be
// confirmed by name.
//
// The two money figures are shown apart and never summed (the owner's rule): what
// is payable ONCE if this is approved — already net of any code — and what the
// store will pay every month afterwards.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  decideBillingRequest,
  type BillingRequest,
  type RestaurantSubscriptionRow,
} from '@favornoms/database/queries';
import {
  ADDON_DELIVERY,
  DEFAULT_UI_LOCALE,
  FEATURE_KEYS,
  billingErrorMessage,
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
import {
  billingErrorOf,
  decisionErrorKey,
  formatMoney,
  requestAsk,
  requestOneTime,
  type PlatformBranchLite,
} from '../../../_components/platform-billing';
import { addOneMonthUtc } from '../../../_components/tenant-health';

type T = ReturnType<typeof useTranslations<'platformBilling'>>;

const money = formatMoney;

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

function useUiLocale(): UiLocale {
  const rawLocale = useLocale();
  return isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
}

export function RequestsView({
  requests,
  status,
  packages,
  branches,
  catalog,
  nowMs,
}: {
  requests: BillingRequest[];
  status: string;
  /** Each requesting restaurant's package today, keyed by restaurant id. A missing
   *  key means the read failed, not that the store has no package. */
  packages: Record<string, RestaurantSubscriptionRow>;
  /** Every branch of each requesting restaurant, so delivery is named rather than
   *  counted: "delivery at Food Thai Thai", not "delivery × 1". */
  branches: Record<string, PlatformBranchLite[]>;
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
              branches={branches[r.restaurant_id] ?? []}
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
  branches,
  catalog,
  nowMs,
  onError,
}: {
  request: BillingRequest;
  current: RestaurantSubscriptionRow | null;
  branches: PlatformBranchLite[];
  catalog: BillingProduct[];
  nowMs: number;
  onError: (m: string | null) => void;
}) {
  const router = useRouter();
  const t = useTranslations('platformBilling');
  const format = useFormatter();
  const locale = useUiLocale();
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = React.useState('');

  const pending = request.status === 'pending';
  const name = request.restaurant_name ?? t('requests.thisRestaurant');
  const noPackage = t('requests.noPackage');
  const diff = React.useMemo(
    () =>
      pending && current
        ? packageDiff(request, current, branches, catalog, nowMs, locale, noPackage)
        : null,
    [pending, request, current, branches, catalog, nowMs, locale, noPackage],
  );

  const ask = requestAsk(request.branch_seats, request.delivery_branch_ids, branches);
  const oneTime = requestOneTime(request);

  // Branch names are the merchant's own words; only the list punctuation is localized.
  const nameList = (names: string[], unnamed = 0) =>
    format.list(
      unnamed > 0 ? [...names, t('requests.unnamedBranches', { count: unnamed })] : names,
      { type: 'conjunction' },
    );

  const deliveryText =
    ask.deliveryBranchNames.length === 0 && ask.unnamedDeliveryBranches === 0
      ? t('requests.deliveryNone')
      : t('requests.deliveryAt', {
          branches: nameList(ask.deliveryBranchNames, ask.unnamedDeliveryBranches),
        });

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
      onError(decisionMessage(res.error, t, locale));
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
      {/* What is being asked for, in a sentence: "2 branches, delivery at Food
          Thai Thai". The old row of add-on pills could not say WHICH branch. */}
      <div className={`${pending ? 'mt-1.5' : 'mt-3'} flex flex-wrap items-center gap-2 text-sm`}>
        <Badge variant="outline">{planName(catalog, request.plan_code, noPackage)}</Badge>
        <span>{t('requests.asking', { seats: ask.seats, delivery: deliveryText })}</span>
      </div>

      {/* Two totals, never one. Paid once today, then every month. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-muted/50 px-3 py-2.5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            {t('requests.payOnce')}
          </p>
          <p className="font-display text-xl font-bold tabular-nums">{money(oneTime.net)}</p>
          {oneTime.code ? (
            <p className="mt-0.5 text-xs text-success">
              {t('requests.discountApplied', {
                code: oneTime.code,
                amount: money(oneTime.discount),
                list: money(oneTime.gross),
              })}
            </p>
          ) : request.discount_code ? (
            // A code was typed and took nothing off — worth saying, because the
            // merchant may well believe they got a discount.
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('requests.discountNothingOff', { code: request.discount_code })}
            </p>
          ) : oneTime.net === 0 ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{t('requests.nothingOnce')}</p>
          ) : null}
        </div>
        <div className="rounded-xl bg-muted/50 px-3 py-2.5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            {t('requests.thenMonthly')}
          </p>
          <p className="font-display text-xl font-bold tabular-nums">
            {perMonth(money(request.monthly_total))}
          </p>
        </div>
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
          <PackageComparison diff={diff} nameList={nameList} />
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

function PackageComparison({
  diff,
  nameList,
}: {
  diff: PackageDiff;
  nameList: (names: string[], unnamed?: number) => string;
}) {
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
          <span>
            {t('requests.asking', {
              seats: diff.seatsFrom,
              delivery:
                diff.deliveryFrom.length === 0
                  ? t('requests.deliveryNone')
                  : t('requests.deliveryAt', { branches: nameList(diff.deliveryFrom) }),
            })}
          </span>
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
          {diff.deliveryRemoves.length > 0 && (
            <li className="font-semibold text-danger">
              {t('requests.deliveryOff', { branches: nameList(diff.deliveryRemoves) })}
            </li>
          )}
          {diff.deliveryAdds.length > 0 && (
            <li className="font-semibold text-success">
              {t('requests.deliveryOn', { branches: nameList(diff.deliveryAdds) })}
            </li>
          )}
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
          {/* The one-time side of approving: the pending charges become paid. Never
              added to the monthly figure — and not mentioned at all when there is
              nothing one-time to settle. The code's use is not TAKEN here: it was
              reserved when the merchant sent the request and approving keeps it, so a
              code switched off since then still honours the price they were quoted. */}
          {diff.oneTimeNet > 0 && (
            <li>{t('requests.marksPaid', { amount: money(diff.oneTimeNet) })}</li>
          )}
          {diff.discountCode && (
            <li>{t('requests.keepsCode', { code: diff.discountCode })}</li>
          )}
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
  /** Branch names delivering today. */
  deliveryFrom: string[];
  /** Branch names approving switches ON / OFF. */
  deliveryAdds: string[];
  deliveryRemoves: string[];
  /** Feature labels (delivery excluded — it is per branch above) lost and gained. */
  removes: string[];
  adds: string[];
  seatsFrom: number;
  seatsTo: number;
  totalFrom: number;
  totalTo: number;
  requestedTotal: number;
  /** Payable once on approval, already net of the code. */
  oneTimeNet: number;
  /** The code that took something off, whose use was reserved when the merchant sent this. */
  discountCode: string | null;
  /** The current deadline, only while it is still ahead. */
  paidFrom: string | null;
  paidTo: string;
  daysLost: number;
}

function planName(catalog: BillingProduct[], code: string, noPackage: string): string {
  if (code === 'none') return noPackage;
  return catalog.find((p) => p.code === code)?.name ?? code;
}

function packageDiff(
  request: BillingRequest,
  current: RestaurantSubscriptionRow,
  branches: PlatformBranchLite[],
  catalog: BillingProduct[],
  nowMs: number,
  locale: UiLocale,
  /** The reader's words for plan code 'none'. */
  noPackage: string,
): PackageDiff {
  const ent = current.entitlements;
  const next: PackageSelection = {
    planCode: request.plan_code,
    branchSeats: Math.max(1, Math.trunc(request.branch_seats || 1)),
    deliveryBranchIds: [...request.delivery_branch_ids],
  };

  // Delivery is compared branch by branch, because that is what it is now. An id
  // with no branch on hand is left out of the NAMES (there is nothing to print)
  // but the card still counts it in the request's own summary above.
  const nameOf = (id: string) => branches.find((b) => b.id === id)?.name ?? null;
  const namesOf = (ids: string[]) =>
    ids.map(nameOf).filter((n): n is string => typeof n === 'string' && n.length > 0);
  const wanted = new Set(next.deliveryBranchIds);
  const held = new Set(ent.deliveryBranchIds);

  // Feature-level loss catches what the branch list cannot: a trialing store has
  // every feature through the trial PLAN, so a Base request switches Digital
  // Signage off without any branch changing. Skipped when the catalog did not
  // load — every feature would then read as removed.
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
    lostFeatures = FEATURE_KEYS.filter(
      // delivery is per branch and already reported by name; reporting it here
      // as well would say "this removes Delivery" while a branch keeps it.
      (k) => k !== ADDON_DELIVERY && ent.features[k] === true && !after.has(k),
    );
    gainedFeatures = FEATURE_KEYS.filter(
      (k) => k !== ADDON_DELIVERY && ent.features[k] !== true && after.has(k),
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
    deliveryFrom: namesOf(ent.deliveryBranchIds),
    deliveryAdds: namesOf(next.deliveryBranchIds.filter((id) => !held.has(id))),
    deliveryRemoves: namesOf(ent.deliveryBranchIds.filter((id) => !wanted.has(id))),
    removes: lostFeatures.map((k) => featureLabel(k, locale)),
    adds: gainedFeatures.map((k) => featureLabel(k, locale)),
    seatsFrom: ent.branchSeats,
    seatsTo: next.branchSeats,
    totalFrom: ent.monthlyTotal,
    totalTo:
      catalog.length > 0 ? packageMonthlyTotal(next, catalog) : Number(request.monthly_total ?? 0),
    requestedTotal: Number(request.monthly_total ?? 0),
    oneTimeNet: requestOneTime(request).net,
    discountCode: requestOneTime(request).code,
    paidFrom: live ? ent.entitledThrough : null,
    paidTo: paidTo.toISOString(),
    daysLost,
  };
}

/**
 * A failed decision, in the operator's language.
 *
 * The contract errors (a stale discount code, a seat count the branches no longer
 * fit into) carry their own sentence; everything else falls back to a key. The raw
 * PostgREST text is logged by decisionErrorKey, never shown.
 */
function decisionMessage(raw: string | undefined, t: T, locale: UiLocale): string {
  const decoded = billingErrorOf(raw);
  if (decoded) {
    // A code's use is reserved when the merchant submits (decide_billing_request only
    // confirms the reservation), so approval never refuses over a discount code any more.
    console.error('[platform/requests] decide_billing_request failed:', raw);
    return billingErrorMessage(decoded, locale);
  }
  return t(decisionErrorKey(raw));
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

  // A branch losing delivery is a removal like any other, and the one most likely
  // to be missed: nothing else on the card changes when it happens.
  const lost = [
    ...diff.deliveryRemoves.map((branch) => t('requests.deliveryLossItem', { branch })),
    ...diff.removes,
  ];
  const removes = lost.length > 0;
  const cutsSeats = diff.seatsTo < diff.seatsFrom;
  const shortens = diff.daysLost > 0 && diff.paidFrom !== null;
  if (!removes && !cutsSeats && !shortens) return null;

  const items = lost.join(', ');
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
