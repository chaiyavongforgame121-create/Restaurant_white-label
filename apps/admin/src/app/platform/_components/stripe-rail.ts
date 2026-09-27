// How a restaurant pays the platform, as the console shows it
// (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §6).
//
// Two rails: 'stripe' (card, renews by itself) and 'manual' (a request the platform
// approves, for bank transfers and special deals). A restaurant is on the Stripe rail
// while it has a live Stripe subscription — billing_is_stripe_managed, the one
// definition every SQL guard uses — and the console must not offer a manual control the
// SQL would refuse with `stripe_managed` (D11). Every such decision is made here, as a
// pure function with a test, and the screens only render what it returns.
//
// Nothing in this file is worded: it returns keys, ids and URLs.

import type { BillingCard, BillingRailInfo, BillingRequest } from '@favornoms/database/queries';

/** The bare Stripe Dashboard. Stripe opens a path under it inside the signed-in account. */
export const STRIPE_DASHBOARD = 'https://dashboard.stripe.com/';

/**
 * The Dashboard base to build links from.
 *
 * The stripe-billing `status` action answers `https://dashboard.stripe.com/<acct>/`
 * (plus `test/` in test mode). Anything else — absent, or not a Stripe Dashboard URL —
 * falls back to the bare Dashboard rather than building a link to a host nobody checked.
 */
export function dashboardBaseOf(base: string | null | undefined): string {
  if (typeof base !== 'string' || !base.startsWith(STRIPE_DASHBOARD)) return STRIPE_DASHBOARD;
  return base.endsWith('/') ? base : `${base}/`;
}

/** A Dashboard page, e.g. `settings/payouts`, under the given base. */
export function stripeDashboardUrl(base: string | null | undefined, path: string): string {
  return dashboardBaseOf(base) + path.replace(/^\/+/, '');
}

// Stripe ids are opaque, but their shape is fixed. An id that does not look like one is
// never put into a URL: a garbage column would otherwise become a link to a garbage page.
const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;

export interface StripeLink {
  kind: 'customer' | 'subscription';
  href: string;
}

/**
 * "Open in Stripe" links for one restaurant.
 *
 * The console rows do not carry the account id or the mode, so without a base these are
 * `https://dashboard.stripe.com/customers/<cus>`: Stripe resolves that inside the account
 * the operator is signed in to, and offers to switch to test data for a test-mode object.
 * The setup page, which does know the base, passes it.
 */
export function stripeObjectLinks(
  customerId: string | null | undefined,
  subscriptionId: string | null | undefined,
  base: string | null = null,
): StripeLink[] {
  const links: StripeLink[] = [];
  if (customerId && CUSTOMER_ID.test(customerId)) {
    links.push({ kind: 'customer', href: stripeDashboardUrl(base, `customers/${customerId}`) });
  }
  if (subscriptionId && SUBSCRIPTION_ID.test(subscriptionId)) {
    links.push({ kind: 'subscription', href: stripeDashboardUrl(base, `subscriptions/${subscriptionId}`) });
  }
  return links;
}

/** Only an https link is ever rendered from a stored URL (a hosted invoice page). */
export function safeHttpsUrl(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url) ? url : null;
}

// --- the rail ------------------------------------------------------------------

export type RailKey = 'stripe' | 'manual';

export const railKey = (billing: BillingRailInfo): RailKey => (billing.rail === 'stripe' ? 'stripe' : 'manual');

export const isStripeRail = (billing: BillingRailInfo): boolean => billing.rail === 'stripe';

/**
 * Whether the dashboard index shows a rail chip on this row.
 *
 * While card billing is off every restaurant is manual, and a "Manual" pill on every row
 * would be furniture. Once it is on — or while a restaurant still pays by card after it
 * was switched off — the rail is the first thing that tells the operator which controls
 * this row even has.
 */
export const showRailInIndex = (billing: BillingRailInfo): boolean =>
  billing.rail === 'stripe' || billing.stripeEnabled;

