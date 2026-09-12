import { describe, expect, it } from 'vitest';
import {
  changeDue,
  digitsOnly,
  quickTender,
  readNumericField,
  splitBill,
  summariseSplit,
} from './counter-math';

const sum = (parts: number[]) => Math.round(parts.reduce((s, p) => s + p * 100, 0)) / 100;

describe('splitBill', () => {
  it('is the bug report: $4.82 four ways is not $2.00 each', () => {
    const parts = splitBill(4.82, 4);
    expect(parts).toEqual([1.21, 1.21, 1.2, 1.2]);
    expect(sum(parts)).toBe(4.82);
    // Math.ceil(4.82 / 4) === 2, which is what the till used to print.
    expect(parts.every((p) => p < 2)).toBe(true);
  });

  it('adds back up to the total for every way of splitting a range of bills', () => {
    for (let cents = 0; cents <= 20_000; cents += 7) {
      const total = cents / 100;
      for (let ways = 1; ways <= 20; ways++) {
        expect(sum(splitBill(total, ways))).toBe(total);
      }
    }
  });

  it('never spreads the parts by more than a cent', () => {
    for (let cents = 1; cents <= 5_000; cents += 13) {
      for (let ways = 2; ways <= 12; ways++) {
        const parts = splitBill(cents / 100, ways);
        const spread = Math.round((Math.max(...parts) - Math.min(...parts)) * 100);
        expect(spread === 0 || spread === 1).toBe(true);
      }
    }
  });

  it('divides evenly when it can', () => {
    expect(splitBill(10, 4)).toEqual([2.5, 2.5, 2.5, 2.5]);
    expect(splitBill(9.99, 3)).toEqual([3.33, 3.33, 3.33]);
  });

  it('gives the whole bill to one person when not split', () => {
    expect(splitBill(4.82, 1)).toEqual([4.82]);
  });

  it('treats a zero or nonsense way-count as one person rather than dividing by it', () => {
    expect(splitBill(4.82, 0)).toEqual([4.82]);
    expect(splitBill(4.82, -3)).toEqual([4.82]);
    expect(splitBill(4.82, Number.NaN)).toEqual([4.82]);
  });

  it('has nothing to hand out for a zero bill', () => {
    expect(splitBill(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it('does not let float noise create a phantom cent', () => {
    // 0.1 + 0.2 territory: 3 x 0.29 is 0.8699999999999999 in binary floating point.
    expect(sum(splitBill(0.87, 3))).toBe(0.87);
    expect(splitBill(0.87, 3)).toEqual([0.29, 0.29, 0.29]);
  });
});

describe('summariseSplit', () => {
  it('collapses an even split to one tier', () => {
    const s = summariseSplit(10, 4);
    expect(s.even).toBe(true);
    expect(s.tiers).toEqual([{ amount: 2.5, people: 4 }]);
    expect(s.total).toBe(10);
  });

  it('reports the uneven split as who pays what, biggest share first', () => {
    const s = summariseSplit(4.82, 4);
    expect(s.even).toBe(false);
    expect(s.tiers).toEqual([
      { amount: 1.21, people: 2 },
      { amount: 1.2, people: 2 },
    ]);
    expect(s.total).toBe(4.82);
  });

  it('never produces more than two tiers, because the parts differ by a cent at most', () => {
    for (let cents = 1; cents <= 3_000; cents += 11) {
      for (let ways = 1; ways <= 15; ways++) {
        expect(summariseSplit(cents / 100, ways).tiers.length).toBeLessThanOrEqual(2);
      }
    }
  });

  it('tier people always add up to the number of ways', () => {
    for (let ways = 1; ways <= 20; ways++) {
      const s = summariseSplit(37.77, ways);
      expect(s.tiers.reduce((n, t) => n + t.people, 0)).toBe(ways);
    }
  });
});

describe('readNumericField', () => {
  const discount = { min: 0, max: 100, empty: 0 };

  it('lets an emptied field mean empty instead of snapping back to zero', () => {
    expect(readNumericField('', discount)).toBe(0);
    expect(readNumericField('   ', discount)).toBe(0);
  });

  it('clamps to the range', () => {
    expect(readNumericField('150', discount)).toBe(100);
    expect(readNumericField('-5', discount)).toBe(0);
    expect(readNumericField('15', discount)).toBe(15);
  });

  it('falls back for anything that is not a finite number', () => {
    expect(readNumericField('abc', discount)).toBe(0);
    // Number('1e999') is Infinity. Clamping it would read as a deliberate 100% discount;
    // falling back to empty is the only safe reading of a field nobody meant to fill.
    expect(readNumericField('1e999', discount)).toBe(0);
  });

  it('uses its own empty value, so Split reads as one person rather than zero people', () => {
    const split = { min: 1, max: 20, empty: 1 };
    expect(readNumericField('', split)).toBe(1);
    expect(readNumericField('0', split)).toBe(1);
    expect(readNumericField('25', split)).toBe(20);
  });
});

describe('digitsOnly', () => {
  it('keeps the digits and drops everything else', () => {
    expect(digitsOnly('12')).toBe('12');
    expect(digitsOnly('1a2')).toBe('12');
    expect(digitsOnly('-5')).toBe('5');
    expect(digitsOnly('')).toBe('');
  });
});

describe('changeDue', () => {
  it('is what goes back in the customer\u2019s hand', () => {
    expect(changeDue(20, 18.75)).toBe(1.25);
    expect(changeDue(60, 59.39)).toBe(0.61);
  });

  it('is zero on the nose for exact money', () => {
    expect(changeDue(18.75, 18.75)).toBe(0);
  });

  it('goes negative while they are still short, rather than reading zero', () => {
    expect(changeDue(10, 18.75)).toBe(-8.75);
  });

  it('does not leak float dust', () => {
    expect(changeDue(0.3, 0.1)).toBe(0.2);
    expect(changeDue(100, 0.07)).toBe(99.93);
  });
});

describe('quickTender', () => {
  it('offers the exact amount first', () => {
    expect(quickTender(18.75)[0]).toBe(18.75);
  });

  it('rounds up to the next dollar before reaching for notes', () => {
    expect(quickTender(18.75)).toContain(19);
  });

  it('offers notes that actually cover the bill', () => {
    const opts = quickTender(18.75);
    expect(opts.every((o) => o >= 18.75)).toBe(true);
    expect(opts).toEqual([18.75, 19, 20, 50, 100]);
  });

  it('does not offer a note equal to an exact total twice', () => {
    const opts = quickTender(20);
    expect(new Set(opts).size).toBe(opts.length);
    expect(opts[0]).toBe(20);
  });

  it('stays short enough to fit a row of buttons', () => {
    for (const total of [0.5, 4.82, 17, 59.39, 123.45, 999.99]) {
      expect(quickTender(total).length).toBeLessThanOrEqual(5);
    }
  });

  it('has nothing to offer on a zero bill', () => {
    expect(quickTender(0)).toEqual([]);
    expect(quickTender(-5)).toEqual([]);
  });

  it('is always ascending', () => {
    for (const total of [1.01, 6.5, 21, 76.25]) {
      const opts = quickTender(total);
      expect([...opts].sort((a, b) => a - b)).toEqual(opts);
    }
  });
});
