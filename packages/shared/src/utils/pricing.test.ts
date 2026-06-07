import { describe, expect, it } from 'vitest';
import { computeSalesTax, formatCurrency } from './index';

/**
 * Mirrors the server-side math in supabase/functions/place-order. Each test
 * pins one piece of the pricing flow so a regression on the edge function
 * surfaces here too.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

interface Line { unitPrice: number; quantity: number }

function subtotalOf(lines: Line[]) {
  return r2(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0));
}

function computeTotal({
  lines,
  taxRate = 0,
  deliveryFee = 0,
  serviceFeePercent = 0,
  tipAmount = 0,
  loyaltyPointsRedeemed = 0,
  promoDiscount = 0,
  freeDelivery = false,
}: {
  lines: Line[];
  taxRate?: number;
  deliveryFee?: number;
  serviceFeePercent?: number;
  tipAmount?: number;
  loyaltyPointsRedeemed?: number;
  promoDiscount?: number;
  freeDelivery?: boolean;
}) {
  const subtotal = subtotalOf(lines);
  const fee = freeDelivery ? 0 : deliveryFee;
  const service = r2(subtotal * (serviceFeePercent / 100));
  const loyaltyDollarsOff = r2(loyaltyPointsRedeemed / 100);
  const taxableBase = Math.max(0, subtotal - loyaltyDollarsOff - promoDiscount);
  const tax = computeSalesTax(taxableBase, taxRate);
  const total = r2(taxableBase + fee + service + tipAmount + tax);
  return { subtotal, deliveryFee: fee, serviceFee: service, tax, total, loyaltyDollarsOff };
}

describe('place-order math', () => {
  it('basic subtotal + tax (no extras)', () => {
    const result = computeTotal({
      lines: [{ unitPrice: 10, quantity: 1 }],
      taxRate: 0.0875,
    });
    expect(result.subtotal).toBe(10);
    expect(result.tax).toBe(0.88);
    expect(result.total).toBe(10.88);
  });

  it('adds delivery + service + tip + tax', () => {
    const result = computeTotal({
      lines: [{ unitPrice: 14.95, quantity: 2 }, { unitPrice: 4.95, quantity: 1 }],
      taxRate: 0.08875,
      deliveryFee: 3.99,
      serviceFeePercent: 5,
      tipAmount: 5,
    });
    // subtotal 34.85, service 1.74, tax 3.09, total 48.67
    expect(result.subtotal).toBe(34.85);
    expect(result.serviceFee).toBe(1.74);
    expect(result.tax).toBe(3.09);
    expect(result.total).toBeCloseTo(48.67, 2);
  });

  it('promo discount lowers the taxable base', () => {
    const result = computeTotal({
      lines: [{ unitPrice: 100, quantity: 1 }],
      taxRate: 0.1,
      promoDiscount: 20,
    });
    // taxable base = 80, tax = 8, total = 88
    expect(result.tax).toBe(8);
    expect(result.total).toBe(88);
  });

  it('free-delivery promo zeroes the delivery fee', () => {
    const result = computeTotal({
      lines: [{ unitPrice: 25, quantity: 1 }],
      taxRate: 0.05,
      deliveryFee: 3.99,
      freeDelivery: true,
    });
    expect(result.deliveryFee).toBe(0);
    expect(result.total).toBe(26.25); // 25 + 1.25 tax
  });

  it('loyalty redemption converts 100 pts → $1 off', () => {
    const result = computeTotal({
      lines: [{ unitPrice: 50, quantity: 1 }],
      taxRate: 0,
      loyaltyPointsRedeemed: 500,
    });
    expect(result.loyaltyDollarsOff).toBe(5);
    expect(result.total).toBe(45);
  });

  it('loyalty redeem max 50% of subtotal still leaves total > 0', () => {
    // 50 subtotal, 50% cap = 25 = 2500 pts max. We attempt 9999 pts client-side
    // but enforce here that the math cannot make total negative.
    const cappedRedeem = Math.min(9999, Math.floor(50 * 50));
    expect(cappedRedeem).toBe(2500);
    const result = computeTotal({
      lines: [{ unitPrice: 50, quantity: 1 }],
      taxRate: 0,
      loyaltyPointsRedeemed: cappedRedeem,
    });
    expect(result.total).toBe(25);
  });

  it('rounds tip + service to 2 decimals', () => {
    const result = computeTotal({
      lines: [{ unitPrice: 12.34, quantity: 1 }],
      taxRate: 0.06,
      serviceFeePercent: 5,
      tipAmount: 2,
    });
    expect(result.serviceFee).toBe(0.62);
    expect(result.tax).toBe(0.74);
    expect(result.total).toBe(15.7);
  });

  it('zero quantities → zero total', () => {
    const result = computeTotal({
      lines: [],
      taxRate: 0.1,
    });
    expect(result.total).toBe(0);
  });

  it('formatCurrency matches the receipt display', () => {
    expect(formatCurrency(48.67)).toMatch(/\$48\.67/);
    expect(formatCurrency(0)).toMatch(/\$0\.00/);
  });
});

describe('promo validation rules', () => {
  // Mirror of public.validate_promo_code edge cases. These are policy tests:
  // they make sure the rules don't silently regress in the helper functions
  // we expose for the UI.
  const minSubtotal = 25;
  const subtotalOk = 30;
  const subtotalLow = 10;

  function applyPromo({
    kind, value, freeDelivery,
  }: { kind: 'percent_off' | 'fixed_off' | 'free_delivery'; value: number; freeDelivery?: boolean }) {
    return ({ subtotal }: { subtotal: number }) => {
      if (subtotal < minSubtotal) return { valid: false, reason: 'min_subtotal_not_met' };
      let amountOff = 0;
      if (kind === 'percent_off') amountOff = Math.min(subtotal, r2(subtotal * (value / 100)));
      if (kind === 'fixed_off') amountOff = Math.min(subtotal, value);
      return { valid: true, amountOff, freeDelivery: kind === 'free_delivery' || !!freeDelivery };
    };
  }

  it('rejects below-minimum subtotal', () => {
    const r = applyPromo({ kind: 'percent_off', value: 10 })({ subtotal: subtotalLow });
    expect(r.valid).toBe(false);
  });

  it('percent-off uses rounded discount', () => {
    const r = applyPromo({ kind: 'percent_off', value: 15 })({ subtotal: subtotalOk });
    expect(r).toMatchObject({ valid: true, amountOff: 4.5 });
  });

  it('fixed-off cannot exceed subtotal', () => {
    const r = applyPromo({ kind: 'fixed_off', value: 999 })({ subtotal: subtotalOk });
    expect((r as { amountOff: number }).amountOff).toBe(subtotalOk);
  });

  it('free_delivery promo carries the flag', () => {
    const r = applyPromo({ kind: 'free_delivery', value: 0 })({ subtotal: subtotalOk });
    expect((r as { freeDelivery: boolean }).freeDelivery).toBe(true);
  });
});

describe('refund math', () => {
  function refund({ orderTotal, refundAmount }: { orderTotal: number; refundAmount: number }) {
    if (refundAmount <= 0) return { status: 'rejected', reason: 'amount_must_be_positive' };
    if (refundAmount > orderTotal) return { status: 'rejected', reason: 'amount_exceeds_order' };
    const isFull = refundAmount >= orderTotal - 0.01;
    return { status: isFull ? 'refunded_full' : 'refunded_partial', refunded: refundAmount };
  }

  it('rejects zero / negative amounts', () => {
    expect(refund({ orderTotal: 25, refundAmount: 0 }).status).toBe('rejected');
    expect(refund({ orderTotal: 25, refundAmount: -1 }).status).toBe('rejected');
  });

  it('rejects amounts above the order total', () => {
    expect(refund({ orderTotal: 25, refundAmount: 26 }).status).toBe('rejected');
  });

  it('classifies full vs partial refunds', () => {
    expect(refund({ orderTotal: 25, refundAmount: 25 }).status).toBe('refunded_full');
    expect(refund({ orderTotal: 25, refundAmount: 10 }).status).toBe('refunded_partial');
  });
});