/**
 * The Stripe subscription is set to end before it charges again.
 *
 * Two ways to get there, and Stripe keeps them apart: the portal's "cancel at the end of
 * the month" sets cancel_at_period_end, while the Dashboard's "cancel on a custom date"
 * (or any API call with cancel_at) sets only cancel_at. The console tells the operator to
 * cancel in Stripe, so the second is the one it will meet — and reading only the first
 * showed "renews" and a next charge for a store Stripe was about to cancel.
 *
 * A cancel_at LATER than the next renewal still renews at least once, so it does not
 * count (§10.8): the store is charged on its next renewal like any other, and only ends
 * on cancel_at. billing_rail_json follows the same rule — it keeps next_charge_at for a
 * cancel_at after the next renewal and nulls it only when cancel_at comes first — so
 * "no next charge" with a cancel_at means cancelling, and otherwise the dates decide.
 */
export function stripeCancelling(billing: BillingRailInfo): boolean {
  if (billing.cancelAtPeriodEnd) return true;
  if (billing.rail !== 'stripe' || billing.cancelAt === null) return false;
  if (billing.nextChargeAt === null) return true;
  const end = Date.parse(billing.cancelAt);
  const next = Date.parse(billing.nextChargeAt);
  // An unreadable date is not evidence that it renews.
  return !Number.isFinite(end) || !Number.isFinite(next) || end <= next;
}

/**
 * The cancel date Stripe holds for a card store that still renews first, or null.
 *
 * "Cancel on a custom date" months out leaves the store renewing until then, so it is not
 * cancelling (stripeCancelling) and the screens show its next charge. The date is still
 * the day the store stops, and it is shown beside that charge rather than dropped.
 */
export function stripeCancelsLater(billing: BillingRailInfo): string | null {
  if (billing.rail !== 'stripe' || billing.cancelAt === null || stripeCancelling(billing)) return null;
  return Number.isFinite(Date.parse(billing.cancelAt)) ? billing.cancelAt : null;
}

/**
 * A Stripe restaurant renews by itself unless it is past due, cancelled or set to cancel.
 *
 * It also needs a next charge date: billing_rail_json leaves next_charge_at empty exactly
 * when no charge is scheduled, and "renews" with no date would be a promise nobody made.
 * (Its paid-through date is no stand-in: on the Stripe rail it carries the 7-day grace
 * after the period end, a week after Stripe would actually charge.)
 */
export function renewsByItself(billing: BillingRailInfo, status: string, cancelAtPeriodEnd: boolean): boolean {
  return (
    billing.rail === 'stripe' &&
    status !== 'past_due' &&
    status !== 'cancelled' &&
    !cancelAtPeriodEnd &&
    !stripeCancelling(billing) &&
    billing.nextChargeAt !== null
  );
}

/**
 * The day a card store that is cancelled, or set to cancel, stops.
 *
 * Set to cancel: Stripe's own cancel date. The store's paid-through date is a week later on
 * the Stripe rail (the renewal grace), but Stripe ends the subscription on cancel_at and
 * the store goes dark then. Already cancelled: the paid-through date, which the database
 * has pinned to the period end Stripe reported.
 */
export function stripeEndsOn(
  billing: BillingRailInfo,
  status: string,
  entitledThrough: string | null,
): string | null {
  if (status === 'cancelled') return entitledThrough ?? billing.cancelAt;
  return billing.cancelAt ?? entitledThrough;
}

/**
 * What Stripe charges next, as the drawer and the Subscriptions page show it.
 *
 * - charge: a date, and an amount when the server knows it;
 * - none: cancelled or set to cancel, so Stripe charges nothing more;
 * - unknown: nothing scheduled and no cancellation recorded (or not the Stripe rail).
 *
 * The amount is `nextChargeAmount`, which the server fills from the Stripe subscription's
 * own recurring items (subscriptions.stripe_monthly_amount). It is never recomputed from
 * the catalog here: a card payer keeps the price it bought at, and the catalog total
 * drifts from what Stripe bills as soon as a price changes or a branch is hidden.
 */
export type NextChargeView =
  | { kind: 'charge'; at: string; amount: number | null }
  | { kind: 'none' }
  | { kind: 'unknown' };

export function nextChargeView(
  billing: BillingRailInfo,
  status: string,
  /** The subscriptions row's own flag, read beside the billing payload on the dashboard. */
  cancelAtPeriodEnd = false,
): NextChargeView {
  if (billing.rail !== 'stripe') return { kind: 'unknown' };
  if (status === 'cancelled' || cancelAtPeriodEnd || stripeCancelling(billing)) return { kind: 'none' };
  if (billing.nextChargeAt === null) return { kind: 'unknown' };
  return { kind: 'charge', at: billing.nextChargeAt, amount: billing.nextChargeAmount };
}

