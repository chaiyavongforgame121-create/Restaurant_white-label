// The plan page's card-billing decisions (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §5), with
// no React in them so they can be pinned in a test. The dashboard's billing card reads the same
// rules from here, so the two screens cannot tell a merchant different things about one bill.
//
// Two rails pay the platform. On the MANUAL rail a request waits for the Favornoms team, and
// nothing renews by itself. On the STRIPE rail the merchant files the same request and pays it
// by card straight away, and the monthly fee renews on the card by itself. Which rail a
// restaurant is on is the server's answer (`billing.rail`, from billing_is_stripe_managed); an
// unreadable answer is MANUAL_RAIL, so every rule below falls back to today's manual copy.

import type {
  BillingCard,
  BillingInvoiceSummary,
  BillingRailInfo,
  CardPaymentStart,
} from '@favornoms/database/queries';
import type { Entitlements } from '@favornoms/shared';
import { cardMayBeCharged, cardStepError, type CardStepError } from './plan-copy';

const DAY_MS = 86_400_000;

// --- coming back from Stripe -------------------------------------------------

/**
 * Where Stripe Checkout sent the merchant back from. `sessionId` is what `confirmCheckout`
 * settles; null when the URL carried none (or carried something that is not a session id),
 * in which case the page only waits for the webhook.
 */
export type CheckoutReturn = { kind: 'success'; sessionId: string | null } | { kind: 'cancelled' } | null;

/**
 * A Checkout Session id as Stripe writes it into the success URL (`cs_test_…`, `cs_live_…`).
 *
 * The query string is anyone's to edit, so the id is shape-checked before it is sent to the
 * edge function. That is not the security boundary (the function re-reads the session and
 * checks the caller may bill its restaurant); it keeps an unsubstituted `{CHECKOUT_SESSION_ID}`
 * or a pasted fragment from turning into an error banner on a payment that went through.
 */
export function isCheckoutSessionId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^cs_[A-Za-z0-9_]{8,255}$/.test(raw);
}

export function readCheckoutReturn(checkout: unknown, sessionId: unknown): CheckoutReturn {
  if (checkout === 'success') {
    return { kind: 'success', sessionId: isCheckoutSessionId(sessionId) ? sessionId : null };
  }
  if (checkout === 'cancelled') return { kind: 'cancelled' };
  return null;
}

/** `?portal=return`: Stripe's customer portal sent the merchant back. */
export function readPortalReturn(portal: unknown): boolean {
  return portal === 'return';
}

/**
 * The banner a card payment leaves on the page.
 *
 * - confirming: back from Checkout, the settlement has not reached our records yet.
 * - processing: still not there after the polling cap. The payment did go through (Stripe only
 *   uses the success URL after it did), so the page says so and asks the merchant NOT to pay
 *   again rather than offering the button that would.
 * - active: the first purchase settled; the restaurant is on the Stripe rail.
 * - applied: a change was charged to the card on file and is live.
 * - cancelled: the merchant left Checkout; nothing was charged and the request is still there.
 * - refundedStale: the payment was for a request that is no longer open (replaced in another
 *   tab, or declined by the team, after Checkout opened). stripe-webhook refunds it in full and
 *   cancels the subscription it created (D12), so the page says so and lets the merchant pay
 *   the request that IS open, instead of promising a package that will never turn on.
 * - refundedFailed: the payment went through but the package could not be applied; the money
 *   is given back (§9.5).
 * - notApplied: Checkout finished with nothing to pay (an "Add card" Checkout, where the monthly
 *   fee starts at the end of time already covered), and the request could not be applied —
 *   replaced or closed meanwhile, or it no longer fits. Nothing was charged, so nothing is
 *   refunded, and the page lets the merchant pay whatever is waiting now (ui-rr-1).
 */
export type CardResult =
  | 'confirming'
  | 'processing'
  | 'active'
  | 'applied'
  | 'cancelled'
  | 'refundedStale'
  | 'refundedFailed'
  | 'notApplied';

/** How often the page re-reads the overview while it waits, and for how long at most. */
export const CHECKOUT_POLL_MS = 2_000;
export const CHECKOUT_POLL_CAP_MS = 20_000;

/** The waiting request as the return page needs it: whether it is the one Checkout was opened for. */
export interface ReturnPending {
  /** billing_requests.stripe_checkout_session_id: the Checkout opened for it, if any. */
  checkoutSessionId: string | null;
  rail: 'manual' | 'stripe';
}

/**
 * Is the session in the URL the payment for the request that is waiting now?
 *
 * - pending: yes. Its payment went through and is on its way to our records: wait for it, and
 *   do not let anything be paid again meanwhile.
 * - other: no. Either an old URL out of the history or a bookmark (UIM-8), or a Checkout for a
 *   request that was replaced or declined since (UIM-3). Neither can turn the waiting request
 *   (if any) into a paid one, so nothing on the page may be locked on its account.
 * - unknown: the URL carried no usable session id; only the webhook can tell.
 */
