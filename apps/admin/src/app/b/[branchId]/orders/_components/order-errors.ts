// The order RPCs raise bare postgres exception names ('order_not_found',
// 'cannot_cancel_status:completed'). PostgREST hands that text back as the error message, and
// shown as-is it reads like a crash rather than a rule — and never in the merchant's language.
// Each known code becomes a key under orders.errors; anything else is 'generic', and the caller
// keeps the raw text for the console only.

/** Which RPC failed. The same code can mean different things to different actions. */
export type OrderAction =
  | 'editNote' // admin_edit_order_notes
  | 'cancel' // cancel_order
  | 'issueInvoice' // issue_tax_invoice
  | 'refund' // refund_order
  | 'requeue' // requeue_failed_delivery
  | 'decidePayment'; // decide_payment_proof

export type OrderErrorKey =
  | 'generic'
  | 'authRequired'
  | 'orderNotFound'
  | 'notAuthorized'
  | 'noteLocked'
  | 'cannotCancel'
  | 'invoiceNotCompleted'
  | 'invoiceNotAuthorized'
  | 'refundNotAuthorized'
  | 'invalidRefundAmount'
  | 'deliveryNotFound'
  | 'deliveryNotFailed'
  | 'deliveryForbidden'
  | 'paymentNotFound'
  | 'paymentForbidden';

/** 'order_locked_status:completed' is the code 'order_locked_status' with a detail after it. */
function is(raw: string, code: string): boolean {
  return raw === code || raw.startsWith(`${code}:`);
}

export function orderErrorKey(action: OrderAction, message: string | null | undefined): OrderErrorKey {
  const raw = (message ?? '').trim();
  if (is(raw, 'auth_required')) return 'authRequired';
  switch (action) {
    case 'editNote':
      if (is(raw, 'order_not_found')) return 'orderNotFound';
      if (is(raw, 'not_authorized')) return 'notAuthorized';
      if (is(raw, 'order_locked_status')) return 'noteLocked';
      break;
    case 'cancel':
      if (is(raw, 'order_not_found')) return 'orderNotFound';
      if (is(raw, 'not_authorized')) return 'notAuthorized';
      if (is(raw, 'cannot_cancel_status')) return 'cannotCancel';
      break;
    case 'issueInvoice':
      if (is(raw, 'order_not_found')) return 'orderNotFound';
      if (is(raw, 'not_authorized')) return 'invoiceNotAuthorized';
      if (is(raw, 'order_not_completed')) return 'invoiceNotCompleted';
      break;
    case 'refund':
      if (is(raw, 'order_not_found')) return 'orderNotFound';
      if (is(raw, 'not_authorized')) return 'refundNotAuthorized';
      if (is(raw, 'invalid_refund_amount')) return 'invalidRefundAmount';
      break;
    case 'requeue':
      if (is(raw, 'not_found')) return 'deliveryNotFound';
      if (is(raw, 'forbidden')) return 'deliveryForbidden';
      if (is(raw, 'not_failed')) return 'deliveryNotFailed';
      break;
    case 'decidePayment':
      // Matched loosely on purpose, as before: the word is what the approval rule raises.
      if (/forbidden/i.test(raw)) return 'paymentForbidden';
      if (is(raw, 'payment_not_found')) return 'paymentNotFound';
      break;
  }
  return 'generic';
}
