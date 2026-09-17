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