export type SessionMatch = 'pending' | 'other' | 'unknown';

export function sessionMatch(sessionId: string | null, pending: ReturnPending | null): SessionMatch {
  if (!sessionId) return 'unknown';
  return pending?.checkoutSessionId === sessionId ? 'pending' : 'other';
}

export function openingCardResult(
  ret: CheckoutReturn,
  rail: BillingRailInfo['rail'],
  pending: ReturnPending | null,
): CardResult | null {
  if (!ret) return null;
  if (ret.kind === 'cancelled') return 'cancelled';
  const match = sessionMatch(ret.sessionId, pending);
  if (rail === 'stripe') {
    // The webhook can beat the browser back: then there is nothing left to wait for. A
    // restaurant already paying by card that still has a request waiting, though, is looking
    // at an old URL — announcing "your package is active" would also hide that request.
    return match === 'other' && pending ? null : 'active';
  }
  // No session id to confirm and no card request that could be settling: there is nothing to
  // wait for, and waiting would lock the page behind "do not pay again" for good.
  if (match === 'unknown' && pending?.rail !== 'stripe') return null;
  return 'confirming';
}

/**
 * The banner after one more look at the overview.
 *
 * Settled means `rail === 'stripe'` — the one definition every guard uses (§3.4) — rather than
 * `entitled` or the status: a trialing merchant is entitled and 'active'-looking before AND
 * after paying, so those would declare victory on the first poll.
 *
 * Only a session that is (or may be) the waiting request's own becomes "processing" at the cap;
 * one that is not can never settle that request, so the wait simply ends.
 */
export function cardResultAfterPoll(
  phase: CardResult | null,
  rail: BillingRailInfo['rail'],
  elapsedMs: number,
  match: SessionMatch = 'pending',
): CardResult | null {
  if (!isSettling(phase)) return phase;
  if (rail === 'stripe') return 'active';
  if (phase === 'confirming' && elapsedMs >= CHECKOUT_POLL_CAP_MS) {
    return match === 'other' ? null : 'processing';
  }
  return phase;
}

/**
 * What `confirmCheckout` said about the session, or the code it failed with. `reason` is the
 * settlement's own refusal, which stripe-billing sends beside `status: 'charged_refunded'`.
 */
export type ConfirmOutcome =
  | { kind: 'answer'; settled: boolean; status: string | null; reason?: string | null }
  | { kind: 'failed'; code: string };

/**
 * Money was taken and the settlement refused it: the webhook refunds it (D12, §9.5). The only
 * status that means a charge — stripe-billing sends it when the session's payment_status is
 * 'paid', with the refusal beside it in `reason`.
 */
const CONFIRM_CHARGED = /^charged_refunded\b/;
/** The refusal beside charged_refunded: the request closed after Checkout opened. */
const REASON_STALE = /^(request_not_pending|request_not_found|not_pending)\b/;
/**
 * What billing_settle_stripe_request refuses with, sent bare when Checkout took nothing
 * (payment_status 'no_payment_required'): nothing was charged, so nothing is refunded (ui-rr-1).
 */
const CONFIRM_NOT_APPLIED =
  /^(request_not_pending|request_not_found|not_pending|settle_failed|invalid_arguments|not_settled|plan_limit_exceeded)\b/;
/** The session was never paid (an old or hand-typed URL): nothing is on its way. */
const CONFIRM_UNPAID = /^(open|expired)\b/;
/** The caller can never settle this session here; retrying will not change that. */
const CONFIRM_REFUSED = /^(forbidden|not_a_package_payment|bad_request|cannot_bill|platform_admin_only)\b/;

/**
 * The banner once `confirmCheckout` has answered.
 *
 * Before this the page only acted on `settled: true`, so a Checkout for a replaced or declined
 * request (refunded by the webhook) and an old success URL both sat under "payment received,
 * do not pay again" with the buy button disabled, on every reload (UIM-3, UIM-8).
 */
