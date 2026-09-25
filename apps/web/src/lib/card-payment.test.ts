import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CARD_PAYMENT_TIME_TO_PAY_MINUTES,
  cardFailureReasonKey,
  cardPaymentDeadline,
  cardPaymentErrorCode,
  cardPaymentView,
  cardRefundTotals,
  cardRefusalKey,
  forgetCartToClear,
  minutesLeftToPay,
  readPaymentReturn,
  rememberCardError,
  rememberCartToClear,
  stripeLocale,
  takeCardError,
  takeCartToClear,
  toCents,
  type CardRefundTotals,
} from './card-payment';

const MIN = 60_000;
const CREATED = '2026-09-24T12:00:00.000Z';
const T0 = Date.parse(CREATED);

describe('toCents', () => {
  it('counts dollars as Stripe does', () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(0)).toBe(0);
    expect(toCents(-3)).toBe(0);
    expect(toCents(Number.NaN)).toBe(0);
  });
});

describe('cardPaymentErrorCode', () => {
  const thrown = (status: number, body: unknown) => `card_payment_failed:${status}:${JSON.stringify(body)}`;

  it('reads the function’s refusal code', () => {
    expect(cardPaymentErrorCode(thrown(409, { error: 'card_not_ready' }))).toBe('card_not_ready');
    expect(cardPaymentErrorCode(thrown(409, { error: 'already_paid', state: 'paid' }))).toBe('already_paid');
    expect(cardPaymentErrorCode(thrown(403, { error: 'feature_not_entitled', feature: 'card_payment' }))).toBe(
      'feature_not_entitled:card_payment',
    );
  });

  it('is null for anything that is not one', () => {
    expect(cardPaymentErrorCode('TypeError: Failed to fetch')).toBeNull();
    expect(cardPaymentErrorCode('card_payment_failed:502:<html>Bad gateway</html>')).toBeNull();
  });
});

describe('cardRefusalKey / cardFailureReasonKey', () => {
  it('says "not available here" for what the diner cannot fix', () => {
    for (const code of ['card_not_ready', 'stripe_not_configured', 'feature_not_entitled:card_payment']) {
      expect(cardRefusalKey(code)).toBe('unavailable');
    }
    expect(cardRefusalKey('payment_window_expired')).toBe('expired');
    expect(cardRefusalKey('order_not_payable')).toBe('notPayable');
    expect(cardRefusalKey('payment_in_progress')).toBe('inProgress');
    expect(cardRefusalKey(null)).toBe('generic');
    expect(cardRefusalKey('stripe_error')).toBe('generic');
  });

  it('names a decline in the diner’s terms', () => {
    expect(cardFailureReasonKey('insufficient_funds')).toBe('insufficientFunds');
    expect(cardFailureReasonKey('card_declined')).toBe('declined');
    expect(cardFailureReasonKey('generic_decline')).toBe('declined');
    expect(cardFailureReasonKey('expired_card')).toBe('expired');
    expect(cardFailureReasonKey('incorrect_cvc')).toBe('cvc');
    expect(cardFailureReasonKey('payment_intent_authentication_failure')).toBe('authentication');
    expect(cardFailureReasonKey(null)).toBe('generic');
    expect(cardFailureReasonKey('something_new')).toBe('generic');
  });
});

describe('the time to pay', () => {
  it('runs to the payment cut-off, 28 minutes from the order, not to the 30-minute expiry', () => {
    expect(CARD_PAYMENT_TIME_TO_PAY_MINUTES).toBe(28);
    expect(cardPaymentDeadline(CREATED)).toBe(T0 + 28 * MIN);
    expect(minutesLeftToPay(CREATED, T0)).toBe(28);
    expect(minutesLeftToPay(CREATED, T0 + 27.5 * MIN)).toBe(1);
    expect(minutesLeftToPay(CREATED, T0 + 28 * MIN)).toBe(0);
    expect(minutesLeftToPay(CREATED, T0 + 29 * MIN)).toBe(0);
    expect(minutesLeftToPay(CREATED, T0 + 90 * MIN)).toBe(0);
    expect(minutesLeftToPay('not a date', T0)).toBe(0);
  });
});

