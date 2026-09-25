// A diner's card payment on the storefront: calls to stripe-create-payment-intent and the small
// decisions the checkout and the order page share.
//
// The money goes to the BRANCH's own Stripe account (Connect, direct charges:
// docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md). Nothing here decides an amount or an account: the
// edge function reads both from the database and only hands the browser what Stripe.js needs to
// show the form and confirm the payment. Stripe.js itself is loaded in ./stripe-loader.ts, so this
// file stays importable from tests and from pages that never show a card form.

import { getSupabaseEnv } from '@favornoms/database/env';
import { getBrowserClient } from '@favornoms/database/client';

/**
 * How long an unpaid card order waits before it is cancelled. The same figure as
 * CARD_PAYMENT_WINDOW_MINUTES in supabase/functions/stripe-create-payment-intent/logic.ts and the
 * expiry job; card-payment-edge.test.ts fails if the two ever differ.
 */
export const CARD_PAYMENT_WINDOW_MINUTES = 30;

/**
 * The last minutes of that window in which the payment function starts no new payment attempt
 * (CARD_PAYMENT_CUTOFF_MARGIN_MINUTES in logic.ts, pinned by card-payment-edge.test.ts), so a
 * diner is never sent into a card form for an order the expiry job is about to cancel.
 */
export const CARD_PAYMENT_CUTOFF_MARGIN_MINUTES = 2;

/**
 * The time the diner actually has to pay: up to the payment function's cut-off, not the expiry.
 * The order page counted down the full 30 minutes, so for the last two a live timer sat over a
 * form that could only answer "the time to pay has run out".
 */
export const CARD_PAYMENT_TIME_TO_PAY_MINUTES = CARD_PAYMENT_WINDOW_MINUTES - CARD_PAYMENT_CUTOFF_MARGIN_MINUTES;

/** Stripe's smallest USD charge, in cents. place-order refuses a card order under it. */
export const CARD_MIN_CHARGE_CENTS = 50;

/**
 * The payment methods the Payment Element offers: a card, with Apple Pay and Google Pay (Stripe
 * runs both as 'card'). It must list exactly what the PaymentIntent lists
 * (CARD_PAYMENT_METHOD_TYPES in supabase/functions/stripe-create-payment-intent/logic.ts;
 * card-payment-edge.test.ts pins the two), because Stripe refuses to confirm an intent whose
 * types differ from the ones the form collected. Left to the branch's own Stripe settings, the
 * form could offer a bank debit, which takes days to clear; an order must be paid in minutes.
 */
export const CARD_PAYMENT_METHOD_TYPES: readonly string[] = ['card'];

/** A dollar amount as whole cents, as Stripe counts it. 19.99 * 100 is 1998.999…, hence the round. */
export function toCents(amount: number): number {
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}

/** What the checkout needs before any order exists: the Payment Element is shown in deferred-intent
 *  mode, which takes the publishable key and the branch's connected account up front. */
export interface CardConfig {
  publishable_key: string;
  stripe_account: string;
}

/** The answer to "take the payment for this order". */
export type CardIntent =
  | {
      state: 'awaiting';
      client_secret: string;
      publishable_key: string;
      stripe_account: string;
      /** Cents. */
      amount: number;
      currency: string;
      payment_intent_id: string;
    }
  | { state: 'paid' | 'processing'; payment_intent_id?: string | null };

/** The payment as Stripe has it now, re-checked server side. */
export type CardState = 'paid' | 'processing' | 'failed' | 'awaiting' | 'canceled';

export interface CardStatus {
  state: CardState;
  failure_code: string | null;
  payment_status: string | null;
  order_status: string;
  payment_intent_id: string | null;
}

/** The function's refusals, as thrown: `card_payment_failed:<http status>:<body>`. */
const FAILURE_PREFIX = /^card_payment_failed:(\d+):([\s\S]*)$/;

