import { describe, expect, it } from 'vitest';
import { MANUAL_RAIL, type BillingRailInfo } from '@favornoms/database/queries';
import {
  STRIPE_DASHBOARD,
  cardBrandName,
  cardExpired,
  cardExpiry,
  dashboardBaseOf,
  isPaymentInProgressError,
  isStripeDeliveryActiveError,
  isStripeManagedError,
  CARD_CHANGE_WINDOW_MS,
  monthlyFigure,
  nextChargeView,
  railKey,
  renewsByItself,
  requestCardLock,
  requestInvoiceOf,
  requestRailView,
  safeHttpsUrl,
  showRailInIndex,
  stripeCancelling,
  stripeCancelsLater,
  stripeDashboardUrl,
  stripeEndsOn,
  stripeInvoiceLink,
  stripeObjectLinks,
} from './stripe-rail';

// The rail decides which controls a restaurant even has. A wrong answer here either
// offers a button the database refuses (a manual Extend on a card store) or hides the
// one an operator needs (Approve on a manual request), so each branch is pinned.

const NEXT = '2026-10-26T00:00:00Z';

const stripe = (over: Partial<BillingRailInfo> = {}): BillingRailInfo => ({
  ...MANUAL_RAIL,
  stripeEnabled: true,
  rail: 'stripe',
  status: 'active',
  nextChargeAt: NEXT,
  nextChargeAmount: 87,
  ...over,
});

describe('Dashboard links', () => {
  it('builds on the base the status gave, test mode included', () => {
    const base = 'https://dashboard.stripe.com/acct_123/test/';
    expect(stripeDashboardUrl(base, 'settings/payouts')).toBe(
      'https://dashboard.stripe.com/acct_123/test/settings/payouts',
    );
    expect(stripeDashboardUrl('https://dashboard.stripe.com/acct_123', '/invoices')).toBe(
      'https://dashboard.stripe.com/acct_123/invoices',
    );
  });

  it('falls back to the bare Dashboard for a missing or foreign base', () => {
    expect(dashboardBaseOf(null)).toBe(STRIPE_DASHBOARD);
    expect(dashboardBaseOf('https://evil.example/')).toBe(STRIPE_DASHBOARD);
    expect(stripeDashboardUrl(undefined, 'customers')).toBe('https://dashboard.stripe.com/customers');
  });

  it('links a customer and a subscription, and nothing that is not a Stripe id', () => {
    expect(stripeObjectLinks('cus_Abc123', 'sub_Xyz789')).toEqual([
      { kind: 'customer', href: 'https://dashboard.stripe.com/customers/cus_Abc123' },
      { kind: 'subscription', href: 'https://dashboard.stripe.com/subscriptions/sub_Xyz789' },
    ]);
    expect(stripeObjectLinks('cus_A', null, 'https://dashboard.stripe.com/acct_1/test/')).toEqual([
      { kind: 'customer', href: 'https://dashboard.stripe.com/acct_1/test/customers/cus_A' },
    ]);
    expect(stripeObjectLinks('cus_../../x', 'sub_ok?x=1')).toEqual([]);
    expect(stripeObjectLinks(null, undefined)).toEqual([]);
  });

  it('renders a stored invoice link only when it is https', () => {
    expect(safeHttpsUrl('https://invoice.stripe.com/i/acct_1/test_abc')).toBe(
      'https://invoice.stripe.com/i/acct_1/test_abc',
    );
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('http://invoice.stripe.com/x')).toBeNull();
    expect(safeHttpsUrl(null)).toBeNull();
  });
});