describe('cardPaymentView', () => {
  const view = (over: Partial<Parameters<typeof cardPaymentView>[0]> = {}) =>
    cardPaymentView({
      orderStatus: 'pending',
      awaitingPayment: true,
      paymentStatus: 'pending',
      hasStripeAccount: true,
      state: null,
      createdAt: CREATED,
      nowMs: T0 + 5 * MIN,
      ...over,
    });

  const totals = (over: Partial<CardRefundTotals> = {}): CardRefundTotals => ({
    refundedCents: 0,
    pendingCents: 0,
    failedCents: 0,
    ...over,
  });

  it('offers the payment while the order waits for it', () => {
    expect(view()).toBe('pay');
    expect(view({ state: 'awaiting' })).toBe('pay');
  });

  it('says paid as soon as either side knows', () => {
    expect(view({ paymentStatus: 'completed' })).toBe('paid');
    expect(view({ state: 'paid' })).toBe('paid');
    // The webhook released the order before this page heard back.
    expect(view({ awaitingPayment: false, orderStatus: 'confirmed' })).toBe('paid');
  });

  it('shows a decline with the retry, and a payment in flight as processing', () => {
    expect(view({ state: 'failed' })).toBe('failed');
    expect(view({ paymentStatus: 'failed' })).toBe('failed');
    expect(view({ state: 'processing' })).toBe('processing');
  });

  it('stops offering the payment once the time is up', () => {
    // At the cut-off, not two minutes later when the expiry job cancels the order: the payment
    // function refuses a new attempt from 28 minutes on.
    expect(view({ nowMs: T0 + 27.5 * MIN })).toBe('pay');
    expect(view({ nowMs: T0 + 28 * MIN })).toBe('expired');
    expect(view({ nowMs: T0 + 29 * MIN, state: 'failed' })).toBe('expired');
    expect(view({ nowMs: T0 + 31 * MIN })).toBe('expired');
    expect(view({ nowMs: T0 + 31 * MIN, state: 'failed' })).toBe('expired');
    // A payment Stripe is still taking is not cut off by the clock.
    expect(view({ nowMs: T0 + 31 * MIN, state: 'processing' })).toBe('processing');
  });

  it('leaves a cancelled order with nothing refunded to the cancellation notice', () => {
    expect(view({ orderStatus: 'cancelled' })).toBe('closed');
    expect(view({ orderStatus: 'refunded', awaitingPayment: false })).toBe('closed');
    // Paid, but the refunds have not been read yet: never "Paid" on a closed order.
    expect(view({ orderStatus: 'cancelled', paymentStatus: 'completed', state: 'paid' })).toBe('closed');
    // A dispute took the money back through the bank, so there is no refund to announce.
    expect(view({ orderStatus: 'cancelled', paymentStatus: 'completed', refunds: totals() })).toBe('closed');
  });

  it('tells the diner their card is being refunded when the restaurant cancels a paid order', () => {
    // stripe-refund's cancel mode records the refund before the order closes: pending first,
    // succeeded once Stripe confirms it.
    expect(
      view({ orderStatus: 'cancelled', awaitingPayment: false, paymentStatus: 'completed', refunds: totals({ pendingCents: 2450 }) }),
    ).toBe('refunding');
    expect(
      view({ orderStatus: 'cancelled', awaitingPayment: false, paymentStatus: 'refunded', refunds: totals({ refundedCents: 2450 }) }),
    ).toBe('refunded');
    expect(view({ orderStatus: 'refunded', awaitingPayment: false, refunds: totals({ refundedCents: 2450 }) })).toBe('refunded');
    // A payment that landed after the order expired, refunded by the Connect webhook.
    expect(view({ orderStatus: 'cancelled', paymentStatus: 'completed', state: 'paid', refunds: totals({ pendingCents: 900 }) })).toBe(
      'refunding',
    );
  });

  it('says so when the refund of a closed order failed, and not when a later one went through', () => {
    expect(view({ orderStatus: 'cancelled', awaitingPayment: false, refunds: totals({ failedCents: 2450 }) })).toBe('refundFailed');
    expect(
      view({ orderStatus: 'cancelled', awaitingPayment: false, refunds: totals({ failedCents: 2450, refundedCents: 2450 }) }),
    ).toBe('refunded');
  });

  it('stops saying "Paid" once the whole payment was refunded on an open order', () => {
    // A full refund made in the branch's Stripe Dashboard marks the payment refunded but leaves
    // the order as it was; the status check still answers state 'paid' for it.
    const open = { orderStatus: 'completed', awaitingPayment: false, total: 24.5 };
    expect(view({ ...open, paymentStatus: 'refunded' })).toBe('refunded');
    expect(view({ ...open, paymentStatus: 'refunded', state: 'paid' })).toBe('refunded');
    expect(view({ ...open, paymentStatus: 'completed', refunds: totals({ refundedCents: 2450 }) })).toBe('refunded');
    expect(view({ ...open, paymentStatus: 'completed', refunds: totals({ pendingCents: 2450 }) })).toBe('refunding');
    // Part of it back is still a paid order; the box adds a line for the part.
    expect(view({ ...open, paymentStatus: 'completed', refunds: totals({ refundedCents: 500 }) })).toBe('paid');
    // A card from before online payments has no Stripe refund to speak of.
    expect(view({ ...open, hasStripeAccount: false, paymentStatus: 'completed', refunds: totals({ refundedCents: 2450 }) })).toBe('paid');
  });

  it('tells an order from before online card payments to pay the restaurant', () => {
    expect(view({ hasStripeAccount: false, awaitingPayment: false })).toBe('payAtRestaurant');
    expect(view({ hasStripeAccount: false, awaitingPayment: false, orderStatus: 'completed' })).toBe('closed');
    expect(view({ hasStripeAccount: false, paymentStatus: 'completed' })).toBe('paid');
  });
});

