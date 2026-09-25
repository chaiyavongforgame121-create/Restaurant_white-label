import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildReceipt,
  printReceiptViaBrowser,
  receiptLineTotal,
  receiptLinesInMenuOrder,
} from '@favornoms/ui/printer';
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
  // Read in the order the diner tapped them; the trigger stamped where each sits on the menu.
  order_items: [
    {
      item_name: 'Iced Tea',
      quantity: 1,
      unit_price: '4.00',
      subtotal: '4.00',
      category_position: 11,
      item_position: 2,
    },
    {
      item_name: 'Pad Thai',
      quantity: 2,
      unit_price: '8.00',
      subtotal: '16.00',
      notes: 'No peanuts',
      category_position: 3,
      item_position: 0,
    },
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
      {
        name: 'Pad Thai',
        quantity: 2,
        unit_price: 8,
        line_total: 16,
        notes: 'No peanuts',
        category_position: 3,
        item_position: 0,
      },
      {
        name: 'Iced Tea',
        quantity: 1,
        unit_price: 4,
        line_total: 4,
        notes: null,
        category_position: 11,
        item_position: 2,
      },
    ]);
  });

  it('lists the lines category by category, the same dish with other options side by side', () => {
    // Order A-2609-0005 as it was tapped: a set, a drink, two soups, then another set.
    const set = {
      item_name: 'SET A',
      quantity: 1,
      unit_price: '15.99',
      subtotal: '15.99',
      category_position: 10,
      item_position: 0,
    };
    const soup = { quantity: 1, unit_price: '9.00', subtotal: '9.00', category_position: 2 };
    const tapped = toReceiptInput(
      {
        ...order,
        order_items: [
          { ...set, modifiers: [{ name: 'Runny-Yolk Fried Egg', price_delta: 0 }] },
          {
            item_name: 'Fountain Drink',
            quantity: 1,
            unit_price: '2.00',
            subtotal: '2.00',
            category_position: 11,
            item_position: 0,
          },
          { ...soup, item_name: 'Tom Kha Soup', item_position: 3 },
          { ...soup, item_name: 'Tom Yum Soup', item_position: 1 },
          { ...set, modifiers: [{ name: 'No Egg', price_delta: 0 }] },
        ],
      },
      { branchName: 'Food Thai Thai' },
    );
    expect(tapped.items.map((i) => [i.name, i.notes])).toEqual([
      ['Tom Yum Soup', null],
      ['Tom Kha Soup', null],
      ['SET A', 'No Egg'],
      ['SET A', 'Runny-Yolk Fried Egg'],
      ['Fountain Drink', null],
    ]);
  });

  it('prints a happy-hour line as charged, with its unit unrounded', () => {
    // The owner's bill: 7 × SET A at $7.995 was charged $55.97 and printed "7 × $8.00".
    const happy = toReceiptInput(
      {
        ...order,
        subtotal: '55.97',
        order_items: [
          { item_name: 'SET A', quantity: 7, unit_price: '7.9950', subtotal: '55.97', modifier_total: '0.00' },
        ],
      },
      { branchName: 'Food Thai Thai' },
    );
    expect(happy.items).toEqual([
      {
        name: 'SET A',
        quantity: 7,
        unit_price: 7.995,
        line_total: 55.97,
        notes: null,
        category_position: null,
        item_position: null,
      },
    ]);
    expect(happy.items.map(receiptLineTotal)).toEqual([55.97]);
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
    // 2 × a $8.00 burger with a $0.75 jalapeño costs $17.50, not $16.00. The printer prints
    // the charged line, and the unit beside it arrives with the options already folded in.
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
        line_total: 17.5,
        notes: 'Regular, Jalapeños · no onion',
        category_position: null,
        item_position: null,
      },
    ]);
    const line = modified.items[0]!;
    expect(line.unit_price * line.quantity).toBeCloseTo(17.5, 2);
    expect(receiptLineTotal(line)).toBe(17.5);
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
    expect(broken.items[0]!.line_total).toBeUndefined();
    expect(receiptLineTotal(broken.items[0]!)).toBe(16);
  });

  it('says unpaid when the reader cannot see the payment row', () => {
    expect(toReceiptInput(order, { branchName: 'Coastal Grill' }).paymentMethod).toBe('unpaid');
    expect(
      toReceiptInput(order, { branchName: 'Coastal Grill', paymentMethod: 'card' }).paymentMethod,
    ).toBe('card');
  });

  it('prints card refunds, so a reprint of a refunded card order does not read as fully paid', () => {
    const input = toReceiptInput(order, {
      branchName: 'Coastal Grill',
      paymentMethod: 'card',
      refunds: [
        { amount: 5, status: 'succeeded', createdAt: '2026-09-24T12:00:00Z' },
        { amount: 0.1, status: 'succeeded', createdAt: '2026-09-24T12:30:00Z' },
        { amount: 2.5, status: 'pending', createdAt: '2026-09-24T13:00:00Z' },
        // A refund Stripe refused moved no money and is not printed.
        { amount: 9, status: 'failed', createdAt: '2026-09-24T14:00:00Z' },
      ],
    });
    // One total per state however many refunds there were: the footer is a single line.
    expect(input.footerNote).toBe(
      'Tax 1.60 · Tip 4.00 · Discount -2.00 · Refunded -5.10 · Refund pending -2.50',
    );
    // The charged total stays what the card was charged; the refunds are their own lines.
    expect(input.total).toBe(27.6);
  });

  it('prints a refund on an order with nothing else to adjust', () => {
    const plain = toReceiptInput(
      { ...order, tax_amount: 0, tip_amount: 0, discount_amount: 0 },
      { branchName: 'Coastal Grill', refunds: [{ amount: 27.6, status: 'succeeded', createdAt: '2026-09-24T12:00:00Z' }] },
    );
    expect(plain.footerNote).toBe('Refunded -27.60');
  });
});