/**
 * The monthly figure a restaurant's row shows.
 *
 * On the Stripe rail it is what Stripe bills every month, when the server knows it; the
 * catalog-priced package total stands in only on the manual rail, or before the first
 * sync has stored Stripe's amount.
 */
export function monthlyFigure(billing: BillingRailInfo, packageMonthly: number): number {
  return billing.rail === 'stripe' && billing.nextChargeAmount !== null ? billing.nextChargeAmount : packageMonthly;
}

// --- the card on file ------------------------------------------------------------

const BRAND_NAMES: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  american_express: 'American Express',
  discover: 'Discover',
  jcb: 'JCB',
  diners: 'Diners Club',
  diners_club: 'Diners Club',
  unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires',
  eftpos_au: 'eftpos',
  interac: 'Interac',
  link: 'Link',
};

/** Stripe's brand code as a card reads it; an unknown code is shown as it came. */
export function cardBrandName(brand: string): string {
  return BRAND_NAMES[brand.toLowerCase()] ?? brand;
}

/** "08/27", or null when Stripe did not give both halves. */
export function cardExpiry(card: BillingCard): string | null {
  const { expMonth, expYear } = card;
  if (expMonth === null || expYear === null || expMonth < 1 || expMonth > 12 || expYear < 0) return null;
  return `${String(expMonth).padStart(2, '0')}/${String(expYear % 100).padStart(2, '0')}`;
}

/**
 * The card stopped working at the end of its expiry month (UTC). A renewal charged to it
 * will fail, so the console flags it before the merchant goes past due. Unknown = false:
 * an expiry nobody knows is not evidence of an expired card.
 */
export function cardExpired(card: BillingCard, nowMs: number): boolean {
  const { expMonth, expYear } = card;
  if (expMonth === null || expYear === null || expMonth < 1 || expMonth > 12) return false;
  const year = expYear < 100 ? 2000 + expYear : expYear;
  // Date.UTC(year, month) with a 1-based month is the first instant of the NEXT month.
  return nowMs >= Date.UTC(year, expMonth);
}

// --- package requests --------------------------------------------------------------

const INVOICE_ID = /^in_[A-Za-z0-9]+$/;

