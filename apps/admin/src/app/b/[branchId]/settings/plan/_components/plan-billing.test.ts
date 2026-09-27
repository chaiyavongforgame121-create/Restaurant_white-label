// The card rail's decisions (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §5): what the plan page
// and the dashboard say about a restaurant that pays the platform by card, and what they must
// never say — "goes dark" about a package that renews by itself, "pay again" about a payment
// that already went through.

import fs from 'node:fs';
import path from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { BillingRailInfo, CardPaymentStart } from '@favornoms/database/queries';
// The edge function's own rule, run beside the page's over the same cases (UIM-7). The module
// imports nothing, which is what lets this app's test runner load it.
import { billingAnchor } from '../../../../../../../../../supabase/functions/_shared/stripe-billing';
import {
  ANCHOR_MAX_LEAD_MS,
  CHECKOUT_POLL_CAP_MS,
  MONTHLY_DEFER_MIN_MS,
  canContinuePayment,
  canReplacePending,
  cardResultAfterConfirm,
  filedAction,
  invoiceStep,
  isCancelling,
  isHttpsUrl,
  payOnceNote,
  paysByCard,
  sessionMatch,
  cardAction,
  cardBrandName,
  cardCharge,
  cardExpiresBefore,
  cardExpiry,
  cardFootnote,
  cardResultAfterPoll,
  coveredUntil,
  dashboardBillingCard,
  dashboardNeedsRail,
  expiryDaysLeft,
  invoiceAmount,
  isCheckoutSessionId,
  isSettling,
  isStripeUrl,
  monthlyStartsOn,
  nextCharge,
  openingCardResult,
  pendingPayment,
  railBanners,
  readCheckoutReturn,
  readPortalReturn,
  invoiceStatusKey,
} from './plan-billing';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** What get_billing_overview's `billing` reads as when it could not be read: MANUAL_RAIL. */
const MANUAL: BillingRailInfo = {
  stripeEnabled: false,
  rail: 'manual',
  status: 'none',
  hasStripeCustomer: false,
  nextChargeAt: null,
  nextChargeAmount: null,
  cancelAtPeriodEnd: false,
  cancelAt: null,
  graceUntil: null,
  card: null,
  lastInvoice: null,
  pendingRequestRail: null,
  pendingInvoiceUrl: null,
};

/** A restaurant paying by card, renewing on Oct 26 for $58. */
const STRIPE: BillingRailInfo = {
  ...MANUAL,
  stripeEnabled: true,
  rail: 'stripe',
  status: 'active',
  hasStripeCustomer: true,
  nextChargeAt: '2026-10-26T12:00:00Z',
  nextChargeAmount: 58,
  card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
  lastInvoice: {
    amountPaid: 228,
    amountDue: 228,
    status: 'paid',
    paidAt: '2026-09-26T12:00:00Z',
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/acct_1/test_abc',
    billingReason: 'subscription_create',
    attemptCount: 1,
  },
};

// --- coming back from Stripe -------------------------------------------------

describe('the page reads Stripe’s return without trusting the query string', () => {
  it('passes a real Checkout Session id through', () => {
    expect(readCheckoutReturn('success', 'cs_test_a1B2c3D4e5F6g7')).toEqual({
      kind: 'success',
      sessionId: 'cs_test_a1B2c3D4e5F6g7',
    });
    expect(isCheckoutSessionId('cs_live_a1B2c3D4e5F6g7H8')).toBe(true);
  });

  it('drops an unsubstituted placeholder or anything that is not a session id, but still waits', () => {
    // A success URL whose {CHECKOUT_SESSION_ID} was never filled in is still a payment that
    // went through: the page waits for the webhook instead of showing an error.
    for (const bad of ['{CHECKOUT_SESSION_ID}', 'pi_123456789', "cs_x'; drop", '', undefined, ['cs_test_aaaaaaaaaa']]) {
      expect(readCheckoutReturn('success', bad)).toEqual({ kind: 'success', sessionId: null });
    }
  });

  it('reads cancel and portal returns, and nothing else', () => {
    expect(readCheckoutReturn('cancelled', undefined)).toEqual({ kind: 'cancelled' });
    expect(readCheckoutReturn('maybe', 'cs_test_a1B2c3D4e5F6g7')).toBeNull();
    expect(readCheckoutReturn(undefined, undefined)).toBeNull();
    expect(readPortalReturn('return')).toBe(true);
    expect(readPortalReturn('1')).toBe(false);
    expect(readPortalReturn(undefined)).toBe(false);
  });
});

const SESSION = 'cs_test_a1B2c3D4e5F6g7';
const OLD_SESSION = 'cs_test_z9Y8x7W6v5U4t3';
/** The request Checkout was opened for, still waiting. */
const CHECKOUT_PENDING = { checkoutSessionId: SESSION, rail: 'stripe' as const };

describe('after Checkout, the page waits for the card rail and never offers to pay again', () => {
  it('opens on "confirming", or straight on "active" when the webhook beat the browser back', () => {
    expect(openingCardResult({ kind: 'success', sessionId: SESSION }, 'manual', CHECKOUT_PENDING)).toBe('confirming');
    expect(openingCardResult({ kind: 'success', sessionId: SESSION }, 'stripe', null)).toBe('active');
    expect(openingCardResult({ kind: 'cancelled' }, 'manual', CHECKOUT_PENDING)).toBe('cancelled');
    expect(openingCardResult(null, 'stripe', null)).toBeNull();
  });

  it('waits without a session id only while a card request could be settling', () => {
    expect(openingCardResult({ kind: 'success', sessionId: null }, 'manual', CHECKOUT_PENDING)).toBe('confirming');
    // No id to confirm and nothing that is paid by card: an old or mangled URL, nothing to wait for.
    expect(openingCardResult({ kind: 'success', sessionId: null }, 'manual', null)).toBeNull();
    expect(
      openingCardResult({ kind: 'success', sessionId: null }, 'manual', { checkoutSessionId: null, rail: 'manual' }),
    ).toBeNull();
  });

  it('does not announce "active" over a card restaurant’s waiting request from an old URL', () => {
    const waiting = { checkoutSessionId: null, rail: 'stripe' as const };
    expect(openingCardResult({ kind: 'success', sessionId: OLD_SESSION }, 'stripe', waiting)).toBeNull();
  });

  it('is settled only by the rail — a trial looks entitled before and after paying', () => {
    expect(cardResultAfterPoll('confirming', 'manual', 2_000)).toBe('confirming');
    expect(cardResultAfterPoll('confirming', 'stripe', 2_000)).toBe('active');
    // A late webhook still turns "processing" into the good news.
    expect(cardResultAfterPoll('processing', 'stripe', 0)).toBe('active');
  });

  it('gives up polling at the cap and says "processing", not "failed"', () => {
    expect(cardResultAfterPoll('confirming', 'manual', CHECKOUT_POLL_CAP_MS - 1)).toBe('confirming');
    expect(cardResultAfterPoll('confirming', 'manual', CHECKOUT_POLL_CAP_MS)).toBe('processing');
    expect(cardResultAfterPoll('confirming', 'manual', CHECKOUT_POLL_CAP_MS, 'unknown')).toBe('processing');
    expect(cardResultAfterPoll('processing', 'manual', CHECKOUT_POLL_CAP_MS * 5)).toBe('processing');
  });

  it('ends the wait at the cap for a session that is not the waiting request’s', () => {
    expect(cardResultAfterPoll('confirming', 'manual', CHECKOUT_POLL_CAP_MS, 'other')).toBeNull();
  });

  it('leaves every other banner alone', () => {
    for (const phase of ['active', 'applied', 'cancelled', 'refundedStale', 'refundedFailed', null] as const) {
      expect(cardResultAfterPoll(phase, 'stripe', CHECKOUT_POLL_CAP_MS)).toBe(phase);
    }
  });

  it('treats a payment being recorded as one that must not be offered again', () => {
    expect(isSettling('confirming')).toBe(true);
    expect(isSettling('processing')).toBe(true);
    const kind = pendingPayment({
      pending: { id: 'req-1', rail: 'stripe' },
      restaurantRail: 'manual',
      byCard: true,
      invoiceUrl: null,
      startFailedFor: null,
      unconfirmedFor: null,
      result: 'processing',
    });
    expect(kind).toBe('settling');
    expect(canContinuePayment(kind)).toBe(false);
  });
});

