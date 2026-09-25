import { describe, expect, it } from 'vitest';
import * as plan from '../../../../../../../../supabase/functions/stripe-refund/refund-plan';
import { DISPUTE_STATUSES_MONEY_TAKEN as BACK_OFFICE_DISPUTE_STATUSES, summarizeCardPayment } from './card-refund';

/**
 * The stripe-refund edge function's decisions, pinned from here because a Deno function cannot
 * run under this app's test runner but a module with no imports can:
 * supabase/functions/stripe-refund/refund-plan.ts imports nothing for exactly this reason.
 *
 * What is at stake: a refund leaves the branch's own Stripe account for the diner's card. Too
 * much, twice, from the wrong account or against another restaurant's charge are the four ways
 * that goes wrong, and each rule below closes one of them.
 */

const ACCT = 'acct_1Q2w3E4r5T6y7U8i';
const OTHER = 'acct_9Z8y7X6w5V4u3T2s';

describe('stripe-refund: which payment', () => {
  const row = (over: Partial<plan.PaymentCandidate> = {}): plan.PaymentCandidate => ({
    id: 'pay-1',
    status: 'completed',
    method: 'card',
    gateway: 'stripe',
    gateway_charge_id: 'pi_123',
    created_at: '2026-09-24T10:00:00Z',
    ...over,
  });

  it('refunds only a paid Stripe card payment with a PaymentIntent', () => {
    expect(plan.pickRefundablePayment([row()])?.id).toBe('pay-1');
    expect(plan.pickRefundablePayment([row({ status: 'refunded' })])?.id).toBe('pay-1');
    expect(plan.pickRefundablePayment([row({ status: 'pending' })])).toBeNull();
    expect(plan.pickRefundablePayment([row({ status: 'failed' })])).toBeNull();
    expect(plan.pickRefundablePayment([row({ status: 'voided' })])).toBeNull();
    // A card swiped on the restaurant's own terminal, and the pre-Connect rows.
    expect(plan.pickRefundablePayment([row({ gateway: null })])).toBeNull();
    expect(plan.pickRefundablePayment([row({ gateway_charge_id: null })])).toBeNull();
    expect(plan.pickRefundablePayment([row({ gateway_charge_id: 'ch_123' })])).toBeNull();
  });

  it('picks the newest paid attempt, the same one the back office offers', () => {
    const rows = [
      row({ id: 'old', gateway_charge_id: 'pi_old', created_at: '2026-09-24T09:00:00Z' }),
      row({ id: 'new', gateway_charge_id: 'pi_new', created_at: '2026-09-24T09:05:00Z' }),
    ];
    expect(plan.pickRefundablePayment(rows)?.id).toBe('new');
    const dialog = summarizeCardPayment(
      rows.map((r) => ({ ...r, order_id: 'o', amount: '10.00' })),
      [],
    );
    expect(dialog?.paymentId).toBe('new');
  });
});

describe('stripe-refund: how much', () => {
  const base = {
    capturedCents: 4250,
    recordedCents: 4250,
    refundedInBooksCents: 0,
    refundedAtStripeCents: 0 as number | null,
    requestedCents: null as number | null,
  };

  it('refunds everything left when no amount is given', () => {
    expect(plan.planRefund(base)).toEqual({ ok: true, amountCents: 4250, remainingCents: 4250, alreadyRefundedCents: 0 });
    expect(plan.planRefund({ ...base, refundedInBooksCents: 1000 })).toMatchObject({ ok: true, amountCents: 3250 });
  });

  it('refuses more than is left: non-failed refunds plus this one may not pass the captured amount', () => {
    expect(plan.planRefund({ ...base, refundedInBooksCents: 1000, requestedCents: 3251 })).toMatchObject({
      ok: false,
      error: 'over_refund',
      remainingCents: 3250,
    });
    expect(plan.planRefund({ ...base, refundedInBooksCents: 1000, requestedCents: 3250 })).toMatchObject({
      ok: true,
      amountCents: 3250,
    });
  });

  it('counts a refund made in the Stripe Dashboard before the webhook has recorded it', () => {
    expect(plan.planRefund({ ...base, refundedAtStripeCents: 4000, requestedCents: 500 })).toMatchObject({
      ok: false,
      error: 'over_refund',
      remainingCents: 250,
    });
  });

  it('takes the smaller ceiling and the larger tally when the books and Stripe disagree', () => {
    expect(plan.planRefund({ ...base, capturedCents: 4000 })).toMatchObject({ ok: true, amountCents: 4000 });
    expect(plan.planRefund({ ...base, recordedCents: 3000 })).toMatchObject({ ok: true, amountCents: 3000 });
    expect(plan.planRefund({ ...base, refundedInBooksCents: 500, refundedAtStripeCents: 900 })).toMatchObject({
      ok: true,
      amountCents: 3350,
      alreadyRefundedCents: 900,
    });
  });

  it('says there is nothing left rather than sending a zero refund', () => {
    expect(plan.planRefund({ ...base, refundedInBooksCents: 4250 })).toMatchObject({ ok: false, error: 'nothing_to_refund' });
    expect(plan.planRefund({ ...base, capturedCents: 0 })).toMatchObject({ ok: false, error: 'nothing_to_refund' });
    expect(plan.planRefund({ ...base, refundedAtStripeCents: null, refundedInBooksCents: 9999 })).toMatchObject({
      ok: false,
      error: 'nothing_to_refund',
      remainingCents: 0,
    });
  });

  it('refuses a non-positive or fractional request', () => {
    expect(plan.planRefund({ ...base, requestedCents: 0 })).toMatchObject({ ok: false, error: 'invalid_amount' });
    expect(plan.planRefund({ ...base, requestedCents: -5 })).toMatchObject({ ok: false, error: 'invalid_amount' });
    expect(plan.planRefund({ ...base, requestedCents: 10.5 })).toMatchObject({ ok: false, error: 'invalid_amount' });
  });
});

