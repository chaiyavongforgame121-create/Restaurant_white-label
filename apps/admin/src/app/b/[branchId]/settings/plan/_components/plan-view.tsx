'use client';

// The package picker. This is the one merchant page that must stay reachable
// while suspended — it is the escape hatch, so the layout deliberately does not
// redirect away from it.
//
// Rebuilt for the 2026-09-23 packaging (docs/PACKAGING-2026-09-23.md §4.1). Two things
// changed and both are visible here:
//
//   1. Money is paid once AND every month. The two totals are shown in two boxes and are
//      never added together — the owner's instruction for this page was to make it easy or
//      users will be confused ("ทำให้มันเข้าใจง่ายหน่อยเดี๋ยวผู้ใช้จะงง").
//   2. Delivery is per branch, so the page lists the restaurant's branches and each one
//      carries its own switch instead of one restaurant-wide add-on card.
//
// Submit routes to Stripe Checkout when Stripe is configured and falls back to the manual
// request queue when it is not (the permanent state today). The fallback is not an error
// path: `createBillingCheckoutSession` returns `{dormant:true}` on the 503 and we queue
// instead. No UI change is needed on the day the owner supplies keys.
//
// Every price is read from the catalog and every total is the server's to confirm; the
// arithmetic the page shows lives in plan-model.ts so it can be tested.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Minus,
  Plus,
  RotateCcw,
  Sparkles,
  Store,
  XCircle,
} from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  createBillingCheckoutSession,
  requestPackageChange,
  validateBillingDiscount,
  type BillingRequest,
} from '@favornoms/database/queries';
import {
  DEFAULT_UI_LOCALE,
  discountReasonMessage,
  formatInZone,
  intlLocaleFor,
  isTrialing,
  isUiLocale,
  trialDaysLeft,
  type BillingPaidState,
  type BillingProduct,
  type Entitlements,
  type PackageSelection,
  type PriceLine,
  type UiLocale,
} from '@favornoms/shared';
import { Badge, Button, Card, useConfirm } from '@favornoms/ui';
import {
  codeNeedsApplying,
  discountAfterTyping,
  filedFacts,
  filedRequest,
  payOnceView,
  requestErrorMessage,
  showsFiledRequest,
  type FiledRequest,
  type PlanTranslator,
} from './plan-copy';
import {
  MAX_SEATS,
  SEAT_CODE,
  branchRows,
  canQuote,
  isDirty,
  joinNames,
  minimumSeats,
  netOneTime,
  openingSelection,
  planTotals,
  priceOf,
  selectionKey,
  submittableCode,
  summaryFacts,
  toggleDelivery,
  withSeats,
  type AppliedDiscount,
  type PlanBranch,
} from './plan-model';

/** The restaurant's most recent approved or rejected request, as the plan page shows it. */
export interface DecidedRequest {
  id: string;
  status: 'approved' | 'rejected';
  planCode: string;
  branchSeats: number;
  deliveryBranchIds: string[];
  monthlyTotal: number;
  oneTimeTotal: number;
  decisionNote: string | null;
  decidedAt: string;
}

interface Props {
  branchId: string;
  restaurantId: string;
  entitlements: Entitlements;
  catalog: BillingProduct[];
  /** Every active branch of the restaurant, with its delivery state. */
  branches: PlanBranch[];
  /** What is already bought, so nothing one-time is quoted twice. */
  paid: BillingPaidState;
  pendingRequest: BillingRequest | null;
  latestDecision: DecidedRequest | null;
  /** The branch's zone, so a request "sent 9/12" means the merchant's 9/12. */
  timezone: string;
  suspended: boolean;
  /** `?add=delivery`: the merchant pressed an upsell for delivery. */
  addDelivery: boolean;
  /** `?branch=<uuid>`: the branch whose switch that upsell was about. */
  preselectBranchId: string | null;
  /** `?no_trial=1`: a second restaurant on an account that already used its trial. */
  noTrial: boolean;
  /** `?renew=1`: sent from the dashboard's expiry banner. */
  renew: boolean;
}

type PlanT = ReturnType<typeof useTranslations>;