describe('the session in the URL is matched to the request that is waiting', () => {
  it('is the waiting request’s own payment only when the ids agree', () => {
    expect(sessionMatch(SESSION, CHECKOUT_PENDING)).toBe('pending');
    expect(sessionMatch(OLD_SESSION, CHECKOUT_PENDING)).toBe('other');
    expect(sessionMatch(SESSION, null)).toBe('other');
    expect(sessionMatch(SESSION, { checkoutSessionId: null, rail: 'manual' })).toBe('other');
    expect(sessionMatch(null, CHECKOUT_PENDING)).toBe('unknown');
  });
});

describe('what confirmCheckout says decides the banner (UIM-3, UIM-8)', () => {
  const ours = { rail: 'manual' as const, match: 'pending' as const };
  const old = { rail: 'manual' as const, match: 'other' as const };
  const answer = (settled: boolean, status: string | null = null) => ({ kind: 'answer' as const, settled, status });

  it('keeps waiting for our own settled payment until the refresh brings the card rail', () => {
    expect(cardResultAfterConfirm('confirming', answer(true), ours)).toBe('confirming');
    expect(cardResultAfterConfirm('confirming', answer(true), { ...ours, rail: 'stripe' })).toBe('active');
  });

  const refunded = (reason: string | null) => ({ kind: 'answer' as const, settled: false, status: 'charged_refunded', reason });

  it('says a payment for a replaced or declined request is refunded, and unlocks the page', () => {
    for (const reason of ['request_not_pending', 'request_not_found']) {
      const r = cardResultAfterConfirm('confirming', refunded(reason), ours);
      expect(r, reason).toBe('refundedStale');
      expect(isSettling(r)).toBe(false);
    }
    // After the cap, too: "processing" must not outlive the answer.
    expect(cardResultAfterConfirm('processing', refunded('request_not_pending'), ours)).toBe('refundedStale');
  });

  it('says a payment whose package could not be applied is refunded', () => {
    for (const reason of ['settle_failed', 'invalid_arguments', null]) {
      expect(cardResultAfterConfirm('confirming', refunded(reason), ours), String(reason)).toBe('refundedFailed');
    }
  });

  it('reads only charged_refunded as a refund: a bare settle refusal took no money (ui-rr-1)', () => {
    // An "Add card" Checkout (no_payment_required) for a request replaced in another tab, or one
    // that no longer fits: stripe-billing sends the settlement's refusal as it is.
    for (const status of ['request_not_pending', 'request_not_found', 'settle_failed', 'invalid_arguments', 'not_settled']) {
      const r = cardResultAfterConfirm('confirming', answer(false, status), ours);
      expect(r, status).toBe('notApplied');
      // Over: the URL is cleaned and nothing is locked on its account...
      expect(isSettling(r)).toBe(false);
      // ...so whatever is waiting now can be paid.
      expect(
        pendingPayment({
          pending: { id: 'b', rail: 'stripe' },
          restaurantRail: 'manual',
          byCard: true,
          invoiceUrl: null,
          startFailedFor: null,
          unconfirmedFor: null,
          result: r,
        }),
      ).toBe('card');
    }
    // Whichever session it was: an old URL's no-charge Checkout was not applied either.
    expect(cardResultAfterConfirm('confirming', answer(false, 'request_not_pending'), old)).toBe('notApplied');
    expect(cardResultAfterConfirm('processing', answer(false, 'settle_failed'), ours)).toBe('notApplied');
  });

  it('treats an old success URL as over, whatever it answers', () => {
    // The request it paid for was settled long ago (a duplicate), or it never was this page's.
    expect(cardResultAfterConfirm('confirming', answer(true), old)).toBeNull();
    expect(cardResultAfterConfirm('confirming', answer(false, 'expired'), old)).toBeNull();
    expect(cardResultAfterConfirm('confirming', { kind: 'failed', code: '500' }, old)).toBeNull();
    expect(cardResultAfterConfirm('confirming', answer(false, 'unpaid'), old)).toBeNull();
  });

  it('ends the wait for a session that was never paid', () => {
    expect(cardResultAfterConfirm('confirming', answer(false, 'open'), ours)).toBeNull();
    expect(cardResultAfterConfirm('confirming', answer(false, 'expired'), ours)).toBeNull();
  });

  it('keeps waiting for our own payment through an outage or a payment still clearing', () => {
    expect(cardResultAfterConfirm('confirming', { kind: 'failed', code: 'internal_error' }, ours)).toBe('confirming');
    expect(cardResultAfterConfirm('confirming', { kind: 'failed', code: '' }, ours)).toBe('confirming');
    expect(cardResultAfterConfirm('confirming', answer(false, 'unpaid'), ours)).toBe('confirming');
    expect(cardResultAfterConfirm('confirming', answer(false, 'dormant'), ours)).toBe('confirming');
  });

  it('stops for a session the caller can never settle here', () => {
    for (const code of ['forbidden', 'not_a_package_payment', 'bad_request', 'cannot_bill']) {
      expect(cardResultAfterConfirm('confirming', { kind: 'failed', code }, ours), code).toBeNull();
    }
  });

  it('never overrides a banner the merchant already moved past', () => {
    for (const phase of ['active', 'applied', 'cancelled', 'notApplied', null] as const) {
      expect(cardResultAfterConfirm(phase, answer(false, 'request_not_pending'), ours)).toBe(phase);
    }
  });
});

