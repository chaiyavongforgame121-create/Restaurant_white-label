import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeServiceFee, SERVICE_FEE_MAX_PERCENT as SHARED_FEE_CAP } from '@favornoms/shared';
import * as card from '../../../../supabase/functions/place-order/card';
import * as logic from '../../../../supabase/functions/stripe-create-payment-intent/logic';
import {
  CARD_MIN_CHARGE_CENTS,
  CARD_PAYMENT_CUTOFF_MARGIN_MINUTES,
  CARD_PAYMENT_METHOD_TYPES,
  CARD_PAYMENT_WINDOW_MINUTES,
  minutesLeftToPay,
} from './card-payment';

/**
 * The edge functions' card rules, pinned from here because a Deno function cannot run under this
 * app's test runner but a module with no imports can: supabase/functions/place-order/card.ts and
 * supabase/functions/stripe-create-payment-intent/logic.ts import nothing for exactly this reason.
 *
 * What is at stake: the diner's money goes to the branch's own Stripe account, for exactly the
 * order's total, once. Each rule below is one way that could go wrong.
 */

const MIN = 60_000;
const NOW = Date.parse('2026-09-24T12:00:00Z');
const ACCT = 'acct_1Q2w3E4r5T6y7U8i';

describe('place-order: the card rules', () => {
  it('caps the card fee at the shared ceiling, 3%', () => {
    expect(card.SERVICE_FEE_MAX_PERCENT).toBe(SHARED_FEE_CAP);
    expect(card.SERVICE_FEE_MAX_PERCENT).toBe(3);
  });

  it('reads a branch stored above the cap as the cap, and anything unreadable as nothing', () => {
    expect(card.serviceFeePercentOf({ service_fee_percent: 5 })).toBe(3);
    expect(card.serviceFeePercentOf({ service_fee_percent: 25 })).toBe(3);
    expect(card.serviceFeePercentOf({ service_fee_percent: '2.5' })).toBe(2.5);
    expect(card.serviceFeePercentOf({ service_fee_percent: 'abc' })).toBe(0);
    expect(card.serviceFeePercentOf({ service_fee_percent: -1 })).toBe(0);
    expect(card.serviceFeePercentOf({})).toBe(0);
  });

  it('prices the fee exactly as the checkout quotes it (computeServiceFee)', () => {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    for (const pct of [0, 1, 2.5, 3, 5, 25]) {
      for (const subtotal of [12.34, 34.85, 100]) {
        const server = r2(subtotal * (card.serviceFeePercentOf({ service_fee_percent: pct }) / 100));
        expect(server, `${pct}% of ${subtotal}`).toBe(computeServiceFee(subtotal, pct, 'card'));
      }
    }
  });

  it('treats only a storefront card as a Stripe card; a till card is a terminal sale', () => {
    expect(card.isStorefrontCard('card', false)).toBe(true);
    expect(card.isStorefrontCard('card', true)).toBe(false);
    expect(card.isStorefrontCard('cash', false)).toBe(false);
    expect(card.isStorefrontCard('transfer', false)).toBe(false);
  });

  it('accepts a card only where the branch account can take charges', () => {
    expect(card.readyStripeAccount({ stripe_account_id: ACCT, charges_enabled: true })).toBe(ACCT);
    expect(card.readyStripeAccount({ stripe_account_id: ACCT, charges_enabled: false })).toBeNull();
    expect(card.readyStripeAccount({ stripe_account_id: ACCT, charges_enabled: null })).toBeNull();
    expect(card.readyStripeAccount({ stripe_account_id: null, charges_enabled: true })).toBeNull();
    // Anything that is not an account id is never sent to Stripe as one.
    expect(card.readyStripeAccount({ stripe_account_id: 'acct_', charges_enabled: true })).toBeNull();
    expect(card.readyStripeAccount({ stripe_account_id: 'cus_123', charges_enabled: true })).toBeNull();
    expect(card.readyStripeAccount({ stripe_account_id: 'acct_1 OR 1=1', charges_enabled: true })).toBeNull();
    expect(card.readyStripeAccount(null)).toBeNull();
    expect(card.readyStripeAccount(undefined)).toBeNull();
  });

  it('holds a storefront card order off the kitchen board until it is paid, as a transfer', () => {
    expect(card.orderAwaitsPayment('card', false, 20)).toBe(true);
    expect(card.orderAwaitsPayment('transfer', false, 20)).toBe(true);
    expect(card.orderAwaitsPayment('transfer', true, 20)).toBe(true);
    // The till took the card on its terminal; the sale is recorded straight after.
    expect(card.orderAwaitsPayment('card', true, 20)).toBe(false);
    expect(card.orderAwaitsPayment('cash', false, 20)).toBe(false);
    // Nothing to pay has no payment row to release it.
    expect(card.orderAwaitsPayment('card', false, 0)).toBe(false);
    expect(card.orderAwaitsPayment('transfer', false, 0)).toBe(false);
  });

  it('refuses a storefront card order under Stripe’s 50-cent minimum, and only that', () => {
    expect(card.cardTotalTooSmall(true, 0.49)).toBe(true);
    expect(card.cardTotalTooSmall(true, 0.01)).toBe(true);
    expect(card.cardTotalTooSmall(true, 0.5)).toBe(false);
    expect(card.cardTotalTooSmall(true, 0)).toBe(false);
    expect(card.cardTotalTooSmall(false, 0.2)).toBe(false);
    expect(Math.round(card.CARD_MIN_CHARGE * 100)).toBe(logic.STRIPE_MIN_CHARGE_CENTS);
    expect(CARD_MIN_CHARGE_CENTS).toBe(logic.STRIPE_MIN_CHARGE_CENTS);
  });

  it('labels only a storefront card payment as Stripe, with the account it will be charged on', () => {
    expect(card.pendingPaymentGateway(true, ACCT)).toEqual({
      gateway: 'stripe',
      gateway_metadata: { pending: true, stripe_account: ACCT },
    });
    expect(card.pendingPaymentGateway(false, null)).toEqual({ gateway: null, gateway_metadata: { pending: true } });
  });
});

