import { describe, expect, it } from 'vitest';
import {
  cancelOutcomeFromRefund,
  cardRefundErrorKey,
  checkRefundAmount,
  DISPUTE_STATUSES_MONEY_TAKEN,
  disputeTookTheMoney,
  isStripeCardPayment,
  keepIdempotencyKey,
  needsCardRefund,
  summarizeCardPayment,
  summarizeCardPaymentsByOrder,
  type CardPaymentRow,
  type PaymentRefundRow,
} from './card-refund';

const pay = (over: Partial<CardPaymentRow> = {}): CardPaymentRow => ({
  id: 'pay-1',
  order_id: 'order-1',
  amount: '42.50',
  status: 'completed',
  method: 'card',
  gateway: 'stripe',
  gateway_charge_id: 'pi_123',
  created_at: '2026-09-24T10:00:00Z',
  ...over,
});

const refund = (over: Partial<PaymentRefundRow> = {}): PaymentRefundRow => ({
  id: 'ref-1',
  payment_id: 'pay-1',
  order_id: 'order-1',
  amount: '10.00',
  status: 'succeeded',
  reason: null,
  created_at: '2026-09-24T11:00:00Z',
  ...over,
});

describe('isStripeCardPayment', () => {
  it('needs a card row that went through Stripe with a PaymentIntent', () => {
    expect(isStripeCardPayment(pay())).toBe(true);
    // The ten card rows from before Stripe Connect: gateway stripe, no intent.
    expect(isStripeCardPayment(pay({ gateway_charge_id: null }))).toBe(false);
    expect(isStripeCardPayment(pay({ gateway_charge_id: '  ' }))).toBe(false);
    // A card taken on the counter's own terminal.
    expect(isStripeCardPayment(pay({ gateway: null }))).toBe(false);
    expect(isStripeCardPayment(pay({ method: 'cash' }))).toBe(false);
  });
});