describe('cardRefundTotals', () => {
  it('adds the diner’s refunds up by Stripe status, in cents', () => {
    expect(
      cardRefundTotals([
        { amount: '10.10', status: 'succeeded' },
        { amount: 2.2, status: 'succeeded' },
        { amount: '4.00', status: 'pending' },
        { amount: '3.00', status: 'failed' },
        { amount: '1.00', status: 'canceled' },
      ]),
    ).toEqual({ refundedCents: 1230, pendingCents: 400, failedCents: 400 });
  });

  it('reads nothing as nothing', () => {
    expect(cardRefundTotals(null)).toEqual({ refundedCents: 0, pendingCents: 0, failedCents: 0 });
    expect(cardRefundTotals([{ amount: 'abc', status: 'succeeded' }, { amount: '5', status: 'unknown' }])).toEqual({
      refundedCents: 0,
      pendingCents: 0,
      failedCents: 0,
    });
  });
});

describe('readPaymentReturn', () => {
  it('reads Stripe’s return and the checkout’s own marker', () => {
    expect(
      readPaymentReturn(
        new URLSearchParams('payment_intent=pi_3Nabc&payment_intent_client_secret=pi_3Nabc_secret_x&redirect_status=succeeded'),
      ),
    ).toEqual({ paymentIntent: 'pi_3Nabc', redirectStatus: 'succeeded', checkoutFailed: false });
    expect(readPaymentReturn(new URLSearchParams('card=retry'))).toEqual({
      paymentIntent: null,
      redirectStatus: null,
      checkoutFailed: true,
    });
  });

  it('ignores a payment_intent that is not one', () => {
    expect(readPaymentReturn(new URLSearchParams('payment_intent=<script>')).paymentIntent).toBeNull();
    expect(readPaymentReturn(null)).toEqual({ paymentIntent: null, redirectStatus: null, checkoutFailed: false });
  });
});

describe('stripeLocale', () => {
  it('passes the four storefront languages through and falls back to English', () => {
    expect(stripeLocale('th')).toBe('th');
    expect(stripeLocale('es')).toBe('es');
    expect(stripeLocale('vi')).toBe('vi');
    expect(stripeLocale('en')).toBe('en');
    expect(stripeLocale('fr')).toBe('en');
  });
});

describe('handing the order from the checkout to its order page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('empties the cart once, for the order the checkout noted', () => {
    rememberCartToClear('branch-1', 'A-2609-0001');
    expect(takeCartToClear('branch-1', 'A-2609-0002')).toBe(false);
    expect(takeCartToClear('branch-2', 'A-2609-0001')).toBe(false);
    expect(takeCartToClear('branch-1', 'A-2609-0001')).toBe(true);
    expect(takeCartToClear('branch-1', 'A-2609-0001')).toBe(false);
  });

  it('forgets the note when the checkout emptied the cart itself', () => {
    rememberCartToClear('branch-1', 'A-2609-0001');
    forgetCartToClear('branch-1');
    expect(takeCartToClear('branch-1', 'A-2609-0001')).toBe(false);
  });

  it('carries Stripe’s message for a failed card to the order page, once', () => {
    rememberCardError('order-1', 'Your card was declined.');
    expect(takeCardError('order-2')).toBeNull();
    expect(takeCardError('order-1')).toBe('Your card was declined.');
    expect(takeCardError('order-1')).toBeNull();
  });

  it('never throws when storage is switched off', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => rememberCartToClear('branch-1', 'A-1')).not.toThrow();
    expect(takeCartToClear('branch-1', 'A-1')).toBe(false);
    expect(() => rememberCardError('order-1', 'x')).not.toThrow();
    expect(takeCardError('order-1')).toBeNull();
  });
});