describe('where the page sends the browser (SEC-EDGE-3)', () => {
  it('follows any https URL our function answers with, custom domains included', () => {
    expect(isHttpsUrl('https://checkout.stripe.com/c/pay/cs_test_abc')).toBe(true);
    expect(isHttpsUrl('https://invoice.stripe.com/i/acct_1/test_abc')).toBe(true);
    expect(isHttpsUrl('https://billing.stripe.com/p/session/test_abc')).toBe(true);
    expect(isHttpsUrl('https://payments.favornoms.com/c/pay/cs_live_abc')).toBe(true);
  });

  it('never navigates to anything that is not https', () => {
    for (const bad of [
      'http://checkout.stripe.com/c/pay/cs_test_abc',
      'javascript:alert(1)',
      '/b/x/settings/plan',
      'not a url',
      '',
      null,
      42,
    ]) {
      expect(isHttpsUrl(bad), String(bad)).toBe(false);
    }
  });

  it('links a stored invoice only when it is Stripe’s own page', () => {
    expect(isStripeUrl('https://invoice.stripe.com/i/acct_1/test_abc')).toBe(true);
    for (const bad of [
      'http://invoice.stripe.com/i/acct_1/test_abc',
      'https://checkout.stripe.com.evil.example/c/pay',
      'https://evilstripe.com/',
      'https://payments.favornoms.com/i/abc',
      'javascript:alert(1)',
      '',
      null,
    ]) {
      expect(isStripeUrl(bad), String(bad)).toBe(false);
    }
  });
});

// --- the request waiting to be paid ------------------------------------------

describe('a restaurant already paying by card keeps paying by card (UIM-5)', () => {
  it('pays by card when the switch is on, or when it is on the card rail whatever the switch', () => {
    expect(paysByCard({ stripeEnabled: true, rail: 'manual' })).toBe(true);
    expect(paysByCard({ stripeEnabled: false, rail: 'stripe' })).toBe(true);
    expect(paysByCard({ stripeEnabled: false, rail: 'manual' })).toBe(false);
  });
});

describe('the waiting request says who it is waiting for', () => {
  const INVOICE = 'https://invoice.stripe.com/i/acct_1/test_abc';
  const base = {
    restaurantRail: 'manual' as const,
    byCard: true,
    invoiceUrl: null,
    startFailedFor: null,
    unconfirmedFor: null,
    result: null,
  };

  it('waits for the Favornoms team while card payments are off for a manual restaurant', () => {
    expect(pendingPayment({ ...base, byCard: false, pending: { id: 'r', rail: 'manual' } })).toBe('team');
    expect(canContinuePayment('team')).toBe(false);
  });

  it('never leaves a card request waiting for a team that cannot approve it', () => {
    // A Checkout request filed before the switch went off: sent to the team again, as a manual one.
    const kind = pendingPayment({ ...base, byCard: false, pending: { id: 'r', rail: 'stripe' } });
    expect(kind).toBe('cardPaused');
    expect(filedAction(kind)).toBe('sendToTeam');
    // A card-rail restaurant pays by card whatever the switch, so its request still waits for the card.
    expect(pendingPayment({ ...base, byCard: paysByCard({ stripeEnabled: false, rail: 'stripe' }), pending: { id: 'r', rail: 'stripe' } })).toBe('card');
  });

  it('waits for the card once Checkout was opened for it', () => {
    const kind = pendingPayment({ ...base, pending: { id: 'r', rail: 'stripe' } });
    expect(kind).toBe('card');
    expect(canContinuePayment(kind)).toBe(true);
    expect(filedAction(kind)).toBe('continue');
  });

  it('waits for the card when starting the payment failed after the request was filed', () => {
    // The server never marked it as a card request, but the merchant was paying for it: the
    // page must show the filed request with Continue to payment, not a request for the team.
    expect(pendingPayment({ ...base, startFailedFor: 'r', pending: { id: 'r', rail: 'manual' } })).toBe('card');
    expect(pendingPayment({ ...base, startFailedFor: 'other', pending: { id: 'r', rail: 'manual' } })).toBe(
      'teamOrCard',
    );
  });

  it('offers the card for a request filed for the team before card billing was switched on', () => {
    const kind = pendingPayment({ ...base, pending: { id: 'r', rail: 'manual' } });
    expect(kind).toBe('teamOrCard');
    expect(canContinuePayment(kind)).toBe(true);
  });

  it('never sends a card restaurant’s request to the team, even while its row reads manual (ui-rr-4)', () => {
    // A change whose card step failed before Stripe invoiced it (subscription_not_active, a dropped
    // connection), read again after a reload: the row was never marked, and the page's own memory
    // of the failure is gone. The team cannot approve it by hand (D11), so it waits for the card.
    const kind = pendingPayment({ ...base, restaurantRail: 'stripe', pending: { id: 'r', rail: 'manual' } });
    expect(kind).toBe('card');
    expect(canContinuePayment(kind)).toBe(true);
    expect(filedAction(kind)).toBe('continue');
    expect(payOnceNote(kind)).toBe('stripe.onceAwaiting');
    // With the switch off too: a card restaurant pays by card whatever the switch.
    expect(
      pendingPayment({
        ...base,
        restaurantRail: 'stripe',
        byCard: paysByCard({ stripeEnabled: false, rail: 'stripe' }),
        pending: { id: 'r', rail: 'manual' },
      }),
    ).toBe('card');
    // A manual restaurant's manual request still names the team.
    expect(pendingPayment({ ...base, pending: { id: 'r', rail: 'manual' } })).toBe('teamOrCard');
    expect(pendingPayment({ ...base, byCard: false, pending: { id: 'r', rail: 'manual' } })).toBe('team');
  });

  it('sends a change held on 3-D Secure to Stripe’s page, and nothing replaces it meanwhile', () => {
    const kind = pendingPayment({ ...base, invoiceUrl: INVOICE, pending: { id: 'r', rail: 'stripe' } });
    expect(kind).toBe('invoice');
    expect(filedAction(kind)).toBe('finish');
    expect(canContinuePayment(kind)).toBe(false);
    // request_package_change answers payment_in_progress: the button says so instead of failing.
    expect(canReplacePending(kind)).toBe(false);
    // An invoice link means nothing for a request that is not a card request.
    expect(pendingPayment({ ...base, invoiceUrl: INVOICE, pending: { id: 'r', rail: 'manual' } })).toBe('teamOrCard');
  });

  it('offers nothing for a request whose card step ended without a known result (UIM-1)', () => {
    const kind = pendingPayment({ ...base, unconfirmedFor: 'r', pending: { id: 'r', rail: 'stripe' } });
    expect(kind).toBe('unconfirmed');
    expect(canContinuePayment(kind)).toBe(false);
    expect(filedAction(kind)).toBe('checking');
    // Even when it had also failed to start earlier, and whatever invoice link is around.
    expect(
      pendingPayment({ ...base, unconfirmedFor: 'r', startFailedFor: 'r', invoiceUrl: INVOICE, pending: { id: 'r', rail: 'stripe' } }),
    ).toBe('unconfirmed');
    // Another request (a replacement filed since) is not held back by it.
    expect(pendingPayment({ ...base, unconfirmedFor: 'old', pending: { id: 'r', rail: 'stripe' } })).toBe('card');
    expect(canReplacePending(kind)).toBe(true);
  });

  it('says "nothing has been charged yet" only where it is true', () => {
    expect(payOnceNote('card')).toBe('stripe.onceAwaiting');
    expect(payOnceNote('invoice')).toBe('stripe.onceAwaiting');
    expect(payOnceNote('settling')).toBe('stripe.onceSettling');
    expect(payOnceNote('unconfirmed')).toBe('stripe.onceUnconfirmed');
    expect(payOnceNote('team')).toBe('pay.onceAwaiting');
    expect(payOnceNote('cardPaused')).toBe('pay.onceAwaiting');
  });

  it('has nothing to press for a request waiting on the team', () => {
    expect(filedAction('team')).toBe('waiting');
    expect(filedAction('settling')).toBe('waiting');
  });

  it('reads the pre-refresh copy of a request that was just paid as nothing waiting', () => {
    for (const result of ['active', 'applied'] as const) {
      expect(pendingPayment({ ...base, result, pending: { id: 'r', rail: 'stripe' } })).toBe('none');
    }
  });

  it('lets the merchant pay the request that is open after a stale payment was refunded (UIM-3)', () => {
    for (const result of ['refundedStale', 'refundedFailed', 'notApplied'] as const) {
      const kind = pendingPayment({ ...base, result, pending: { id: 'b', rail: 'stripe' } });
      expect(kind, result).toBe('card');
      expect(canContinuePayment(kind)).toBe(true);
    }
  });

  it('is nothing at all without a request, or with a refusal that carried no id', () => {
    expect(pendingPayment({ ...base, pending: null })).toBe('none');
    expect(pendingPayment({ ...base, pending: { id: null, rail: 'stripe' } })).toBe('none');
  });
});