export function cardResultAfterConfirm(
  phase: CardResult | null,
  outcome: ConfirmOutcome,
  ctx: {
    rail: BillingRailInfo['rail'];
    match: SessionMatch;
    /** A request paid by card was waiting when the page opened. */
    pendingIsCard?: boolean;
  },
): CardResult | null {
  if (!isSettling(phase)) return phase;
  if (ctx.rail === 'stripe') return 'active';
  if (outcome.kind === 'failed') {
    if (CONFIRM_REFUSED.test(outcome.code)) return null;
    // An outage: the webhook settles the same session. Only the waiting request's own payment
    // is worth waiting for.
    return ctx.match === 'other' ? null : phase;
  }
  if (outcome.settled) {
    // Settled now (the refresh brings the card rail) — or settled long ago, when the URL is old.
    // While a card request is waiting the page does not bet on which: it keeps the lock until the
    // refresh or the polling cap (which ends it for a session that is not that request's), so a
    // mismatch in what the page read can never put Continue to payment next to a paid request.
    return ctx.match === 'other' && !ctx.pendingIsCard ? null : phase;
  }
  const status = outcome.status ?? '';
  // Only 'charged_refunded' is a refund. It covers both a request that closed after Checkout
  // opened and a package that no longer fits; the reason beside it says which. Without one, the
  // failed copy is the one that is true either way ("could not be applied").
  if (CONFIRM_CHARGED.test(status)) {
    return REASON_STALE.test(outcome.reason ?? '') ? 'refundedStale' : 'refundedFailed';
  }
  // A bare settle refusal: the session took no money. Saying "it is being refunded" promised a
  // refund that never comes; waiting would lock the page for good. It is over, and says so.
  if (CONFIRM_NOT_APPLIED.test(status)) return 'notApplied';
  if (CONFIRM_UNPAID.test(status)) return null;
  // 'unpaid' (a payment still clearing), 'dormant', anything new: keep waiting for our own.
  return ctx.match === 'other' ? null : phase;
}

/** A payment that went through and has not reached our records: nothing may be paid again. */
export function isSettling(phase: CardResult | null): boolean {
  return phase === 'confirming' || phase === 'processing';
}

/**
 * Where the page may send the browser when our edge function answers with a URL.
 *
 * Any https URL. The function is the trust boundary: it asked Stripe with the secret key and
 * passes on Stripe's own `url`, which is on the platform's custom domain once one is set up for
 * Checkout and the customer portal (SEC-EDGE-3) — an allow-list of stripe.com hosts broke every
 * purchase then. Anything that is not https (javascript:, a relative path, garbage) is still
 * refused, so a bug ends in a readable error rather than a navigation.
 */
export function isHttpsUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw === '') return false;
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Links read from our records (the last invoice, the invoice a change waits on) are only shown
 * when they are Stripe's own pages. Stripe serves hosted invoices on invoice.stripe.com whatever
 * custom domain is set (custom domains cover Checkout, Payment Links and the portal), so this
 * costs nothing, and a stored value that is not Stripe's never becomes a link on the page.
 */
export function isStripeUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com'));
  } catch {
    return false;
  }
}

/**
 * The message key for a Stripe invoice status under settings.plan.stripe.invoiceStatus.
 * An uncollectible invoice reads as unpaid, which is what it is to the merchant; anything
 * Stripe adds later reads as pending rather than as paid.
 */
export function invoiceStatusKey(status: string | null | undefined): 'paid' | 'open' | 'void' | 'other' {
  if (status === 'paid') return 'paid';
  if (status === 'open' || status === 'uncollectible') return 'open';
  if (status === 'void') return 'void';
  return 'other';
}

// --- the request waiting to be paid ------------------------------------------

/**
 * Whether this restaurant's purchases are paid by card.
 *
 * The platform switch controls NEW card purchases only (§9.9): a restaurant already on the card
 * rail keeps renewing, and its changes can only be applied through Stripe — decide_billing_request
 * refuses to approve anything for a Stripe-managed restaurant by hand (stripe_managed). Filing it
 * a manual request while the switch is off would leave it waiting for a team that can never say
 * yes (UIM-5).
 */
export function paysByCard(billing: Pick<BillingRailInfo, 'stripeEnabled' | 'rail'>): boolean {
  return billing.stripeEnabled || billing.rail === 'stripe';
}

/**
 * What the waiting request needs from the merchant.
 *
 * - none: nothing is waiting.
 * - team: card billing is off; the Favornoms team activates it (today's banner).
 * - card: it waits for the card payment — Checkout was opened for it, starting the card payment
 *   failed after it was filed, or the restaurant already pays by card. "Continue to payment"
 *   finishes it. The last case is what a reload shows for a change whose card step failed before
 *   Stripe invoiced it: the server only marks a request as a card request once Stripe has an
 *   invoice for it, so the row still reads 'manual' — yet the team can never approve a card
 *   restaurant's request by hand (D11), so "waiting for the Favornoms team" would strand it
 *   (ui-rr-4).
 * - teamOrCard: a request filed for the team (before card billing was switched on) while card
 *   billing is on. The team can still approve it — the manual rail stays for bank transfers —
 *   so the banner keeps saying so, and offers the card as well.
 * - invoice: a change charged to the card on file is waiting on Stripe's invoice page (3-D
 *   Secure, or a declined card). The merchant finishes it there; until then the server refuses
 *   to replace it (payment_in_progress), so the page offers "Finish payment" instead of anything
 *   that would be refused (§9.3). That button — and the page, when it opens — asks stripe-billing
 *   `start` about the invoice first rather than only linking to it, which is what voids an invoice
 *   past its window and cancels the request, so the lock always ends (§10.1): see invoiceStep().
 * - unconfirmed: the card step for it ended on this page without a known result — the card on
 *   file may have been charged (UIM-1). Nothing is offered for it until the page is read again.
 * - cardPaused: it was waiting for a card payment, and card payments are switched off for this
 *   restaurant now. The team cannot approve a card request by hand, so it is sent to them again
 *   as a manual one instead of sitting under a "waiting for the team" banner forever (UIM-5).
 * - settling: a payment for it went through and is being recorded. Offering to pay again here
 *   is how a merchant pays twice.
 *
 * After a payment settled on this page ('active', 'applied') the request the page still holds is
 * the copy from before the refresh — it is approved on the server — so it reads as nothing
 * waiting. The page clears the result when the merchant starts another purchase.
 */