describe('stripe-create-payment-intent: amounts', () => {
  it('turns a total into whole cents without float drift', () => {
    expect(logic.toCents(19.99)).toBe(1999);
    expect(logic.toCents(0.1 + 0.2)).toBe(30);
    expect(logic.toCents(55.97)).toBe(5597);
    expect(logic.toCents('1234.56')).toBe(123456);
    expect(logic.toCents(0)).toBe(0);
  });

  it('never turns a malformed total into a charge', () => {
    expect(logic.toCents(-1)).toBeNull();
    expect(logic.toCents(Number.NaN)).toBeNull();
    expect(logic.toCents(Infinity)).toBeNull();
    expect(logic.toCents('abc')).toBeNull();
    expect(logic.toCents(null)).toBeNull();
    expect(logic.toCents(undefined)).toBeNull();
  });
});

describe('stripe-create-payment-intent: who may be charged', () => {
  const order = (over: Partial<logic.GateOrder> = {}): logic.GateOrder => ({
    status: 'pending',
    awaiting_payment: true,
    created_at: new Date(NOW - 5 * MIN).toISOString(),
    total: 21.4,
    ...over,
  });
  const payment = (over: Partial<logic.GatePayment> = {}): logic.GatePayment => ({
    method: 'card',
    status: 'pending',
    gateway: 'stripe',
    ...over,
  });
  const account = (over: Partial<logic.GateAccount> = {}): logic.GateAccount => ({
    stripe_account_id: ACCT,
    charges_enabled: true,
    ...over,
  });
  const refusal = (o: logic.GateOrder, p: logic.GatePayment | null, a: logic.GateAccount | null, nowMs = NOW) =>
    logic.cardPaymentRefusal({ order: o, payment: p, account: a, nowMs });

  it('lets an unpaid storefront card order be paid', () => {
    expect(refusal(order(), payment(), account())).toBeNull();
  });

  it('lets a declined attempt be retried', () => {
    expect(refusal(order(), payment({ status: 'failed' }), account())).toBeNull();
  });

  it('says a paid order is paid before anything else', () => {
    expect(refusal(order({ status: 'confirmed', awaiting_payment: false }), payment({ status: 'completed' }), null)).toBe(
      'already_paid',
    );
  });

  it('refuses an order that has left pending (cancelled, expired, refunded, cooking)', () => {
    for (const status of ['cancelled', 'refunded', 'confirmed', 'preparing', 'completed']) {
      expect(refusal(order({ status }), payment(), account()), status).toBe('order_not_payable');
    }
  });

  it('refuses anything that is not a pending Stripe card payment', () => {
    expect(refusal(order(), null, account())).toBe('not_awaiting_card_payment');
    expect(refusal(order(), payment({ method: 'cash' }), account())).toBe('not_awaiting_card_payment');
    // A counter card sale: no gateway, taken on a terminal.
    expect(refusal(order(), payment({ gateway: null }), account())).toBe('not_awaiting_card_payment');
    expect(refusal(order(), payment({ status: 'refunded' }), account())).toBe('not_awaiting_card_payment');
    expect(refusal(order(), payment({ status: 'voided' }), account())).toBe('not_awaiting_card_payment');
    // An order the kitchen can already see was never waiting for this money.
    expect(refusal(order({ awaiting_payment: false }), payment(), account())).toBe('not_awaiting_card_payment');
  });

  it('stops offering a payment shortly before the expiry job cancels the order', () => {
    const at = (minutesOld: number) => order({ created_at: new Date(NOW - minutesOld * MIN).toISOString() });
    expect(refusal(at(27), payment(), account())).toBeNull();
    expect(refusal(at(28), payment(), account())).toBe('payment_window_expired');
    expect(refusal(at(45), payment(), account())).toBe('payment_window_expired');
    expect(refusal(order({ created_at: 'not a date' }), payment(), account())).toBe('payment_window_expired');
    expect(logic.CARD_PAYMENT_WINDOW_MINUTES).toBe(CARD_PAYMENT_WINDOW_MINUTES);
    expect(logic.CARD_PAYMENT_CUTOFF_MARGIN_MINUTES).toBe(CARD_PAYMENT_CUTOFF_MARGIN_MINUTES);
  });

  it('ends the order page countdown exactly where the function stops taking payments', () => {
    // A live timer over a form the function refuses is what the diner must never see, and a
    // timer that runs out while the function would still take the payment loses the sale.
    const created = new Date(NOW - 0).toISOString();
    for (const minutesLater of [0, 1, 27, 27.5, 27.99, 28, 28.01, 29, 30, 45]) {
      const at = NOW + minutesLater * MIN;
      expect(minutesLeftToPay(created, at) > 0).toBe(logic.withinPaymentWindow(created, at));
    }
  });

  it('never charges without a branch account that can take charges', () => {
    expect(refusal(order(), payment(), null)).toBe('card_not_ready');
    expect(refusal(order(), payment(), account({ charges_enabled: false }))).toBe('card_not_ready');
    expect(refusal(order(), payment(), account({ stripe_account_id: null }))).toBe('card_not_ready');
    expect(refusal(order(), payment(), account({ stripe_account_id: 'acct_x y' }))).toBe('card_not_ready');
  });

  it('refuses a total Stripe cannot charge', () => {
    expect(refusal(order({ total: 0.49 }), payment(), account())).toBe('amount_too_small');
    expect(refusal(order({ total: 'garbage' }), payment(), account())).toBe('amount_too_small');
    expect(refusal(order({ total: 0.5 }), payment(), account())).toBeNull();
  });

  it('answers each refusal with a conflict, except an amount the request can never meet', () => {
    expect(logic.GATE_STATUS.amount_too_small).toBe(400);
    for (const code of ['already_paid', 'order_not_payable', 'not_awaiting_card_payment', 'payment_window_expired', 'card_not_ready'] as const) {
      expect(logic.GATE_STATUS[code]).toBe(409);
    }
  });
});

