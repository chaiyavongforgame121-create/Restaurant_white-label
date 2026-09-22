import { describe, expect, it } from 'vitest';
import {
  formatCurrency,
  formatUnitPrice,
  lineTotal,
  orderLineUnitPrice,
  sumMoney,
  unitPrice4,
} from './index';

/**
 * Food Thai Thai, 2026-09: SET A (list $15.99) at a 50% happy hour is $7.995. Seven of them showed
 * $55.97 on the cart line and $56.00 everywhere after it, because the unit was rounded to $8.00
 * before it was multiplied. place-order mirrors lineTotal() by hand; these pin this side.
 */
describe('unitPrice4', () => {
  it('keeps a happy-hour price to four decimals and drops the float dust', () => {
    expect(unitPrice4(15.99 * 0.5)).toBe(7.995);
    expect(unitPrice4(15.99 * (1 - 33 / 100))).toBe(10.7133);
    expect(unitPrice4(8)).toBe(8);
    expect(unitPrice4(0.1 + 0.2)).toBe(0.3);
  });

  it('rounds a fifth decimal half-up, as Postgres round(x, 4) does', () => {
    expect(unitPrice4(15.99 * (1 - 33.33 / 100))).toBe(10.6605); // 10.660533
    expect(unitPrice4(1.23455)).toBe(1.2346);
  });
});

describe('lineTotal', () => {
  it('charges 7 x $7.995 as $55.97, not 7 x $8.00', () => {
    expect(lineTotal(7.995, 0, 7)).toBe(55.97);
  });

  it('rounds half a cent up on a line of one', () => {
    expect(lineTotal(7.995, 0, 1)).toBe(8);
    expect(lineTotal(7.995, 0, 2)).toBe(15.99);
  });

  it('rounds once, after the quantity: a third off $15.99, three of them', () => {
    // 10.7133 x 3 = 32.1399. Rounding the unit first would say 10.71 x 3 = 32.13.
    expect(lineTotal(15.99 * (1 - 33 / 100), 0, 3)).toBe(32.14);
  });

  it('adds the options to the unit before multiplying', () => {
    expect(lineTotal(7.995, 1.5, 2)).toBe(18.99); // 9.495 x 2
    expect(lineTotal(7.995, [1.5, 0.25, -0.5], 3)).toBe(27.74); // 9.245 x 3 = 27.735
    expect(lineTotal(10, [], 2)).toBe(20);
  });

  it('does not let float drift pick the cent', () => {
    // 0.1 + 0.2 is 0.30000000000000004 as a double; a line of three is still 0.90.
    expect(lineTotal(0.1, 0.2, 3)).toBe(0.9);
    expect(lineTotal(1.005, 0, 1)).toBe(1.01); // 1.005 is 1.00499999... in binary
    expect(lineTotal(14.95, 0, 2)).toBe(29.9);
  });

  it('is zero for a quantity of zero', () => {
    expect(lineTotal(7.995, 1.5, 0)).toBe(0);
    expect(Object.is(lineTotal(7.995, 0, 0), 0)).toBe(true);
  });
});

describe('sumMoney', () => {
  it('adds amounts as whole cents', () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([55.97, 0.25, 0.33])).toBe(56.55);
    expect(sumMoney([])).toBe(0);
  });

  it('never rounds the sum of the lines any further', () => {
    const lines = [lineTotal(7.995, 0, 7), lineTotal(7.995, 0, 1)];
    expect(sumMoney(lines)).toBe(63.97); // 55.97 + 8.00
  });
});

describe('orderLineUnitPrice', () => {
  it('shows the stored four-decimal unit, not the charged line split and rounded', () => {
    const line = { unit_price: '7.9950', quantity: 7, subtotal: '55.97', modifier_total: '0.00' };
    expect(orderLineUnitPrice(line)).toBe(7.995);
  });

  it('puts the options into the unit so quantity x unit reaches the line', () => {
    // 2 x ($8.00 + $0.75) = $17.50: the plain $8.00 beside a $17.50 line cannot add up.
    expect(orderLineUnitPrice({ unit_price: 8, quantity: 2, subtotal: 17.5, modifier_total: 1.5 })).toBe(8.75);
    expect(orderLineUnitPrice({ unit_price: 7.995, quantity: 3, subtotal: 27.74, modifier_total: 3.75 })).toBe(9.245);
  });

  it('reads an order placed before units kept their decimals as it was charged', () => {
    expect(orderLineUnitPrice({ unit_price: '8.00', quantity: 7, subtotal: '56.00', modifier_total: 0 })).toBe(8);
  });

  it('splits the charged line to four decimals when the stored parts do not reproduce it', () => {
    // No modifier_total on the row: the options are only in the subtotal.
    expect(orderLineUnitPrice({ unit_price: 8, quantity: 2, subtotal: 17.5 })).toBe(8.75);
    expect(orderLineUnitPrice({ unit_price: 1, quantity: 7, subtotal: 55.97 })).toBe(7.9957);
  });

  it('survives a zero or unreadable quantity and an unreadable subtotal', () => {
    expect(orderLineUnitPrice({ unit_price: 5, quantity: 0, subtotal: 5 })).toBe(5);
    expect(orderLineUnitPrice({ unit_price: 5, quantity: 2, subtotal: 'x' })).toBe(5);
  });
});

describe('formatUnitPrice', () => {
  it('shows the decimals a unit price has, two at least', () => {
    expect(formatUnitPrice(7.995)).toBe('$7.995');
    expect(formatUnitPrice(8)).toBe('$8.00');
    expect(formatUnitPrice(15.99)).toBe('$15.99');
    expect(formatUnitPrice(10.7133)).toBe('$10.7133');
    expect(formatUnitPrice(15.99 * 0.5)).toBe('$7.995');
  });

  it('matches formatCurrency on a two-decimal price', () => {
    expect(formatUnitPrice(12.5)).toBe(formatCurrency(12.5));
    expect(formatUnitPrice(0)).toBe(formatCurrency(0));
  });

  it('keeps a zero-decimal currency whole', () => {
    expect(formatUnitPrice(155, 'JPY')).toBe('¥155');
    expect(formatUnitPrice(77.5, 'JPY')).toBe('¥77.5');
  });
});