describe('a change held on Stripe’s invoice page is asked about, not only linked to (edge-rr-1)', () => {
  const STORED = 'https://invoice.stripe.com/i/acct_1/test_stored';
  const FRESH = 'https://invoice.stripe.com/i/acct_1/test_fresh';
  const onLoad = { pressed: false, storedUrl: STORED };
  const onPress = { pressed: true, storedUrl: STORED };
  const answer = (start: CardPaymentStart) => ({ kind: 'answer', start }) as const;
  const failed = (code: string) => ({ kind: 'failed', raw: `stripe_billing_failed:${code}` }) as const;

  it('opens Stripe’s page as start gives it when Finish payment is pressed, and never on opening', () => {
    expect(invoiceStep(answer({ kind: 'action_required', url: FRESH }), onPress)).toEqual({ do: 'go', url: FRESH });
    expect(invoiceStep(answer({ kind: 'action_required', url: FRESH }), onLoad)).toEqual({ do: 'stay' });
    // Something that is not https is never followed: the stored page is.
    expect(invoiceStep(answer({ kind: 'action_required', url: 'javascript:alert(1)' }), onPress)).toEqual({
      do: 'go',
      url: STORED,
    });
  });

  it('shows the change as live when the invoice had been paid, on opening or on a press', () => {
    expect(invoiceStep(answer({ kind: 'applied' }), onLoad)).toEqual({ do: 'applied' });
    expect(invoiceStep(answer({ kind: 'applied' }), onPress)).toEqual({ do: 'applied' });
  });

  it('says a change past its window was cancelled with nothing charged, and reads the page again', () => {
    // The lock ends: start voided the invoice and cancelled the request (§10.1).
    for (const ctx of [onLoad, onPress]) {
      expect(invoiceStep(failed('payment_expired'), ctx)).toEqual({
        do: 'tell',
        error: 'paymentExpired',
        refresh: true,
        unconfirmed: false,
      });
    }
  });

  it('says what happened to money whenever start reports it, and offers nothing more for it', () => {
    for (const ctx of [onLoad, onPress]) {
      expect(invoiceStep(failed('charged_refunded'), ctx)).toMatchObject({ do: 'tell', error: 'chargedRefunded', unconfirmed: true });
      expect(invoiceStep(failed('charged_not_applied'), ctx)).toMatchObject({ do: 'tell', error: 'chargedNotApplied', unconfirmed: true });
      expect(invoiceStep(failed('change_conflict'), ctx)).toMatchObject({ do: 'tell', error: 'changeConflict', unconfirmed: true });
      expect(invoiceStep(failed('change_not_applied'), ctx)).toEqual({
        do: 'tell',
        error: 'changeNotApplied',
        refresh: true,
        unconfirmed: false,
      });
    }
  });

  it('reads a request that moved on again, quietly on opening', () => {
    expect(invoiceStep(failed('request_not_pending'), onLoad)).toEqual({ do: 'refresh' });
    expect(invoiceStep(failed('request_not_pending'), onPress)).toEqual({
      do: 'tell',
      error: 'requestGone',
      refresh: true,
      unconfirmed: false,
    });
  });

  it('keeps refusals that only matter to a press to the press', () => {
    for (const [code, error] of [
      ['payment_in_progress', 'busy'],
      ['forbidden', 'forbidden'],
      ['plan_limit_exceeded', 'planLimit'],
      ['subscription_not_active', 'needsTeam'],
      ['stripe_not_configured', 'cardPaused'],
    ] as const) {
      expect(invoiceStep(failed(code), onLoad), code).toEqual({ do: 'stay' });
      expect(invoiceStep(failed(code), onPress), code).toEqual({ do: 'tell', error, refresh: false, unconfirmed: false });
    }
    expect(invoiceStep(answer({ kind: 'dormant' }), onLoad)).toEqual({ do: 'stay' });
    expect(invoiceStep(answer({ kind: 'dormant' }), onPress)).toMatchObject({ do: 'tell', error: 'cardPaused' });
  });

  it('falls back to the stored invoice page when start gives no clear answer to a press', () => {
    // Stripe's own page tells the truth about that invoice: paid, open or void.
    for (const raw of ['stripe_billing_failed:internal_error', 'stripe_billing_failed:502', 'Failed to fetch', '']) {
      expect(invoiceStep({ kind: 'failed', raw }, onPress), raw).toEqual({ do: 'go', url: STORED });
      expect(invoiceStep({ kind: 'failed', raw }, onLoad), raw).toEqual({ do: 'stay' });
    }
    // With no stored page to fall back to, it may not claim nothing was charged.
    expect(invoiceStep(failed('internal_error'), { pressed: true, storedUrl: null })).toEqual({
      do: 'tell',
      error: 'resultUnknown',
      refresh: true,
      unconfirmed: true,
    });
  });
});