describe('stripe-create-payment-intent: one payment, one PaymentIntent', () => {
  it('keys a payment on an account to the same intent every time', () => {
    const a = logic.paymentIntentIdempotencyKey('pay-1', ACCT);
    expect(logic.paymentIntentIdempotencyKey('pay-1', ACCT)).toBe(a);
    expect(logic.paymentIntentIdempotencyKey('pay-2', ACCT)).not.toBe(a);
    expect(logic.paymentIntentIdempotencyKey('pay-1', 'acct_Other123')).not.toBe(a);
  });

  const expected: logic.ExpectedCharge = { cents: 2140, orderId: 'order-1', paymentId: 'pay-1' };
  const intent = (over: Partial<logic.IntentSnapshot> = {}): logic.IntentSnapshot => ({
    id: 'pi_123',
    status: 'requires_payment_method',
    amount: 2140,
    currency: 'usd',
    metadata: { order_id: 'order-1', payment_id: 'pay-1' },
    last_payment_error: null,
    ...over,
  });

  it('matches an intent to its payment on amount, currency, order and payment', () => {
    expect(logic.intentMatches(intent(), expected)).toBe(true);
    expect(logic.intentMatches(intent({ amount: 2141 }), expected)).toBe(false);
    expect(logic.intentMatches(intent({ currency: 'eur' }), expected)).toBe(false);
    expect(logic.intentMatches(intent({ metadata: { order_id: 'order-1', payment_id: 'pay-9' } }), expected)).toBe(false);
    expect(logic.intentMatches(intent({ metadata: { order_id: 'order-9', payment_id: 'pay-1' } }), expected)).toBe(false);
    expect(logic.intentMatches(intent({ metadata: null }), expected)).toBe(false);
  });

  it('hands the same intent out again while it can still be confirmed', () => {
    for (const status of ['requires_payment_method', 'requires_confirmation', 'requires_action']) {
      expect(logic.decideExistingIntent(intent({ status }), expected), status).toBe('reuse');
    }
  });

  it('records money Stripe already took instead of charging again', () => {
    expect(logic.decideExistingIntent(intent({ status: 'succeeded' }), expected)).toBe('succeeded');
  });

  it('waits on a payment in flight instead of starting another', () => {
    expect(logic.decideExistingIntent(intent({ status: 'processing' }), expected)).toBe('processing');
    expect(logic.decideExistingIntent(intent({ status: 'requires_capture' }), expected)).toBe('processing');
  });

  it('never makes a second intent: a cancelled one ends the payment', () => {
    // Replacing it would race the canceled event, which voids the payment the new intent needs.
    expect(logic.decideExistingIntent(intent({ status: 'canceled' }), expected)).toBe('canceled');
    expect(logic.decideExistingIntent(intent({ status: 'canceled', amount: 1 }), expected)).toBe('canceled');
  });

  it('refuses an intent that is not this payment’s rather than recording or reusing it', () => {
    expect(logic.decideExistingIntent(intent({ amount: 999 }), expected)).toBe('mismatch');
    expect(logic.decideExistingIntent(intent({ status: 'succeeded', amount: 1 }), expected)).toBe('mismatch');
    expect(logic.decideExistingIntent(intent({ status: 'processing', currency: 'eur' }), expected)).toBe('mismatch');
    expect(
      logic.decideExistingIntent(intent({ metadata: { order_id: 'order-1', payment_id: 'pay-other' } }), expected),
    ).toBe('mismatch');
    expect(logic.decideExistingIntent(intent({ status: 'something_new' }), expected)).toBe('mismatch');
  });

  it('says paid only once the payment row is completed', () => {
    const succeeded = { status: 'succeeded', last_payment_error: null };
    expect(logic.dinerStateAfterApply(succeeded, { ok: true, status: 'completed', order_status: 'confirmed' })).toBe('paid');
    // Stripe has it, the database could not record it yet: ask again, the webhook records it.
    expect(logic.dinerStateAfterApply(succeeded, null)).toBe('processing');
    expect(logic.dinerStateAfterApply(succeeded, { ok: false, error: 'payment_not_found' })).toBe('processing');
    // Money for an order that expired first goes back; it is not a payment for this order.
    expect(
      logic.dinerStateAfterApply(succeeded, { ok: true, status: 'completed', order_status: 'cancelled', action: 'refund_required' }),
    ).toBe('canceled');
  });

  it('reads anything short of a success from Stripe’s own status', () => {
    expect(
      logic.dinerStateAfterApply(
        { status: 'requires_payment_method', last_payment_error: { code: 'card_declined' } },
        { ok: true, status: 'failed' },
      ),
    ).toBe('failed');
    expect(logic.dinerStateAfterApply({ status: 'processing' }, { ok: true, status: 'pending' })).toBe('processing');
    expect(logic.dinerStateAfterApply({ status: 'requires_action' }, { ok: true, status: 'pending' })).toBe('awaiting');
  });
});