export type PendingPayment =
  | 'none'
  | 'team'
  | 'teamOrCard'
  | 'card'
  | 'invoice'
  | 'unconfirmed'
  | 'cardPaused'
  | 'settling';

export function pendingPayment(args: {
  pending: { id: string | null; rail: 'manual' | 'stripe' } | null;
  /** The RESTAURANT's rail (billing.rail): 'stripe' when it already pays the platform by card. */
  restaurantRail: BillingRailInfo['rail'];
  /** paysByCard(): the switch is on, or the restaurant already pays by card. */
  byCard: boolean;
  /** Stripe's page for the invoice the waiting request is held on, when it is one of Stripe's. */
  invoiceUrl: string | null;
  /** The request whose card start just failed on this page, if any. */
  startFailedFor: string | null;
  /** The request whose card step ended with an unknown result on this page, if any. */
  unconfirmedFor: string | null;
  result: CardResult | null;
}): PendingPayment {
  const { pending, restaurantRail, byCard, invoiceUrl, startFailedFor, unconfirmedFor, result } = args;
  if (!pending || !pending.id) return 'none';
  if (isSettling(result)) return 'settling';
  if (result === 'active' || result === 'applied') return 'none';
  if (unconfirmedFor === pending.id) return 'unconfirmed';
  if (pending.rail === 'stripe' && invoiceUrl) return 'invoice';
  if (!byCard) return pending.rail === 'stripe' ? 'cardPaused' : 'team';
  if (pending.rail === 'stripe' || restaurantRail === 'stripe' || startFailedFor === pending.id) return 'card';
  return 'teamOrCard';
}

/** Whether the page offers "Continue to payment" for the waiting request. */
export function canContinuePayment(kind: PendingPayment): boolean {
  return kind === 'card' || kind === 'teamOrCard';
}

/**
 * What the purchase button does while the selection on screen IS the waiting request.
 *
 * - continue: pay it ("Continue to payment").
 * - finish: open Stripe's invoice page it is held on ("Finish payment").
 * - sendToTeam: card payments are paused for it; file it again as a manual request.
 * - checking: its card step ended without a known result; nothing until the page is read again.
 * - waiting: it waits for the Favornoms team (or is being recorded); nothing to press.
 */
export type FiledAction = 'continue' | 'finish' | 'sendToTeam' | 'checking' | 'waiting';

export function filedAction(kind: PendingPayment): FiledAction {
  if (canContinuePayment(kind)) return 'continue';
  if (kind === 'invoice') return 'finish';
  if (kind === 'cardPaused') return 'sendToTeam';
  if (kind === 'unconfirmed') return 'checking';
  return 'waiting';
}

/**
 * The sentence under the waiting request's one-time total (a settings.plan key). "Nothing has
 * been charged yet" is only said where it is true: not while a payment for it is being recorded,
 * and not after a card step whose result is unknown.
 */
export function payOnceNote(
  kind: PendingPayment,
): 'stripe.onceAwaiting' | 'stripe.onceSettling' | 'stripe.onceUnconfirmed' | 'pay.onceAwaiting' {
  if (kind === 'settling') return 'stripe.onceSettling';
  if (kind === 'unconfirmed') return 'stripe.onceUnconfirmed';
  if (kind === 'card' || kind === 'invoice') return 'stripe.onceAwaiting';
  return 'pay.onceAwaiting';
}

/**
 * Whether another selection may be sent in place of the waiting request. Not while it is held
 * on Stripe's invoice page: request_package_change refuses that (payment_in_progress, §9.3), so
 * the button says to finish the payment first instead of offering a purchase that fails.
 */
export function canReplacePending(kind: PendingPayment): boolean {
  return kind !== 'invoice';
}

/**
 * What `start` answered about a request held on an invoice: startCardPayment's answer, or the
 * message it threw.
 */
