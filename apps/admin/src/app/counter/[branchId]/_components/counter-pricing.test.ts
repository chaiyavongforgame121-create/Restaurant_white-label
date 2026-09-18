import { describe, expect, it } from 'vitest';
import {
  effectivePriceMap,
  lineSubtotal,
  quoteCounterCart,
  r2,
  unitPrice,
  type CounterQuoteInput,
} from './counter-pricing';

const base: CounterQuoteInput = {
  itemSubtotals: [],
  comboSubtotals: [],
  discountPercent: 0,
  salesTaxRate: 0,
  serviceFeePercent: 0,
  deliveryFee: 0,
  method: 'cash',
};

describe('effectivePriceMap', () => {
  it('keeps only dishes a happy hour makes cheaper, reading PostgREST numeric strings', () => {
    const map = effectivePriceMap([
      { menu_item_id: 'pad-thai', list_price: '14.95', effective_price: '7.475', discount_label: ' Happy Dinner ' },
      { menu_item_id: 'soup', list_price: 13.95, effective_price: 13.95, discount_label: null },
      { menu_item_id: 'dearer', list_price: 5, effective_price: 6 },
      { menu_item_id: null, list_price: 5, effective_price: 1 },
      { menu_item_id: 'broken', list_price: 'x', effective_price: 1 },
    ]);
    expect(map).toEqual({ 'pad-thai': { price: 7.475, label: 'Happy Dinner' } });
  });

  it('tolerates a missing answer', () => {
    expect(effectivePriceMap(null)).toEqual({});
    expect(effectivePriceMap(undefined)).toEqual({});
  });
});

describe('unitPrice / lineSubtotal', () => {
  it('rounds the happy-hour price with its options once, the way place-order does', () => {
    // place-order: r2(Number(it.price) + modDelta). 7.475 is 7.4749999… in binary.
    expect(unitPrice(7.475)).toBe(r2(7.475));
    expect(unitPrice(7.475, [{ price_delta: '1.5' }, { price_delta: 0.25 }])).toBe(r2(7.475 + 1.75));
  });

  it('rounds a line once more after the quantity', () => {
    expect(lineSubtotal(unitPrice(1.105), 3)).toBe(r2(r2(1.105) * 3));
  });
});

describe('quoteCounterCart', () => {
  it('takes the discount off the food before tax and the card fee', () => {
    const cash = quoteCounterCart({
      ...base,
      itemSubtotals: [12, 8],
      discountPercent: 10,
      salesTaxRate: 0.075,
      serviceFeePercent: 5,
    });
    expect(cash).toEqual({ subtotal: 20, discount: 2, serviceFee: 0, tax: 1.35, deliveryFee: 0, total: 19.35 });

    const card = quoteCounterCart({
      ...base,
      itemSubtotals: [12, 8],
      discountPercent: 10,
      salesTaxRate: 0.075,
      serviceFeePercent: 5,
      method: 'card',
    });
    expect(card.serviceFee).toBe(0.9);
    expect(card.total).toBe(20.25);
  });

  it('charges a QR transfer like cash: the service fee is card-only', () => {
    const input = { ...base, itemSubtotals: [10], salesTaxRate: 0.0701, serviceFeePercent: 3 };
    expect(quoteCounterCart({ ...input, method: 'transfer' })).toEqual(
      quoteCounterCart({ ...input, method: 'cash' }),
    );
  });

  it('adds the delivery fee untaxed and counts combos in the subtotal', () => {
    const q = quoteCounterCart({
      ...base,
      itemSubtotals: [4.5],
      comboSubtotals: [15.99],
      salesTaxRate: 0.1,
      deliveryFee: 3.99,
    });
    expect(q.subtotal).toBe(20.49);
    expect(q.tax).toBe(2.05);
    expect(q.total).toBe(r2(20.49 + 3.99 + 2.05));
  });

  it('clamps a nonsense discount and fee instead of going negative', () => {
    const q = quoteCounterCart({
      ...base,
      itemSubtotals: [10],
      discountPercent: 250,
      serviceFeePercent: 90,
      method: 'card',
      deliveryFee: 2,
    });
    expect(q.discount).toBe(10);
    expect(q.serviceFee).toBe(0);
    expect(q.total).toBe(2);
  });
});