describe('stripe-create-payment-intent: what the diner is told', () => {
  it('reads Stripe’s status in the storefront’s words', () => {
    expect(logic.dinerPaymentState({ status: 'succeeded' })).toBe('paid');
    expect(logic.dinerPaymentState({ status: 'processing' })).toBe('processing');
    expect(logic.dinerPaymentState({ status: 'requires_capture' })).toBe('processing');
    expect(logic.dinerPaymentState({ status: 'canceled' })).toBe('canceled');
    expect(logic.dinerPaymentState({ status: 'requires_action' })).toBe('awaiting');
    // A fresh intent and a declined one share a status; only the decline carries an error.
    expect(logic.dinerPaymentState({ status: 'requires_payment_method' })).toBe('awaiting');
    expect(
      logic.dinerPaymentState({ status: 'requires_payment_method', last_payment_error: { code: 'card_declined' } }),
    ).toBe('failed');
  });

  it('gives the network’s decline code before Stripe’s error code', () => {
    expect(
      logic.failureCode({ last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } }),
    ).toBe('insufficient_funds');
    expect(logic.failureCode({ last_payment_error: { code: 'expired_card' } })).toBe('expired_card');
    expect(logic.failureCode({ last_payment_error: null })).toBeNull();
  });
});

describe('stripe-create-payment-intent: the PaymentIntent it asks Stripe for', () => {
  const params = logic.paymentIntentParams({
    cents: 2140,
    orderId: 'order-1',
    orderNumber: 'A-2609-0005',
    paymentId: 'pay-1',
    branchId: 'branch-1',
  });

  it('charges exactly the order’s total in dollars', () => {
    expect(params.get('amount')).toBe('2140');
    expect(params.get('currency')).toBe('usd');
    expect(params.get('metadata[order_id]')).toBe('order-1');
    expect(params.get('metadata[payment_id]')).toBe('pay-1');
    expect(params.get('metadata[branch_id]')).toBe('branch-1');
    expect(params.get('description')).toBe('Order A-2609-0005');
  });

  // A bank debit (ACH) stays 'processing' for days; left to the connected account's own settings a
  // full-Dashboard branch could switch one on, and its order would reach the kitchen days late.
  it('accepts a card only, never the methods the branch’s own Stripe settings would add', () => {
    const typeKeys = [...params.keys()].filter((k) => k.startsWith('payment_method_types'));
    expect(typeKeys.map((k) => params.get(k))).toEqual(['card']);
    expect([...params.keys()].some((k) => k.startsWith('automatic_payment_methods'))).toBe(false);
    expect([...logic.CARD_PAYMENT_METHOD_TYPES]).toEqual(['card']);
  });

  it('offers in the Payment Element exactly the methods the PaymentIntent accepts', () => {
    // Stripe refuses to confirm an intent whose types differ from the ones the form collected.
    expect([...CARD_PAYMENT_METHOD_TYPES]).toEqual([...logic.CARD_PAYMENT_METHOD_TYPES]);
    // The deferred-intent form (the checkout) is the one that must pass the list itself; the
    // order page's retry form is built from the intent and follows its list.
    const form = readFileSync(path.resolve(__dirname, '../components/card-payment/stripe-card-form.tsx'), 'utf8');
    expect(form).toContain('paymentMethodTypes: [...CARD_PAYMENT_METHOD_TYPES]');
  });

  it('takes nothing for the platform and routes nothing through it', () => {
    const keys = [...params.keys()];
    for (const forbidden of ['application_fee_amount', 'transfer_data', 'on_behalf_of', 'transfer_group']) {
      expect(keys.some((k) => k.startsWith(forbidden)), forbidden).toBe(false);
    }
  });

  it('leaves out empty form values', () => {
    const form = logic.stripeForm({ a: 1, b: null, c: undefined, d: false });
    expect(form.toString()).toBe('a=1&d=false');
  });

  it('only ever sends ids that look like Stripe’s', () => {
    expect(logic.STRIPE_ACCOUNT_ID.test(ACCT)).toBe(true);
    expect(logic.STRIPE_ACCOUNT_ID.test('acct_')).toBe(false);
    expect(logic.STRIPE_ACCOUNT_ID.test('acct_abc/../x')).toBe(false);
    expect(logic.PAYMENT_INTENT_ID.test('pi_3Nabc')).toBe(true);
    expect(logic.PAYMENT_INTENT_ID.test('pi_3Nabc/cancel')).toBe(false);
  });
});