// --- what is charged now ------------------------------------------------------

const TRIAL = {
  status: 'trialing',
  trialEndsAt: iso(NOW + 10 * DAY),
  entitledThrough: iso(NOW + 10 * DAY),
  monthlyTotal: 0,
};
const PAID_MANUAL = {
  status: 'active',
  trialEndsAt: null,
  entitledThrough: iso(NOW + 20 * DAY),
  monthlyTotal: 29,
};
const LAPSED = { status: 'expired', trialEndsAt: null, entitledThrough: null, monthlyTotal: 29 };

describe('time already covered is not charged twice (D5)', () => {
  it('starts a trial’s monthly fee when the trial ends, and charges only the one-time fees now', () => {
    const c = cardCharge({ rail: 'manual', entitlements: TRIAL, oneTimeNow: 170, monthlyTotal: 29, nowMs: NOW });
    expect(c).toEqual({ kind: 'first', now: 170, monthlyFrom: TRIAL.trialEndsAt });
    expect(cardAction(c)).toEqual({ key: 'payNow', amount: 170 });
    expect(cardFootnote(c)).toEqual({ key: 'firstLater', date: TRIAL.trialEndsAt });
  });

  it('keeps what a manual merchant already paid for', () => {
    const c = cardCharge({ rail: 'manual', entitlements: PAID_MANUAL, oneTimeNow: 0, monthlyTotal: 29, nowMs: NOW });
    expect(c).toEqual({ kind: 'first', now: 0, monthlyFrom: PAID_MANUAL.entitledThrough });
    // Nothing today: Checkout only saves the card, and the button says when the first charge is.
    expect(cardAction(c)).toEqual({ key: 'addCard', date: PAID_MANUAL.entitledThrough });
  });

  it('charges the first month now when 48 hours and 10 minutes or less are left', () => {
    const at = (ms: number) => ({ ...TRIAL, trialEndsAt: iso(NOW + ms), entitledThrough: iso(NOW + ms) });
    const ending = at(MONTHLY_DEFER_MIN_MS);
    expect(monthlyStartsOn(ending, NOW)).toBeNull();
    const c = cardCharge({ rail: 'manual', entitlements: ending, oneTimeNow: 170, monthlyTotal: 59, nowMs: NOW });
    expect(c).toEqual({ kind: 'first', now: 229, monthlyFrom: null });
    expect(cardFootnote(c)).toEqual({ key: 'firstNow' });

    // 48 h 5 min: past Stripe's 48 hours but inside the edge's margin, so Checkout charges the
    // month today — and the page has to say so (UIM-7).
    expect(monthlyStartsOn(at(48 * 3_600_000 + 5 * 60_000), NOW)).toBeNull();

    const justOver = at(MONTHLY_DEFER_MIN_MS + 1);
    expect(monthlyStartsOn(justOver, NOW)).toBe(justOver.trialEndsAt);
  });

  it('charges a past-due restaurant its month now, as the edge does', () => {
    const pastDue = { ...PAID_MANUAL, status: 'past_due' };
    expect(coveredUntil(pastDue)).toBeNull();
    expect(monthlyStartsOn(pastDue, NOW)).toBeNull();
  });

  it('reads a trial by the later of its end and its deadline', () => {
    const t = { ...TRIAL, trialEndsAt: iso(NOW + DAY), entitledThrough: iso(NOW + 5 * DAY) };
    expect(coveredUntil(t)).toBe(t.entitledThrough);
    expect(monthlyStartsOn(t, NOW)).toBe(t.entitledThrough);
    expect(coveredUntil({ ...t, entitledThrough: iso(NOW + DAY / 2) })).toBe(t.trialEndsAt);
  });

  it('clamps a date further out than Stripe allows, to the date Checkout will use', () => {
    const far = { ...PAID_MANUAL, entitledThrough: iso(NOW + 900 * DAY) };
    expect(monthlyStartsOn(far, NOW)).toBe(iso(NOW + ANCHOR_MAX_LEAD_MS));
  });

  it('charges a lapsed restaurant its first month now', () => {
    expect(coveredUntil(LAPSED)).toBeNull();
    const c = cardCharge({ rail: 'manual', entitlements: LAPSED, oneTimeNow: 0, monthlyTotal: 29, nowMs: NOW });
    expect(c).toEqual({ kind: 'first', now: 29, monthlyFrom: null });
    expect(cardAction(c)).toEqual({ key: 'payNow', amount: 29 });
  });

  it('reads a trial by its end date, and falls back to the deadline when it has none', () => {
    expect(coveredUntil({ ...TRIAL, trialEndsAt: null })).toBe(TRIAL.entitledThrough);
    expect(coveredUntil({ ...PAID_MANUAL, status: 'cancelled' })).toBe(PAID_MANUAL.entitledThrough);
    expect(coveredUntil({ status: 'none', trialEndsAt: null, entitledThrough: iso(NOW + DAY * 30) })).toBeNull();
  });

  it('adds cents without floating-point drift', () => {
    const c = cardCharge({ rail: 'manual', entitlements: LAPSED, oneTimeNow: 49.5, monthlyTotal: 29.1, nowMs: NOW });
    expect(c.now).toBe(78.6);
  });
});

describe('the page and the edge agree on when the first monthly charge is (UIM-7)', () => {
  const H = 3_600_000;
  const M = 60_000;
  const leads = [
    -5 * H,
    0,
    10 * H,
    48 * H,
    48 * H + 5 * M,
    48 * H + 10 * M,
    48 * H + 10 * M + 1_000,
    48 * H + 11 * M,
    3 * 24 * H,
    30 * 24 * H,
    728 * 24 * H,
    729 * 24 * H + H,
    1_000 * 24 * H,
  ];
  const at = (lead: number | null) => (lead === null ? null : iso(NOW + lead));
  const cases: Array<{ status: string; trial: number | null; period: number | null }> = [];
  for (const status of ['trialing', 'active', 'cancelled', 'past_due', 'expired', 'none']) {
    for (const lead of leads) {
      cases.push({ status, trial: status === 'trialing' ? lead : null, period: lead });
      if (status === 'trialing') {
        cases.push({ status, trial: lead, period: null });
        cases.push({ status, trial: null, period: lead });
        cases.push({ status, trial: lead, period: lead + 2 * 24 * H });
        cases.push({ status, trial: lead + 2 * 24 * H, period: lead });
      }
    }
  }

  it(`defers exactly when billingAnchor defers, to the same second (${cases.length} cases)`, () => {
    for (const c of cases) {
      const ent = { status: c.status, trialEndsAt: at(c.trial), entitledThrough: at(c.period) };
      const page = monthlyStartsOn(ent, NOW);
      const edge = billingAnchor(NOW, ent.trialEndsAt, ent.entitledThrough, c.status);
      const label = JSON.stringify(c);
      if (edge === null) expect(page, label).toBeNull();
      else expect(page === null ? null : Math.floor(Date.parse(page) / 1000), label).toBe(edge);
    }
  });
});

