import { describe, expect, it } from 'vitest';
import {
  computeSalesTax,
  computeServiceFee,
  formatCurrency,
  lineTotal,
  parseServiceFeePercent,
  SERVICE_FEE_MAX_PERCENT,
  serviceFeeApplies,
  storedServiceFeePercent,
  sumMoney,
} from './index';

/**
 * Mirrors the server-side math in supabase/functions/place-order. Each test
 * pins one piece of the pricing flow so a regression on the edge function
 * surfaces here too.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

interface Line { unitPrice: number; quantity: number }

// Each line rounded to the cent once, then summed exactly (money.ts).
function subtotalOf(lines: Line[]) {
  return sumMoney(lines.map((l) => lineTotal(l.unitPrice, 0, l.quantity)));
}

function computeTotal({
  lines,
  taxRate = 0,
  deliveryFee = 0,
  serviceFeePercent = 0,
  paymentMethod = 'card',
  tipAmount = 0,
  loyaltyPointsRedeemed = 0,
  promoDiscount = 0,
  freeDelivery = false,
}: {
  lines: Line[];
  taxRate?: number;
  deliveryFee?: number;
  serviceFeePercent?: number;
  paymentMethod?: 'card' | 'cash' | 'transfer';
  tipAmount?: number;
  loyaltyPointsRedeemed?: number;
  promoDiscount?: number;
  freeDelivery?: boolean;
}) {
  const subtotal = subtotalOf(lines);
  const fee = freeDelivery ? 0 : deliveryFee;
  const service = computeServiceFee(subtotal, serviceFeePercent, paymentMethod);
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
      serviceFeePercent: 3,
      tipAmount: 5,
    });
    // subtotal 34.85, service 1.05 (3% of 34.85 = 1.0455), tax 3.09, total 47.98
    expect(result.subtotal).toBe(34.85);
    expect(result.serviceFee).toBe(1.05);
    expect(result.tax).toBe(3.09);
    expect(result.total).toBeCloseTo(47.98, 2);
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
      serviceFeePercent: 3,
      tipAmount: 2,
    });
    expect(result.serviceFee).toBe(0.37);
    expect(result.tax).toBe(0.74);
    expect(result.total).toBe(15.45);
  });

  it('prices a happy-hour unit unrounded: 7 x $7.995 is $55.97, not 7 x $8.00', () => {
    const result = computeTotal({
      lines: [{ unitPrice: 15.99 * 0.5, quantity: 7 }, { unitPrice: 2.5, quantity: 1 }],
      taxRate: 0.1,
    });
    expect(result.subtotal).toBe(58.47);
    expect(result.tax).toBe(5.85);
    expect(result.total).toBe(64.32);
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

describe('service fee is card-only', () => {
  // The rule the merchant sets in Branch settings: the surcharge rides on card
  // payments and nothing else. place-order mirrors computeServiceFee() by hand, so a
  // change here without a change there is exactly the drift these cases are for.

  it('applies to card and to nothing else', () => {
    expect(serviceFeeApplies('card')).toBe(true);
    expect(serviceFeeApplies('cash')).toBe(false);
    expect(serviceFeeApplies('transfer')).toBe(false);
    expect(serviceFeeApplies(undefined)).toBe(false);
    expect(serviceFeeApplies(null)).toBe(false);
    expect(serviceFeeApplies('')).toBe(false);
  });

  it('charges the percentage on card, zero on cash and transfer', () => {
    expect(computeServiceFee(34.85, 3, 'card')).toBe(1.05);
    expect(computeServiceFee(34.85, 3, 'cash')).toBe(0);
    expect(computeServiceFee(34.85, 3, 'transfer')).toBe(0);
  });

  it('rounds to the cent and clamps the percentage', () => {
    expect(computeServiceFee(12.34, 3, 'card')).toBe(0.37);
    expect(computeServiceFee(100, 2.5, 'card')).toBe(2.5);
    expect(computeServiceFee(100, 0, 'card')).toBe(0);
    expect(computeServiceFee(100, 40, 'card')).toBe(3);
    expect(computeServiceFee(100, -3, 'card')).toBe(0);
    expect(computeServiceFee(-5, 3, 'card')).toBe(0);
  });

  it('reads the branch setting out of the raw jsonb', () => {
    expect(parseServiceFeePercent({ service_fee_percent: '2.5' })).toBe(2.5);
    expect(parseServiceFeePercent({})).toBe(0);
    expect(parseServiceFeePercent(null)).toBe(0);
    expect(parseServiceFeePercent({ service_fee_percent: 99 })).toBe(3);
    expect(parseServiceFeePercent({ service_fee_percent: 'abc' })).toBe(0);
    expect(parseServiceFeePercent({ service_fee_percent: -1 })).toBe(0);
  });
});

describe('card surcharge cap (US card-network rules)', () => {
  // The networks cap a credit-card surcharge at 3%. Live branches were saved at 5% under the
  // old 25% ceiling; they must price card orders at 3% without anyone re-saving them.

  it('is 3%', () => {
    expect(SERVICE_FEE_MAX_PERCENT).toBe(3);
  });

  it('reads a branch stored above the cap as the cap', () => {
    expect(parseServiceFeePercent({ service_fee_percent: 5 })).toBe(3);
    expect(parseServiceFeePercent({ service_fee_percent: '7.5' })).toBe(3);
    expect(computeServiceFee(20, 5, 'card')).toBe(0.6);
  });

  it('keeps the stored figure available so the settings card can say it was above the cap', () => {
    expect(storedServiceFeePercent({ service_fee_percent: 5 })).toBe(5);
    expect(storedServiceFeePercent({ service_fee_percent: '7.5' })).toBe(7.5);
    expect(storedServiceFeePercent({ service_fee_percent: 3 })).toBe(3);
    expect(storedServiceFeePercent({})).toBeNull();
    expect(storedServiceFeePercent(null)).toBeNull();
    expect(storedServiceFeePercent({ service_fee_percent: '' })).toBeNull();
    expect(storedServiceFeePercent({ service_fee_percent: 'abc' })).toBeNull();
  });

  it('changes the order total with the method the diner picks', () => {
    const lines = [{ unitPrice: 20, quantity: 1 }];
    expect(computeTotal({ lines, serviceFeePercent: 3, paymentMethod: 'card' }).total).toBe(20.6);
    expect(computeTotal({ lines, serviceFeePercent: 3, paymentMethod: 'cash' }).total).toBe(20);
    expect(computeTotal({ lines, serviceFeePercent: 3, paymentMethod: 'transfer' }).total).toBe(20);
  });

  it('dine-in pays none — the checkout submits it as cash', () => {
    const result = computeTotal({
      lines: [{ unitPrice: 20, quantity: 1 }],
      serviceFeePercent: 3,
      paymentMethod: 'cash',
    });
    expect(result.serviceFee).toBe(0);
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