export type InvoiceStartOutcome = { kind: 'answer'; start: CardPaymentStart } | { kind: 'failed'; raw: string };

/**
 * What the page does with that answer.
 *
 * - go: open this page — Stripe's invoice page as `start` just gave it, or, when `start` could
 *   not say, the one stored with the request (Stripe's own page then tells the truth about it).
 * - applied: the invoice had been paid; `start` settled it and the change is live.
 * - tell: say what happened; read the page again when `refresh`. `unconfirmed` when the card may
 *   have been charged, so nothing is offered for that request until the page is read again.
 * - refresh: read the page again without a word (the request moved on since it was drawn).
 * - stay: nothing changes on the page.
 */
export type InvoiceStep =
  | { do: 'go'; url: string }
  | { do: 'applied' }
  | { do: 'tell'; error: CardStepError; refresh: boolean; unconfirmed: boolean }
  | { do: 'refresh' }
  | { do: 'stay' };

/**
 * A request held on Stripe's invoice page is asked about through `start` (§10.1), both when the
 * page opens (`pressed` false) and when "Finish payment" is pressed. For a request that already
 * has an invoice, `start` only resolves it: paid → settled ('applied'); open → its page
 * ('action_required'); past its ~23 h window, void or gone → voided and the request cancelled
 * (payment_expired). Only linking to the invoice, as the page used to, left a declined fee invoice
 * nobody paid holding the restaurant in payment_in_progress for good (edge-rr-1).
 *
 * Opening the page never navigates anywhere and stays quiet about anything that only matters to
 * someone pressing a button: it says only what is true about the money (charged, refunded, put
 * back, expired). A press that gets no clear answer falls back to the stored invoice page.
 */
export function invoiceStep(
  outcome: InvoiceStartOutcome,
  ctx: { pressed: boolean; storedUrl: string | null },
): InvoiceStep {
  const { pressed, storedUrl } = ctx;
  const unclear: InvoiceStep = !pressed
    ? { do: 'stay' }
    : storedUrl
      ? { do: 'go', url: storedUrl }
      : { do: 'tell', error: 'resultUnknown', refresh: true, unconfirmed: true };
  if (outcome.kind === 'answer') {
    const start = outcome.start;
    if (start.kind === 'applied') return { do: 'applied' };
    if (start.kind === 'dormant') {
      return pressed ? { do: 'tell', error: 'cardPaused', refresh: false, unconfirmed: false } : { do: 'stay' };
    }
    // Still open: this is its page. (A Checkout answer cannot come for a card restaurant's change;
    // it would be a page to pay this request on all the same.)
    if (!pressed) return { do: 'stay' };
    return isHttpsUrl(start.url) ? { do: 'go', url: start.url } : unclear;
  }
  // `start` on a card restaurant's request is a card-on-file call, whatever it did this time.
  const error = cardStepError(outcome.raw, true);
  switch (error) {
    case 'paymentExpired':
    case 'changeNotApplied':
    case 'chargedRefunded':
    case 'chargedNotApplied':
    case 'changeConflict':
      return { do: 'tell', error, refresh: true, unconfirmed: cardMayBeCharged(error) };
    case 'requestGone':
      return pressed ? { do: 'tell', error, refresh: true, unconfirmed: false } : { do: 'refresh' };
    case 'busy':
    case 'signedOut':
    case 'forbidden':
    case 'planLimit':
    case 'needsTeam':
    case 'cardPaused':
    case 'dormant':
      return pressed ? { do: 'tell', error, refresh: false, unconfirmed: false } : { do: 'stay' };
    case 'resultUnknown':
    case 'startFailed':
      return unclear;
  }
}

// --- what is charged now ------------------------------------------------------

/**
 * Time already covered is not charged twice (D5): with more than this left on the trial or on
 * a paid-through date, the monthly charge starts at that date and only the one-time fees are
 * charged now.
 *
 * The SAME rule as the edge function's billingAnchor() (supabase/functions/_shared/
 * stripe-billing.ts), constant for constant — Stripe's 48-hour minimum for a Checkout trial_end
 * plus the edge's 10-minute margin, and its two-year clamp — and a test runs both over the same
 * cases. A page that deferred at "more than 48 hours" while the edge wanted 48 h 10 min promised
 * "your monthly fee starts on {date}" for a Checkout that charged the month today (UIM-7).
 */
export const STRIPE_MIN_TRIAL_LEAD_MS = 48 * 3_600_000;
export const ANCHOR_SAFETY_MS = 10 * 60_000;
export const ANCHOR_MAX_LEAD_MS = 729 * DAY_MS;
export const MONTHLY_DEFER_MIN_MS = STRIPE_MIN_TRIAL_LEAD_MS + ANCHOR_SAFETY_MS;