describe('the rail', () => {
  it('names the rail and says when the index shows it', () => {
    expect(railKey(stripe())).toBe('stripe');
    expect(railKey(MANUAL_RAIL)).toBe('manual');
    // Card billing off: everyone is manual, so the chip would be furniture.
    expect(showRailInIndex(MANUAL_RAIL)).toBe(false);
    // On: the rail tells the operator which controls the row has.
    expect(showRailInIndex({ ...MANUAL_RAIL, stripeEnabled: true })).toBe(true);
    // Switched off later, a store still paying by card still says so.
    expect(showRailInIndex(stripe({ stripeEnabled: false }))).toBe(true);
  });

  it('renews by itself only on the Stripe rail, not past due, not cancelling', () => {
    expect(renewsByItself(stripe(), 'active', false)).toBe(true);
    expect(renewsByItself(MANUAL_RAIL, 'active', false)).toBe(false);
    expect(renewsByItself(stripe(), 'past_due', false)).toBe(false);
    expect(renewsByItself(stripe(), 'cancelled', false)).toBe(false);
    expect(renewsByItself(stripe(), 'active', true)).toBe(false);
    expect(renewsByItself(stripe({ cancelAtPeriodEnd: true }), 'active', false)).toBe(false);
    // Cancelled on a custom date in the Stripe Dashboard: only cancel_at is set.
    expect(renewsByItself(stripe({ cancelAt: NEXT, nextChargeAt: null }), 'active', false)).toBe(false);
    // No charge scheduled is no promise to renew.
    expect(renewsByItself(stripe({ nextChargeAt: null }), 'active', false)).toBe(false);
  });

  it('counts cancel_at as cancelling when it comes before the next renewal', () => {
    expect(stripeCancelling(stripe())).toBe(false);
    expect(stripeCancelling(stripe({ cancelAtPeriodEnd: true }))).toBe(true);
    // billing_rail_json nulls next_charge_at when cancel_at comes first.
    expect(stripeCancelling(stripe({ cancelAt: '2026-10-20T00:00:00Z', nextChargeAt: null }))).toBe(true);
    // Even if it did not, the dates say so.
    expect(stripeCancelling(stripe({ cancelAt: '2026-10-20T00:00:00Z' }))).toBe(true);
    expect(stripeCancelling(stripe({ cancelAt: NEXT }))).toBe(true);
    // A cancel date after the next renewal still renews once.
    expect(stripeCancelling(stripe({ cancelAt: '2026-12-01T00:00:00Z' }))).toBe(false);
    // An unreadable date is not proof that it renews.
    expect(stripeCancelling(stripe({ cancelAt: 'garbage' }))).toBe(true);
    // A stale cancel_at on the manual rail is not the console's business.
    expect(stripeCancelling({ ...MANUAL_RAIL, cancelAt: '2026-10-20T00:00:00Z' })).toBe(false);
  });

  it('keeps a far-off "cancel on a custom date" renewing until then (ui-rr-2)', () => {
    // The operator cancels on Dec 26 in the Stripe Dashboard; the store renews Oct 26 first.
    // billing_rail_json now keeps next_charge_at for it, so the dates decide.
    const later = stripe({ cancelAt: '2026-12-26T00:00:00Z' });
    expect(stripeCancelling(later)).toBe(false);
    expect(renewsByItself(later, 'active', false)).toBe(true);
    expect(nextChargeView(later, 'active')).toEqual({ kind: 'charge', at: NEXT, amount: 87 });
    // ... and the day it stops is still shown beside that charge.
    expect(stripeCancelsLater(later)).toBe('2026-12-26T00:00:00Z');
  });

  it('names a later cancel date only for a card store that still renews first', () => {
    expect(stripeCancelsLater(stripe())).toBeNull();
    // Cancelling before (or on) the next renewal is the "Ends" date's job, not this one.
    expect(stripeCancelsLater(stripe({ cancelAt: '2026-10-20T00:00:00Z' }))).toBeNull();
    expect(stripeCancelsLater(stripe({ cancelAt: NEXT }))).toBeNull();
    expect(stripeCancelsLater(stripe({ cancelAt: '2026-12-26T00:00:00Z', cancelAtPeriodEnd: true }))).toBeNull();
    expect(stripeCancelsLater({ ...MANUAL_RAIL, cancelAt: '2026-12-26T00:00:00Z' })).toBeNull();
    // An unreadable date counts as cancelling (above), so it is never shown as a later one.
    expect(stripeCancelsLater(stripe({ cancelAt: 'garbage' }))).toBeNull();
  });

  it("ends a cancelling store on Stripe's date, a cancelled one on its paid-through date", () => {
    const paidThrough = '2026-11-02T00:00:00Z'; // the period end plus the 7-day grace
    expect(stripeEndsOn(stripe({ cancelAt: '2026-10-20T00:00:00Z' }), 'active', paidThrough)).toBe(
      '2026-10-20T00:00:00Z',
    );
    expect(stripeEndsOn(stripe({ cancelAtPeriodEnd: true }), 'active', paidThrough)).toBe(paidThrough);
    expect(stripeEndsOn(stripe({ cancelAt: '2026-10-20T00:00:00Z' }), 'cancelled', '2026-10-26T00:00:00Z')).toBe(
      '2026-10-26T00:00:00Z',
    );
  });
});

