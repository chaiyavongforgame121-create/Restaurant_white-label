import { describe, expect, it } from 'vitest';
import {
  ALLERGY_RE,
  countItems,
  hasSpecialRequests,
  isRemovedOption,
  itemsLabel,
  modifierLabel,
  parseLineModifiers,
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

describe('item counting and summary', () => {
  it('counts quantities, not lines', () => {
    expect(countItems([burger, tea])).toBe(3);
    expect(itemsLabel([burger, tea])).toBe('3 items');
    expect(itemsLabel([tea])).toBe('1 item');
    expect(itemsLabel([])).toBe('0 items');
  });

  it('summarises the first two lines and counts the rest', () => {
    expect(summarizeLines([burger, tea, soup])).toBe('2× Double Smash Spicy, 1× Iced Tea +1 more');
    expect(summarizeLines([tea])).toBe('1× Iced Tea');
    expect(summarizeLines([])).toBe('');
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