type Covered = Pick<Entitlements, 'status' | 'trialEndsAt' | 'entitledThrough'>;

const msOf = (iso: string | null): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The date the restaurant is already covered to: the later of the trial's end and its deadline
 * while trialing, the date it paid through when active or cancelled-but-paid. past_due and
 * expired have nothing covered — the edge charges them the month now, so the page must too.
 */
export function coveredUntil(ent: Covered): string | null {
  if (ent.status === 'trialing') {
    const trial = msOf(ent.trialEndsAt);
    const period = msOf(ent.entitledThrough);
    if (trial !== null && period !== null) return period > trial ? ent.entitledThrough : ent.trialEndsAt;
    return trial !== null ? ent.trialEndsAt : period !== null ? ent.entitledThrough : null;
  }
  if (ent.status === 'active' || ent.status === 'cancelled') {
    return msOf(ent.entitledThrough) === null ? null : ent.entitledThrough;
  }
  return null;
}

/**
 * When the monthly card charge starts, if later than now (D5); null means it is charged now.
 * A date further out than Stripe allows is clamped exactly as the edge clamps it, so the date
 * the page names is the one Checkout will use.
 */
export function monthlyStartsOn(ent: Covered, nowMs: number): string | null {
  const until = coveredUntil(ent);
  const ms = msOf(until);
  if (until === null || ms === null || ms - nowMs <= MONTHLY_DEFER_MIN_MS) return null;
  const cap = nowMs + ANCHOR_MAX_LEAD_MS;
  return ms > cap ? new Date(cap).toISOString() : until;
}

/**
 * What pressing the button charges to the card, as far as the page can know it.
 *
 * - first: the restaurant's first card purchase, through Checkout. The one-time fees now, and
 *   the first month too unless time is already covered (then `monthlyFrom` is when it starts).
 *   Checkout itself shows Stripe's figure before anything is taken.
 * - change: a restaurant already paying by card. The one-time fees now, charged to the card on
 *   file with no Stripe page in between, plus the prorated difference in the monthly fee when
 *   it changes — which only Stripe can work out, so the page says it exists instead of guessing.
 *
 * Display only: the server prices every request, and Stripe is told net amounts.
 */
export type CardCharge =
  | { kind: 'first'; now: number; monthlyFrom: string | null }
  | { kind: 'change'; now: number; monthlyChanges: boolean };

const cents = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100);

export function cardCharge(args: {
  rail: BillingRailInfo['rail'];
  entitlements: Covered & Pick<Entitlements, 'monthlyTotal'>;
  /** The one-time total the merchant is asked for, net of any code. */
  oneTimeNow: number;
  /** The selection's monthly total. */
  monthlyTotal: number;
  nowMs: number;
}): CardCharge {
  const once = Math.max(0, cents(args.oneTimeNow));
  if (args.rail === 'stripe') {
    return {
      kind: 'change',
      now: once / 100,
      monthlyChanges: cents(args.monthlyTotal) !== cents(args.entitlements.monthlyTotal),
    };
  }
  const monthlyFrom = monthlyStartsOn(args.entitlements, args.nowMs);
  const monthly = monthlyFrom ? 0 : Math.max(0, cents(args.monthlyTotal));
  return { kind: 'first', now: (once + monthly) / 100, monthlyFrom };
}

/** The purchase button on the card rail says what it charges. */
export type CardAction =
  | { key: 'payNow'; amount: number }
  | { key: 'addCard'; date: string }
  | { key: 'confirmChange' }
  | { key: 'confirm' };

export function cardAction(charge: CardCharge): CardAction {
  if (charge.now > 0) return { key: 'payNow', amount: charge.now };
  if (charge.kind === 'change') return { key: 'confirmChange' };
  // Nothing today and the month starts later: Checkout only saves the card.
  if (charge.monthlyFrom) return { key: 'addCard', date: charge.monthlyFrom };
  return { key: 'confirm' };
}

/** The sentence under the button: that the monthly fee renews on the card by itself. */
export type CardFootnote =
  | { key: 'firstLater'; date: string }
  | { key: 'firstNow' }
  | { key: 'change' };

export function cardFootnote(charge: CardCharge): CardFootnote {
  if (charge.kind === 'change') return { key: 'change' };
  return charge.monthlyFrom ? { key: 'firstLater', date: charge.monthlyFrom } : { key: 'firstNow' };
}

// --- the Stripe rail's own banners and card ----------------------------------

export interface RailBanners {
  /** The last renewal failed; the restaurant keeps working until `graceUntil`. */
  pastDue: { graceUntil: string | null } | null;
  /** Cancelled in the portal: active until `on`, then it ends and is not renewed. */
  cancelling: { on: string | null } | null;
}