describe('the next charge', () => {
  it('takes the amount from Stripe, never from the catalog', () => {
    expect(nextChargeView(stripe(), 'active')).toEqual({ kind: 'charge', at: NEXT, amount: 87 });
    // Before the first sync stored Stripe's amount: the date alone.
    expect(nextChargeView(stripe({ nextChargeAmount: null }), 'active')).toEqual({
      kind: 'charge',
      at: NEXT,
      amount: null,
    });
  });

  it('charges nothing for a store that is cancelled or set to cancel, either way', () => {
    expect(nextChargeView(stripe({ cancelAtPeriodEnd: true }), 'active')).toEqual({ kind: 'none' });
    expect(nextChargeView(stripe({ cancelAt: '2026-10-20T00:00:00Z', nextChargeAt: null }), 'active')).toEqual({
      kind: 'none',
    });
    expect(nextChargeView(stripe(), 'cancelled')).toEqual({ kind: 'none' });
    // The dashboard reads the subscriptions row's own flag beside the payload.
    expect(nextChargeView(stripe(), 'active', true)).toEqual({ kind: 'none' });
  });

  it('knows nothing on the manual rail or with no date', () => {
    expect(nextChargeView(MANUAL_RAIL, 'active')).toEqual({ kind: 'unknown' });
    expect(nextChargeView(stripe({ nextChargeAt: null }), 'active')).toEqual({ kind: 'unknown' });
  });

  it("shows Stripe's monthly amount for a card store and the package total otherwise", () => {
    expect(monthlyFigure(stripe(), 58)).toBe(87);
    expect(monthlyFigure(stripe({ nextChargeAmount: null }), 58)).toBe(58);
    expect(monthlyFigure({ ...MANUAL_RAIL, nextChargeAmount: 87 }, 58)).toBe(58);
  });
});

