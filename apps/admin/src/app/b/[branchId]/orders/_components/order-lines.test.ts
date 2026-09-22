import { describe, expect, it } from 'vitest';
import {
  ALLERGY_RE,
  countItems,
  hasSpecialRequests,
  isRemovedOption,
  lineUnitPrice,
  modifierLabel,
  parseLineModifiers,
  refundLineAmount,
  summarizeLines,
  type OrderLine,
} from './order-lines';

/**
 * The orders list shows staff what a diner asked for without opening the receipt. These
 * pin the jsonb parsing so a row written by place-order, a row written by hand, and a row
 * of garbage all render something sensible instead of blanking the list.
 */

// The shape place-order writes, copied from a live row.
const burger: OrderLine = {
  id: 'l1',
  item_name: 'Double Smash Spicy',
  quantity: 2,
  unit_price: '8.00',
  subtotal: '17.50',
  modifiers: [
    { group_id: 'g1', option_id: 'o1', name: 'Regular', price_delta: 0 },
    { group_id: 'g2', option_id: 'o2', name: 'Jalapeños', price_delta: 0.75 },
  ],
  notes: null,
};
const tea: OrderLine = {
  id: 'l2',
  item_name: 'Iced Tea',
  quantity: 1,
  unit_price: '4.00',
  subtotal: '4.00',
  modifiers: [],
  notes: 'less ice',
};
const soup: OrderLine = {
  id: 'l3',
  item_name: 'Tom Yum',
  quantity: 1,
  unit_price: '9.00',
  subtotal: '9.00',
  modifiers: [],
  notes: null,
};

describe('parseLineModifiers', () => {
  it('reads the place-order shape', () => {
    expect(parseLineModifiers(burger.modifiers)).toEqual([
      { name: 'Regular', priceDelta: 0 },
      { name: 'Jalapeños', priceDelta: 0.75 },
    ]);
  });

  it('tolerates strings, label/option_name keys and garbage', () => {
    expect(
      parseLineModifiers([
        'Extra rice',
        { label: 'No onion', price: '0.5' },
        { option_name: 'Large' },
        { name: 'Broken', price_delta: 'abc' },
        42,
        null,
        {},
        '   ',
      ]),
    ).toEqual([
      { name: 'Extra rice', priceDelta: 0 },
      { name: 'No onion', priceDelta: 0.5 },
      { name: 'Large', priceDelta: 0 },
      { name: 'Broken', priceDelta: 0 },
    ]);
    expect(parseLineModifiers(null)).toEqual([]);
    expect(parseLineModifiers(undefined)).toEqual([]);
    expect(parseLineModifiers('not json')).toEqual([]);
  });

  it('accepts an object keyed by group, which is how a hand-written row tends to look', () => {
    expect(parseLineModifiers({ size: { name: 'Large', price_delta: 1 } })).toEqual([
      { name: 'Large', priceDelta: 1 },
    ]);
  });
});

describe('modifierLabel', () => {
  it('prices paid options and leaves free ones bare', () => {
    expect(modifierLabel({ name: 'Jalapeños', priceDelta: 0.75 }, 'USD')).toBe(
      'Jalapeños (+$0.75)',
    );
    expect(modifierLabel({ name: 'No cheese', priceDelta: -0.5 }, 'USD')).toBe(
      'No cheese (−$0.50)',
    );
    expect(modifierLabel({ name: 'Regular', priceDelta: 0 }, 'USD')).toBe('Regular');
  });

  it('formats in the branch currency, not a hard-coded dollar', () => {
    // Asserted in pieces because Intl puts a non-breaking space between a letter
    // currency code and the amount, and a typed space here looks identical to it.
    const thb = modifierLabel({ name: 'ฟฟฟ', priceDelta: 1 }, 'THB');
    expect(thb.startsWith('ฟฟฟ (+THB')).toBe(true);
    expect(thb.endsWith('1.00)')).toBe(true);
    expect(thb).not.toContain('$');
  });
});