describe('a restaurant already paying by card is charged on the card on file (D7)', () => {
  const onCard = { ...PAID_MANUAL, monthlyTotal: 58 };

  it('charges the one-time fees now and says a monthly difference is prorated', () => {
    const c = cardCharge({ rail: 'stripe', entitlements: onCard, oneTimeNow: 70, monthlyTotal: 87, nowMs: NOW });
    expect(c).toEqual({ kind: 'change', now: 70, monthlyChanges: true });
    expect(cardAction(c)).toEqual({ key: 'payNow', amount: 70 });
    expect(cardFootnote(c)).toEqual({ key: 'change' });
  });

  it('never adds a month the subscription already bills', () => {
    // The trial/paid-through rule is for the first purchase only: a card-rail change keeps its
    // period, and the month is on the subscription already.
    const c = cardCharge({ rail: 'stripe', entitlements: { ...onCard, entitledThrough: iso(NOW + DAY) }, oneTimeNow: 0, monthlyTotal: 29, nowMs: NOW });
    expect(c).toEqual({ kind: 'change', now: 0, monthlyChanges: true });
    expect(cardAction(c)).toEqual({ key: 'confirmChange' });
  });

  it('knows when the monthly fee does not move', () => {
    const c = cardCharge({ rail: 'stripe', entitlements: onCard, oneTimeNow: 0, monthlyTotal: 58, nowMs: NOW });
    expect(c).toEqual({ kind: 'change', now: 0, monthlyChanges: false });
  });
});

// --- the Stripe rail's banners and card ---------------------------------------

describe('the card rail’s banners', () => {
  const ent = { entitledThrough: '2026-10-26T12:00:00Z' };
  /** What billing_rail_json sends for a subscription set to end: no next charge. */
  const ENDING = { ...STRIPE, nextChargeAt: null, cancelAt: '2026-10-20T00:00:00Z' };

  it('says nothing on the manual rail, whatever the flags say', () => {
    expect(railBanners({ ...MANUAL, status: 'past_due', cancelAtPeriodEnd: true }, ent)).toEqual({
      pastDue: null,
      cancelling: null,
    });
  });

  it('says a payment failed and until when the store keeps working', () => {
    const b = railBanners({ ...STRIPE, status: 'past_due', graceUntil: '2026-11-02T12:00:00Z' }, ent);
    expect(b.pastDue).toEqual({ graceUntil: '2026-11-02T12:00:00Z' });
    // Without a stored grace date, the deadline is the store's own (billing_compute includes it).
    expect(railBanners({ ...STRIPE, status: 'past_due' }, ent).pastDue).toEqual({ graceUntil: ent.entitledThrough });
  });

  it('says when a cancelled package ends', () => {
    expect(railBanners({ ...ENDING, cancelAtPeriodEnd: true }, ent).cancelling).toEqual({ on: ENDING.cancelAt });
    expect(railBanners(STRIPE, ent)).toEqual({ pastDue: null, cancelling: null });
  });

  it('never names the deadline as the end date: on the card rail it runs past the period end', () => {
    expect(railBanners({ ...STRIPE, nextChargeAt: null, cancelAtPeriodEnd: true }, ent).cancelling).toEqual({ on: null });
  });

  it('counts a cancel_at date as cancelling, with cancel_at_period_end left false (UIM-4)', () => {
    expect(isCancelling(ENDING)).toBe(true);
    expect(railBanners(ENDING, ent).cancelling).toEqual({ on: ENDING.cancelAt });
    // While the server still schedules a charge (next_charge_at), a cancel_at is not the end yet.
    expect(isCancelling({ ...STRIPE, cancelAt: '2026-12-20T00:00:00Z' })).toBe(false);
    // Past due has its own banner.
    expect(isCancelling({ ...ENDING, status: 'past_due' })).toBe(false);
    expect(isCancelling(STRIPE)).toBe(false);
  });
});

describe('the Billing card', () => {
  it('shows the next charge, or the end date once cancelled', () => {
    expect(nextCharge(STRIPE)).toEqual({ kind: 'charge', at: STRIPE.nextChargeAt, amount: 58 });
    expect(nextCharge({ ...STRIPE, cancelAtPeriodEnd: true, nextChargeAt: null, cancelAt: '2026-10-26T12:00:00Z' })).toEqual({
      kind: 'cancels',
      on: '2026-10-26T12:00:00Z',
    });
    expect(nextCharge({ ...STRIPE, nextChargeAt: null })).toEqual({ kind: 'none' });
  });

  it('shows no charge for a subscription ending on a cancel_at date (UIM-4)', () => {
    expect(nextCharge({ ...STRIPE, nextChargeAt: null, cancelAt: '2026-10-20T00:00:00Z' })).toEqual({
      kind: 'cancels',
      on: '2026-10-20T00:00:00Z',
    });
  });

  it('prints the card the way it is embossed', () => {
    expect(cardBrandName('visa')).toBe('Visa');
    expect(cardBrandName('amex')).toBe('American Express');
    expect(cardBrandName('mastercard')).toBe('Mastercard');
    expect(cardBrandName('some_new_brand')).toBe('Some new brand');
    expect(cardBrandName('unknown')).toBe('');
    expect(cardExpiry({ brand: 'visa', last4: '4242', expMonth: 8, expYear: 2027 })).toBe('08/27');
    expect(cardExpiry({ brand: 'visa', last4: '4242', expMonth: null, expYear: 2027 })).toBeNull();
    expect(cardExpiry({ brand: 'visa', last4: '4242', expMonth: 13, expYear: 2027 })).toBeNull();
  });

  it('warns about a card that expires before the next charge, and only then', () => {
    const card = { brand: 'visa', last4: '4242', expMonth: 10, expYear: 2026 };
    // Good through Oct 31: an Oct 26 charge goes through, a Nov 1 charge does not.
    expect(cardExpiresBefore(card, '2026-10-26T12:00:00Z')).toBe(false);
    expect(cardExpiresBefore(card, '2026-10-31T20:00:00Z')).toBe(false);
    expect(cardExpiresBefore(card, '2026-11-01T12:00:00Z')).toBe(true);
    expect(cardExpiresBefore(null, '2026-11-01T12:00:00Z')).toBe(false);
    expect(cardExpiresBefore(card, null)).toBe(false);
  });

  it('shows what an invoice took, or what is still owed on it', () => {
    const paid = STRIPE.lastInvoice!;
    expect(invoiceAmount(paid)).toBe(228);
    expect(invoiceAmount({ ...paid, status: 'open', amountPaid: 0, amountDue: 58 })).toBe(58);
  });
});