describe('summarizeCardPayment', () => {
  it('is null when the order has no Stripe card payment, so the old refund path applies', () => {
    expect(summarizeCardPayment([], [])).toBeNull();
    expect(summarizeCardPayment([pay({ method: 'transfer', gateway: null })], [])).toBeNull();
    expect(summarizeCardPayment([pay({ gateway_charge_id: null, status: 'pending' })], [])).toBeNull();
  });

  it('offers the whole charge when nothing has been refunded', () => {
    const s = summarizeCardPayment([pay()], []);
    expect(s).toMatchObject({ paid: true, amount: 42.5, refunded: 0, refundPending: 0, refundable: 42.5 });
  });

  it('holds back confirmed and pending refunds, and ignores failed and canceled ones', () => {
    const s = summarizeCardPayment(
      [pay()],
      [
        refund({ id: 'a', amount: '10.00', status: 'succeeded' }),
        refund({ id: 'b', amount: '5.25', status: 'pending', created_at: '2026-09-24T12:00:00Z' }),
        refund({ id: 'c', amount: '20.00', status: 'failed', created_at: '2026-09-24T09:00:00Z' }),
        refund({ id: 'd', amount: '1.00', status: 'canceled' }),
      ],
    );
    expect(s?.refunded).toBe(10);
    expect(s?.refundPending).toBe(5.25);
    expect(s?.refundable).toBe(27.25);
    // Oldest first, the failed one included so staff can see it.
    expect(s?.refunds.map((r) => r.id)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('adds refunds in whole cents, with no float tail', () => {
    const s = summarizeCardPayment(
      [pay({ amount: '0.30' })],
      [refund({ id: 'a', amount: '0.10' }), refund({ id: 'b', amount: '0.20' })],
    );
    expect(s?.refunded).toBe(0.3);
    expect(s?.refundable).toBe(0);
  });

  it('never offers less than zero, even if Stripe recorded more than the row says', () => {
    const s = summarizeCardPayment([pay({ amount: '10.00' })], [refund({ amount: '12.00' })]);
    expect(s?.refundable).toBe(0);
  });

  it('offers nothing on a card payment that has not gone through', () => {
    const s = summarizeCardPayment([pay({ status: 'pending' })], []);
    expect(s).toMatchObject({ paid: false, refundable: 0 });
  });

  it('keeps counting a payment the webhook marked refunded as paid', () => {
    const s = summarizeCardPayment(
      [pay({ status: 'refunded' })],
      [refund({ amount: '42.50' })],
    );
    expect(s).toMatchObject({ paid: true, refunded: 42.5, refundable: 0 });
  });

  it('uses the paid attempt, and otherwise the newest one', () => {
    const declined = pay({ id: 'old', status: 'failed', gateway_charge_id: 'pi_old', created_at: '2026-09-24T09:00:00Z' });
    const paid = pay({ id: 'new', status: 'completed', gateway_charge_id: 'pi_new', created_at: '2026-09-24T09:05:00Z' });
    expect(summarizeCardPayment([paid, declined], [])?.paymentId).toBe('new');
    expect(summarizeCardPayment([declined, paid], [])?.paymentId).toBe('new');
    const retrying = pay({ id: 'retry', status: 'pending', gateway_charge_id: 'pi_retry', created_at: '2026-09-24T09:10:00Z' });
    expect(summarizeCardPayment([declined, retrying], [])?.paymentId).toBe('retry');
  });

  it("counts only the chosen payment's refunds", () => {
    const s = summarizeCardPayment([pay()], [refund({ payment_id: 'someone-else', amount: '42.50' })]);
    expect(s?.refundable).toBe(42.5);
  });
});

describe('summarizeCardPaymentsByOrder', () => {
  it('keys each Stripe card payment by its order and leaves the refund lines out', () => {
    const out = summarizeCardPaymentsByOrder(
      [
        pay(),
        pay({ id: 'pay-2', order_id: 'order-2', amount: '8.00' }),
        pay({ id: 'pay-3', order_id: 'order-3', gateway: null }),
      ],
      [refund({ amount: '2.50', status: 'pending' })],
    );
    expect(Object.keys(out).sort()).toEqual(['order-1', 'order-2']);
    expect(out['order-1']).toEqual({
      paymentId: 'pay-1',
      paid: true,
      amount: 42.5,
      refunded: 0,
      refundPending: 2.5,
      refundable: 40,
      disputed: false,
    });
    expect(out['order-2']?.refundable).toBe(8);
  });

  it('carries a dispute to the row, so a cancelled disputed order is not flagged "Card not refunded"', () => {
    const out = summarizeCardPaymentsByOrder([pay({ dispute_status: 'lost' })], []);
    expect(out['order-1']).toMatchObject({ paid: true, disputed: true, refundable: 0 });
  });
});

describe('disputes', () => {
  it('offers nothing to refund once a formal dispute has taken the money back', () => {
    for (const status of ['needs_response', 'under_review', 'lost']) {
      const s = summarizeCardPayment([pay({ amount: '20.00', dispute_status: status })], []);
      expect(s, status).toMatchObject({ paid: true, amount: 20, disputed: true, refundable: 0 });
    }
  });

  it('leaves an inquiry or a won dispute refundable: the money is still the restaurant’s', () => {
    for (const status of ['warning_needs_response', 'warning_under_review', 'warning_closed', 'won', null]) {
      const s = summarizeCardPayment([pay({ amount: '20.00', dispute_status: status })], []);
      expect(s, String(status)).toMatchObject({ disputed: false, refundable: 20 });
    }
  });

  it('names the same statuses as stripe-refund, which refuses and skips those refunds', () => {
    expect([...DISPUTE_STATUSES_MONEY_TAKEN]).toEqual(['needs_response', 'under_review', 'lost']);
    expect(disputeTookTheMoney('lost')).toBe(true);
    expect(disputeTookTheMoney('won')).toBe(false);
    expect(disputeTookTheMoney(undefined)).toBe(false);
  });

  it('words stripe-refund’s own dispute refusal as Stripe’s charge_disputed', () => {
    expect(cardRefundErrorKey(409, { error: 'disputed' })).toBe('stripeDisputed');
  });
});

describe('checkRefundAmount', () => {
  it('refuses nothing and more than what is left, to the cent', () => {
    expect(checkRefundAmount(0, 10)).toBe('amountZero');
    expect(checkRefundAmount(-1, 10)).toBe('amountZero');
    expect(checkRefundAmount(Number.NaN, 10)).toBe('amountZero');
    expect(checkRefundAmount(10.01, 10)).toBe('amountTooHigh');
    expect(checkRefundAmount(10, 10)).toBe(null);
    // 0.1 + 0.2 is 0.30000000000000004 in floating point: still exactly 30 cents.
    expect(checkRefundAmount(0.1 + 0.2, 0.3)).toBe(null);
  });
});

describe('cardRefundErrorKey', () => {
  it('names what stripe-refund refuses with', () => {
    expect(cardRefundErrorKey(503, { error: 'stripe_not_configured' })).toBe('notConfigured');
    expect(cardRefundErrorKey(403, { error: 'not_authorized' })).toBe('notAuthorized');
    expect(cardRefundErrorKey(404, { error: 'order_not_found' })).toBe('orderNotFound');
    expect(cardRefundErrorKey(409, { error: 'not_paid_by_card' })).toBe('notPaid');
    expect(cardRefundErrorKey(409, { error: 'payment_not_settled' })).toBe('notPaid');
    expect(cardRefundErrorKey(409, { error: 'nothing_to_refund' })).toBe('nothingToRefund');
    expect(cardRefundErrorKey(409, { error: 'over_refund', refundable: 3 })).toBe('overRefund');
    expect(cardRefundErrorKey(400, { error: 'invalid_amount' })).toBe('invalidAmount');
    expect(cardRefundErrorKey(409, { error: 'no_stripe_account' })).toBe('noAccount');
    expect(cardRefundErrorKey(409, { error: 'payment_mismatch' })).toBe('mismatch');
    expect(cardRefundErrorKey(401, { error: 'invalid_token' })).toBe('authRequired');
  });

  it("turns Stripe's own refusals into what they mean for the branch", () => {
    expect(cardRefundErrorKey(422, { error: 'stripe_refused', stripe_code: 'charge_disputed' })).toBe('stripeDisputed');
    expect(cardRefundErrorKey(422, { error: 'stripe_refused', stripe_code: 'charge_already_refunded' })).toBe(
      'stripeAlreadyRefunded',
    );
    expect(cardRefundErrorKey(422, { error: 'stripe_refused', stripe_code: 'balance_insufficient' })).toBe(
      'stripeInsufficientFunds',
    );
    expect(cardRefundErrorKey(422, { error: 'stripe_refused', stripe_code: 'something_new' })).toBe('stripeRefused');
    expect(cardRefundErrorKey(422, { error: 'stripe_refused' })).toBe('stripeRefused');
  });

  it('says the outcome is unknown when nothing answered or the function fell over', () => {
    expect(cardRefundErrorKey(null, null)).toBe('unreachable');
    expect(cardRefundErrorKey(502, { error: 'stripe_unreachable' })).toBe('unreachable');
    expect(cardRefundErrorKey(500, { error: 'internal_error' })).toBe('unreachable');
    expect(cardRefundErrorKey(400, { error: 'something_else' })).toBe('generic');
  });
});

describe('keepIdempotencyKey', () => {
  it('keeps the key only when the refund may already exist', () => {
    expect(keepIdempotencyKey(null)).toBe(true);
    expect(keepIdempotencyKey(500)).toBe(true);
    expect(keepIdempotencyKey(502)).toBe(true);
    expect(keepIdempotencyKey(504)).toBe(true);
    // Definite refusals: Stripe remembers a refused request under its key.
    expect(keepIdempotencyKey(422)).toBe(false);
    expect(keepIdempotencyKey(409)).toBe(false);
    expect(keepIdempotencyKey(400)).toBe(false);
  });
});

describe('needsCardRefund', () => {
  it('reads the database refusal that asks for the card refund first', () => {
    expect(needsCardRefund('card_refund_required')).toBe(true);
    expect(needsCardRefund(' card_refund_required ')).toBe(true);
    expect(needsCardRefund('card_refund_required:7.00')).toBe(true);
    expect(needsCardRefund('cannot_cancel_status:completed')).toBe(false);
    expect(needsCardRefund('card_paid_ask_restaurant')).toBe(false);
    expect(needsCardRefund(null)).toBe(false);
  });
});

describe('cancelOutcomeFromRefund', () => {
  const success = (amount: number, stripe_status: string | null = 'succeeded') => ({
    ok: true as const,
    data: { ok: true as const, cancelled: true as const, refund_id: amount > 0 ? 're_1' : null, amount, stripe_status, recorded: true },
  });
  const refused = (status: number | null, body: Record<string, unknown> | null) => ({
    ok: false as const,
    status,
    body,
  });

  it('is cancelled, with what went back to the card', () => {
    expect(cancelOutcomeFromRefund(success(12.5))).toEqual({
      ok: true,
      refunded: { amount: 12.5, stripeStatus: 'succeeded' },
    });
    expect(cancelOutcomeFromRefund(success(12.5, null))).toEqual({
      ok: true,
      refunded: { amount: 12.5, stripeStatus: 'pending' },
    });
  });

  it('is cancelled with nothing refunded when the money was already back', () => {
    expect(cancelOutcomeFromRefund(success(0, null))).toEqual({ ok: true, refunded: null });
  });

  it('is a refused cancel when the order closed before anything was refunded', () => {
    expect(cancelOutcomeFromRefund(refused(409, { error: 'cannot_cancel_status', status: 'completed' }))).toEqual({
      ok: false,
      stage: 'cancel',
      code: 'cannot_cancel_status:completed',
    });
  });

  it('keeps the refund when the cancel after it failed, so the screen says the money is back', () => {
    expect(
      cancelOutcomeFromRefund(refused(409, { error: 'cancel_failed', cancel_error: 'not_authorized', amount: 9 })),
    ).toEqual({ ok: false, stage: 'cancelAfterRefund', code: 'not_authorized', amount: 9 });
    // Nothing was refunded by this request (it had gone back earlier): only the cancel failed.
    expect(
      cancelOutcomeFromRefund(refused(409, { error: 'cancel_failed', cancel_error: 'not_authorized', amount: 0 })),
    ).toEqual({ ok: false, stage: 'cancel', code: 'not_authorized' });
  });

  it('is a refund refusal otherwise, worded by cardRefundErrorKey and nothing cancelled', () => {
    const outcome = cancelOutcomeFromRefund(refused(422, { error: 'stripe_refused', stripe_code: 'balance_insufficient' }));
    expect(outcome).toMatchObject({ ok: false, stage: 'refund', status: 422 });
    if (!outcome.ok && outcome.stage === 'refund') {
      expect(cardRefundErrorKey(outcome.status, outcome.body)).toBe('stripeInsufficientFunds');
    }
    // Stripe refunded but our books could not take it: retry with the same key.
    const lost = cancelOutcomeFromRefund(refused(500, { error: 'refund_not_recorded', refund_id: 're_1', amount: 5 }));
    expect(lost).toMatchObject({ ok: false, stage: 'refund', status: 500 });
    expect(keepIdempotencyKey(500)).toBe(true);
    expect(cancelOutcomeFromRefund(refused(null, null))).toMatchObject({ ok: false, stage: 'refund', status: null });
  });
});