describe('stripe-refund: reading the request', () => {
  it('turns dollars into exact cents and refuses anything that is not whole cents', () => {
    expect(plan.dollarsToCents(12.5)).toBe(1250);
    expect(plan.dollarsToCents('12.50')).toBe(1250);
    expect(plan.dollarsToCents(0.1 + 0.2)).toBe(30);
    expect(plan.dollarsToCents(19.99)).toBe(1999);
    expect(plan.dollarsToCents(12.345)).toBeNull();
    expect(plan.dollarsToCents(0)).toBeNull();
    expect(plan.dollarsToCents(-1)).toBeNull();
    expect(plan.dollarsToCents('')).toBeNull();
    expect(plan.dollarsToCents('abc')).toBeNull();
    expect(plan.dollarsToCents(Number.POSITIVE_INFINITY)).toBeNull();
    expect(plan.dollarsToCents(null)).toBeNull();
  });

  it("stores the operator's reason as refund_order does", () => {
    expect(plan.parseReason('  Cold food  ')).toBe('Cold food');
    expect(plan.parseReason('')).toBeNull();
    expect(plan.parseReason(42)).toBeNull();
    expect(plan.parseReason('a\nb\tc')).toBe('a b c');
    expect(plan.parseReason('x'.repeat(400))).toHaveLength(300);
  });

  it('reads money back from numeric columns', () => {
    expect(plan.storedCents('42.50')).toBe(4250);
    expect(plan.storedCents(null)).toBe(0);
    expect(plan.storedCents('0.10')).toBe(10);
  });
});

describe('stripe-refund: never twice', () => {
  it("keys one operator's refund the same across retries", () => {
    const a = plan.refundIdempotencyKey({ paymentId: 'pay-1', clientKey: 'c0ffee00-1111', amountCents: 500, alreadyRefundedCents: 0 });
    const b = plan.refundIdempotencyKey({ paymentId: 'pay-1', clientKey: 'c0ffee00-1111', amountCents: 500, alreadyRefundedCents: 500 });
    // The first attempt may have been recorded before the answer was lost: still the same key.
    expect(a).toBe(b);
  });

  it('gives a corrected amount its own key, so a refused request is not replayed', () => {
    const a = plan.refundIdempotencyKey({ paymentId: 'pay-1', clientKey: 'c0ffee00-1111', amountCents: 500, alreadyRefundedCents: 0 });
    const b = plan.refundIdempotencyKey({ paymentId: 'pay-1', clientKey: 'c0ffee00-1111', amountCents: 400, alreadyRefundedCents: 0 });
    expect(a).not.toBe(b);
  });

  it('falls back to what is already refunded when the caller sends no usable key', () => {
    const first = plan.refundIdempotencyKey({ paymentId: 'pay-1', clientKey: undefined, amountCents: 500, alreadyRefundedCents: 0 });
    const again = plan.refundIdempotencyKey({ paymentId: 'pay-1', clientKey: 'bad key!', amountCents: 500, alreadyRefundedCents: 0 });
    const second = plan.refundIdempotencyKey({ paymentId: 'pay-1', clientKey: undefined, amountCents: 500, alreadyRefundedCents: 500 });
    expect(first).toBe(again);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(255);
  });
});