/**
 * The card subscription is set to end rather than renew.
 *
 * Stripe says so two ways: `cancel_at_period_end` (the portal's own cancel, in classic billing
 * mode) or a `cancel_at` date (a "custom date" cancel in the Stripe Dashboard, an API or schedule
 * change, or the portal in flexible billing mode) — with cancel_at_period_end left false. Reading
 * only the first showed "Next charge $149 on Oct 26" and no warning for a store that went dark
 * on Oct 26 (UIM-4). `next_charge_at` is the server's word on whether a charge is still coming
 * (billing_rail_json leaves it out once the subscription is set to end), so a cancel_at with a
 * charge still scheduled is not read as the end. A past-due subscription has its own, louder
 * banner.
 */
export function isCancelling(
  billing: Pick<BillingRailInfo, 'cancelAtPeriodEnd' | 'cancelAt' | 'nextChargeAt' | 'status'>,
): boolean {
  if (billing.cancelAtPeriodEnd) return true;
  return billing.cancelAt !== null && billing.nextChargeAt === null && billing.status !== 'past_due';
}

export function railBanners(
  billing: BillingRailInfo,
  entitlements: Pick<Entitlements, 'entitledThrough'>,
): RailBanners {
  if (billing.rail !== 'stripe') return { pastDue: null, cancelling: null };
  return {
    // Past due, the store's own deadline IS the end of the grace window (billing_deadline takes
    // grace_until into account), so it stands in for a grace date that was not stored.
    pastDue:
      billing.status === 'past_due'
        ? { graceUntil: billing.graceUntil ?? entitlements.entitledThrough }
        : null,
    // Not the deadline here: on the card rail it runs a grace window past the period end (§9.1),
    // and the subscription ends at cancel_at, not then. No date is better than a wrong one.
    cancelling: isCancelling(billing) ? { on: billing.cancelAt } : null,
  };
}

/** The Billing card's "Next charge" line. */
export type NextCharge =
  | { kind: 'charge'; at: string; amount: number | null }
  | { kind: 'cancels'; on: string | null }
  | { kind: 'none' };

/**
 * The next charge Stripe will make, in the server's own words. `nextChargeAt` null means none is
 * scheduled, and it is never filled in from the deadline: on the card rail that is the period end
 * plus the grace window, and a charge "on" it is one Stripe will not make.
 */
export function nextCharge(billing: BillingRailInfo): NextCharge {
  if (isCancelling(billing)) return { kind: 'cancels', on: billing.cancelAt };
  return billing.nextChargeAt
    ? { kind: 'charge', at: billing.nextChargeAt, amount: billing.nextChargeAmount }
    : { kind: 'none' };
}

const BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  american_express: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  diners_club: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires',
  eftpos_au: 'eftpos',
  link: 'Link',
};

/** Stripe's brand code as it is printed on the card. */
export function cardBrandName(brand: string): string {
  const key = brand.trim().toLowerCase();
  if (BRANDS[key]) return BRANDS[key];
  if (!key || key === 'unknown') return '';
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
}

/** "08/27", or null when Stripe gave no expiry. */
export function cardExpiry(card: BillingCard): string | null {
  const { expMonth, expYear } = card;
  if (!expMonth || !expYear || expMonth < 1 || expMonth > 12) return null;
  return `${String(expMonth).padStart(2, '0')}/${String(expYear % 100).padStart(2, '0')}`;
}

/**
 * The card stops working before the next charge. A card is good through the last day of its
 * expiry month; warning a month ahead of a renewal it cannot pay is cheaper than a past-due
 * banner after it.
 */
export function cardExpiresBefore(card: BillingCard | null, iso: string | null): boolean {
  if (!card || !card.expMonth || !card.expYear || !iso) return false;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  // Day 0 of the following month is the last day of the expiry month.
  const goodThrough = Date.UTC(card.expYear, card.expMonth, 0, 23, 59, 59);
  return goodThrough < at;
}

/** What an invoice is for the merchant: what was paid, or what is still owed on it. */
export function invoiceAmount(inv: BillingInvoiceSummary): number {
  return inv.status === 'paid' ? inv.amountPaid : inv.amountDue;
}

// --- the dashboard -----------------------------------------------------------

/**
 * A paid package on the manual rail runs for a fixed month and the expiry job switches the store
 * off at the deadline, mid-service if that is when it falls, so the dashboard counts down the
 * last week. Trials already have their own card.
 */
export const EXPIRY_WARN_DAYS = 7;

export function expiryDaysLeft(
  ent: Pick<Entitlements, 'entitled' | 'status' | 'entitledThrough'>,
  nowMs: number,
): number | null {
  // isTrialing()'s rule, on the three fields this needs.
  if (!ent.entitled || ent.status === 'trialing' || !ent.entitledThrough) return null;
  const ms = Date.parse(ent.entitledThrough);
  if (!Number.isFinite(ms) || ms - nowMs > EXPIRY_WARN_DAYS * DAY_MS) return null;
  return Math.max(0, Math.ceil((ms - nowMs) / DAY_MS));
}