// --- the dashboard -----------------------------------------------------------

describe('the dashboard never says "goes dark" about a package that renews by itself', () => {
  const ent = (days: number, status = 'active', billingRail: 'manual' | 'stripe' = 'manual') => ({
    entitled: true,
    status,
    entitledThrough: iso(NOW + days * DAY),
    billingRail,
    billingEndsAt: null as string | null,
  });
  const card = (days: number, status = 'active') => ent(days, status, 'stripe');
  /** A card restaurant set to end in `endsIn` days, as the entitlements every role reads say it. */
  const ending = (days: number, endsIn: number) => ({ ...card(days), billingEndsAt: iso(NOW + endsIn * DAY) });

  it('counts down the last week on the manual rail, as before', () => {
    expect(dashboardBillingCard({ entitlements: ent(3), billing: MANUAL, nowMs: NOW })).toEqual({
      kind: 'expiry',
      daysLeft: 3,
    });
    expect(dashboardBillingCard({ entitlements: ent(3), billing: null, nowMs: NOW })).toEqual({
      kind: 'expiry',
      daysLeft: 3,
    });
    expect(dashboardBillingCard({ entitlements: ent(30), billing: MANUAL, nowMs: NOW })).toEqual({ kind: 'none' });
  });

  it('drops the countdown for managers of a card restaurant too — the rail comes with the entitlements (UIM-6)', () => {
    // A manager's dashboard never reads the owner's overview: billing is null.
    expect(dashboardBillingCard({ entitlements: card(3), billing: null, nowMs: NOW })).toEqual({ kind: 'none' });
    expect(dashboardBillingCard({ entitlements: card(0), billing: null, nowMs: NOW })).toEqual({ kind: 'none' });
  });

  it('drops it for the owner whose overview says card, even on an entitlements payload without the rail', () => {
    expect(dashboardBillingCard({ entitlements: ent(3), billing: STRIPE, nowMs: NOW })).toEqual({ kind: 'none' });
    // A failed overview read (MANUAL_RAIL) does not bring the countdown back for a card restaurant.
    expect(dashboardBillingCard({ entitlements: card(3), billing: MANUAL, nowMs: NOW })).toEqual({ kind: 'none' });
  });

  it('warns everyone about a failed payment, with the grace date', () => {
    // Staff: from the entitlements alone — past due, the deadline is the end of the grace window.
    expect(dashboardBillingCard({ entitlements: card(5, 'past_due'), billing: null, nowMs: NOW })).toEqual({
      kind: 'paymentFailed',
      graceUntil: iso(NOW + 5 * DAY),
    });
    // Owner: the stored grace date.
    const billing = { ...STRIPE, status: 'past_due', graceUntil: iso(NOW + 4 * DAY) };
    expect(dashboardBillingCard({ entitlements: card(5, 'past_due'), billing, nowMs: NOW })).toEqual({
      kind: 'paymentFailed',
      graceUntil: iso(NOW + 4 * DAY),
    });
    // Even with weeks of grace left: a failed card is worth knowing about now.
    expect(dashboardBillingCard({ entitlements: card(20, 'past_due'), billing: null, nowMs: NOW })).toEqual({
      kind: 'paymentFailed',
      graceUntil: iso(NOW + 20 * DAY),
    });
  });

  it('counts down to the cancel date, not to the deadline that runs past it', () => {
    // The deadline is the period end plus the grace window; the subscription ends at cancel_at.
    const billing = { ...STRIPE, nextChargeAt: null, cancelAtPeriodEnd: true, cancelAt: iso(NOW + 2 * DAY) };
    expect(dashboardBillingCard({ entitlements: card(9), billing, nowMs: NOW })).toEqual({
      kind: 'cancelling',
      on: iso(NOW + 2 * DAY),
      daysLeft: 2,
    });
    expect(
      dashboardBillingCard({ entitlements: card(30), billing: { ...billing, cancelAt: iso(NOW + 20 * DAY) }, nowMs: NOW }),
    ).toEqual({ kind: 'none' });
  });

  it('counts down a cancel_at set without cancel_at_period_end (UIM-4)', () => {
    const billing = { ...STRIPE, nextChargeAt: null, cancelAt: iso(NOW + 3 * DAY) };
    expect(dashboardBillingCard({ entitlements: card(10), billing, nowMs: NOW })).toEqual({
      kind: 'cancelling',
      on: iso(NOW + 3 * DAY),
      daysLeft: 3,
    });
  });

  it('falls back to the deadline for a cancellation Stripe gave no date for', () => {
    const billing = { ...STRIPE, nextChargeAt: null, cancelAtPeriodEnd: true, cancelAt: null };
    expect(dashboardBillingCard({ entitlements: card(4), billing, nowMs: NOW })).toEqual({
      kind: 'cancelling',
      on: iso(NOW + 4 * DAY),
      daysLeft: 4,
    });
  });

  it('shows nothing for a trial or a lapsed store (they have their own screens)', () => {
    expect(expiryDaysLeft(ent(2, 'trialing'), NOW)).toBeNull();
    expect(expiryDaysLeft({ entitled: false, status: 'expired', entitledThrough: null }, NOW)).toBeNull();
    expect(dashboardBillingCard({ entitlements: ent(2, 'trialing'), billing: null, nowMs: NOW })).toEqual({
      kind: 'none',
    });
    const lapsed = { entitled: false, status: 'past_due', entitledThrough: null, billingRail: 'stripe' as const, billingEndsAt: null };
    expect(dashboardBillingCard({ entitlements: lapsed, billing: null, nowMs: NOW })).toEqual({ kind: 'none' });
    expect(
      dashboardBillingCard({ entitlements: { ...lapsed, billingEndsAt: iso(NOW + DAY) }, billing: null, nowMs: NOW }),
    ).toEqual({ kind: 'none' });
  });

  it('warns managers and admins of a card restaurant set to end, from the entitlements alone (ui-rr-3)', () => {
    // Staff never read the owner's overview: billing is null. The deadline runs past the end.
    expect(dashboardBillingCard({ entitlements: ending(9, 3), billing: null, nowMs: NOW })).toEqual({
      kind: 'cancelling',
      on: iso(NOW + 3 * DAY),
      daysLeft: 3,
    });
    expect(dashboardBillingCard({ entitlements: ending(9, 0.5), billing: null, nowMs: NOW })).toEqual({
      kind: 'cancelling',
      on: iso(NOW + 0.5 * DAY),
      daysLeft: 1,
    });
    // Only in its last week, like every other countdown here.
    expect(dashboardBillingCard({ entitlements: ending(30, 20), billing: null, nowMs: NOW })).toEqual({ kind: 'none' });
    // A failed overview read (MANUAL_RAIL) leaves the entitlements' answer standing.
    expect(dashboardBillingCard({ entitlements: ending(9, 3), billing: MANUAL, nowMs: NOW })).toMatchObject({
      kind: 'cancelling',
      daysLeft: 3,
    });
    // A failed payment is the louder card.
    expect(
      dashboardBillingCard({ entitlements: { ...ending(9, 3), status: 'past_due' }, billing: null, nowMs: NOW }),
    ).toMatchObject({ kind: 'paymentFailed' });
    // An end date means nothing to a restaurant on the manual rail, whose own countdown stands.
    expect(
      dashboardBillingCard({ entitlements: { ...ent(3), billingEndsAt: iso(NOW + DAY) }, billing: null, nowMs: NOW }),
    ).toEqual({ kind: 'expiry', daysLeft: 3 });
  });

  it('lets the owner’s overview have the last word, and uses the entitlements’ date when Stripe gave none', () => {
    // The overview says it renews: no card, whatever the entitlements say.
    expect(dashboardBillingCard({ entitlements: ending(9, 3), billing: STRIPE, nowMs: NOW })).toEqual({ kind: 'none' });
    // Ending with no cancel_at: the server's end date before the deadline.
    const noDate = { ...STRIPE, nextChargeAt: null, cancelAtPeriodEnd: true, cancelAt: null };
    expect(dashboardBillingCard({ entitlements: ending(9, 2), billing: noDate, nowMs: NOW })).toEqual({
      kind: 'cancelling',
      on: iso(NOW + 2 * DAY),
      daysLeft: 2,
    });
  });

  it('reads the owner’s overview for a card restaurant, or when it changes the manual card', () => {
    expect(dashboardNeedsRail(card(30), NOW, true)).toBe(true);
    expect(dashboardNeedsRail(ent(3), NOW, true)).toBe(true);
    expect(dashboardNeedsRail(ent(30, 'past_due'), NOW, true)).toBe(true);
    expect(dashboardNeedsRail(ent(30), NOW, true)).toBe(false);
    // Never for anyone else: the overview is the owner's read. They get the rail from the entitlements.
    expect(dashboardNeedsRail(card(3), NOW, false)).toBe(false);
    expect(dashboardNeedsRail({ entitled: false, status: 'expired', entitledThrough: null, billingRail: 'stripe' }, NOW, true)).toBe(false);
  });
});

