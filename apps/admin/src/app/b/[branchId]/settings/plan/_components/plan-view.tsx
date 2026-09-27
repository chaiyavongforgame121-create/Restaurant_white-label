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
// Submit always files the request first (request_package_change: the server prices it, the
// code is reserved, the one-time charges are written), exactly as on the manual rail. When the
// platform has switched card billing on (`billing.stripeEnabled`) the page then asks Stripe to
// take payment FOR THAT REQUEST (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §5): the first
// purchase goes to Stripe Checkout, a restaurant already paying by card is charged on the card
// it has on file, and a card that needs 3-D Secure opens Stripe's invoice page. With card
// billing off — or the function answering dormant — the request simply waits for the
// Favornoms team, as before. A card step that fails leaves the request filed and the page
// offering "Continue to payment", never a request that silently vanished.
//
// Every price is read from the catalog and every total is the server's to confirm; the
// arithmetic the page shows lives in plan-model.ts, the sentences in plan-copy.ts and the
// card-rail decisions in plan-billing.ts, so each can be tested.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CalendarX,
  Check,
  CheckCircle2,
  Clock,
  CreditCard,
  ExternalLink,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  Sparkles,
  Store,
  XCircle,
} from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  confirmCheckout,
  openBillingPortal,
  requestPackageChange,
  startCardPayment,
  validateBillingDiscount,
  type BillingRailInfo,
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
  cardMayBeCharged,
  cardStepError,
  cardStepErrorMessage,
  codeNeedsApplying,
  discountAfterTyping,
  filedFacts,
  filedRequest,
  payOnceView,
  portalErrorMessage,
  requestErrorMessage,
  showsFiledRequest,
  type FiledRequest,
  type PlanTranslator,
} from './plan-copy';
import {
  CHECKOUT_POLL_CAP_MS,
  CHECKOUT_POLL_MS,
  canContinuePayment,
  cardAction,
  cardBrandName,
  cardCharge,
  cardExpiresBefore,
  cardExpiry,
  cardFootnote,
  cardResultAfterConfirm,
  cardResultAfterPoll,
  invoiceAmount,
  isHttpsUrl,
  isSettling,
  isStripeUrl,
  nextCharge,
  canReplacePending,
  filedAction,
  invoiceStep,
  isCancelling,
  openingCardResult,
  payOnceNote,
  paysByCard,
  pendingPayment,
  railBanners,
  sessionMatch,
  type CardCharge,
  type CardResult,
  type CheckoutReturn,
  type InvoiceStartOutcome,
  type PendingPayment,
  type ReturnPending,
  invoiceStatusKey,
} from './plan-billing';
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
  /** Approved because a card payment settled it, not by the Favornoms team. */
  paidByCard: boolean;
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
  /** How the restaurant pays the platform: card through Stripe, or the manual rail. */
  billing: BillingRailInfo;
  /** `?checkout=success|cancelled`: Stripe Checkout sending the merchant back. */
  checkoutReturn: CheckoutReturn;
  /** `?portal=return`: back from Stripe's customer portal. */
  portalReturn: boolean;
}

/** What taking payment for a filed request led to, for the caller's busy state. */
type PayOutcome = 'leaving' | 'done' | 'failed';

type PlanT = ReturnType<typeof useTranslations>;