// Money stays in the restaurant's US format in every interface language.
const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function usePlanLocale(): UiLocale {
  const raw = useLocale();
  return isUiLocale(raw) ? raw : DEFAULT_UI_LOCALE;
}

export function PlanView({
  branchId,
  restaurantId,
  entitlements,
  catalog,
  branches,
  paid,
  pendingRequest,
  latestDecision,
  timezone,
  suspended,
  addDelivery,
  preselectBranchId,
  noTrial,
  renew,
}: Props) {
  const t = useTranslations('settings.plan');
  const locale = usePlanLocale();
  const router = useRouter();
  const confirm = useConfirm();

  const minSeats = minimumSeats(entitlements, branches);
  // The deep link decides the opening state ONCE. Recomputing it would switch a branch the
  // merchant has just switched off straight back on, which is how ?add= used to fight them.
  const [opening] = React.useState(() =>
    openingSelection({
      entitlements,
      branches,
      minSeats,
      addDelivery,
      branchParam: preselectBranchId,
    }),
  );
  const [sel, setSel] = React.useState<PackageSelection>(opening.selection);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [code, setCode] = React.useState('');
  const [applied, setApplied] = React.useState<AppliedDiscount | null>(null);
  const [codeBusy, setCodeBusy] = React.useState(false);
  const [codeProblem, setCodeProblem] = React.useState<string | null>(null);
  // What was just sent, held until router.refresh() brings the server's copy back. Without
  // it the button briefly re-arms against the OLD pending request and a second click
  // files the same request twice. It is the row request_package_change returned, so even
  // in that moment the page repeats the server's figures rather than its own.
  const [queued, setQueued] = React.useState<FiledRequest | null>(null);
  // The refresh brings a new request id. Dropping the local copy then puts the banner back
  // on the stored row.
  const pendingId = pendingRequest?.id ?? null;
  React.useEffect(() => {
    setQueued(null);
  }, [pendingId]);

  // The plan the selection buys, for its catalog name. A trialing merchant selects Base,
  // so this is the package they are about to have rather than the one they are on.
  const base = catalog.find((p) => p.code === sel.planCode);
  const seatPrice = priceOf(catalog, SEAT_CODE);
  // No figure on this page is shown, and nothing is sent, unless the catalog can price the
  // selection — see canQuote().
  const quotable = canQuote(catalog, sel.planCode);

  const onTrial = isTrialing(entitlements);
  const trialDays = trialDaysLeft(entitlements);

  const rows = branchRows(sel, catalog, branches, paid);
  const totals = planTotals(sel, catalog, branches, paid);
  const facts = summaryFacts(sel, catalog, branches, paid);
  const dueNow = netOneTime(sel, totals.oneTimeTotal, applied);
  // A quote priced against another selection is not applied: the merchant flipped a switch
  // after asking, and showing a discount the server did not give for THIS package is how a
  // page ends up promising money it cannot take off.
  const activeDiscount = applied && applied.key === selectionKey(sel) ? applied : null;
  const staleDiscount = applied !== null && activeDiscount === null;

  // The request waiting for the Favornoms team, in the server's own figures.
  const filed = queued ?? filedRequest(pendingRequest);
  const showingFiled = showsFiledRequest(sel, filed, activeDiscount?.code ?? null);
  const payOnce = payOnceView({ filed, showingFiled, quoteLines: totals.oneTimeLines.length });
  const payOnceTotal = payOnce.kind === 'filed' ? payOnce.total : dueNow;

  const setDelivery = (id: string, on: boolean) => {
    setSel((s) => toggleDelivery(s, id, on));
  };

  const setSeats = (n: number) => {
    setSel((s) => withSeats(s, n, minSeats));
  };

  const applyCode = async () => {
    const typed = code.trim();
    if (!typed) return;
    setCodeBusy(true);
    setCodeProblem(null);
    try {
      const supabase = getBrowserClient();
      // The server prices the code against the selection and returns the amount; nothing
      // here works out a discount of its own.
      const quote = await validateBillingDiscount(supabase, {
        restaurantId,
        code: typed,
        selection: sel,
      });
      if (!quote.valid) {
        setApplied(null);
        // Worded by the shared discountReasonMessage() and nowhere else, so this box says
        // what every other screen says: 'invalid_code' for a code that is unknown, switched
        // off or not started yet (one answer, so the box cannot be used to find codes), the
        // specific reason for one that expired, ran out or was already used here, and
        // 'rate_limited' once too many wrong codes were tried.
        setCodeProblem(discountReasonMessage(quote.reason, locale));
        return;
      }
      setApplied({
        code: typed.toUpperCase(),
        label: quote.label ?? null,
        amountOff: quote.amountOff,
        netTotal: quote.netTotal,
        key: selectionKey(sel),
      });
    } catch (e) {
      console.error('validate_billing_discount failed', e);
      setApplied(null);
      setCodeProblem(discountReasonMessage('unknown', locale));
    } finally {
      setCodeBusy(false);
    }
  };

  const clearCode = () => {
    setApplied(null);
    setCode('');
    setCodeProblem(null);
  };

  const submit = async () => {
    // The button is disabled in this state; this is the belt to that brace, because a request
    // sent from a page that could not read its prices is one the merchant never saw priced.
    if (!quotable) return;

    // A code typed into the box but never priced is NOT quietly dropped — see
    // codeNeedsApplying(). The merchant is told to press Apply or clear the box.
    if (codeNeedsApplying(code, submittableCode(sel, applied))) {
      setCodeProblem(t('discount.notApplied'));
      return;
    }

    // request_package_change withdraws the older pending request itself — its charges and
    // its discount reservation — before it prices this one, so replacing is one call. It is
    // still asked about: the earlier request disappears from the platform owner's queue, and
    // that should not happen on a stray click.
    // Replacing gives the earlier request's code back (its use was reserved for THAT request).
    // A merchant who reloaded the page sees an empty code box and would lose the discount
    // without a word, so the dialog names the code unless this request carries it again.
    const dropsCode =
      filed?.discountCode && filed.discountCode !== (activeDiscount?.code ?? null)
        ? filed.discountCode
        : null;
    if (
      filed &&
      !(await confirm({
        title: t('replaceDialog.title'),
        body: [
          t('replaceDialog.body', { summary: summaryLine(t, locale, filedFacts(filed, branches)) }),
          dropsCode ? t('replaceDialog.codeReleased', { code: dropsCode }) : null,
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: t('replaceDialog.confirm'),
      }))
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const origin = `${window.location.origin}/b/${branchId}/settings/plan`;

      // Stripe first; dormant is expected and falls through to the queue.
      const checkout = await createBillingCheckoutSession(supabase, restaurantId, sel, {
        successUrl: `${origin}?checkout=success`,
        cancelUrl: `${origin}?checkout=cancelled`,
      });
      if ('url' in checkout) {
        window.location.href = checkout.url;
        return;
      }

      const sentCode = submittableCode(sel, applied);
      const row = await requestPackageChange(supabase, {
        restaurantId,
        selection: sel,
        // Only a code the server already accepted for this exact selection is sent. It
        // re-prices it anyway and refuses a stale one, which is decoded below.
        discountCode: sentCode,
      });
      // The row the server wrote, so the Pay-once box and the banner repeat ITS figures.
      //
      // A row without an id is not a request. request_package_change answers a refused code
      // with {ok:false, error:'discount_invalid:<reason>'} instead of raising — raising would
      // roll back the failed attempt it records for the guessing limit — so an answer with no
      // request in it is a refusal, and the page must say so rather than show a request
      // "waiting for the Favornoms team" that was never filed.
      const sent = filedRequest(row);
      if (!sent?.id) {
        const refusal = (row as unknown as { error?: unknown } | null)?.error;
        throw new Error(typeof refusal === 'string' && refusal ? refusal : 'request_not_filed');
      }
      setQueued(sent);
      router.refresh();
    } catch (e) {
      console.error('Sending the package request failed', e);
      setError(
        e instanceof Error && e.message
          ? requestErrorMessage(e.message, t as PlanTranslator, locale)
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const dirty = isDirty(sel, entitlements);

  // One ladder for label and state, so the two cannot disagree. A pending request no
  // longer locks the page: an owner who asked for the wrong thing used to be stuck with it
  // until the platform owner happened to decide, and approving it could remove add-ons
  // they still pay for.
  const action: { label: string; enabled: boolean } = !quotable
    ? { label: t('action.pricesUnavailable'), enabled: false }
    : showingFiled
      ? { label: t('action.pending'), enabled: false }
      : filed
        ? { label: t('action.replace'), enabled: true }
        : suspended
          ? {
              label: noTrial ? t('action.requestActivation') : t('action.reactivate'),
              enabled: true,
            }
          : dirty
            ? { label: t('action.confirm'), enabled: true }
            : renew
              ? { label: t('action.renew'), enabled: true }
              : { label: t('action.current'), enabled: false };

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0 lg:pl-0">
        <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>
      </header>

      {suspended && noTrial && <NoTrialBanner />}
      {suspended && !noTrial && <SuspendedBanner />}
      {!suspended && onTrial && <TrialBanner days={trialDays} />}
      {!suspended && !onTrial && renew && (
        <RenewBanner
          paidThrough={
            entitlements.entitledThrough
              ? formatInZone(entitlements.entitledThrough, timezone, {}, locale)
              : null
          }
        />
      )}

      {latestDecision && (
        <DecisionBanner
          decision={latestDecision}
          branches={branches}
          timezone={timezone}
          locale={locale}
        />
      )}

      {filed && (
        <PendingBanner
          summary={summaryLine(t, locale, filedFacts(filed, branches))}
          oneTimeTotal={filed.oneTimeTotal}
          sentOn={
            filed.createdAt
              ? formatInZone(filed.createdAt, timezone, { dateOnly: true }, locale)
              : null
          }
        />
      )}

      {!quotable && <PricesUnavailableBanner />}

      {error && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_21rem] lg:items-start">
        <div className="space-y-4">
          {/* 1. What you have now */}
          <Card className="border-primary/40 p-5">
            <h2 className="font-display text-xl font-bold">{t('now.title')}</h2>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <Fact label={t('now.plan')}>
                {onTrial
                  ? t('now.trialPlan')
                  : entitlements.planCode === 'none'
                    ? t('now.noPlan')
                    : (base?.name ?? t('base.name'))}
              </Fact>
              <Fact label={t('now.branches')}>
                {t('now.branchesValue', {
                  used: entitlements.branchesUsed,
                  seats: Math.max(1, entitlements.branchSeats),
                })}
              </Fact>
              <Fact label={t('now.delivery')}>
                {onTrial
                  ? t('now.deliveryTrial')
                  : entitlements.deliveryBranchIds.length === 0
                    ? t('now.deliveryNone')
                    : joinNames(
                        branches
                          .filter((b) => entitlements.deliveryBranchIds.includes(b.id))
                          .map((b) => b.name),
                        intlLocaleFor(locale),
                      )}
              </Fact>
              <Fact label={onTrial ? t('now.trialEnds') : t('now.nextPayment')}>
                {entitlements.entitledThrough
                  ? formatInZone(entitlements.entitledThrough, timezone, { dateOnly: true }, locale)
                  : t('now.noNextPayment')}
              </Fact>
            </dl>
            {onTrial && trialDays !== null && (
              <p className="mt-3 rounded-xl bg-primary/10 px-3 py-2 text-xs">
                {trialDays === 0 ? t('trial.endsToday') : t('trial.daysLeft', { days: trialDays })}
              </p>
            )}
            <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('now.includedTitle')}
            </p>
            <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
              <Included>{t('base.included.cardPayment')}</Included>
              <Included>{t('base.included.onlineOrdering')}</Included>
              <Included>{t('base.included.reportsLoyalty')}</Included>
              <Included>{t('base.included.kitchenCounter')}</Included>
              <Included>{t('base.included.oneBranch')}</Included>
            </ul>
          </Card>

          {/* 2. Your branches — delivery is bought per branch. */}
          <Card className="p-5">
            <h2 className="font-display text-lg font-bold">{t('branches.title')}</h2>
            <p className="text-sm text-muted-foreground">
              {quotable
                ? t('branches.subtitle', { price: money(seatPrice.monthly) })
                : t('branches.subtitleNoPrice')}
            </p>
            {branches.length === 0 ? (
              <p className="mt-4 rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">
                {t('branches.empty')}
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className={`rounded-xl border p-3 transition-colors ${
                      row.id === opening.focusBranchId ? 'border-primary bg-primary/[0.04]' : 'border-border'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-semibold">
                          <Store className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">{row.name}</span>
                        </p>
                        {quotable && (
                          <p className="mt-0.5 text-sm tabular-nums text-muted-foreground">
                            {t('branches.eachMonth', { price: money(row.monthly) })}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="text-sm font-medium">{t('branches.delivery')}</p>
                          {quotable && (
                            <p className="text-xs text-muted-foreground">
                              {row.deliveryOnce > 0
                                ? t('branches.costOnceAndMonthly', {
                                    once: money(row.deliveryOnce),
                                    monthly: money(row.deliveryMonthly),
                                  })
                                : t('branches.costMonthly', {
                                    monthly: money(row.deliveryMonthly),
                                  })}
                            </p>
                          )}
                        </div>
                        <Switch
                          checked={row.delivers}
                          onChange={(on) => setDelivery(row.id, on)}
                          label={t('branches.switchLabel', { branch: row.name })}
                        />
                      </div>
                    </div>
                    {row.delivers && row.unlocked && !row.deliversToday && (
                      <p className="mt-2 text-xs text-success">{t('branches.alreadyUnlocked')}</p>
                    )}
                    {row.losingDelivery && (
                      <p className="mt-2 flex items-start gap-2 rounded-lg bg-warning/15 px-3 py-2 text-xs">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                        <span>
                          {t('branches.offWarning', { branch: row.name })}
                          {quotable &&
                            ` ${t('branches.dropsTo', { price: money(row.monthlyWithoutDelivery) })}`}
                        </span>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {onTrial && (
              <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
                {t('branches.trialNote')}
              </p>
            )}
          </Card>

          {/* 3. Add a branch */}
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-bold">{t('seats.title')}</h2>
                {quotable && (
                  <p className="text-sm text-muted-foreground">
                    {t('seats.body', {
                      once: money(seatPrice.once),
                      monthly: money(seatPrice.monthly),
                    })}
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('seats.usage', {
                    used: entitlements.branchesUsed,
                    seats: entitlements.branchSeats,
                  })}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label={t('seats.remove')}
                  disabled={sel.branchSeats <= minSeats}
                  onClick={() => setSeats(sel.branchSeats - 1)}
                  className="focus-ring grid h-10 w-10 place-items-center rounded-full border border-border disabled:opacity-40"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <span className="w-8 text-center font-display text-2xl font-bold tabular-nums">
                  {sel.branchSeats}
                </span>
                <button
                  type="button"
                  aria-label={t('seats.add')}
                  disabled={sel.branchSeats >= MAX_SEATS}
                  onClick={() => setSeats(sel.branchSeats + 1)}
                  className="focus-ring grid h-10 w-10 place-items-center rounded-full border border-border disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
            {totals.unusedSeats > 0 && (
              <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
                {t('seats.newSeats', { count: totals.unusedSeats })}
              </p>
            )}
            {sel.branchSeats <= minSeats && entitlements.branchesUsed > 1 && (
              <p className="mt-3 text-xs text-muted-foreground">
                {t('seats.floor', { count: entitlements.branchesUsed, min: minSeats })}
              </p>
            )}
          </Card>
        </div>

        {/* 4 & 5. What you pay — two totals, never one. */}
        <Card className="p-5 lg:sticky lg:top-6">
          <h2 className="font-display text-lg font-bold">{t('pay.title')}</h2>

          {!quotable ? (
            // No price list, no figures: a $0 here would read as "free".
            <p className="mt-3 rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">
              {t('pricesUnavailable.pay')}
            </p>
          ) : (
            <>
              {/* Pay once today */}
              <section className="mt-3 rounded-xl bg-muted/60 p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('pay.onceTitle')}
                </h3>
                {payOnce.kind === 'filed' ? (
                  // The request that was sent, in its own figures: nothing on it is paid yet.
                  <ul className="mt-2 space-y-1.5 text-sm">
                    <li className="flex items-baseline justify-between gap-3">
                      <span className="text-muted-foreground">{t('pay.onceOnRequest')}</span>
                      <span className="tabular-nums">{money(payOnce.list)}</span>
                    </li>
                    {payOnce.discount > 0 && (
                      <li className="flex items-baseline justify-between gap-3 text-success">
                        <span>
                          {payOnce.code ? t('pay.onceCode', { code: payOnce.code }) : t('discount.title')}
                        </span>
                        <span className="tabular-nums">−{money(payOnce.discount)}</span>
                      </li>
                    )}
                  </ul>
                ) : payOnce.kind === 'nothing' ? (
                  <p className="mt-2 text-sm text-muted-foreground">{t('pay.onceNothing')}</p>
                ) : (
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {totals.oneTimeLines.map((line, i) => (
                      <li key={`${line.code}-${line.branchId ?? i}`} className="flex items-baseline justify-between gap-3">
                        <span className="text-muted-foreground">{oneTimeLabel(t, line, branches)}</span>
                        <span className="tabular-nums">{money(line.total)}</span>
                      </li>
                    ))}
                    {activeDiscount && (
                      <li className="flex items-baseline justify-between gap-3 text-success">
                        <span>{activeDiscount.label ?? activeDiscount.code}</span>
                        <span className="tabular-nums">−{money(activeDiscount.amountOff)}</span>
                      </li>
                    )}
                  </ul>
                )}
                <p className="mt-2 flex items-baseline justify-between gap-3 border-t border-border/60 pt-2">
                  <span className="font-semibold">{t('pay.total')}</span>
                  <span className="font-display text-2xl font-bold tabular-nums">
                    {money(payOnceTotal)}
                  </span>
                </p>
                {payOnce.kind === 'filed' && (
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('pay.onceAwaiting')}</p>
                )}

                {/* Discount code — it only ever comes off the one-time total. */}
                <div className="mt-3">
                  <label className="text-xs font-medium" htmlFor="plan-discount">
                    {t('discount.title')}
                  </label>
                  <div className="mt-1 flex gap-2">
                    <input
                      id="plan-discount"
                      value={code}
                      onChange={(e) => {
                        const typed = e.target.value;
                        setCode(typed);
                        setCodeProblem(null);
                        // Editing the box after Apply drops the quote, exactly as changing the
                        // selection does — see discountAfterTyping().
                        setApplied((a) => discountAfterTyping(a, typed));
                      }}
                      placeholder={t('discount.placeholder')}
                      autoComplete="off"
                      className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm uppercase outline-none transition-colors focus-visible:border-primary"
                    />
                    {activeDiscount ? (
                      <Button size="sm" variant="outline" onClick={clearCode}>
                        {t('discount.remove')}
                      </Button>
                    ) : (
                      <Button size="sm" variant="soft" loading={codeBusy} onClick={applyCode} disabled={!code.trim()}>
                        {t('discount.apply')}
                      </Button>
                    )}
                  </div>
                  {activeDiscount && (
                    <p className="mt-1.5 text-xs text-success">
                      {activeDiscount.label
                        ? t('discount.applied', {
                            label: activeDiscount.label,
                            amount: money(activeDiscount.amountOff),
                          })
                        : t('discount.appliedPlain', { amount: money(activeDiscount.amountOff) })}
                    </p>
                  )}
                  {/* One message at a time: `notApplied` already says to press Apply. */}
                  {staleDiscount && !codeProblem && (
                    <p className="mt-1.5 text-xs text-warning">{t('discount.repriced')}</p>
                  )}
                  {codeProblem && <p className="mt-1.5 text-xs text-destructive">{codeProblem}</p>}
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('discount.onlyOnce')}</p>
                </div>
              </section>

              {/* Then every month */}
              <section className="mt-4 rounded-xl border border-border p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('pay.monthlyTitle')}
                </h3>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {totals.perBranch.map((line) => (
                    <li key={line.branchId} className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-muted-foreground">
                        {line.delivers
                          ? t('pay.withDelivery', { branch: line.name ?? '' })
                          : (line.name ?? '')}
                      </span>
                      <span className="tabular-nums">{money(line.monthly)}</span>
                    </li>
                  ))}
                  {totals.unusedSeats > 0 && (
                    <li className="flex items-baseline justify-between gap-3">
                      <span className="text-muted-foreground">
                        {t('pay.unusedSeats', { count: totals.unusedSeats })}
                      </span>
                      <span className="tabular-nums">
                        {money(totals.unusedSeats * totals.seatMonthly)}
                      </span>
                    </li>
                  )}
                </ul>
                <p className="mt-2 flex items-baseline justify-between gap-3 border-t border-border/60 pt-2">
                  <span className="font-semibold">{t('pay.total')}</span>
                  <span className="font-display text-2xl font-bold tabular-nums">
                    {money(totals.monthlyTotal)}
                    <span className="ml-1 text-sm font-normal text-muted-foreground">
                      {t('perMonth')}
                    </span>
                  </span>
                </p>
              </section>

              <p className="mt-3 text-sm">{summaryLine(t, locale, facts)}</p>
            </>
          )}

          {onTrial && (
            <p className="mt-3 rounded-xl bg-primary/10 px-3 py-2 text-xs">{t('pay.trialNote')}</p>
          )}

          <Button
            variant="gradient"
            fullWidth
            className="mt-4"
            loading={busy}
            disabled={!action.enabled}
            onClick={submit}
            leftIcon={<Sparkles className="h-4 w-4" />}
          >
            {action.label}
          </Button>

          <p className="mt-3 text-xs text-muted-foreground">{t('pay.footnote')}</p>
        </Card>
      </div>
    </div>
  );
}

/** "2 branches, delivery at Food Thai Thai — $87 every month", assembled per language. */
function summaryLine(
  t: PlanT,
  locale: UiLocale,
  facts: { branches: number; deliveryNames: string[]; monthlyTotal: number },
): string {
  return t('pay.summary.line', {
    branches: t('pay.summary.branches', { count: facts.branches }),
    delivery:
      facts.deliveryNames.length === 0
        ? t('pay.summary.noDelivery')
        : t('pay.summary.delivery', {
            names: joinNames(facts.deliveryNames, intlLocaleFor(locale)),
          }),
    price: money(facts.monthlyTotal),
  });
}

/** A one-time line as the merchant reads it: the product, and the branch when it has one. */
function oneTimeLabel(t: PlanT, line: PriceLine, branches: PlanBranch[]): string {
  const branch = line.branchId ? branches.find((b) => b.id === line.branchId) : undefined;
  const label = branch ? t('pay.forBranch', { product: line.label, branch: branch.name }) : line.label;
  return line.qty > 1 ? `${label} × ${line.qty}` : label;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}

/**
 * The Delivery switch. A plain checkbox reads as "tick to agree" beside a price; this is a
 * switch because it turns a branch's delivery on and off, and it carries the branch name in
 * its accessible label so a screen reader does not meet five switches all called "Delivery".
 */
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-primary' : 'bg-muted-foreground/30'
      }`}
    >
      <span
        className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${
          checked ? 'left-6' : 'left-1'
        }`}
      />
    </button>
  );
}

function Included({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      <span>{children}</span>
    </li>
  );
}

function TrialBanner({ days }: { days: number | null }) {
  const t = useTranslations('settings.plan.trial');
  const urgent = days !== null && days <= 3;
  return (
    <div
      className={`mb-4 flex items-start gap-3 rounded-xl px-4 py-3 text-sm ${
        urgent ? 'bg-warning/15 text-warning-foreground' : 'bg-primary/10 text-foreground'
      }`}
    >
      <Clock className={`mt-0.5 h-4 w-4 shrink-0 ${urgent ? 'text-warning' : 'text-primary'}`} />
      <div>
        <p className="font-semibold">
          {days === null
            ? t('active')
            : days === 0
              ? t('endsToday')
              : t('daysLeft', { days })}
        </p>
        <p className="text-muted-foreground">{t('body')}</p>
      </div>
    </div>
  );
}

function SuspendedBanner() {
  const t = useTranslations('settings.plan.suspended');
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-semibold">{t('title')}</p>
        <p className="opacity-90">{t('body')}</p>
      </div>
    </div>
  );
}

/**
 * The catalog could not be read, so the page has no prices. It says so, once, at the top: the
 * figures are left out everywhere below and the button is disabled — see canQuote().
 */
function PricesUnavailableBanner() {
  const t = useTranslations('settings.plan.pricesUnavailable');
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-semibold">{t('title')}</p>
        <p className="opacity-90">{t('body')}</p>
      </div>
    </div>
  );
}

/**
 * Onboarding sends a second restaurant here with ?no_trial=1. Without this the owner of a
 * brand-new store met "Your account is not active … everything comes straight back", which
 * describes a lapsed store and gives no hint why a new one never got its trial.
 */
function NoTrialBanner() {
  const t = useTranslations('settings.plan.noTrial');
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-warning/15 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div>
        <p className="font-semibold">{t('title')}</p>
        <p className="text-muted-foreground">{t('body')}</p>
      </div>
    </div>
  );
}

function RenewBanner({ paidThrough }: { paidThrough: string | null }) {
  const t = useTranslations('settings.plan.renew');
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-primary/10 px-4 py-3 text-sm">
      <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div>
        <p className="font-semibold">{t('title')}</p>
        <p className="text-muted-foreground">
          {paidThrough && <>{t('paidThrough', { date: paidThrough })} </>}
          {t('body')}
        </p>
      </div>
    </div>
  );
}

function DecisionBanner({
  decision,
  branches,
  timezone,
  locale,
}: {
  decision: DecidedRequest;
  branches: PlanBranch[];
  timezone: string;
  locale: UiLocale;
}) {
  const t = useTranslations('settings.plan');
  const approved = decision.status === 'approved';
  const on = formatInZone(decision.decidedAt, timezone, { dateOnly: true }, locale);
  const names = branches
    .filter((b) => decision.deliveryBranchIds.includes(b.id))
    .map((b) => b.name);
  const summary = summaryLine(t, locale, {
    branches: decision.branchSeats,
    deliveryNames: names,
    monthlyTotal: decision.monthlyTotal,
  });
  return (
    <div
      className={`mb-4 flex items-start gap-3 rounded-xl px-4 py-3 text-sm ${
        approved ? 'bg-success/10' : 'bg-destructive/10'
      }`}
    >
      {approved ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      )}
      <div className="min-w-0">
        <p className="font-semibold">
          {approved
            ? t('decision.approvedOn', { date: on })
            : t('decision.declinedOn', { date: on })}
        </p>
        <p className="text-muted-foreground">
          {summary}
          {decision.oneTimeTotal > 0 && ` ${t('pay.summary.plusOnce', { price: money(decision.oneTimeTotal) })}`}
        </p>
        {decision.decisionNote ? (
          <p className="mt-1 whitespace-pre-line break-words">
            <span className="font-medium">{t('decision.noteLabel')}</span>{' '}
            {decision.decisionNote}
          </p>
        ) : (
          !approved && (
            <p className="mt-1 text-muted-foreground">{t('decision.noReason')}</p>
          )
        )}
      </div>
      <Badge variant={approved ? 'success' : 'danger'} className="ml-auto shrink-0">
        {approved ? t('decision.approved') : t('decision.declined')}
      </Badge>
    </div>
  );
}

function PendingBanner({
  summary,
  oneTimeTotal,
  sentOn,
}: {
  summary: string;
  oneTimeTotal: number;
  sentOn: string | null;
}) {
  const t = useTranslations('settings.plan');
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-muted px-4 py-3 text-sm">
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="font-semibold">
          {sentOn ? t('pending.titleSent', { date: sentOn }) : t('pending.title')}
        </p>
        <p className="text-muted-foreground">
          {summary}
          {oneTimeTotal > 0 && ` ${t('pay.summary.plusOnce', { price: money(oneTimeTotal) })}`}{' '}
          {t('pending.body')}
        </p>
      </div>
      <Badge variant="warning" className="ml-auto shrink-0">
        {t('pending.badge')}
      </Badge>
    </div>
  );
}