// --- every new string exists in every language -------------------------------

type Tree = { [key: string]: string | Tree };
const LOCALES = ['en', 'es', 'th', 'vi'] as const;
const messages = (locale: string, file: string): Tree =>
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../../../../../messages', locale, `${file}.json`), 'utf8'),
  ) as Tree;

/** Every leaf key under a tree, dotted. */
const leaves = (tree: Tree, prefix = ''): string[] =>
  Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : leaves(v, `${prefix}${k}.`)));

/** Every dashboard.stripe key page.tsx asks for, with the arguments it passes. */
const DASHBOARD_USED: Array<[string, Record<string, string | number>?]> = [
  ['stripe.paymentFailed.title'],
  ['stripe.paymentFailed.body', { date: '11/2/2026, 12:00 PM' }],
  ['stripe.paymentFailed.bodyNoDate'],
  ['stripe.paymentFailed.bodyStaff', { date: '11/2/2026, 12:00 PM' }],
  ['stripe.paymentFailed.bodyStaffNoDate'],
  ['stripe.paymentFailed.cta'],
  ['stripe.cancelling.titleDays', { date: '10/20/2026', days: 3 }],
  ['stripe.cancelling.titleUnderDay', { date: '10/20/2026' }],
  ['stripe.cancelling.body'],
  ['stripe.cancelling.cta'],
  ['stripe.cancelling.titleDaysStaff', { date: '10/20/2026', days: 3 }],
  ['stripe.cancelling.titleDaysStaff', { date: '10/20/2026', days: 1 }],
  ['stripe.cancelling.titleUnderDayStaff', { date: '10/20/2026' }],
  ['stripe.cancelling.bodyStaff'],
];

describe('the card rail speaks every language', () => {
  it('has the same settings.plan.stripe and dashboard.stripe keys in every locale', () => {
    const en = {
      plan: leaves((messages('en', 'settings').plan as Tree).stripe as Tree).sort(),
      dash: leaves(messages('en', 'dashboard').stripe as Tree).sort(),
    };
    for (const locale of LOCALES) {
      expect(leaves((messages(locale, 'settings').plan as Tree).stripe as Tree).sort(), locale).toEqual(en.plan);
      expect(leaves(messages(locale, 'dashboard').stripe as Tree).sort(), locale).toEqual(en.dash);
    }
  });

  for (const locale of LOCALES) {
    it(`renders every dashboard card key in ${locale}`, () => {
      const t = createTranslator({
        locale,
        messages: { dashboard: messages(locale, 'dashboard') },
        namespace: 'dashboard',
        onError: (error) => {
          throw error;
        },
      }) as unknown as (key: string, values?: Record<string, string | number>) => string;
      for (const [key, values] of DASHBOARD_USED) {
        expect(t(key, values), `${locale}: ${key}`).toBeTruthy();
      }
    });

    it(`names every invoice status in ${locale}`, () => {
      const t = createTranslator({
        locale,
        messages: { settings: messages(locale, 'settings') },
        namespace: 'settings.plan.stripe',
        onError: (error) => {
          throw error;
        },
      }) as unknown as (key: string, values?: Record<string, string | number>) => string;
      const seen = new Set<string>();
      for (const status of ['paid', 'open', 'uncollectible', 'void', 'draft']) {
        const text = t(`invoiceStatus.${invoiceStatusKey(status)}`);
        expect(text, `${locale}: ${status}`).toBeTruthy();
        expect(text).not.toContain('{');
        seen.add(text);
      }
      // Paid and unpaid must never read the same.
      expect(t('invoiceStatus.paid')).not.toBe(t('invoiceStatus.open'));
      expect(seen.size).toBeGreaterThanOrEqual(3);
    });
  }
});