// Money stays in the restaurant's US format in every interface language. Whole dollars read
// as "$99"; anything with cents keeps them, because a discount can leave cents behind (50% off
// $99 is $49.50) and the owner's rule is that a total is never rounded to look tidier.
const money = (n: number) =>
  Number.isInteger(n)
    ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  billing,
  checkoutReturn,
  portalReturn,
}: Props) {
  const t = useTranslations('settings.plan');
  const locale = usePlanLocale();
  const router = useRouter();
  const confirm = useConfirm();
  const planPath = `/b/${branchId}/settings/plan`;
  const day = (iso: string) => formatInZone(iso, timezone, { dateOnly: true }, locale);

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

  // --- card billing (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §5, §9.9) -----------------
  //
  // The request that was waiting when the page opened, as the return from Checkout needs it:
  // whether the session in the URL is ITS payment. Frozen at mount, like the result below — once
  // the payment settles, the refresh drops the request, and a live value would then read the
  // very session that settled it as "someone else's".
  const [returnPending] = React.useState<ReturnPending | null>(() =>
    pendingRequest?.id
      ? {
          checkoutSessionId: pendingRequest.stripe_checkout_session_id ?? null,
          rail:
            pendingRequest.rail === 'stripe' || billing.pendingRequestRail === 'stripe' ? 'stripe' : 'manual',
        }
      : null,
  );
  const sessionId = checkoutReturn?.kind === 'success' ? checkoutReturn.sessionId : null;
  const [returnMatch] = React.useState(() => sessionMatch(sessionId, returnPending));
  // Held in state rather than read from the URL on every render: the URL is cleaned once the
  // payment has landed (a reload must not announce it again), and the banner has to outlive that.
  const [result, setResult] = React.useState<CardResult | null>(() =>
    openingCardResult(checkoutReturn, billing.rail, returnPending),
  );
  // The request whose card step failed on this page. It stays filed; until the server marks it
  // as a card request, this is what makes the page say it waits for payment.
  const [startFailedFor, setStartFailedFor] = React.useState<string | null>(null);
  // The request whose card step ended without a known result — the card on file may have been
  // charged. Nothing is offered for it again on this view; a reload reads where it stands.
  const [unconfirmedFor, setUnconfirmedFor] = React.useState<string | null>(null);
  const [paying, setPaying] = React.useState(false);
  const [portalBusy, setPortalBusy] = React.useState(false);
  // The clock for the "charged now or when the trial ends" rule. It ticks, because a page left
  // open across the 48-hour line would otherwise keep promising a later first charge that the
  // edge, deciding at the click, no longer gives (UIM-7).
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Back from Checkout: settle it now rather than waiting for the webhook, then re-read the
  // overview until the restaurant is on the card rail. `confirmCheckout` is idempotent on the
  // server. Its answer decides the banner (cardResultAfterConfirm): a payment for a request that
  // is no longer open is being refunded, an old URL is over, and only this request's own payment
  // is waited for. A failed call is not the merchant's problem — the webhook settles the same
  // session — so the polling carries on.
  const waiting = result === 'confirming';
  const railRef = React.useRef(billing.rail);
  React.useEffect(() => {
    railRef.current = billing.rail;
    setResult((r) => cardResultAfterPoll(r, billing.rail, 0, returnMatch));
  }, [billing.rail, returnMatch]);
  React.useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const started = Date.now();
    if (sessionId) {
      const ctx = () => ({
        rail: railRef.current,
        match: returnMatch,
        pendingIsCard: returnPending?.rail === 'stripe',
      });
      confirmCheckout(getBrowserClient(), sessionId)
        .then((answer) => {
          if (stopped) return;
          // `reason` is the settlement's refusal beside 'charged_refunded': which refund it is.
          const outcome = {
            kind: 'answer' as const,
            settled: answer.settled,
            status: answer.status,
            reason: answer.reason,
          };
          setResult((r) => cardResultAfterConfirm(r, outcome, ctx()));
          if (answer.settled) router.refresh();
        })
        .catch((e) => {
          console.error('Confirming the Stripe checkout failed', e);
          if (stopped) return;
          const code = e instanceof Error ? e.message.replace(/^.*stripe_billing_failed:/, '') : '';
          setResult((r) => cardResultAfterConfirm(r, { kind: 'failed', code }, ctx()));
        });
    }
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - started;
      if (elapsed >= CHECKOUT_POLL_CAP_MS) {
        window.clearInterval(timer);
        setResult((r) => cardResultAfterPoll(r, railRef.current, elapsed, returnMatch));
        return;
      }
      router.refresh();
    }, CHECKOUT_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [waiting, sessionId, returnMatch, returnPending, router]);

  // The URL is cleaned once there is nothing left to wait for — landed, cancelled, refunded, or
  // never this request's payment at all (an old URL out of the history, UIM-8). A payment still
  // being confirmed keeps it, so a reload asks Stripe again instead of showing the unpaid request
  // with its Continue to payment button — the one way to pay the same thing twice.
  const urlCleaned = React.useRef(false);
  React.useEffect(() => {
    if (urlCleaned.current || !checkoutReturn) return;
    if (!isSettling(result)) {
      urlCleaned.current = true;
      router.replace(planPath, { scroll: false });
    }
  }, [result, checkoutReturn, planPath, router]);

  // Back from the customer portal: a new card or a cancellation reaches our records by webhook,
  // which can land a moment after the merchant does, so the page reads itself again shortly.
  // Keyed on the value the page opened with: cleaning the URL flips the prop to false, and an
  // effect keyed on the prop would cancel its own refresh.
  const [backFromPortal] = React.useState(portalReturn);
  React.useEffect(() => {
    if (!backFromPortal) return;
    router.replace(planPath, { scroll: false });
    const timer = window.setTimeout(() => router.refresh(), 4_000);
    return () => window.clearTimeout(timer);
  }, [backFromPortal, planPath, router]);

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

  // How this purchase is paid. `stripeEnabled` is the platform's switch for NEW card purchases;
  // the rail says whether this restaurant already pays by card, in which case a change is charged
  // to the card on file instead of opening Checkout again — switch or no switch (paysByCard).
  const byCard = paysByCard(billing);
  const onStripeRail = billing.rail === 'stripe';
  // Stripe's page for a change waiting on 3-D Secure or a declined card. Read from our records,
  // so it is only ever linked when it is Stripe's own page.
  const invoiceUrl = isStripeUrl(billing.pendingInvoiceUrl) ? billing.pendingInvoiceUrl : null;
  // A card-rail package renews on the card by itself: there is nothing to renew by hand, so a
  // stale ?renew=1 link is not allowed to offer it.
  const renewing = renew && !onStripeRail;
  // The stored request's rail comes with the row; the overview says the same thing about it and
  // is read as well, so an older get_pending_billing_request that leaves the column out does not
  // turn a checkout in progress back into a request for the team.
  const pendingRail: 'manual' | 'stripe' =
    filed?.rail === 'stripe' || (filed !== null && queued === null && billing.pendingRequestRail === 'stripe')
      ? 'stripe'
      : 'manual';
  const pendingKind = pendingPayment({
    pending: filed ? { id: filed.id, rail: pendingRail } : null,
    // A card restaurant's request waits for the card even while its row still reads 'manual'
    // (a change whose card step failed before Stripe invoiced it, read again after a reload).
    restaurantRail: billing.rail,
    byCard,
    invoiceUrl,
    startFailedFor,
    unconfirmedFor,
    result,
  });
  const continuable = canContinuePayment(pendingKind);
  const monthlyNow = showingFiled && filed ? filed.monthlyTotal : totals.monthlyTotal;
  const charge = cardCharge({
    rail: billing.rail,
    entitlements,
    oneTimeNow: payOnceTotal,
    monthlyTotal: monthlyNow,
    nowMs,
  });
  const banners = railBanners(billing, entitlements);
  const cardText = billing.card
    ? t('stripe.billing.cardValue', {
        brand: cardBrandName(billing.card.brand),
        last4: billing.card.last4,
      }).trim()
    : t('stripe.chargeDialog.cardOnFile');

  /** What the card will be charged, in the sentences the confirmation dialog reads out. */
  const chargeSentences = (c: CardCharge, monthly: number): string[] => {
    const out: string[] = [];
    if (c.now > 0) out.push(t('stripe.chargeDialog.amount', { amount: money(c.now), card: cardText }));
    if (c.kind === 'change' && c.monthlyChanges) {
      out.push(t('stripe.chargeDialog.proration', { monthly: money(monthly) }));
    }
    if (out.length === 0) out.push(t('stripe.chargeDialog.nothing'));
    return out;
  };

  /**
   * Take payment for a filed request. Checkout and Stripe's invoice page open in this tab (the
   * busy state stays on until the browser leaves); a change charged to the card on file is live
   * at once; 'dormant' means card billing went off since the page was drawn, and a first
   * purchase's request stays exactly what it is — a request for the Favornoms team. A failure is
   * worded by cardStepError(): what it says about the money depends on whether this call could
   * have charged the card on file.
   */
  const payFor = async (requestId: string): Promise<PayOutcome> => {
    // Decided before the call: on the card rail `start` charges the card on file directly, and
    // that is what makes a failure's result unknown rather than "nothing was charged".
    const chargesCardOnFile = onStripeRail;
    try {
      const start = await startCardPayment(getBrowserClient(), requestId, branchId);
      if (start.kind === 'checkout' || start.kind === 'action_required') {
        if (!isHttpsUrl(start.url)) throw new Error('stripe_billing_failed:unexpected_answer');
        window.location.href = start.url;
        return 'leaving';
      }
      setStartFailedFor(null);
      setUnconfirmedFor(null);
      if (start.kind === 'applied') {
        setResult('applied');
        // Settled and approved on the server, so there will be no pending row for the refresh
        // to swap in — and without a new id nothing else would ever drop the local copy.
        setQueued(null);
      } else if (chargesCardOnFile) {
        // 'dormant' for a restaurant already paying by card: the function is switched off or
        // missing its key. The team cannot approve a card restaurant's change by hand, so the
        // request is NOT left to them; it stays here to be paid when card payments are back.
        setStartFailedFor(requestId);
        setError(cardStepErrorMessage('cardPaused', t as PlanTranslator, locale));
      }
      router.refresh();
      return 'done';
    } catch (e) {
      console.error('Starting the card payment failed', e);
      const kind = cardStepError(e instanceof Error ? e.message : '', chargesCardOnFile);
      if (cardMayBeCharged(kind)) setUnconfirmedFor(requestId);
      else setStartFailedFor(requestId);
      setError(cardStepErrorMessage(kind, t as PlanTranslator, locale));
      // Read again whatever happened: a payment that did go through settles by webhook, a request
      // held on Stripe's invoice page brings its Finish payment link, a refused one its state.
      router.refresh();
      return 'failed';
    }
  };

  /**
   * A request held on Stripe's invoice page is asked about through `start` rather than only
   * linked to (§10.1, edge-rr-1): a paid invoice is settled, an open one answers with its page,
   * and one past its window is voided and the request cancelled — the one thing that ends the
   * payment_in_progress lock for a declined fee invoice nobody pays. Done when the page opens
   * (quietly, never leaving the page) and when "Finish payment" is pressed (then Stripe's page
   * opens). What each answer leads to is invoiceStep()'s.
   */
  const [invoiceBusy, setInvoiceBusy] = React.useState(false);
  const askAboutInvoice = async (requestId: string, pressed: boolean) => {
    setInvoiceBusy(true);
    if (pressed) setError(null);
    let outcome: InvoiceStartOutcome;
    try {
      outcome = { kind: 'answer', start: await startCardPayment(getBrowserClient(), requestId, branchId) };
    } catch (e) {
      console.error('Checking the card payment waiting on Stripe’s invoice failed', e);
      outcome = { kind: 'failed', raw: e instanceof Error ? e.message : '' };
    }
    const step = invoiceStep(outcome, { pressed, storedUrl: invoiceUrl });
    switch (step.do) {
      case 'go':
        // Busy until the browser has left, so it cannot be pressed twice on the way out.
        window.location.href = step.url;
        return;
      case 'applied':
        setError(null);
        setResult('applied');
        setQueued(null);
        router.refresh();
        break;
      case 'tell':
        if (step.unconfirmed) setUnconfirmedFor(requestId);
        setError(cardStepErrorMessage(step.error, t as PlanTranslator, locale));
        if (step.refresh) router.refresh();
        break;
      case 'refresh':
        router.refresh();
        break;
      case 'stay':
        break;
    }
    setInvoiceBusy(false);
  };

  // Once per request held on an invoice, when the page shows it.
  const invoiceRequestId = pendingKind === 'invoice' ? (filed?.id ?? null) : null;
  const askedAboutInvoice = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!invoiceRequestId || askedAboutInvoice.current === invoiceRequestId) return;
    askedAboutInvoice.current = invoiceRequestId;
    void askAboutInvoice(invoiceRequestId, false);
    // askAboutInvoice is a new function on every render; the request id is what this runs for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceRequestId]);

  /** "Finish payment": the change waiting on 3-D Secure or a new card, through `start` first. */
  const finishPayment = () => {
    const id = filed?.id;
    if (!id || pendingKind !== 'invoice' || invoiceBusy) return;
    void askAboutInvoice(id, true);
  };

  /** "Continue to payment": pay the request that is already filed, without filing it again. */
  const continuePayment = async () => {
    const id = filed?.id;
    if (!filed || !id || !continuable) return;
    // On the card rail this charges the card on file with no Stripe page in between, so it is
    // asked first, in the request's own figures.
    if (onStripeRail) {
      const c = cardCharge({
        rail: billing.rail,
        entitlements,
        oneTimeNow: filed.oneTimeTotal,
        monthlyTotal: filed.monthlyTotal,
        nowMs,
      });
      const ok = await confirm({
        title: t('stripe.chargeDialog.title'),
        body: chargeSentences(c, filed.monthlyTotal).join(' '),
        confirmLabel: t('stripe.chargeDialog.confirm'),
      });
      if (!ok) return;
    }
    setPaying(true);
    setError(null);
    setResult(null);
    const outcome = await payFor(id);
    if (outcome !== 'leaving') setPaying(false);
  };

  /** "Manage card & invoices": Stripe's customer portal, in this tab. */
  const openPortal = async () => {
    setPortalBusy(true);
    setError(null);
    let leaving = false;
    try {
      const url = await openBillingPortal(getBrowserClient(), branchId);
      if (url === null) {
        setError(portalErrorMessage(null, t as PlanTranslator));
        return;
      }
      if (!isHttpsUrl(url)) throw new Error('stripe_billing_failed:unexpected_answer');
      leaving = true;
      window.location.href = url;
    } catch (e) {
      console.error('Opening the billing portal failed', e);
      setError(portalErrorMessage(e instanceof Error ? e.message : '', t as PlanTranslator));
    } finally {
      if (!leaving) setPortalBusy(false);
    }
  };

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
    // "Nothing was charged for the earlier one" is not said about a request whose card step just
    // ended without a known result: if that payment went through, it is refunded (§9.3).
    const filedSummary = filed ? summaryLine(t, locale, filedFacts(filed, branches)) : '';
    const replacing = filed
      ? [
          pendingKind === 'unconfirmed'
            ? t('stripe.replaceBodyUnconfirmed', { summary: filedSummary })
            : byCard
              ? t('stripe.replaceBody', { summary: filedSummary })
              : t('replaceDialog.body', { summary: filedSummary }),
          dropsCode ? t('replaceDialog.codeReleased', { code: dropsCode }) : null,
        ]
      : [];
    if (byCard && onStripeRail) {
      // A restaurant already paying by card is charged on the card on file the moment this is
      // sent — there is no Stripe page to back out of — so the money is named first. Replacing a
      // waiting request is said in the same dialog rather than in a second one.
      const ok = await confirm({
        title: t('stripe.chargeDialog.title'),
        body: [...replacing, ...chargeSentences(charge, monthlyNow)].filter(Boolean).join(' '),
        confirmLabel: t('stripe.chargeDialog.confirm'),
      });
      if (!ok) return;
    } else if (
      filed &&
      !(await confirm({
        title: t('replaceDialog.title'),
        body: replacing.filter(Boolean).join(' '),
        confirmLabel: t('replaceDialog.confirm'),
      }))
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);
    setStartFailedFor(null);
    setUnconfirmedFor(null);
    // Checkout and Stripe's invoice page are followed in this tab; the button stays busy until
    // the browser has left, so it cannot be pressed twice on the way out.
    let leaving = false;
    try {
      const supabase = getBrowserClient();
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
      if (!byCard) {
        router.refresh();
        return;
      }
      // Filed; now pay for THAT request. Whatever happens next, the request exists — a failure
      // leaves it on the page with Continue to payment (payFor says why).
      leaving = (await payFor(sent.id)) === 'leaving';
    } catch (e) {
      console.error('Sending the package request failed', e);
      const raw = e instanceof Error ? e.message : '';
      setError(raw ? requestErrorMessage(raw, t as PlanTranslator, locale) : t('errors.generic'));
      // The waiting request is held on Stripe's invoice page (§9.3). A page drawn before that
      // does not have the page's link yet; reading it again brings the Finish payment banner.
      if (raw.includes('payment_in_progress')) router.refresh();
    } finally {
      if (!leaving) setBusy(false);
    }
  };

  const dirty = isDirty(sel, entitlements);

  // One ladder for label and state, so the two cannot disagree. A pending request no
  // longer locks the page: an owner who asked for the wrong thing used to be stuck with it
  // until the platform owner happened to decide, and approving it could remove add-ons
  // they still pay for.
  //
  // With card billing on, every purchase label says what it charges ("Pay $199 now") — see
  // cardAction(). While a payment that went through is being recorded, nothing can be bought:
  // a new request would replace the one just paid for, and the payment would be refunded.
  const payLabel = (() => {
    const a = cardAction(charge);
    switch (a.key) {
      case 'payNow':
        return t('stripe.action.payNow', { amount: money(a.amount) });
      case 'addCard':
        return t('stripe.action.addCard', { date: day(a.date) });
      case 'confirmChange':
        return t('stripe.action.confirmChange');
      case 'confirm':
        return t('action.confirm');
    }
  })();
  const filedButton = (): { label: string; enabled: boolean; does?: 'continue' | 'finish' } => {
    switch (filedAction(pendingKind)) {
      case 'continue':
        return { label: t('stripe.action.continue'), enabled: true, does: 'continue' };
      case 'finish':
        return { label: t('stripe.action.finishPayment'), enabled: invoiceUrl !== null, does: 'finish' };
      case 'sendToTeam':
        // Filed again without the card: request_package_change replaces the card request with a
        // manual one the team can approve.
        return { label: t('stripe.action.sendToTeam'), enabled: true };
      case 'checking':
        return { label: t('stripe.action.checking'), enabled: false };
      case 'waiting':
        return { label: t('action.pending'), enabled: false };
    }
  };
  const action: { label: string; enabled: boolean; does?: 'continue' | 'finish' } = !quotable
    ? { label: t('action.pricesUnavailable'), enabled: false }
    : isSettling(result)
      ? { label: t('stripe.action.processing'), enabled: false }
      : showingFiled
        ? filedButton()
        : filed
          ? canReplacePending(pendingKind)
            ? { label: byCard ? payLabel : t('action.replace'), enabled: true }
            : { label: t('stripe.action.finishFirst'), enabled: false }
          : suspended
            ? {
                label: byCard
                  ? payLabel
                  : noTrial
                    ? t('action.requestActivation')
                    : t('action.reactivate'),
                enabled: true,
              }
            : dirty
              ? { label: byCard ? payLabel : t('action.confirm'), enabled: true }
              : renewing
                ? { label: byCard ? payLabel : t('action.renew'), enabled: true }
                : { label: t('action.current'), enabled: false };

  // The sentence under the button. On the card rail it says what renews on the card by itself;
  // with nothing to buy and no card on file there is nothing true to say about a card, so none.
  // "Renews automatically" is not said about a subscription that is set to end (UIM-4).
  const renewsByItself = onStripeRail && !isCancelling(billing);
  const footnote: string | null = !byCard
    ? t('pay.footnote')
    : action.enabled && action.does !== 'finish'
      ? (() => {
          const f = cardFootnote(charge);
          return f.key === 'firstLater'
            ? t('stripe.footnote.firstLater', { date: day(f.date), monthly: money(monthlyNow) })
            : t(`stripe.footnote.${f.key}`, { monthly: money(monthlyNow) });
        })()
      : renewsByItself
        ? t('stripe.footnote.renews', {
            monthly: money(billing.nextChargeAmount ?? entitlements.monthlyTotal),
          })
        : null;
  const trialNote: string | null = !onTrial
    ? null
    : !byCard
      ? t('pay.trialNote')
      : charge.kind === 'first'
        ? charge.monthlyFrom
          ? t('stripe.trialNote.later', { date: day(charge.monthlyFrom) })
          : t('stripe.trialNote.now')
        : null;
  const nextFact = onTrial ? null : onStripeRail ? nextCharge(billing) : null;

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0 lg:pl-0">
        <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>
      </header>

      {result && (
        <CardResultBanner
          result={result}
          canContinue={continuable}
          paying={paying}
          onContinue={continuePayment}
          onCheckAgain={() => setResult('confirming')}
        />
      )}

      {banners.pastDue && (
        <PastDueBanner
          graceUntil={banners.pastDue.graceUntil ? day(banners.pastDue.graceUntil) : null}
          busy={portalBusy}
          onManage={openPortal}
        />
      )}
      {banners.cancelling && (
        <CancellingBanner
          on={banners.cancelling.on ? day(banners.cancelling.on) : null}
          busy={portalBusy}
          onManage={openPortal}
        />
      )}

      {suspended && noTrial && <NoTrialBanner byCard={byCard} />}
      {suspended && !noTrial && <SuspendedBanner />}
      {!suspended && onTrial && <TrialBanner days={trialDays} byCard={byCard} />}
      {!suspended && !onTrial && renewing && (
        <RenewBanner
          byCard={byCard}
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

      {filed && pendingKind !== 'none' && pendingKind !== 'settling' && (
        <PendingBanner
          kind={pendingKind}
          summary={summaryLine(t, locale, filedFacts(filed, branches))}
          oneTimeTotal={filed.oneTimeTotal}
          sentOn={filed.createdAt ? day(filed.createdAt) : null}
          // The cancelled-checkout banner above already carries the button.
          showContinue={continuable && result !== 'cancelled'}
          invoiceUrl={invoiceUrl}
          paying={paying}
          finishing={invoiceBusy}
          onContinue={continuePayment}
          onFinish={finishPayment}
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
              {nextFact ? (
                // The card rail: the date (and amount) Stripe charges next, or when it ends.
                <Fact
                  label={nextFact.kind === 'cancels' ? t('stripe.now.endsOn') : t('stripe.now.nextCharge')}
                >
                  {nextFact.kind === 'charge'
                    ? nextFact.amount !== null
                      ? t('stripe.now.chargeValue', { amount: money(nextFact.amount), date: day(nextFact.at) })
                      : day(nextFact.at)
                    : nextFact.kind === 'cancels' && nextFact.on
                      ? day(nextFact.on)
                      : t('now.noNextPayment')}
                </Fact>
              ) : (
                <Fact label={onTrial ? t('now.trialEnds') : t('now.nextPayment')}>
                  {entitlements.entitledThrough
                    ? formatInZone(entitlements.entitledThrough, timezone, { dateOnly: true }, locale)
                    : t('now.noNextPayment')}
                </Fact>
              )}
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

          {/* 1b. Billing — only for a restaurant that pays by card. */}
          {onStripeRail && (
            <BillingCard
              billing={billing}
              day={day}
              busy={portalBusy}
              onManage={openPortal}
            />
          )}

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
                {/* Seats already paid for can be used today; seats this change adds wait for the
                    request to be approved. Saying "once this is approved" about a seat the
                    restaurant already owns sent owners looking for a request that was not there. */}
                {sel.branchSeats <= entitlements.branchSeats
                  ? t('seats.newSeatsReady', { count: totals.unusedSeats })
                  : byCard
                    ? t('stripe.newSeats', { count: totals.unusedSeats })
                    : t('seats.newSeats', { count: totals.unusedSeats })}
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
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {t(payOnceNote(pendingKind))}
                  </p>
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

          {trialNote && (
            <p className="mt-3 rounded-xl bg-primary/10 px-3 py-2 text-xs">{trialNote}</p>
          )}

          <Button
            variant="gradient"
            fullWidth
            className="mt-4"
            loading={busy || (action.does === 'continue' && paying) || (action.does === 'finish' && invoiceBusy)}
            disabled={!action.enabled || paying || (action.does === 'finish' && invoiceBusy)}
            onClick={
              action.does === 'continue'
                ? continuePayment
                : action.does === 'finish'
                  ? finishPayment
                  : submit
            }
            leftIcon={
              byCard && action.enabled ? (
                <CreditCard className="h-4 w-4" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )
            }
          >
            {action.label}
          </Button>

          {/* Only Stripe can work out the proration, so the page says it exists, not what it is. */}
          {byCard && action.enabled && charge.kind === 'change' && charge.monthlyChanges && (
            <p className="mt-2 text-xs text-muted-foreground">{t('stripe.prorationNote')}</p>
          )}

          {footnote && <p className="mt-3 text-xs text-muted-foreground">{footnote}</p>}
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

function TrialBanner({ days, byCard }: { days: number | null; byCard: boolean }) {
  const t = useTranslations('settings.plan.trial');
  const stripe = useTranslations('settings.plan.stripe');
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
        {/* "No card needed until the trial ends" is the manual rail's promise. With card
            billing on, buying early charges the one-time fees now and keeps the trial's days. */}
        <p className="text-muted-foreground">{byCard ? stripe('trialBody') : t('body')}</p>
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
function NoTrialBanner({ byCard }: { byCard: boolean }) {
  const t = useTranslations('settings.plan.noTrial');
  const stripe = useTranslations('settings.plan.stripe');
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-warning/15 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div>
        <p className="font-semibold">{t('title')}</p>
        <p className="text-muted-foreground">{byCard ? stripe('noTrialBody') : t('body')}</p>
      </div>
    </div>
  );
}

function RenewBanner({ paidThrough, byCard }: { paidThrough: string | null; byCard: boolean }) {
  const t = useTranslations('settings.plan.renew');
  const stripe = useTranslations('settings.plan.stripe');
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-primary/10 px-4 py-3 text-sm">
      <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div>
        <p className="font-semibold">{t('title')}</p>
        <p className="text-muted-foreground">
          {paidThrough && <>{t('paidThrough', { date: paidThrough })} </>}
          {byCard ? stripe('renewBody') : t('body')}
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
  // Settled by the merchant's own card payment: "paid", and no "note from the Favornoms team",
  // because the team never saw it — the note on the row is the settlement's bookkeeping.
  const paid = approved && decision.paidByCard;
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
          {paid
            ? t('stripe.decision.paidOn', { date: on })
            : approved
              ? t('decision.approvedOn', { date: on })
              : t('decision.declinedOn', { date: on })}
        </p>
        <p className="text-muted-foreground">
          {summary}
          {decision.oneTimeTotal > 0 && ` ${t('pay.summary.plusOnce', { price: money(decision.oneTimeTotal) })}`}
        </p>
        {paid ? null : decision.decisionNote ? (
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
        {paid ? t('stripe.decision.paid') : approved ? t('decision.approved') : t('decision.declined')}
      </Badge>
    </div>
  );
}

/**
 * The request that is filed and not settled. Who it waits for decides every sentence: the
 * Favornoms team (card billing off), the merchant's card (Checkout was opened for it, or
 * starting the card payment failed), either (a request for the team while card billing is on),
 * Stripe's invoice page (3-D Secure or a declined card), a card step whose result is not known
 * yet, or a card request that can no longer be paid by card — see pendingPayment().
 */
function PendingBanner({
  kind,
  summary,
  oneTimeTotal,
  sentOn,
  showContinue,
  invoiceUrl,
  paying,
  finishing,
  onContinue,
  onFinish,
}: {
  kind: Exclude<PendingPayment, 'none' | 'settling'>;
  summary: string;
  oneTimeTotal: number;
  sentOn: string | null;
  showContinue: boolean;
  invoiceUrl: string | null;
  paying: boolean;
  /** The page is asking stripe-billing about the invoice (on opening, or after a press). */
  finishing: boolean;
  onContinue: () => void;
  /** Asks `start` about the invoice first, then opens Stripe's page for it (§10.1). */
  onFinish: () => void;
}) {
  const t = useTranslations('settings.plan');
  const card = kind === 'card' || kind === 'invoice';
  const title =
    kind === 'invoice'
      ? t('stripe.pending.invoiceTitle')
      : kind === 'unconfirmed'
        ? t('stripe.pending.unconfirmedTitle')
        : kind === 'cardPaused'
          ? t('stripe.pending.pausedTitle')
          : card
            ? sentOn
              ? t('stripe.pending.titleSent', { date: sentOn })
              : t('stripe.pending.title')
            : sentOn
              ? t('pending.titleSent', { date: sentOn })
              : t('pending.title');
  const body =
    kind === 'invoice'
      ? t('stripe.pending.invoiceBody')
      : kind === 'unconfirmed'
        ? t('stripe.pending.unconfirmedBody')
        : kind === 'cardPaused'
          ? t('stripe.pending.pausedBody')
          : card
            ? t('stripe.pending.body')
            : t('pending.body');
  return (
    <div
      className={`mb-4 flex flex-wrap items-start gap-3 rounded-xl px-4 py-3 text-sm ${
        card || kind === 'unconfirmed' ? 'bg-primary/10' : 'bg-muted'
      }`}
    >
      {card ? (
        <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      ) : kind === 'unconfirmed' ? (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      ) : (
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        <p className="text-muted-foreground">
          {summary}
          {oneTimeTotal > 0 && ` ${t('pay.summary.plusOnce', { price: money(oneTimeTotal) })}`} {body}
          {kind === 'teamOrCard' && ` ${t('stripe.pending.orPayByCard')}`}
        </p>
        {showContinue && (
          <Button
            size="sm"
            variant="gradient"
            className="mt-2"
            loading={paying}
            onClick={onContinue}
            leftIcon={<CreditCard className="h-4 w-4" />}
          >
            {t('stripe.action.continue')}
          </Button>
        )}
        {/* Stripe's hosted invoice page, where the bank's check or a new card finishes it. A
            button, not a link: the invoice is asked about first, so one past its window is
            cancelled instead of opened (§10.1). */}
        {kind === 'invoice' && invoiceUrl && (
          <Button
            size="sm"
            variant="gradient"
            className="mt-2"
            loading={finishing}
            onClick={onFinish}
            leftIcon={<CreditCard className="h-4 w-4" />}
            rightIcon={<ExternalLink className="h-3.5 w-3.5" />}
          >
            {t('stripe.action.finishPayment')}
          </Button>
        )}
      </div>
      <Badge variant="warning" className="ml-auto shrink-0">
        {kind === 'unconfirmed'
          ? t('stripe.pending.unconfirmedBadge')
          : card || kind === 'cardPaused'
            ? t('stripe.pending.badge')
            : t('pending.badge')}
      </Badge>
    </div>
  );
}

/** What the card payment the merchant just made (or walked away from) came to. */
function CardResultBanner({
  result,
  canContinue,
  paying,
  onContinue,
  onCheckAgain,
}: {
  result: CardResult;
  canContinue: boolean;
  paying: boolean;
  onContinue: () => void;
  onCheckAgain: () => void;
}) {
  const t = useTranslations('settings.plan.stripe.result');
  const stripe = useTranslations('settings.plan.stripe');
  if (result === 'refundedStale' || result === 'refundedFailed') {
    // The money is on its way back and nothing is locked: the request that is open now (if any)
    // is shown below with its own Continue to payment, and the buy button works again.
    const stale = result === 'refundedStale';
    return (
      <div role="status" className="mb-4 flex items-start gap-3 rounded-xl bg-warning/15 px-4 py-3 text-sm">
        <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="font-semibold">{stale ? t('refundedStaleTitle') : t('refundedFailedTitle')}</p>
          <p className="text-muted-foreground">{stale ? t('refundedStaleBody') : t('refundedFailedBody')}</p>
        </div>
      </div>
    );
  }
  if (result === 'notApplied') {
    // Checkout took nothing and the request could not be applied: no refund to promise, nothing
    // locked. Whatever is waiting now is shown below with its own Continue to payment.
    return (
      <div role="status" className="mb-4 flex items-start gap-3 rounded-xl bg-warning/15 px-4 py-3 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="font-semibold">{t('notAppliedTitle')}</p>
          <p className="text-muted-foreground">{t('notAppliedBody')}</p>
        </div>
      </div>
    );
  }
  if (result === 'cancelled') {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-xl bg-muted px-4 py-3 text-sm">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="font-semibold">{t('cancelledTitle')}</p>
          <p className="text-muted-foreground">{t('cancelledBody')}</p>
          {canContinue && (
            <Button
              size="sm"
              variant="gradient"
              className="mt-2"
              loading={paying}
              onClick={onContinue}
              leftIcon={<CreditCard className="h-4 w-4" />}
            >
              {stripe('action.continue')}
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (result === 'confirming' || result === 'processing') {
    const confirming = result === 'confirming';
    return (
      <div
        role="status"
        className="mb-4 flex items-start gap-3 rounded-xl bg-primary/10 px-4 py-3 text-sm"
      >
        {confirming ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
        ) : (
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        )}
        <div className="min-w-0">
          <p className="font-semibold">{confirming ? t('confirmingTitle') : t('processingTitle')}</p>
          <p className="text-muted-foreground">{confirming ? t('confirmingBody') : t('processingBody')}</p>
          {!confirming && (
            <Button size="sm" variant="outline" className="mt-2" onClick={onCheckAgain}>
              {t('checkAgain')}
            </Button>
          )}
        </div>
      </div>
    );
  }
  const applied = result === 'applied';
  return (
    <div role="status" className="mb-4 flex items-start gap-3 rounded-xl bg-success/10 px-4 py-3 text-sm">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      <div className="min-w-0">
        <p className="font-semibold">{applied ? t('appliedTitle') : t('activeTitle')}</p>
        <p className="text-muted-foreground">{applied ? t('appliedBody') : t('activeBody')}</p>
      </div>
    </div>
  );
}

/**
 * A renewal failed. The restaurant keeps working until the grace date while Stripe retries the
 * card (D9), so this is a warning with a way out, not a suspension.
 */
function PastDueBanner({
  graceUntil,
  busy,
  onManage,
}: {
  graceUntil: string | null;
  busy: boolean;
  onManage: () => void;
}) {
  const t = useTranslations('settings.plan.stripe.pastDue');
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="font-semibold text-destructive">{t('title')}</p>
        <p className="text-muted-foreground">
          {graceUntil ? t('body', { date: graceUntil }) : t('bodyNoDate')}
        </p>
        <Button
          size="sm"
          variant="danger"
          className="mt-2"
          loading={busy}
          onClick={onManage}
          leftIcon={<CreditCard className="h-4 w-4" />}
        >
          {t('cta')}
        </Button>
      </div>
    </div>
  );
}

/** Cancelled in the portal: it runs to the end of the paid month and does not renew (D10). */
function CancellingBanner({
  on,
  busy,
  onManage,
}: {
  on: string | null;
  busy: boolean;
  onManage: () => void;
}) {
  const t = useTranslations('settings.plan.stripe');
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-warning/15 px-4 py-3 text-sm">
      <CalendarX className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0">
        <p className="font-semibold">
          {on ? t('cancelling.title', { date: on }) : t('cancelling.titleNoDate')}
        </p>
        <p className="text-muted-foreground">{t('cancelling.body')}</p>
        <Button size="sm" variant="outline" className="mt-2" loading={busy} onClick={onManage}>
          {t('billing.manage')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The card rail's own facts: the next charge, the card it goes on and the last invoice, with
 * Stripe's portal for everything a merchant does about them (D10: card, invoices, cancel).
 */
function BillingCard({
  billing,
  day,
  busy,
  onManage,
}: {
  billing: BillingRailInfo;
  day: (iso: string) => string;
  busy: boolean;
  onManage: () => void;
}) {
  const t = useTranslations('settings.plan.stripe.billing');
  const status = useTranslations('settings.plan.stripe');
  const next = nextCharge(billing);
  const card = billing.card;
  const expiry = card ? cardExpiry(card) : null;
  const expiring = cardExpiresBefore(card, next.kind === 'charge' ? next.at : null);
  const invoice = billing.lastInvoice;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <CreditCard className="h-5 w-5 shrink-0 text-muted-foreground" />
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <Fact label={t('nextCharge')}>
          {next.kind === 'charge' ? (
            <span className="tabular-nums">
              {next.amount !== null
                ? status('now.chargeValue', { amount: money(next.amount), date: day(next.at) })
                : day(next.at)}
            </span>
          ) : next.kind === 'cancels' ? (
            next.on ? t('cancelsOn', { date: day(next.on) }) : t('noNextCharge')
          ) : (
            t('noNextCharge')
          )}
        </Fact>
        <Fact label={t('card')}>
          {card ? (
            <>
              <span>
                {t('cardValue', { brand: cardBrandName(card.brand), last4: card.last4 }).trim()}
              </span>
              {expiry && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {t('cardExpires', { date: expiry })}
                </span>
              )}
            </>
          ) : (
            t('noCard')
          )}
        </Fact>
        <Fact label={t('lastInvoice')}>
          {invoice ? (
            <>
              <span className="tabular-nums">
                {t('invoiceValue', {
                  amount: money(invoiceAmount(invoice)),
                  status: status(`invoiceStatus.${invoiceStatusKey(invoice.status)}`),
                })}
              </span>
              {invoice.paidAt && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {day(invoice.paidAt)}
                </span>
              )}
              {invoice.hostedInvoiceUrl && isStripeUrl(invoice.hostedInvoiceUrl) && (
                <a
                  href={invoice.hostedInvoiceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="focus-ring mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  {t('viewInvoice')}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </>
          ) : (
            t('noInvoice')
          )}
        </Fact>
      </dl>
      {expiring && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-warning/15 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>{t('cardExpiring')}</span>
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          loading={busy}
          onClick={onManage}
          leftIcon={<CreditCard className="h-4 w-4" />}
        >
          {t('manage')}
        </Button>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t('manageHint')}</p>
      </div>
    </Card>
  );
}
