// The plan page's "what does the merchant actually believe" decisions, with no React in them
// so they can be pinned in a test.
//
// Everything here is about the gap between what the page says and what the ledger did. The
// arithmetic lives in plan-model.ts; this file only decides which sentence is honest.

import {
  billingErrorMessage,
  describeBillingError,
  discountReasonMessage,
  type PackageSelection,
  type UiLocale,
} from '@favornoms/shared';
import { sameSelection, selectionFromRequest, type PlanBranch } from './plan-model';

// --- the request the merchant already sent -----------------------------------

/**
 * A package request that has been sent and is waiting for the Favornoms team, with the money
 * exactly as request_package_change priced it.
 *
 * The server's figures are the ones to repeat. `oneTimeTotal` is stored net of the discount
 * and was priced against what the restaurant has PAID (a pending charge is on order, not
 * bought), so it is the amount the merchant will be asked for; working it out again from the
 * catalog could only ever disagree with it.
 */
export interface FiledRequest {
  /**
   * Null when the row carried none. The page treats that as "nothing was filed": it is how
   * request_package_change's {ok:false} refusal looks once read as a request row.
   */
  id: string | null;
  selection: PackageSelection;
  /** What is payable once if the request is approved, already net of the discount. */
  oneTimeTotal: number;
  discountCode: string | null;
  discountAmount: number;
  monthlyTotal: number;
  createdAt: string | null;
  /**
   * 'stripe' once the merchant started paying it by card (billing_mark_request_stripe): it
   * waits for that payment, never for the Favornoms team, who cannot approve it by hand.
   */
  rail: 'manual' | 'stripe';
}

/** The fields of a billing_requests row this page reads. */
export interface RequestRow {
  id?: string | null;
  plan_code: string;
  branch_seats: number;
  delivery_branch_ids: string[];
  one_time_total?: number | null;
  discount_code?: string | null;
  discount_amount?: number | null;
  monthly_total?: number | null;
  created_at?: string | null;
  /** Absent on a row from before card billing, which was a manual request. */
  rail?: string | null;
}