/** A non-empty string column read off whatever row object arrives, trimmed; else ''. */
function textOf(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The Stripe invoice a card CHANGE is waiting on (3-D Secure, or a declined card), read
 * off a billing_requests row.
 *
 * list_billing_requests sends the whole row (to_jsonb), so these columns are there, but
 * the typed request may not name them — they are read defensively, from whatever object
 * arrives. Any non-empty id counts as "waiting": that is the server's own rule for
 * refusing `payment_in_progress`, and the screen must not offer what it refuses.
 */
export function requestInvoiceOf(request: object): { waiting: boolean; id: string | null } {
  const r = request as Record<string, unknown>;
  const rawId = textOf(r, 'stripe_invoice_id');
  const rawUrl = textOf(r, 'stripe_invoice_url');
  return {
    waiting: rawId.length > 0 || rawUrl.length > 0,
    // Only an id that looks like one becomes a Dashboard link.
    id: INVOICE_ID.test(rawId) ? rawId : null,
  };
}

/**
 * How long a card change may hold its restaurant's requests while its payment is open:
 * Stripe's own window for a pending subscription update, which the edge applies to a
 * standalone fee invoice as well (CHANGE_INVOICE_TTL_MS) and the SQL to both
 * `payment_in_progress` refusals (§10.1).
 */
export const CARD_CHANGE_WINDOW_MS = 23 * 3600 * 1000;

// The console offers Reject a little after the server's window, never before it: the
// page's clock is the Vercel server's at render time and the refusal is decided by the
// database's now(), so a margin keeps the button from appearing a moment too early.
const CARD_CHANGE_WINDOW_MARGIN_MS = 10 * 60 * 1000;

export interface CardChangeLock {
  /**
   * The row holds the restaurant's requests: it is tied to an invoice, or a subscription
   * update was sent for it (stripe_change_started_at, the in-flight marker, §10.4).
   */
  locked: boolean;
  /**
   * When the lock began: the later of stripe_invoice_marked_at and stripe_change_started_at,
   * or null when neither was recorded (a row from before those columns existed).
   */
  since: string | null;
  /**
   * Its payment window has passed. The server then treats the lock as released: the next
   * request from the merchant, or a Reject here, cancels it (charges void, code released),
   * and a late payment of its invoice is refunded by the webhook (§9.3, §10.1).
   */
  expired: boolean;
}

/**
 * Whether a pending card request holds its restaurant, and whether that hold has run out.
 *
 * The later of the two marks is the one that counts: a retried change stamps its start
 * again, and an expiry read off the earlier one would offer Reject while the server still
 * refuses it. An unreadable or missing mark is not evidence of expiry either. Without a
 * clock (`nowMs` undefined) nothing is expired.
 */
export function requestCardLock(request: object, nowMs?: number): CardChangeLock {
  const r = request as Record<string, unknown>;
  const invoice = requestInvoiceOf(request);
  const started = textOf(r, 'stripe_change_started_at');
  const marks = [textOf(r, 'stripe_invoice_marked_at'), started]
    .map((raw) => ({ raw, ms: raw ? Date.parse(raw) : NaN }))
    .filter((m) => Number.isFinite(m.ms))
    .sort((a, b) => b.ms - a.ms);
  const latest = marks[0] ?? null;
  return {
    locked: invoice.waiting || started.length > 0,
    since: latest ? latest.raw : null,
    expired:
      latest !== null &&
      typeof nowMs === 'number' &&
      Number.isFinite(nowMs) &&
      nowMs - latest.ms > CARD_CHANGE_WINDOW_MS + CARD_CHANGE_WINDOW_MARGIN_MS,
  };
}

/** "Invoice in Stripe" for the operator: the Dashboard page, never the merchant's pay page. */
export function stripeInvoiceLink(invoiceId: string | null, base: string | null = null): string | null {
  return invoiceId && INVOICE_ID.test(invoiceId) ? stripeDashboardUrl(base, `invoices/${invoiceId}`) : null;
}

export interface RequestRailView {
  /** Replaces the plain status badge; null keeps it. Label: platformBilling.stripe.requests.<badge>. */
  badge: 'awaitingCard' | 'paymentInProgress' | 'paymentExpired' | 'paidByCard' | null;
  /** Approve is offered. */
  canApprove: boolean;
  /** Reject is offered. */
  canReject: boolean;
  /**
   * Reject asks first, saying that a late card payment is refunded: for a Checkout (D12),
   * and for a change whose payment window has passed (§10.1). The badge says which.
   */
  confirmReject: boolean;
  /** The sentence under the card; null for an ordinary manual request. Key: stripe.requests.<note>Note. */
  note:
    | 'awaitingCard'
    | 'awaitingCardPaused'
    | 'paymentInProgress'
    | 'paymentExpired'
    | 'managedRestaurant'
    | 'paidByCard'
    | null;
  /**
   * The "what approving does" comparison makes sense. It describes a MANUAL approval
   * (billing_apply_selection restarting the month from now()), which is not what a card
   * payment does — so it is shown only where Approve is.
   */
  showDiff: boolean;
  /** The invoice a change is waiting on, when its id is known: a Dashboard link. */
  invoiceId: string | null;
}

const NOTHING: RequestRailView = {
  badge: null,
  canApprove: false,
  canReject: false,
  confirmReject: false,
  note: null,
  showDiff: false,
  invoiceId: null,
};

export interface RequestRailContext {
  /**
   * The restaurant's `billing.pendingInvoiceUrl`: the invoice ITS pending request waits on.
   * A restaurant has one pending request at most, so it answers for a pending card request
   * even while the row itself arrives without its invoice.
   */
  invoiceUrl?: string | null;
  /** The page's clock (the server's, at render), for the change's payment window. */
  nowMs?: number;
  /**
   * The platform's card switch: true on, false off, null/undefined when it could not be read
   * (no restaurant row to read it from).
   */
  cardSwitchOn?: boolean | null;
}

/**
 * What one package request offers the operator.
 *
 * - rail 'stripe', pending, holding the restaurant (tied to an invoice, or its subscription
 *   update in flight): a card CHANGE Stripe is holding until the merchant confirms 3-D
 *   Secure or replaces a declined card. The payment can still go through, and when it does
 *   Stripe applies the new package to the subscription at once — so rejecting here would
 *   leave the merchant billed, every month, for a package the database never grants.
 *   decide_billing_request refuses it (`payment_in_progress`) and the card offers neither
 *   button while the payment window is open.
 * - the same, once the window (23 h) has passed: the server treats the hold as released,
 *   and Reject is how the operator clears it ("Payment window expired"). A payment made
 *   after that is refunded by the webhook, which the confirmation says (§10.1).
 * - rail 'stripe', pending, no invoice: a Checkout the merchant was sent to. It settles by
 *   itself; Reject stays for a checkout they abandoned, and a payment made after that is
 *   refunded automatically (D12) — which the confirmation says. With card billing switched
 *   off, a restaurant that does not pay by card yet is asked on its plan page to send the
 *   request to the team instead (the switch does not close a Checkout already opened), and
 *   only then does it come back here as a manual request to approve: the note says so.
 * - rail 'manual', pending, but the restaurant already pays by card: approving is refused
 *   for the restaurant (D11); the merchant pays for the change on their plan page, which
 *   works whether card billing is switched on or off. Reject stays.
 * - approved by a card payment (rail 'stripe' and paid_at set): "Paid by card".
 *
 * `currentRail` is null when the restaurant's package could not be read; that keeps
 * today's behaviour (Approve, behind the blind-approval question), because the SQL still
 * refuses a Stripe restaurant whatever the screen offers.
 */
export function requestRailView(
  request: Pick<BillingRequest, 'status' | 'rail' | 'paid_at'>,
  currentRail: RailKey | null,
  context: RequestRailContext = {},
): RequestRailView {
  const { invoiceUrl = null, nowMs, cardSwitchOn = null } = context;
  if (request.status === 'pending') {
    if (request.rail === 'stripe') {
      const lock = requestCardLock(request, nowMs);
      const invoiceId = requestInvoiceOf(request).id;
      if (lock.locked || invoiceUrl !== null) {
        if (lock.expired) {
          return {
            ...NOTHING,
            badge: 'paymentExpired',
            note: 'paymentExpired',
            canReject: true,
            confirmReject: true,
            invoiceId,
          };
        }
        return { ...NOTHING, badge: 'paymentInProgress', note: 'paymentInProgress', invoiceId };
      }
      // The merchant's plan page offers "send it to the team" only to a restaurant that does
      // not pay by card yet (a card payer keeps paying by card with the switch off).
      const paused = cardSwitchOn === false && currentRail === 'manual';
      return {
        ...NOTHING,
        badge: 'awaitingCard',
        note: paused ? 'awaitingCardPaused' : 'awaitingCard',
        canReject: true,
        confirmReject: true,
      };
    }
    if (currentRail === 'stripe') {
      return { ...NOTHING, note: 'managedRestaurant', canReject: true };
    }
    return { ...NOTHING, canApprove: true, canReject: true, showDiff: true };
  }
  if (request.status === 'approved' && request.rail === 'stripe' && request.paid_at) {
    return { ...NOTHING, badge: 'paidByCard', note: 'paidByCard' };
  }
  return NOTHING;
}

/** The SQL refused a manual control because Stripe manages this restaurant (D11). */
export const isStripeManagedError = (raw: string | null | undefined): boolean =>
  typeof raw === 'string' && /stripe_managed/i.test(raw);

/**
 * decide_billing_request refused to reject: the change is waiting on the merchant's card
 * payment at Stripe and could still go through (§9.3) — its 23 h payment window is still
 * open (§10.1).
 */
export const isPaymentInProgressError = (raw: string | null | undefined): boolean =>
  typeof raw === 'string' && /payment_in_progress/i.test(raw);

/**
 * A branch write was refused because the branch delivers on a card subscription: Stripe
 * would keep charging delivery for it (§9.6). Delivery is switched off on the plan page
 * first, which updates Stripe.
 */
export const isStripeDeliveryActiveError = (raw: string | null | undefined): boolean =>
  typeof raw === 'string' && /stripe_delivery_active/i.test(raw);