type DashboardEntitlements = Pick<Entitlements, 'entitled' | 'status' | 'entitledThrough' | 'billingRail'>;

/**
 * Whether the dashboard reads the owner's billing overview. The rail itself comes with the
 * entitlements every role reads (`billingRail`); the overview (get_billing_overview asks
 * billing.manage, and it is not a cheap read) only adds what the entitlements do not carry —
 * whether a card subscription is set to end, and when — so it is read for the owner of a card
 * restaurant. The last week before a deadline and a failed payment keep the read as well, so a
 * payload from before `billing_rail` existed still learns the rail the old way.
 */
export function dashboardNeedsRail(
  ent: DashboardEntitlements,
  nowMs: number,
  canManageBilling: boolean,
): boolean {
  if (!canManageBilling || !ent.entitled) return false;
  return ent.billingRail === 'stripe' || expiryDaysLeft(ent, nowMs) !== null || ent.status === 'past_due';
}

export type DashboardBillingCard =
  | { kind: 'none' }
  /** Manual rail: the package ends on its date unless someone renews it. */
  | { kind: 'expiry'; daysLeft: number }
  /** Stripe rail, renewal failed: working until the grace date while Stripe retries. */
  | { kind: 'paymentFailed'; graceUntil: string | null }
  /**
   * Stripe rail, set to end (cancelled in the portal or in Stripe): it really does end on its
   * date. Shown to every role; only the owner's copy links to the plan page.
   */
  | { kind: 'cancelling'; on: string; daysLeft: number };

/** Whole days until `iso` (0 on the last day), or null when it is unreadable or past the warning. */
function daysUntil(iso: string, nowMs: number): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms - nowMs > EXPIRY_WARN_DAYS * DAY_MS) return null;
  return Math.max(0, Math.ceil((ms - nowMs) / DAY_MS));
}

/**
 * The dashboard's billing card, for every role.
 *
 * The card rail is known from the entitlements (`billingRail`, for managers and admins too — it
 * used to be the owner's read alone, so everyone else saw "the storefront stops on {date}" in
 * the last week of every month for a package that renews by itself, UIM-6) or from the owner's
 * overview; either one saying 'stripe' is enough. On that rail the countdown is dropped, except
 * where the package really does end: a failed renewal (for everyone — the entitlements carry the
 * status and the deadline, which is the end of the grace window), or a subscription set to end
 * (for everyone too: the owner's overview says so, and so does the entitlements' `billingEndsAt`
 * that every role reads — without it the staff running the store got no word before the
 * storefront switched off mid-service, ui-rr-3).
 *
 * `billing` is null when it was not read, and MANUAL_RAIL when the read failed.
 */
export function dashboardBillingCard(args: {
  entitlements: DashboardEntitlements & Pick<Entitlements, 'billingEndsAt'>;
  billing: BillingRailInfo | null;
  nowMs: number;
}): DashboardBillingCard {
  const { entitlements, billing, nowMs } = args;
  const days = expiryDaysLeft(entitlements, nowMs);
  const detail = billing && billing.rail === 'stripe' ? billing : null;
  if (entitlements.billingRail !== 'stripe' && !detail) {
    return days !== null ? { kind: 'expiry', daysLeft: days } : { kind: 'none' };
  }
  if (!entitlements.entitled) return { kind: 'none' };
  if (entitlements.status === 'past_due' || detail?.status === 'past_due') {
    return { kind: 'paymentFailed', graceUntil: detail?.graceUntil ?? entitlements.entitledThrough };
  }
  const on = endsOn(detail, entitlements, days);
  if (!on) return { kind: 'none' };
  const left = daysUntil(on, nowMs);
  return left !== null ? { kind: 'cancelling', on, daysLeft: left } : { kind: 'none' };
}

/**
 * When a card subscription set to end ends, or null when it renews. The owner's overview, when it
 * was read, has the last word (it is the fuller answer); everyone else goes by the entitlements'
 * `billingEndsAt`, which the server fills in on the same rule as the overview's next charge (a
 * cancel date on or before the next renewal, §10.8). Ending with no date from Stripe, the date
 * the server gives is next best, and then the deadline, the latest it can be — counted to only in
 * its last week, like everything else here.
 */
function endsOn(
  detail: BillingRailInfo | null,
  entitlements: Pick<Entitlements, 'entitledThrough' | 'billingEndsAt'>,
  days: number | null,
): string | null {
  if (!detail) return entitlements.billingEndsAt;
  if (!isCancelling(detail)) return null;
  return detail.cancelAt ?? entitlements.billingEndsAt ?? (days !== null ? entitlements.entitledThrough : null);
}
