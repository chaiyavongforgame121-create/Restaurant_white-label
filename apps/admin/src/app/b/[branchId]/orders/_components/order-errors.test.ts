import { describe, expect, it } from 'vitest';
import { orderErrorKey } from './order-errors';

/**
 * The codes below are the exact `raise exception` texts of the RPCs the orders page calls.
 * A merchant must never see one of them, nor a raw database message.
 */
describe('orderErrorKey', () => {
  it('names the codes each RPC raises', () => {
    expect(orderErrorKey('editNote', 'order_locked_status:completed')).toBe('noteLocked');
    expect(orderErrorKey('editNote', 'not_authorized')).toBe('notAuthorized');
    expect(orderErrorKey('cancel', 'cannot_cancel_status:refunded')).toBe('cannotCancel');
    expect(orderErrorKey('cancel', 'order_not_found')).toBe('orderNotFound');
    expect(orderErrorKey('issueInvoice', 'order_not_completed')).toBe('invoiceNotCompleted');
    expect(orderErrorKey('issueInvoice', 'not_authorized')).toBe('invoiceNotAuthorized');
    expect(orderErrorKey('refund', 'invalid_refund_amount')).toBe('invalidRefundAmount');
    expect(orderErrorKey('refund', 'not_authorized')).toBe('refundNotAuthorized');
    expect(orderErrorKey('requeue', 'not_failed')).toBe('deliveryNotFailed');
    expect(orderErrorKey('requeue', 'not_found')).toBe('deliveryNotFound');
    expect(orderErrorKey('requeue', 'forbidden')).toBe('deliveryForbidden');
    expect(orderErrorKey('decidePayment', 'payment_not_found')).toBe('paymentNotFound');
    expect(orderErrorKey('decidePayment', 'forbidden')).toBe('paymentForbidden');
  });

  it('names the card payment rules of 20260925100000 and 20260925120000', () => {
    // Staff trying to settle or move on an online card order the diner has not paid for.
    expect(orderErrorKey('decidePayment', 'stripe_payment_server_only')).toBe('onlineCardUnpaid');
    expect(orderErrorKey('cancel', 'card_payment_not_completed')).toBe('onlineCardUnpaid');
    expect(orderErrorKey('refund', 'stripe_payment_server_only')).toBe('onlineCardUnpaid');
    expect(orderErrorKey('cancel', 'card_refund_required')).toBe('cardRefundRequired');
    expect(orderErrorKey('refund', 'card_refund_required')).toBe('cardRefundNotRecorded');
    expect(orderErrorKey('refund', 'refund_exceeds_remaining:4.00')).toBe('refundExceedsRemaining');
    expect(orderErrorKey('cancel', 'refund_exceeds_remaining:4.00')).toBe('generic');
  });

  it('treats a signed-out session the same everywhere', () => {
    expect(orderErrorKey('refund', 'auth_required')).toBe('authRequired');
    expect(orderErrorKey('requeue', 'auth_required')).toBe('authRequired');
  });

  it('falls back to a generic message for anything it does not know', () => {
    expect(orderErrorKey('refund', 'new row violates row-level security policy')).toBe('generic');
    expect(orderErrorKey('cancel', 'not_found')).toBe('generic');
    expect(orderErrorKey('editNote', '')).toBe('generic');
    expect(orderErrorKey('decidePayment', undefined)).toBe('generic');
  });
});
