import { describe, expect, it } from 'vitest';
import type { CardPaymentSummary } from './card-refund';
import { orderActionRights, type OrderActionInput } from './order-actions-model';

/**
 * The Orders row menu, by role (owner decisions D1 and D4, 2026-10-16). A manager holds
 * orders.refund and orders.cancel; a cashier holds orders.cancel alone and opens this page now.
 */

const manager = { canRefundOrders: true, canCancelOrders: true };
const cashier = { canRefundOrders: false, canCancelOrders: true };
const nobody = { canRefundOrders: false, canCancelOrders: false };

const card = (over: Partial<CardPaymentSummary> = {}): CardPaymentSummary => ({
  paymentId: 'pay-1',
  paid: true,
  amount: 24.5,
  refunded: 0,
  refundPending: 0,
  refundable: 24.5,
  disputed: false,
  ...over,
});

const rights = (over: Partial<OrderActionInput>) =>
  orderActionRights({ status: 'confirmed', card: null, paid: null, ...manager, ...over });

describe('orderActionRights', () => {
  it('gives a manager everything a live order allows', () => {
    expect(rights({ status: 'confirmed' })).toEqual({
      refund: true,
      cancel: true,
      editNote: true,
      issueReceipt: true,
      any: true,
    });
  });

  it('never offers a cashier a refund or a tax invoice', () => {
    for (const status of ['pending', 'confirmed', 'ready', 'completed', 'cancelled']) {
      const r = rights({ status, paid: false, ...cashier });
      expect(r.refund, status).toBe(false);
      expect(r.issueReceipt, status).toBe(false);
    }
  });

  it('lets a cashier cancel an order that has not been paid', () => {
    expect(rights({ status: 'pending', paid: false, ...cashier }).cancel).toBe(true);
    expect(rights({ status: 'confirmed', paid: false, ...cashier }).cancel).toBe(true);
  });

  it('keeps a paid order’s cancel from a cashier, since it gives the money back', () => {
    expect(rights({ status: 'confirmed', paid: true, ...cashier }).cancel).toBe(false);
    // The list did not say (or could not read) whether it was paid: counted as paid.
    expect(rights({ status: 'confirmed', paid: null, ...cashier }).cancel).toBe(false);
    // A card the list saw charged, even with nothing left to refund, is money taken.
    expect(rights({ status: 'confirmed', paid: false, card: card(), ...cashier }).cancel).toBe(false);
    expect(
      rights({ status: 'confirmed', paid: false, card: card({ refundable: 0, refunded: 24.5 }), ...cashier }).cancel,
    ).toBe(false);
    // A card that never went through is not.
    expect(
      rights({ status: 'pending', paid: false, card: card({ paid: false, refundable: 0 }), ...cashier }).cancel,
    ).toBe(true);
  });

  it('lets a manager cancel a paid order, which refunds it', () => {
    expect(rights({ status: 'confirmed', paid: true, card: card() }).cancel).toBe(true);
  });

  it('offers no cancel on a finished order, whoever is looking', () => {
    for (const status of ['completed', 'cancelled', 'refunded']) {
      expect(rights({ status }).cancel, status).toBe(false);
      expect(rights({ status, paid: false, ...cashier }).cancel, status).toBe(false);
    }
  });

  it('still offers a manager the refund of a card a closed order holds', () => {
    expect(rights({ status: 'cancelled', card: card() }).refund).toBe(true);
    expect(rights({ status: 'cancelled', card: card({ refundable: 0 }) }).refund).toBe(false);
  });

  it('lets anyone on staff fix the customer note while the order is in the kitchen', () => {
    for (const status of ['pending', 'confirmed', 'preparing']) {
      expect(rights({ status, ...nobody }).editNote, status).toBe(true);
    }
    expect(rights({ status: 'ready', ...nobody }).editNote).toBe(false);
  });

  it('shows no menu when there is nothing to offer', () => {
    expect(rights({ status: 'completed', ...cashier, paid: true }).any).toBe(false);
    expect(rights({ status: 'ready', ...nobody }).any).toBe(false);
    expect(rights({ status: 'pending', ...nobody }).any).toBe(true);
  });
});