describe('isRemovedOption', () => {
  it('spots the subtractions the kitchen board tints red', () => {
    expect(isRemovedOption('No cheese')).toBe(true);
    expect(isRemovedOption('without ice')).toBe(true);
    expect(isRemovedOption('no-onion')).toBe(true);
    expect(isRemovedOption('Normal spice')).toBe(false);
    expect(isRemovedOption('Jalapeños')).toBe(false);
  });
});

// Food Thai Thai, 2026-09: SET A ($15.99) at the 50% happy hour, seven of them. The line was
// charged $55.97; the bill printed "7 × $8.00".
const setA: OrderLine = {
  id: 'l4',
  item_name: 'SET A : Green Curry Chicken',
  quantity: 7,
  unit_price: '7.9950',
  subtotal: '55.97',
  modifiers: [],
  notes: null,
};

describe('lineUnitPrice', () => {
  it('prints the four-decimal unit a happy hour made, not the line split and rounded', () => {
    expect(lineUnitPrice(setA)).toBe(7.995);
  });

  it('folds the options in so quantity × unit reaches the line', () => {
    // From the modifiers jsonb when modifier_total was not read...
    expect(lineUnitPrice(burger)).toBe(8.75);
    // ...and from modifier_total when it was.
    expect(lineUnitPrice({ ...burger, modifiers: [], modifier_total: '1.50' })).toBe(8.75);
  });

  it('reads a line charged before unit prices kept their decimals as it was charged', () => {
    expect(lineUnitPrice({ ...setA, unit_price: '8.00', subtotal: '56.00' })).toBe(8);
  });
});

describe('refundLineAmount', () => {
  it('gives back exactly what the whole line was charged', () => {
    expect(refundLineAmount(setA, 7)).toBe(55.97);
    expect(refundLineAmount(burger, 2)).toBe(17.5);
  });

  it('prices part of a line as a line of its own, rounded once', () => {
    expect(refundLineAmount(setA, 1)).toBe(8);
    expect(refundLineAmount(setA, 3)).toBe(23.99); // 3 × 7.995 = 23.985
    expect(refundLineAmount(burger, 1)).toBe(8.75);
  });

  it('is nothing for nothing, and never more than the line', () => {
    expect(refundLineAmount(setA, 0)).toBe(0);
    expect(refundLineAmount(setA, -2)).toBe(0);
    expect(refundLineAmount(setA, 99)).toBe(55.97);
  });
});

describe('item counting and summary', () => {
  it('counts quantities, not lines', () => {
    // The row words this with an ICU plural ("3 items", "3 món"), so only the number is pinned.
    expect(countItems([burger, tea])).toBe(3);
    expect(countItems([tea])).toBe(1);
    expect(countItems([])).toBe(0);
  });

  it('summarises the first two lines and counts the rest', () => {
    expect(summarizeLines([burger, tea, soup])).toEqual({
      shown: '2× Double Smash Spicy, 1× Iced Tea',
      more: 1,
    });
    expect(summarizeLines([tea])).toEqual({ shown: '1× Iced Tea', more: 0 });
    expect(summarizeLines([])).toEqual({ shown: '', more: 0 });
  });

  it('carries no interface words, only the merchant’s dish names', () => {
    const { shown } = summarizeLines([burger, tea, soup]);
    expect(shown).not.toMatch(/more|items?\b/);
  });
});

describe('hasSpecialRequests', () => {
  it('is true for an option, a line note or an order note, false for plain lines', () => {
    expect(hasSpecialRequests([burger], [null])).toBe(true);
    expect(hasSpecialRequests([tea], [])).toBe(true);
    expect(hasSpecialRequests([soup], ['no peanuts'])).toBe(true);
    expect(hasSpecialRequests([soup], [null, '  ', undefined])).toBe(false);
  });
});

describe('ALLERGY_RE', () => {
  it('matches the kitchen board words and the Thai word for allergic', () => {
    expect(ALLERGY_RE.test('No peanuts please')).toBe(true);
    expect(ALLERGY_RE.test('แพ้กุ้ง')).toBe(true);
    expect(ALLERGY_RE.test('เผ็ดๆ')).toBe(false);
    expect(ALLERGY_RE.test('less ice')).toBe(false);
  });
});