/** A money figure from the database: a number of 0 or more, whatever arrived. */
const amount = (raw: unknown): number => {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * A stored or freshly returned request, as the page's own shape. Null when the row does not
 * name a plan: a row without one is not something the page can describe, and inventing a
 * selection for it would put words in the merchant's mouth.
 */
export function filedRequest(row: RequestRow | null | undefined): FiledRequest | null {
  if (!row || typeof row.plan_code !== 'string' || row.plan_code === '') return null;
  const code = typeof row.discount_code === 'string' ? row.discount_code.trim() : '';
  return {
    id: typeof row.id === 'string' && row.id !== '' ? row.id : null,
    selection: selectionFromRequest(row),
    oneTimeTotal: amount(row.one_time_total),
    discountCode: code === '' ? null : code.toUpperCase(),
    discountAmount: amount(row.discount_amount),
    monthlyTotal: amount(row.monthly_total),
    createdAt: typeof row.created_at === 'string' && row.created_at !== '' ? row.created_at : null,
    // Anything but 'stripe' is the manual rail: that is the rail that asks nothing of the card.
    rail: row.rail === 'stripe' ? 'stripe' : 'manual',
  };
}

/**
 * Is what is on screen the request that was sent?
 *
 * The same selection with the same code (or with no new code applied) IS that request, so the
 * page shows the request's own money and cannot send it again. Applying a code the request does
 * not carry makes it a different request — the one-time total changes — so the page quotes it
 * afresh and offers to replace the one waiting. Without this a merchant who forgot their code
 * could type it, see it applied, and find the only button still reading "Request pending".
 */
export function showsFiledRequest(
  sel: PackageSelection,
  filed: FiledRequest | null,
  activeCode: string | null,
): boolean {
  if (!filed || !sameSelection(sel, filed.selection)) return false;
  return activeCode === null || activeCode.toUpperCase() === filed.discountCode;
}

/** The facts for the one-sentence summary of a filed request, in the server's figures. */
export function filedFacts(
  filed: FiledRequest,
  branches: PlanBranch[],
): { branches: number; deliveryNames: string[]; monthlyTotal: number } {
  const wanted = new Set(filed.selection.deliveryBranchIds);
  return {
    branches: filed.selection.branchSeats,
    // In the order the page lists the branches, so the sentence reads the way the page does.
    deliveryNames: branches.filter((b) => wanted.has(b.id)).map((b) => b.name),
    monthlyTotal: filed.monthlyTotal,
  };
}

// --- the Pay-once box --------------------------------------------------------

/** What the "Pay once today" box shows. */
export type PayOnceView =
  /** The request that was sent: its list price, its discount and what is left to pay. */
  | { kind: 'filed'; list: number; discount: number; code: string | null; total: number }
  /** Nothing one-time is owed for this selection — every fee in it has been paid. */
  | { kind: 'nothing' }
  /** The page's own quote for the selection on screen. */
  | { kind: 'quote' };

/**
 * Which story the Pay-once box tells.
 *
 * Once a request is sent its one-time charges are PENDING — on order, not bought — and the box
 * shows that request's own total with "nothing has been charged yet". It used to say "Nothing.
 * Everything in this package is already paid for." the moment a request was filed, while the
 * banner directly above it read "Plus $287 once": two statements about the same money, and the
 * reassuring one was false, because nobody had paid anything.
 *
 * "Nothing" is kept for the one case it is true: the selection has no one-time line against
 * what was actually paid. A request of $0 with no discount is that case as well — the server
 * priced it against the same paid-only ledger.
 */
export function payOnceView(args: {
  filed: FiledRequest | null;
  showingFiled: boolean;
  quoteLines: number;
}): PayOnceView {
  const { filed, showingFiled, quoteLines } = args;
  if (filed && showingFiled) {
    if (filed.oneTimeTotal <= 0 && filed.discountAmount <= 0 && quoteLines === 0) {
      return { kind: 'nothing' };
    }
    return {
      kind: 'filed',
      list: filed.oneTimeTotal + filed.discountAmount,
      discount: filed.discountAmount,
      // A code that took nothing off is not worth a line of its own.
      code: filed.discountAmount > 0 ? filed.discountCode : null,
      total: filed.oneTimeTotal,
    };
  }
  return quoteLines > 0 ? { kind: 'quote' } : { kind: 'nothing' };
}

// --- the discount code -------------------------------------------------------

/**
 * Was a code typed into the box and never priced?
 *
 * `submittableCode()` returns only a code the server accepted for THIS selection, so it is
 * null both for a code that was never applied and for one applied against another selection.
 * Submitting either way files the request at list price with no record that a code was ever
 * typed — the merchant's only clue would be a total that never moved. The page blocks and
 * says so instead.
 */
export function codeNeedsApplying(typed: string, submittable: string | null): boolean {
  return typed.trim().length > 0 && submittable === null;
}

/**
 * The applied quote after the merchant edits the code box.
 *
 * Typing over an applied code used to leave the quote in place: the field read SAVE99 while
 * WELCOME50 was still discounting the total, still labelling the green line and still the code
 * sent with the request. A quote belongs to the code that earned it, so editing away from that
 * code drops it and the box falls back to Apply and the list total.
 *
 * Compared upper-case and trimmed because that is how `applyCode()` stores what it sent.
 */
export function discountAfterTyping<T extends { code: string }>(
  applied: T | null,
  typed: string,
): T | null {
  if (!applied) return null;
  return applied.code === typed.trim().toUpperCase() ? applied : null;
}

// --- a request the server refused --------------------------------------------

/** The plan page's translator, narrowed to what this file needs from it. */
export type PlanTranslator = (key: string, values?: Record<string, string | number>) => string;

/**
 * The card step's failures arrive as `stripe_billing_failed:<code>` (callStripeBilling in
 * packages/database). By then the request IS filed — startCardPayment only runs on a request
 * that exists — so "Could not send your request" would be false: the page keeps the request
 * and offers Continue to payment, and this says what happened to the card step.
 */
const STRIPE_FAILED = 'stripe_billing_failed:';

/** The code after the prefix, or null when the message is not a card-step failure. */
function stripeFailureCode(raw: string): string | null {
  const at = raw.indexOf(STRIPE_FAILED);
  return at === -1 ? null : raw.slice(at + STRIPE_FAILED.length).trim();
}

/** The request the card step was asked about is no longer pending: paid, replaced or declined. */
const REQUEST_GONE = /^(request_not_pending|request_not_found|not_pending|not_found|request_not_payable)\b/;

/**
 * The card WAS charged, the change could not be applied, and the money has been given back in
 * full (§9.5, §10.9: the edge refunds it and puts the subscription back as it was). The edge only
 * answers this once the refund went through.
 */
const CHARGED_REFUNDED = /^charged_refunded\b/;

/**
 * The card on file WAS charged, the change could not be applied, and the refund did not go
 * through (§10.9). Saying "nothing was charged" — or "it is being refunded" — here would be
 * false; the Favornoms team puts it right, and paying again would only charge twice.
 */
const CHARGED_NOT_APPLIED = /^charged_not_applied\b/;

/**
 * Stripe took the change, our records refused it, it was put back, and nothing was charged
 * (§10.9: `change_not_applied`, the settle reason in the body). The bare settle reasons are what
 * an edge from before that answer sent in the same case — it only ever sent them when nothing had
 * been paid (charged_refunded otherwise) — so they read the same. `request_not_pending` and
 * `request_not_found` are not among them: those also come before anything is tried, and say the
 * request is gone.
 */
const CHANGE_NOT_APPLIED = /^(change_not_applied|settle_failed|invalid_arguments|not_settled)\b/;

/**
 * request_package_change's refusal: a change on the card rail is waiting on Stripe's invoice page
 * (3-D Secure, a declined card), and nothing replaces it until it is finished there or expires
 * (§9.3, §10.1).
 */
const PAYMENT_IN_PROGRESS = /payment_in_progress/;

/**
 * The change was sent to Stripe before and what it did cannot be told from Stripe (§9.4): this
 * call charged nothing more, but an earlier one may have. Retrying gives the same answer, so the
 * merchant is sent to a person and not offered to pay again.
 */
const CHANGE_CONFLICT = /^change_conflict\b/;

/**
 * The invoice a change waited on was not paid in time: it was voided and the request cancelled
 * (§9.4). Nothing was charged; choosing the package again starts afresh.
 */
const PAYMENT_EXPIRED = /^payment_expired\b/;

/**
 * The package has fewer branch seats than the restaurant has open branches. The edge refuses it
 * before anything is charged (§9.5); the code may arrive bare, or as cannot_bill's detail.
 */
const PLAN_LIMIT = /plan_limit_exceeded/;

/**
 * Refused before anything was charged because the restaurant's card billing is not in a state
 * the function will charge automatically (the subscription is gone, not active, or not the one
 * on record), or the platform's own setup is incomplete. Trying again cannot help, so the
 * merchant is sent to a person.
 */
const NEEDS_TEAM =
  /^(no_subscription|subscription_mismatch|subscription_not_active|subscription_unexpected_items|customer_mismatch|no_stripe_customer|branch_not_in_restaurant|branch_not_found|cannot_bill|admin_url_not_configured|catalog_incomplete|settings_unavailable)\b/;

/**
 * Refused while reading or checking, before any call that charges: the function had not asked
 * Stripe for money yet, whichever rail the restaurant is on.
 */
const BEFORE_CHARGE = /^(bad_request|read_failed|method_not_allowed|request_not_filed)\b/;

/** Who is asking cannot pay for this restaurant, or is not signed in any more. */
function accessKind(raw: string): 'signedOut' | 'forbidden' | null {
  if (raw.includes('auth_required') || raw.includes('not_signed_in') || raw.includes('invalid_token')) {
    return 'signedOut';
  }
  if (
    raw.includes('forbidden') ||
    raw.includes('not_authorized') ||
    raw.includes('other_restaurant') ||
    raw.includes('platform_admin_only') ||
    raw.includes('42501')
  ) {
    return 'forbidden';
  }
  return null;
}

function accessMessage(raw: string, t: PlanTranslator): string | null {
  const kind = accessKind(raw);
  return kind === null ? null : t(`errors.${kind}`);
}

/**
 * What a failed card step means for the merchant's money. Every code stripe-billing answers
 * lands in one of these, and the sentence for each is only true for that case:
 *
 * - chargedRefunded: the card was charged and the full amount went back to it.
 * - chargedNotApplied: the card was charged and the refund did not go through. Never "nothing
 *   was charged", never "it is being refunded"; the team fixes it.
 * - changeNotApplied: Stripe took the change, our records refused it, and it was put back with
 *   nothing charged.
 * - busy: the same payment is being taken by another call right now (Stripe's idempotency key is
 *   in use, §10.6). Trying again in a moment replays that call's answer; nothing is charged twice.
 * - changeConflict: an earlier attempt may have charged it; this one did not. A person sorts it.
 * - resultUnknown: the restaurant already pays by card, so `start` charges the card on file with
 *   no Stripe page in between, and the call failed in a way that does not say whether that
 *   happened (a 5xx, internal_error, write_failed, a Stripe error, a dropped connection, an
 *   answer the client could not read). The page may not claim nothing was charged, and does not
 *   offer to pay again on this view (UIM-1). A retry after a reload is safe: the edge replays
 *   Stripe's first answer for the same request, or resolves it from its stored invoice (§9.4).
 * - startFailed: the first purchase goes through Checkout, where nothing is charged until the
 *   merchant enters a card on Stripe's page, so any failure to open it charged nothing.
 * - the rest are refusals made before any charge, with what to do about each.
 */
export type CardStepError =
  | 'signedOut'
  | 'forbidden'
  | 'chargedRefunded'
  | 'chargedNotApplied'
  | 'changeNotApplied'
  | 'changeConflict'
  | 'resultUnknown'
  | 'requestGone'
  | 'busy'
  | 'paymentExpired'
  | 'planLimit'
  | 'needsTeam'
  | 'cardPaused'
  | 'dormant'
  | 'startFailed';

/**
 * @param raw the thrown message: `stripe_billing_failed:<code>` from callStripeBilling, or
 *   anything else a failed fetch throws (which is also a card-step failure — the request is filed).
 * @param chargesCardOnFile the restaurant is on the card rail, so `start` charges its card directly.
 */
export function cardStepError(raw: string, chargesCardOnFile: boolean): CardStepError {
  const code = stripeFailureCode(raw) ?? raw.trim();
  // Money moved (or was put back): checked first, so no later rule can call it a refusal.
  if (CHARGED_REFUNDED.test(code)) return 'chargedRefunded';
  if (CHARGED_NOT_APPLIED.test(code)) return 'chargedNotApplied';
  if (CHANGE_NOT_APPLIED.test(code)) return 'changeNotApplied';
  if (CHANGE_CONFLICT.test(code)) return 'changeConflict';
  const access = accessKind(raw);
  if (access) return access;
  // From `start` this is another call taking the same payment right now (§10.6), not the
  // invoice lock request_package_change answers with the same word.
  if (PAYMENT_IN_PROGRESS.test(code)) return 'busy';
  if (PAYMENT_EXPIRED.test(code)) return 'paymentExpired';
  if (REQUEST_GONE.test(code)) return 'requestGone';
  if (PLAN_LIMIT.test(code)) return 'planLimit';
  // The function is switched off (or its key is missing). A restaurant paying by card cannot be
  // handed to the team instead (they cannot approve it by hand), so it is told card payments are
  // paused; a first purchase stays a manual request, in the shared words.
  if (/^stripe_not_configured\b/.test(code)) return chargesCardOnFile ? 'cardPaused' : 'dormant';
  if (NEEDS_TEAM.test(code)) return 'needsTeam';
  if (BEFORE_CHARGE.test(code)) return 'startFailed';
  return chargesCardOnFile ? 'resultUnknown' : 'startFailed';
}

/** Whether the card may already have been charged for the request this failure was about. */
export function cardMayBeCharged(kind: CardStepError): boolean {
  return (
    kind === 'chargedRefunded' ||
    kind === 'chargedNotApplied' ||
    kind === 'changeConflict' ||
    kind === 'resultUnknown'
  );
}

export function cardStepErrorMessage(
  kind: CardStepError,
  t: PlanTranslator,
  locale: UiLocale,
): string {
  switch (kind) {
    case 'signedOut':
    case 'forbidden':
      return t(`errors.${kind}`);
    case 'dormant':
      return billingErrorMessage({ kind: 'dormant' }, locale);
    default:
      return t(`stripe.errors.${kind}`);
  }
}

/**
 * What the merchant reads when a request could not be sent — or, on the card rail, could not be
 * paid. The RPC and the edge function answer with codes and raw database text; neither is shown
 * as it is.
 *
 * Every discount refusal goes through the shared discountReasonMessage(), so the plan page and
 * every other screen say the same sentence for the same reason in every language. That includes
 * the guessing limit: request_package_change counts a refused code against the same budget as
 * validate_billing_discount, and a limit reached there is about the code, not about the package.
 */
export function requestErrorMessage(
  raw: string | undefined,
  t: PlanTranslator,
  locale: UiLocale,
  /** A card-step failure on the card rail, where `start` charges the card on file: see cardStepError(). */
  chargesCardOnFile = false,
): string {
  if (!raw) return t('errors.sendFailed');
  const billing = describeBillingError(raw);
  if (billing) return billingErrorMessage(billing, locale);
  if (raw.includes('rate_limited')) return discountReasonMessage('rate_limited', locale);
  const access = accessMessage(raw, t);
  if (access) return access;
  if (raw.includes('unknown_plan') || raw.includes('plan_not_purchasable')) {
    return t('errors.planUnavailable');
  }
  // A card-step failure first: there payment_in_progress means another call is taking the same
  // payment right now (§10.6), which a moment's wait resolves.
  if (stripeFailureCode(raw) !== null) {
    return cardStepErrorMessage(cardStepError(raw, chargesCardOnFile), t, locale);
  }
  // request_package_change refuses to replace a request whose card payment is waiting on
  // Stripe's invoice page (§9.3). The page shows that request with a Finish payment button.
  if (PAYMENT_IN_PROGRESS.test(raw)) return t('stripe.errors.paymentInProgress');
  return t('errors.sendFailed');
}

/**
 * What the merchant reads when "Manage card & invoices" could not open Stripe's portal. `null`
 * is the dormant answer: card billing was switched off since the page was drawn.
 */
export function portalErrorMessage(raw: string | null | undefined, t: PlanTranslator): string {
  if (raw === null) return t('stripe.errors.portalOff');
  if (!raw) return t('stripe.errors.portalFailed');
  const access = accessMessage(raw, t);
  if (access) return access;
  if (/no_stripe_customer|no_customer|not_stripe_managed/.test(raw)) return t('stripe.errors.noCustomer');
  return t('stripe.errors.portalFailed');
}