describe('stripe-refund: the right account and the right charge', () => {
  it('refunds on the account the charge was made on, then the branch account, never anything else', () => {
    expect(plan.chargeAccount({ stripe_account: ACCT }, OTHER)).toBe(ACCT);
    expect(plan.chargeAccount({}, OTHER)).toBe(OTHER);
    expect(plan.chargeAccount(null, OTHER)).toBe(OTHER);
    expect(plan.chargeAccount({ stripe_account: 'not-an-account' }, null)).toBeNull();
    expect(plan.chargeAccount({ stripe_account: 'acct_x' }, 'acct_bad!')).toBeNull();
  });

  it("refuses an intent stamped for another order or payment", () => {
    const expected = { orderId: 'order-1', paymentId: 'pay-1', account: ACCT, branchAccount: ACCT };
    expect(plan.intentBelongsTo({ metadata: { order_id: 'order-1', payment_id: 'pay-1' } }, expected)).toBe(true);
    expect(plan.intentBelongsTo({ metadata: { order_id: 'order-2', payment_id: 'pay-1' } }, expected)).toBe(false);
    expect(plan.intentBelongsTo({ metadata: { order_id: 'order-1', payment_id: 'pay-2' } }, expected)).toBe(false);
    expect(plan.intentBelongsTo({ metadata: { order_id: 'order-1' } }, expected)).toBe(true);
  });

  it("accepts an unstamped intent only on the branch's own current account", () => {
    expect(
      plan.intentBelongsTo({ metadata: {} }, { orderId: 'o', paymentId: 'p', account: ACCT, branchAccount: ACCT }),
    ).toBe(true);
    expect(
      plan.intentBelongsTo({ metadata: null }, { orderId: 'o', paymentId: 'p', account: ACCT, branchAccount: OTHER }),
    ).toBe(false);
    expect(
      plan.intentBelongsTo({}, { orderId: 'o', paymentId: 'p', account: ACCT, branchAccount: null }),
    ).toBe(false);
  });

  it('keeps an unanswered Stripe call retryable and a refusal final', () => {
    expect(plan.classifyStripeFailure(500, 'api_error')).toBe('unknown');
    expect(plan.classifyStripeFailure(599, null)).toBe('unknown');
    expect(plan.classifyStripeFailure(429, 'rate_limit_error')).toBe('unknown');
    expect(plan.classifyStripeFailure(400, 'invalid_request_error')).toBe('refused');
    expect(plan.classifyStripeFailure(402, 'card_error')).toBe('refused');
    expect(plan.classifyStripeFailure(404, 'invalid_request_error')).toBe('refused');
  });
});

describe('stripe-refund: cancel with refund', () => {
  it('lets whoever may cancel ask for the cancel, and only refunders ask for a plain refund', () => {
    // The kitchen's Reject: kitchen.access, no orders.refund.
    expect(plan.mayRequest(['kitchen.access'], true)).toBe(true);
    expect(plan.mayRequest(['kitchen.access'], false)).toBe(false);
    expect(plan.mayRequest(['orders.cancel'], true)).toBe(true);
    expect(plan.mayRequest(['orders.refund'], false)).toBe(true);
    // Refunding is not cancelling: cancel_order would refuse this caller, so no refund is made.
    expect(plan.mayRequest(['orders.refund'], true)).toBe(false);
    expect(plan.mayRequest([], true)).toBe(false);
    expect(plan.mayRequest([null, 42, { capability: 'orders.cancel' }], true)).toBe(false);
  });

  it('switches to the cancel mode on a literal true only', () => {
    expect(plan.wantsCancel(true)).toBe(true);
    for (const raw of ['true', 1, 'yes', {}, null, undefined, false]) expect(plan.wantsCancel(raw)).toBe(false);
  });

  it('does not cancel, or refund for a cancel, an order that is already closed', () => {
    expect([...plan.CLOSED_ORDER_STATUSES].sort()).toEqual(['cancelled', 'completed', 'refunded']);
  });

  it('skips the refund only when a formal dispute has already taken the money', () => {
    for (const status of ['needs_response', 'under_review', 'lost']) {
      expect(plan.disputeTookTheMoney({ dispute_id: 'dp_1', dispute_status: status })).toBe(true);
    }
    // An inquiry leaves the money with the restaurant, and a won dispute gave it back to them.
    for (const status of ['warning_needs_response', 'warning_under_review', 'warning_closed', 'won']) {
      expect(plan.disputeTookTheMoney({ dispute_id: 'dp_1', dispute_status: status })).toBe(false);
    }
    expect(plan.disputeTookTheMoney({})).toBe(false);
    expect(plan.disputeTookTheMoney(null)).toBe(false);
    expect(plan.disputeTookTheMoney('lost')).toBe(false);
  });

  it('names the same dispute statuses the database lets close without a refund', async () => {
    // private.order_card_refund_due in the follow-up migration must agree with the function:
    // otherwise a cancel would skip the refund and then be refused, or refund and be refused.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const sql = readFileSync(
      fileURLToPath(
        new URL('../../../../../../../../supabase/migrations/20260925120000_card_refund_followups.sql', import.meta.url),
      ),
      'utf8',
    );
    const match = /dispute_status', ''\) not in \(([^)]*)\)/.exec(sql);
    expect(match).not.toBeNull();
    const inSql = (match?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).sort();
    expect(inSql).toEqual([...plan.DISPUTE_STATUSES_MONEY_TAKEN].sort());
  });

  it('names the same dispute statuses the Orders page treats as nothing to refund', () => {
    // Otherwise the page would offer a refund the function refuses as 'disputed', or flag a
    // cancelled order "Card not refunded" that the cancel rightly left alone.
    expect([...BACK_OFFICE_DISPUTE_STATUSES].sort()).toEqual([...plan.DISPUTE_STATUSES_MONEY_TAKEN].sort());
  });

  it("syncs refunds from Stripe only when Stripe knows of more than the books", () => {
    expect(plan.booksBehindStripe(0, 500)).toBe(true);
    expect(plan.booksBehindStripe(500, 500)).toBe(false);
    expect(plan.booksBehindStripe(700, 500)).toBe(false);
    expect(plan.booksBehindStripe(0, null)).toBe(false);
  });
});