async function callPaymentFunction<T>(body: Record<string, unknown>): Promise<T> {
  const supabase = getBrowserClient();
  const { data: session } = await supabase.auth.getSession();
  const accessToken = session?.session?.access_token;
  const { url, publishableKey } = getSupabaseEnv();
  const res = await fetch(`${url}/functions/v1/stripe-create-payment-intent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken ?? publishableKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`card_payment_failed:${res.status}:${text}`);
  }
  return (await res.json()) as T;
}

/** The publishable key and account the checkout's card form is loaded for. */
export function fetchCardConfig(branchId: string): Promise<CardConfig> {
  return callPaymentFunction<CardConfig>({ action: 'config', branch_id: branchId });
}

/** Create (or get back) the PaymentIntent for an order's card payment. Idempotent server side. */
export function startCardPayment(orderId: string): Promise<CardIntent> {
  return callPaymentFunction<CardIntent>({ order_id: orderId });
}

/** Ask Stripe, through the server, where the order's payment stands. Records a success. */
export function checkCardPayment(orderId: string): Promise<CardStatus> {
  return callPaymentFunction<CardStatus>({ action: 'status', order_id: orderId });
}

/** The function's error code from a thrown `card_payment_failed:…`, or null (a network failure). */
export function cardPaymentErrorCode(message: string): string | null {
  const match = FAILURE_PREFIX.exec(message);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[2] ?? '') as { error?: unknown; feature?: unknown };
    if (parsed.error === 'feature_not_entitled' && typeof parsed.feature === 'string') {
      return `feature_not_entitled:${parsed.feature}`;
    }
    return typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * The words for a refused or failed card payment, as a key under tracking.cardPayment.errors.
 * A refusal the diner can do nothing about reads as "card payments are not available here now";
 * one that a moment's wait may fix reads as "try again".
 */
export function cardRefusalKey(code: string | null): string {
  switch (code) {
    case 'card_not_ready':
    case 'stripe_not_configured':
    case 'feature_not_entitled:card_payment':
      return 'unavailable';
    case 'payment_window_expired':
      return 'expired';
    case 'order_not_payable':
    case 'not_awaiting_card_payment':
      return 'notPayable';
    case 'amount_too_small':
      return 'tooSmall';
    case 'payment_in_progress':
      return 'inProgress';
    default:
      return 'generic';
  }
}

/**
 * Why a card attempt failed, as a key under tracking.cardPayment.reasons, from the code Stripe
 * gave (a network decline code first, else Stripe's own error code). The diner is never shown
 * Stripe's English message from the server: these are said in their language.
 */
export function cardFailureReasonKey(code: string | null): string {
  switch (code) {
    case 'insufficient_funds':
      return 'insufficientFunds';
    case 'expired_card':
      return 'expired';
    case 'incorrect_cvc':
    case 'invalid_cvc':
      return 'cvc';
    case 'incorrect_number':
    case 'invalid_number':
      return 'number';
    case 'authentication_required':
    case 'payment_intent_authentication_failure':
      return 'authentication';
    case 'processing_error':
      return 'processing';
    case 'card_declined':
    case 'generic_decline':
    case 'do_not_honor':
    case 'lost_card':
    case 'stolen_card':
    case 'pickup_card':
    case 'restricted_card':
    case 'fraudulent':
    case 'card_velocity_exceeded':
    case 'transaction_not_allowed':
      return 'declined';
    default:
      return 'generic';
  }
}

/** The last moment a card payment can be started for the order, in epoch ms (NaN when created_at
 *  is unreadable): the payment function's cut-off, a little before the expiry job cancels it. */
export function cardPaymentDeadline(createdAt: string): number {
  return Date.parse(createdAt) + CARD_PAYMENT_TIME_TO_PAY_MINUTES * 60_000;
}

/** Whole minutes left to pay, never below zero. */
export function minutesLeftToPay(createdAt: string, nowMs: number): number {
  const deadline = cardPaymentDeadline(createdAt);
  if (!Number.isFinite(deadline)) return 0;
  return Math.max(0, Math.ceil((deadline - nowMs) / 60_000));
}

/**
 * What has gone back to the diner's card, in cents, from their order's payment_refunds rows (RLS
 * lets a signed-in diner read the rows of their own orders). Stripe's refund statuses: 'pending'
 * is on its way, 'succeeded' has left the restaurant's Stripe account, and 'failed' or
 * 'canceled' never reached the card.
 */
export interface CardRefundTotals {
  refundedCents: number;
  pendingCents: number;
  failedCents: number;
}

export function cardRefundTotals(
  rows: ReadonlyArray<{ amount: number | string; status: string }> | null | undefined,
): CardRefundTotals {
  const totals: CardRefundTotals = { refundedCents: 0, pendingCents: 0, failedCents: 0 };
  for (const r of rows ?? []) {
    // numeric(10,2) arrives as a string; toCents also drops anything unreadable or not positive.
    const c = toCents(Number(r.amount));
    if (r.status === 'succeeded') totals.refundedCents += c;
    else if (r.status === 'pending') totals.pendingCents += c;
    else if (r.status === 'failed' || r.status === 'canceled') totals.failedCents += c;
  }
  return totals;
}

/** What the order page shows for a card payment. */
export type CardPaymentView =
  | 'paid'
  | 'processing'
  | 'failed'
  | 'pay'
  | 'expired'
  | 'closed'
  | 'payAtRestaurant'
  | 'refunded'
  | 'refunding'
  | 'refundFailed';

/**
 * The order page's card box, decided from the order, the payment row, its refunds (null until
 * they have been read) and the last answer from Stripe (null until one has come back).
 *
 * `hasStripeAccount` tells a card order placed through Stripe from one placed before card payments
 * were taken online (their rows carry no connected account): those were never payable here and
 * are told to pay the restaurant, as before.
 *
 * `paymentStatus` should be the freshest payments.status the page has: the status check's
 * payment_status when it answered, else the row the page loaded with. The check reports a
 * refunded payment as state 'paid' (the payment did go through), so 'refunded' is read from the
 * payment status and the refund rows, never from the state.
 */
export function cardPaymentView(input: {
  orderStatus: string;
  awaitingPayment: boolean;
  paymentStatus: string;
  hasStripeAccount: boolean;
  state: CardState | null;
  createdAt: string;
  nowMs: number;
  refunds?: CardRefundTotals | null;
  /** The order total, in dollars: what "refunded in full" is measured against. */
  total?: number;
}): CardPaymentView {
  const { orderStatus, awaitingPayment, paymentStatus, hasStripeAccount, state, createdAt, nowMs } = input;
  const refunds = hasStripeAccount ? (input.refunds ?? null) : null;
  const goingBackCents = refunds ? refunds.refundedCents + refunds.pendingCents : 0;
  const refundView: CardPaymentView = refunds && refunds.pendingCents > 0 ? 'refunding' : 'refunded';
  // A closed order that had money taken from the card must say where that money is. The
  // restaurant cancelling a paid order refunds it (stripe-refund's cancel mode records the refund
  // before the order closes), and a payment that landed after the order expired is refunded by
  // the Connect webhook; either way the diner was promised their card back and is told so here.
  // With no refund on record (an order that was never paid, or a payment the diner's bank took
  // back through a dispute) the cancellation notice below says all there is.
  if (orderStatus === 'cancelled' || orderStatus === 'refunded') {
    if (goingBackCents > 0) return refundView;
    if (refunds && refunds.failedCents > 0) return 'refundFailed';
    return 'closed';
  }
  // A refund in full on an order that is still open: made in the branch's own Stripe Dashboard,
  // which marks the payment refunded without touching the order. "Paid by card" would then be
  // the one thing on the page that is no longer true.
  if (hasStripeAccount) {
    const totalCents = toCents(input.total ?? 0);
    if (paymentStatus === 'refunded' || (totalCents > 0 && goingBackCents >= totalCents)) return refundView;
  }
  if (paymentStatus === 'completed' || state === 'paid') return 'paid';
  if (!hasStripeAccount) return orderStatus === 'pending' ? 'payAtRestaurant' : 'closed';
  // Stripe released the order (webhook) before this page heard back from its own check.
  if (!awaitingPayment && orderStatus !== 'pending') return 'paid';
  if (state === 'processing') return 'processing';
  if (minutesLeftToPay(createdAt, nowMs) <= 0) return 'expired';
  if (state === 'failed' || paymentStatus === 'failed') return 'failed';
  return 'pay';
}

/** What Stripe put on the return_url, and what the checkout adds after an in-page confirm. */
export interface PaymentReturn {
  paymentIntent: string | null;
  redirectStatus: string | null;
  /** The checkout's own marker: the order was placed but the card step did not finish. */
  checkoutFailed: boolean;
}

export function readPaymentReturn(params: URLSearchParams | null | undefined): PaymentReturn {
  const paymentIntent = params?.get('payment_intent') ?? null;
  return {
    paymentIntent: paymentIntent && /^pi_[A-Za-z0-9]+$/.test(paymentIntent) ? paymentIntent : null,
    redirectStatus: params?.get('redirect_status') ?? null,
    checkoutFailed: params?.get('card') === 'retry',
  };
}

/** The query keys a Stripe return leaves on the order page, dropped once read: the client secret
 *  among them should not sit in the address bar or the history. */
export const PAYMENT_RETURN_PARAMS = ['payment_intent', 'payment_intent_client_secret', 'redirect_status', 'card'];

/** Stripe.js's locale for the storefront's language. All four are Stripe locales as they are. */
export function stripeLocale(locale: string): 'en' | 'es' | 'th' | 'vi' {
  return locale === 'es' || locale === 'th' || locale === 'vi' ? locale : 'en';
}

// Handing an order from the checkout to its order page across a card step.
//
// The checkout cannot empty the cart before stripe.confirmPayment returns: emptying it swaps the
// form for the "order placed" screen, which unmounts the Payment Element the diner typed into, and
// Stripe cannot confirm from an element that is gone. A payment method that redirects (a bank or a
// wallet page) leaves before the checkout gets that far, so the order page finishes the job: the
// checkout notes the order number here, and the order page empties the cart when it opens THAT
// order. sessionStorage, so it never outlives the tab; every access is guarded, because storage can
// be switched off, and losing the note only means the cart is emptied by hand.

const CLEAR_CART_KEY = (branchId: string) => `favornoms-card-clear-cart:${branchId}`;
const CARD_ERROR_KEY = (orderId: string) => `favornoms-card-error:${orderId}`;

export function rememberCartToClear(branchId: string, orderNumber: string): void {
  try {
    sessionStorage.setItem(CLEAR_CART_KEY(branchId), orderNumber);
  } catch {
    // Storage off: the cart stays until the diner empties it.
  }
}

/** True once for the order the checkout noted, and the note is removed. */
export function takeCartToClear(branchId: string, orderNumber: string): boolean {
  try {
    const noted = sessionStorage.getItem(CLEAR_CART_KEY(branchId));
    if (noted !== orderNumber) return false;
    sessionStorage.removeItem(CLEAR_CART_KEY(branchId));
    return true;
  } catch {
    return false;
  }
}

export function forgetCartToClear(branchId: string): void {
  try {
    sessionStorage.removeItem(CLEAR_CART_KEY(branchId));
  } catch {
    // Nothing to forget.
  }
}

/** Stripe.js's own message for a card the checkout could not charge (already in the diner's
 *  language), carried to the order page that offers the retry. */
export function rememberCardError(orderId: string, message: string): void {
  try {
    sessionStorage.setItem(CARD_ERROR_KEY(orderId), message.slice(0, 300));
  } catch {
    // The order page then says it in general terms.
  }
}

export function takeCardError(orderId: string): string | null {
  try {
    const message = sessionStorage.getItem(CARD_ERROR_KEY(orderId));
    if (message !== null) sessionStorage.removeItem(CARD_ERROR_KEY(orderId));
    return message;
  } catch {
    return null;
  }
}