describe('the card on file', () => {
  const visa = { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2027 };

  it('names the brand and the expiry', () => {
    expect(cardBrandName('visa')).toBe('Visa');
    expect(cardBrandName('AMEX')).toBe('American Express');
    expect(cardBrandName('newbrand')).toBe('newbrand');
    expect(cardExpiry(visa)).toBe('08/27');
    expect(cardExpiry({ ...visa, expMonth: null })).toBeNull();
    expect(cardExpiry({ ...visa, expMonth: 13 })).toBeNull();
  });

  it('is expired from the first day after its expiry month, UTC', () => {
    expect(cardExpired(visa, Date.parse('2027-08-31T23:59:59Z'))).toBe(false);
    expect(cardExpired(visa, Date.parse('2027-09-01T00:00:00Z'))).toBe(true);
    // December rolls into the next year.
    expect(cardExpired({ ...visa, expMonth: 12 }, Date.parse('2027-12-31T12:00:00Z'))).toBe(false);
    expect(cardExpired({ ...visa, expMonth: 12 }, Date.parse('2028-01-01T00:00:00Z'))).toBe(true);
    // Unknown is not expired.
    expect(cardExpired({ ...visa, expYear: null }, Date.parse('2099-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('requestRailView', () => {
  type Req = {
    status: string;
    rail: 'manual' | 'stripe';
    paid_at: string | null;
    stripe_invoice_id?: string | null;
    stripe_invoice_url?: string | null;
    stripe_invoice_marked_at?: string | null;
    stripe_change_started_at?: string | null;
  };
  const req = (over: Partial<Req> = {}): Req => ({
    status: 'pending',
    rail: 'manual' as const,
    paid_at: null,
    ...over,
  });

  it('offers Approve, Reject and the comparison on an ordinary manual request', () => {
    expect(requestRailView(req(), 'manual')).toEqual({
      badge: null,
      canApprove: true,
      canReject: true,
      confirmReject: false,
      note: null,
      showDiff: true,
      invoiceId: null,
    });
  });

  it('keeps Approve when the current package could not be read (the SQL still guards)', () => {
    expect(requestRailView(req(), null).canApprove).toBe(true);
  });

  it('keeps Reject on a Checkout request, behind the late-payment-is-refunded question', () => {
    expect(requestRailView(req({ rail: 'stripe' }), 'manual')).toEqual({
      badge: 'awaitingCard',
      canApprove: false,
      canReject: true,
      confirmReject: true,
      note: 'awaitingCard',
      showDiff: false,
      invoiceId: null,
    });
  });

  it('offers neither button on a card change waiting on its invoice', () => {
    // The payment can still go through; Stripe would then bill the new package monthly.
    expect(requestRailView(req({ rail: 'stripe', stripe_invoice_id: 'in_1Abc' }), 'stripe')).toEqual({
      badge: 'paymentInProgress',
      canApprove: false,
      canReject: false,
      confirmReject: false,
      note: 'paymentInProgress',
      showDiff: false,
      invoiceId: 'in_1Abc',
    });
    // An id that does not look like one still counts (the server refuses on any id) but links nowhere.
    const odd = requestRailView(req({ rail: 'stripe', stripe_invoice_id: 'weird' }), 'stripe');
    expect(odd.canReject).toBe(false);
    expect(odd.invoiceId).toBeNull();
    // Only the page link arrived.
    const urlOnly = requestRailView(req({ rail: 'stripe', stripe_invoice_url: 'https://invoice.stripe.com/i/x' }), 'stripe');
    expect(urlOnly.canReject).toBe(false);
  });

  it('reads the waiting invoice off the restaurant when the row arrives without it', () => {
    const view = requestRailView(req({ rail: 'stripe' }), 'stripe', { invoiceUrl: 'https://invoice.stripe.com/i/acct_1/x' });
    expect(view.badge).toBe('paymentInProgress');
    expect(view.canReject).toBe(false);
    // A manual request is never "in progress": the restaurant's invoice is not about it.
    expect(requestRailView(req(), 'stripe', { invoiceUrl: 'https://invoice.stripe.com/i/acct_1/x' }).canReject).toBe(true);
  });

  it("offers Reject, behind the refund question, once a change's payment window has passed (money-rr-1)", () => {
    const marked = '2026-09-26T08:00:00Z';
    const at = (hours: number) => Date.parse(marked) + hours * 3600_000;
    const held = req({ rail: 'stripe', stripe_invoice_id: 'in_1Abc', stripe_invoice_marked_at: marked });
    // Inside the window: the payment could still go through, so nothing to press.
    expect(requestRailView(held, 'stripe', { nowMs: at(22) }).canReject).toBe(false);
    // Just past 23 h the server releases it, but the console waits out its margin first.
    expect(requestRailView(held, 'stripe', { nowMs: at(23) + 60_000 }).badge).toBe('paymentInProgress');
    expect(requestRailView(held, 'stripe', { nowMs: at(24) })).toEqual({
      badge: 'paymentExpired',
      canApprove: false,
      canReject: true,
      confirmReject: true,
      note: 'paymentExpired',
      showDiff: false,
      invoiceId: 'in_1Abc',
    });
  });

  it('reads the window off the later of the two marks, and never guesses an expiry', () => {
    const nowMs = Date.parse('2026-09-28T12:00:00Z');
    const old = '2026-09-26T08:00:00Z';
    const recent = '2026-09-28T08:00:00Z';
    // A retried change stamped its start again: the hold is only four hours old.
    const retried = req({
      rail: 'stripe',
      stripe_invoice_id: 'in_1',
      stripe_invoice_marked_at: old,
      stripe_change_started_at: recent,
    });
    expect(requestRailView(retried, 'stripe', { nowMs }).badge).toBe('paymentInProgress');
    // No mark recorded (a row from before the columns): the server decides, not a guess.
    expect(requestRailView(req({ rail: 'stripe', stripe_invoice_id: 'in_1' }), 'stripe', { nowMs }).canReject).toBe(false);
    // An unreadable mark is no evidence either.
    const garbled = req({ rail: 'stripe', stripe_invoice_id: 'in_1', stripe_invoice_marked_at: 'soon' });
    expect(requestRailView(garbled, 'stripe', { nowMs }).canReject).toBe(false);
    // Without a clock nothing is expired.
    const undated = req({ rail: 'stripe', stripe_invoice_id: 'in_1', stripe_invoice_marked_at: old });
    expect(requestRailView(undated, 'stripe').badge).toBe('paymentInProgress');
    // Held through the restaurant's invoice link alone, the row's own mark still dates it.
    const viaRestaurant = req({ rail: 'stripe', stripe_invoice_marked_at: old });
    expect(
      requestRailView(viaRestaurant, 'stripe', { invoiceUrl: 'https://invoice.stripe.com/i/x', nowMs }).badge,
    ).toBe('paymentExpired');
  });

  it('holds a change whose subscription update was sent even before its invoice is stored', () => {
    const nowMs = Date.parse('2026-09-28T12:00:00Z');
    const inFlight = req({ rail: 'stripe', stripe_change_started_at: '2026-09-28T11:59:00Z' });
    expect(requestRailView(inFlight, 'stripe', { nowMs })).toMatchObject({
      badge: 'paymentInProgress',
      canReject: false,
      invoiceId: null,
    });
    // A lost answer is not a hold forever: it runs out like an invoice does.
    const stuck = req({ rail: 'stripe', stripe_change_started_at: '2026-09-26T11:00:00Z' });
    expect(requestRailView(stuck, 'stripe', { nowMs })).toMatchObject({ badge: 'paymentExpired', canReject: true });
  });

  it('says a Checkout waits on the merchant while card billing is switched off (ui-rr-5)', () => {
    const checkout = req({ rail: 'stripe' });
    // Off, for a restaurant that does not pay by card yet: its plan page asks it to send the
    // request to the team, and only then can it be approved here.
    expect(requestRailView(checkout, 'manual', { cardSwitchOn: false })).toEqual({
      badge: 'awaitingCard',
      canApprove: false,
      canReject: true,
      confirmReject: true,
      note: 'awaitingCardPaused',
      showDiff: false,
      invoiceId: null,
    });
    // On, or unknown: the ordinary Checkout note.
    expect(requestRailView(checkout, 'manual', { cardSwitchOn: true }).note).toBe('awaitingCard');
    expect(requestRailView(checkout, 'manual', { cardSwitchOn: null }).note).toBe('awaitingCard');
    expect(requestRailView(checkout, 'manual').note).toBe('awaitingCard');
    // A card payer keeps paying by card with the switch off, and an unread package is no basis.
    expect(requestRailView(checkout, 'stripe', { cardSwitchOn: false }).note).toBe('awaitingCard');
    expect(requestRailView(checkout, null, { cardSwitchOn: false }).note).toBe('awaitingCard');
    // A manual request is untouched by the switch.
    expect(requestRailView(req(), 'manual', { cardSwitchOn: false }).canApprove).toBe(true);
  });

  it('never offers Approve for a restaurant that already pays by card, but keeps Reject', () => {
    expect(requestRailView(req(), 'stripe')).toEqual({
      badge: null,
      canApprove: false,
      canReject: true,
      confirmReject: false,
      note: 'managedRestaurant',
      showDiff: false,
      invoiceId: null,
    });
  });

  it('says "Paid by card" for a request a card payment settled', () => {
    const settled = req({ status: 'approved', rail: 'stripe', paid_at: '2026-09-26T10:00:00Z' });
    expect(requestRailView(settled, 'stripe').badge).toBe('paidByCard');
    // Approved by hand: the plain status.
    expect(requestRailView(req({ status: 'approved' }), 'manual').badge).toBeNull();
    // Rejected card request: the plain status, and nothing to do.
    expect(requestRailView(req({ status: 'rejected', rail: 'stripe' }), 'manual')).toEqual({
      badge: null,
      canApprove: false,
      canReject: false,
      confirmReject: false,
      note: null,
      showDiff: false,
      invoiceId: null,
    });
  });
});

describe('the invoice a change waits on', () => {
  it('reads it defensively from whatever row arrives', () => {
    expect(requestInvoiceOf({ stripe_invoice_id: 'in_9', stripe_invoice_url: null })).toEqual({
      waiting: true,
      id: 'in_9',
    });
    expect(requestInvoiceOf({ stripe_invoice_id: '  ' })).toEqual({ waiting: false, id: null });
    expect(requestInvoiceOf({ stripe_invoice_id: 42 })).toEqual({ waiting: false, id: null });
    expect(requestInvoiceOf({})).toEqual({ waiting: false, id: null });
  });

  it("dates the hold off the later mark and times it with the edge's 23 h window", () => {
    expect(CARD_CHANGE_WINDOW_MS).toBe(23 * 3600 * 1000);
    const lock = requestCardLock(
      {
        stripe_invoice_id: 'in_1',
        stripe_invoice_marked_at: '2026-09-26T09:00:00Z',
        stripe_change_started_at: '2026-09-26T08:59:00Z',
      },
      Date.parse('2026-09-26T10:00:00Z'),
    );
    expect(lock).toEqual({ locked: true, since: '2026-09-26T09:00:00Z', expired: false });
    // Postgres' microseconds and offset read fine.
    expect(
      requestCardLock({ stripe_change_started_at: '2026-09-26T09:00:00.123456+00:00' }, Date.parse('2026-09-28T09:00:00Z')),
    ).toEqual({ locked: true, since: '2026-09-26T09:00:00.123456+00:00', expired: true });
    // A checkout request holds nothing.
    expect(requestCardLock({}, Date.parse('2026-09-28T09:00:00Z'))).toEqual({ locked: false, since: null, expired: false });
  });

  it('links the operator to the Dashboard invoice, never to a garbage id', () => {
    expect(stripeInvoiceLink('in_1Abc')).toBe('https://dashboard.stripe.com/invoices/in_1Abc');
    expect(stripeInvoiceLink('in_1Abc', 'https://dashboard.stripe.com/acct_1/test/')).toBe(
      'https://dashboard.stripe.com/acct_1/test/invoices/in_1Abc',
    );
    expect(stripeInvoiceLink('in_../x')).toBeNull();
    expect(stripeInvoiceLink(null)).toBeNull();
  });
});

describe('isStripeManagedError', () => {
  it('spots the refusal in whatever wrapper PostgREST puts around it', () => {
    expect(isStripeManagedError('stripe_managed')).toBe(true);
    expect(isStripeManagedError('ERROR: stripe_managed (P0001)')).toBe(true);
    expect(isStripeManagedError('request_already_decided')).toBe(false);
    expect(isStripeManagedError(undefined)).toBe(false);
  });

  it('spots the payment_in_progress and stripe_delivery_active refusals too', () => {
    expect(isPaymentInProgressError('ERROR: payment_in_progress (P0001)')).toBe(true);
    expect(isPaymentInProgressError('stripe_managed')).toBe(false);
    expect(isStripeDeliveryActiveError('stripe_delivery_active')).toBe(true);
    expect(isStripeDeliveryActiveError(null)).toBe(false);
  });
});
