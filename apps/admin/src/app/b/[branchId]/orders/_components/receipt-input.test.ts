import { describe, expect, it } from 'vitest';
import { formatReceiptAddress, toReceiptInput, type ReceiptOrder } from './receipt-input';

/**
 * The printed receipt is the one a diner takes away, so its lines have to reach its own
 * TOTAL. ReceiptInput has no tax/tip/discount row, which is exactly how a printed receipt
 * ends up short by the sales tax — these lock the mapping that keeps it honest.
 */
const order: ReceiptOrder = {
  order_number: 'A-1234',
  status: 'completed',
  channel: 'delivery',
  created_at: '2026-09-01T18:30:00.000Z',
  // PostgREST hands numerics back as strings; the mapping must not pass them through.
  subtotal: '20.00',
  delivery_fee: '3.00',
  service_fee: '1.00',
  tax_amount: '1.60',
  tip_amount: '4.00',
  discount_amount: '2.00',
  total: '27.60',
  customer_name: 'Dana',
  customer_phone: '555-0100',
  delivery_address: {
    line1: '12 Main St',
    line2: '',
    city: 'Austin',
    state: 'TX',
    postal_code: '78701',
  },
  order_items: [
    {
      item_name: 'Pad Thai',
      quantity: 2,
      unit_price: '8.00',
      subtotal: '16.00',
      notes: 'No peanuts',
    },
    { item_name: 'Iced Tea', quantity: 1, unit_price: '4.00', subtotal: '4.00' },
  ],
};

describe('toReceiptInput', () => {
  it('carries every charge the order made', () => {
    const input = toReceiptInput(order, { branchName: 'Coastal Grill' });
    expect(input.subtotal).toBe(20);
    expect(input.deliveryFee).toBe(3);
    expect(input.serviceFee).toBe(1);
    expect(input.total).toBe(27.6);
    expect(input.items).toEqual([
      { name: 'Pad Thai', quantity: 2, unit_price: 8, notes: 'No peanuts' },
      { name: 'Iced Tea', quantity: 1, unit_price: 4, notes: null },
    ]);
  });

  it('accounts for tax, tip and discount so the printed lines reach the total', () => {
    const input = toReceiptInput(order, { branchName: 'Coastal Grill' });
    const printed =
      input.subtotal + (input.deliveryFee ?? 0) + (input.serviceFee ?? 0) + 1.6 + 4 - 2;
    expect(printed).toBeCloseTo(input.total, 2);
    expect(input.footerNote).toBe('Tax 1.60 · Tip 4.00 · Discount -2.00');
  });

  it('omits the adjustment line when there is nothing to adjust', () => {
    const plain = toReceiptInput(
      { ...order, tax_amount: 0, tip_amount: 0, discount_amount: 0 },
      { branchName: 'Coastal Grill' },
    );
    expect(plain.footerNote).toBeUndefined();
  });

  it('drops zero fees rather than printing a 0.00 charge', () => {
    const dineIn = toReceiptInput(
      { ...order, delivery_fee: '0.00', service_fee: 0 },
      { branchName: 'Coastal Grill' },
    );
    expect(dineIn.deliveryFee).toBeUndefined();
    expect(dineIn.serviceFee).toBeUndefined();
  });

  it('prices a modified line so it reaches the subtotal, and names the options', () => {
    // 2 × a $8.00 burger with a $0.75 jalapeño costs $17.50, not $16.00. The printer only
    // multiplies, so the effective unit has to arrive already folded.
    const modified = toReceiptInput(
      {
        ...order,
        order_items: [
          {
            item_name: 'Double Smash Spicy',
            quantity: 2,
            unit_price: '8.00',
            subtotal: '17.50',
            notes: 'no onion',
            modifiers: [
              { group_id: 'g1', option_id: 'o1', name: 'Regular', price_delta: 0 },
              { group_id: 'g2', option_id: 'o2', name: 'Jalapeños', price_delta: 0.75 },
            ],
          },
        ],
      },
      { branchName: 'Coastal Grill' },
    );
    expect(modified.items).toEqual([
      {
        name: 'Double Smash Spicy',
        quantity: 2,
        unit_price: 8.75,
        notes: 'Regular, Jalapeños · no onion',
      },
    ]);
    const line = modified.items[0]!;
    expect(line.unit_price * line.quantity).toBeCloseTo(17.5, 2);
  });

  it('falls back to the base price when a line has no readable subtotal', () => {
    const broken = toReceiptInput(
      {
        ...order,
        order_items: [
          { item_name: 'Pad Thai', quantity: 2, unit_price: '8.00', subtotal: 'n/a' },
        ],
      },
      { branchName: 'Coastal Grill' },
    );
    expect(broken.items[0]!.unit_price).toBe(8);
  });

  it('says unpaid when the reader cannot see the payment row', () => {
    expect(toReceiptInput(order, { branchName: 'Coastal Grill' }).paymentMethod).toBe('unpaid');
    expect(
      toReceiptInput(order, { branchName: 'Coastal Grill', paymentMethod: 'card' }).paymentMethod,
    ).toBe('card');
  });
});

describe('formatReceiptAddress', () => {
  it('joins the parts that were filled in', () => {
    expect(formatReceiptAddress(order.delivery_address)).toBe('12 Main St, Austin, TX, 78701');
  });

  it('is null for a pickup or dine-in order', () => {
    expect(formatReceiptAddress(null)).toBeNull();
    expect(formatReceiptAddress({})).toBeNull();
  });
});