/**
 * Orders store numbers as E.164, and the paper used to print them that way ("+15552345678") while
 * every screen showed "+1 (555) 234-5678". The printers format them now, so the mapping keeps
 * handing over the stored value and both printers are checked here with what they actually emit.
 */
describe('printed phone numbers', () => {
  const us = { ...order, customer_phone: '+15552345678' };
  const ctx = { branchName: 'Coastal Grill', branchPhone: '+66980358264' };

  /** What printReceiptViaBrowser wrote into its print window. */
  function browserReceipt(input: ReturnType<typeof toReceiptInput>): string {
    let html = '';
    const win = {
      document: { open: () => undefined, write: (s: string) => (html = s), close: () => undefined },
      focus: () => undefined,
      print: () => undefined,
    };
    vi.useFakeTimers();
    vi.stubGlobal('window', { open: () => win });
    printReceiptViaBrowser(input);
    return html;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hands the printers the stored number, not a formatted one', () => {
    // Formatting once, in the printer, is what keeps a caller from formatting twice or not at all.
    expect(toReceiptInput(us, ctx).customerPhone).toBe('+15552345678');
  });

  it('prints the customer and branch numbers the way the screens show them (thermal)', () => {
    const paper = new TextDecoder().decode(buildReceipt(toReceiptInput(us, ctx)));
    expect(paper).toMatch(/Phone +\+1 \(555\) 234-5678/);
    expect(paper).toContain('Tel: +66 98 035 8264');
    expect(paper).not.toContain('+15552345678');
    expect(paper).not.toContain('+66980358264');
  });

  it('prints them the same way through the browser fallback', () => {
    const html = browserReceipt(toReceiptInput(us, ctx));
    expect(html).toContain('Phone    +1 (555) 234-5678');
    expect(html).toContain('Tel: +66 98 035 8264');
    expect(html).not.toContain('+15552345678');
  });

  it('prints no Phone row for the till’s walk-in stand-in', () => {
    const walkIn = toReceiptInput({ ...order, customer_phone: '+10000000000' }, { branchName: 'Coastal Grill' });
    const paper = new TextDecoder().decode(buildReceipt(walkIn));
    expect(paper).not.toMatch(/Phone|0000000000|\(000\)/);
    expect(browserReceipt(walkIn)).not.toMatch(/Phone|0000000000|\(000\)/);
  });
});

describe('receiptLinesInMenuOrder', () => {
  const line = (name: string, category_position?: number | null, item_position?: number | null) => ({
    name,
    quantity: 1,
    unit_price: 1,
    category_position,
    item_position,
  });

  it('prints lines that carry menu positions category by category', () => {
    const printed = receiptLinesInMenuOrder([line('Fountain Drink', 11, 0), line('Tom Yum Soup', 2, 1), line('SET A', 10, 0)]);
    expect(printed.map((l) => l.name)).toEqual(['Tom Yum Soup', 'SET A', 'Fountain Drink']);
  });

  it('keeps the given order for a receipt with no positions at all (the counter, the legacy POS)', () => {
    const printed = receiptLinesInMenuOrder([line('Iced Tea'), line('Burger')]);
    expect(printed.map((l) => l.name)).toEqual(['Iced Tea', 'Burger']);
  });

  it('keeps the caller order for the same dish twice', () => {
    const a = { ...line('SET A', 10, 0), notes: 'Runny-Yolk Fried Egg' };
    const b = { ...line('SET A', 10, 0), notes: 'No Egg' };
    expect(receiptLinesInMenuOrder([a, b])).toEqual([a, b]);
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
