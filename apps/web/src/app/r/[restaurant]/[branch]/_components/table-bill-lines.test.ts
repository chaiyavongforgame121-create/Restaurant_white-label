import { describe, expect, it } from 'vitest';
import { billLineOptions, billOptionLabel } from './table-bill-lines';

describe('billOptionLabel', () => {
  it('prints a free option by name alone', () => {
    expect(billOptionLabel({ name: 'No Egg', price_delta: 0 })).toBe('No Egg');
  });

  it('prints what an option adds, or takes off, the way the cart does', () => {
    expect(billOptionLabel({ name: 'Runny-Yolk Fried Egg', price_delta: 2 })).toBe('Runny-Yolk Fried Egg (+$2.00)');
    expect(billOptionLabel({ name: 'No cheese', price_delta: -0.5 })).toBe('No cheese (-$0.50)');
  });

  it('reads a delta that arrives as a string, and ignores one that is not a number', () => {
    expect(billOptionLabel({ name: 'Large', price_delta: '1.5' as unknown as number })).toBe('Large (+$1.50)');
    expect(billOptionLabel({ name: 'Odd', price_delta: 'abc' as unknown as number })).toBe('Odd');
  });
});

describe('billLineOptions', () => {
  it('tells the two SET A lines of order #0005 apart', () => {
    const noEgg = { options: [{ name: 'No Egg', price_delta: 0 }] };
    const friedEgg = { options: [{ name: 'Runny-Yolk Fried Egg', price_delta: 2 }] };
    expect(billLineOptions(noEgg)).toEqual(['No Egg']);
    expect(billLineOptions(friedEgg)).toEqual(['Runny-Yolk Fried Egg (+$2.00)']);
  });

  it('keeps the order the options were chosen in', () => {
    const soup = {
      options: [
        { name: 'Medium', price_delta: 0 },
        { name: 'Jasmine Rice', price_delta: 0 },
        { name: 'Chicken', price_delta: 0 },
      ],
    };
    expect(billLineOptions(soup)).toEqual(['Medium', 'Jasmine Rice', 'Chicken']);
  });

  it('is empty for a line without options, or a bill that does not send them', () => {
    expect(billLineOptions({ options: [] })).toEqual([]);
    expect(billLineOptions({})).toEqual([]);
    expect(billLineOptions({ options: null })).toEqual([]);
  });

  it('skips an entry without a name', () => {
    expect(billLineOptions({ options: [null, { name: '  ', price_delta: 1 }, { name: ' Bowl ', price_delta: 0 }] })).toEqual([
      'Bowl',
    ]);
  });
});
