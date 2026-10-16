// What an Orders row's action menu may offer: the order's state AND the viewer's right.
//
// The status used to decide alone, so once a cashier could open this page (owner decision D1,
// 2026-10-16) it would have been offered a refund, a cancel that refunds the whole card, and a
// tax invoice — each refused by the database, or, for the cancel of a paid cash order, let
// through. The database is the boundary; this keeps the menu to what will work.

import type { CardPaymentSummary } from './card-refund';

export interface OrderActionInput {
  status: string;
  /** The order's Stripe card payment as the list read it, or null. */
  card: CardPaymentSummary | null;
  /** A payment with money taken exists (completed or refunded, more than zero), as the list read
   *  it; null when it was not asked, which counts as paid. */
  paid: boolean | null;
  /** orders.refund at the branch. */
  canRefundOrders: boolean;
  /** orders.cancel at the branch. */
  canCancelOrders: boolean;
}

export interface OrderActionRights {
  refund: boolean;
  cancel: boolean;
  editNote: boolean;
  issueReceipt: boolean;
  /** Any of the four: no menu at all otherwise. */
  any: boolean;
}

export function orderActionRights(input: OrderActionInput): OrderActionRights {
  const { status, card, paid, canRefundOrders, canCancelOrders } = input;
  // Use canonical order_status values ('cancelled' two L's, 'completed' — there is no
  // 'canceled'/'delivered' for orders) so terminal-state orders don't offer dead actions.
  //
  // A closed order is still offered a refund while its card payment sits with the restaurant.
  // The database no longer lets anyone close a paid card order without its refund
  // (20260925120000), so this is for orders closed before that, and for one whose refund Stripe
  // later failed.
  const cardStillHeld = !!card && card.paid && card.refundable > 0;
  const refund = canRefundOrders && (!['cancelled', 'refunded'].includes(status) || cardStillHeld);
  // A paid order's cancel gives the money back, which is a refund (D4): cancel_order refuses it
  // to orders.cancel alone with paid_order_needs_refund. An order the list could not tell about
  // counts as paid, so the cashier is never offered a cancel that may already hold the diner's
  // money.
  const maybePaid = paid !== false || !!card?.paid;
  const cancel =
    (canRefundOrders || (canCancelOrders && !maybePaid)) &&
    !['cancelled', 'refunded', 'completed'].includes(status);
  // admin_edit_order_notes accepts pending, confirmed and preparing, from any member of staff.
  const editNote = ['pending', 'confirmed', 'preparing'].includes(status);
  // issue_tax_invoice raises 'order_not_completed' outside these three, and checks orders.refund.
  // Viewing the receipt is a separate button and stays available on every order.
  const issueReceipt = canRefundOrders && ['confirmed', 'ready', 'completed'].includes(status);
  return { refund, cancel, editNote, issueReceipt, any: refund || cancel || editNote || issueReceipt };
}