describe('the card payment copy', () => {
  const MESSAGES = path.resolve(__dirname, '../../messages');
  const LOCALES = ['en', 'es', 'th', 'vi'];
  const read = (locale: string, ns: string) =>
    JSON.parse(fs.readFileSync(path.join(MESSAGES, locale, `${ns}.json`), 'utf8')) as Record<string, unknown>;
  const at = (obj: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
  const keysOf = (obj: unknown, prefix = ''): string[] =>
    obj && typeof obj === 'object'
      ? Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k))
      : [prefix];

  // Everything the order page and the checkout can say about a card, including every reason and
  // refusal the key functions above can return.
  const REASONS = ['declined', 'insufficientFunds', 'expired', 'cvc', 'number', 'authentication', 'processing', 'generic'];
  const REFUSALS = ['unavailable', 'expired', 'notPayable', 'tooSmall', 'inProgress', 'generic'];
  const TRACKING = [
    'payTitle', 'payBody', 'payNow', 'preparing', 'checking', 'paidTitle', 'paidBody', 'processingTitle',
    'processingBody', 'failedTitle', 'failedBody', 'expiredTitle', 'expiredBody', 'payAtRestaurantTitle',
    'payAtRestaurantBody', 'refundedTitle', 'refundedBody', 'refundingTitle', 'refundingBody',
    'refundFailedTitle', 'refundFailedBody', 'partlyRefunded', 'retry', 'securedNote',
    ...REASONS.map((k) => `reasons.${k}`),
    ...REFUSALS.map((k) => `errors.${k}`),
  ];
  const CHECKOUT = ['loading', 'securedNote', 'notReady', 'checkDetails', 'loadFailedChooseOther', 'loadFailedOnly'];
  const ERRORS = ['cardNotConfigured', 'cardAmountTooSmall', 'cardSetupFailed'];

  it('covers every reason and refusal the helpers can name', () => {
    for (const code of ['insufficient_funds', 'card_declined', 'expired_card', 'incorrect_cvc', 'invalid_number', 'authentication_required', 'processing_error', null]) {
      expect(REASONS).toContain(cardFailureReasonKey(code));
    }
    for (const code of ['card_not_ready', 'payment_window_expired', 'order_not_payable', 'amount_too_small', 'payment_in_progress', null]) {
      expect(REFUSALS).toContain(cardRefusalKey(code));
    }
  });

  it.each(LOCALES)('is written out in %s', (locale) => {
    const tracking = read(locale, 'tracking');
    const checkout = read(locale, 'checkout');
    const errors = read(locale, 'errors');
    for (const key of TRACKING) {
      const value = at(tracking, `cardPayment.${key}`);
      expect(typeof value === 'string' && value.trim().length > 0, `${locale} tracking.cardPayment.${key}`).toBe(true);
    }
    for (const key of CHECKOUT) {
      const value = at(checkout, `card.${key}`);
      expect(typeof value === 'string' && value.trim().length > 0, `${locale} checkout.card.${key}`).toBe(true);
    }
    for (const key of ERRORS) {
      const value = at(errors, `order.${key}`);
      expect(typeof value === 'string' && value.trim().length > 0, `${locale} errors.order.${key}`).toBe(true);
    }
    // The old "card is not available here" notice and its dev-only mock button are gone.
    expect(at(tracking, 'cardPayment.devConfirm')).toBeUndefined();
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('has the same card keys in %s as in English', (locale) => {
    expect(keysOf(at(read(locale, 'tracking'), 'cardPayment')).sort()).toEqual(
      keysOf(at(read('en', 'tracking'), 'cardPayment')).sort(),
    );
    expect(keysOf(at(read(locale, 'checkout'), 'card')).sort()).toEqual(keysOf(at(read('en', 'checkout'), 'card')).sort());
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('is actually translated in %s', (locale) => {
    for (const key of TRACKING) {
      expect(at(read(locale, 'tracking'), `cardPayment.${key}`), `${locale} ${key}`).not.toBe(
        at(read('en', 'tracking'), `cardPayment.${key}`),
      );
    }
  });
});
