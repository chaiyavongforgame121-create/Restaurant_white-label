import { describe, expect, it } from 'vitest';
import { consolidateOrderLines, lineTotal, sumMoney } from '@favornoms/shared';
import {
  addCounterLine,
  counterLineKey,
  counterLineSubtotals,
  effectivePriceMap,
  lineSubtotal,
  quoteCounterCart,
  r2,
  unitPrice,
  type CounterCartLine,
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
  it('keeps the happy-hour price with its options to four decimals, never the cent', () => {
    // place-order stores unit_price to four decimals: half of $14.95 is $7.475, not $7.48.
    expect(unitPrice(7.475)).toBe(7.475);
    expect(unitPrice(7.475, [{ price_delta: '1.5' }, { price_delta: 0.25 }])).toBe(9.225);
    expect(unitPrice(15.99 * 0.5)).toBe(7.995);
  });

  it('rounds the line once, after the quantity (place-order lineTotal)', () => {
    // The owner's bill: 7 x SET A at $7.995 is $55.97. Rounding the unit first said $56.00.
    expect(lineSubtotal(unitPrice(15.99 * 0.5), 7)).toBe(55.97);
    expect(lineSubtotal(unitPrice(15.99 * 0.5), 1)).toBe(8);
    // 1.105 x 3 = 3.315 -> 3.32; r2(1.105) x 3 would have been 3.30 or 3.33.
    expect(lineSubtotal(unitPrice(1.105), 3)).toBe(3.32);
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
      serviceFeePercent: 3,
      method: 'card',
    });
    // 3% of the discounted $18.00, not of the $20.00 before the discount.
    expect(card.serviceFee).toBe(0.54);
    expect(card.total).toBe(19.89);
  });

  it('quotes a branch saved above the 3% card-surcharge cap at 3%, as place-order charges it', () => {
    // Live branches were saved at 5% under the old 25% ceiling.
    const input = { ...base, itemSubtotals: [20], method: 'card' as const };
    expect(quoteCounterCart({ ...input, serviceFeePercent: 5 }).serviceFee).toBe(0.6);
    expect(quoteCounterCart({ ...input, serviceFeePercent: 5 })).toEqual(
      quoteCounterCart({ ...input, serviceFeePercent: 3 }),
    );
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

  it('quotes a happy-hour cart at the cent place-order charges', () => {
    const q = quoteCounterCart({
      ...base,
      itemSubtotals: [lineSubtotal(unitPrice(15.99 * 0.5), 7), lineSubtotal(unitPrice(2.5), 1)],
      salesTaxRate: 0.1,
    });
    expect(q.subtotal).toBe(58.47);
    expect(q.tax).toBe(5.85);
    expect(q.total).toBe(64.32);
  });

  it('adds the lines as whole cents, with no float tail', () => {
    expect(quoteCounterCart({ ...base, itemSubtotals: [0.1, 0.2] }).subtotal).toBe(0.3);
  });

  it('prices two lines of one selection as the one line place-order bills', () => {
    // place-order folds them into 2 x $7.995 = $15.99; quoting $8.00 + $8.00 would ask for a cent
    // more than the order records, and the till would flag its own sale as a mismatch.
    const setA = unitPrice(15.99 * 0.5);
    const q = quoteCounterCart({
      ...base,
      ...counterLineSubtotals([
        { menuItemId: 'set-a', unitPrice: setA, quantity: 1, modifiers: [{ option_id: 'no-egg' }] },
        { menuItemId: 'set-a', unitPrice: setA, quantity: 1, modifiers: [{ option_id: 'no-egg' }], notes: ' ' },
      ]),
    });
    expect(q.subtotal).toBe(15.99);
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

type TestLine = CounterCartLine & { id: string };

const dish = (id: string, optionIds: string[] = [], notes?: string, quantity = 1, price = 7.995): TestLine => ({
  id,
  menuItemId: 'set-a',
  unitPrice: price,
  quantity,
  modifiers: optionIds.map((option_id) => ({ option_id })),
  notes,
});

const deal = (id: string, notes?: string, quantity = 1): TestLine => ({
  id,
  kind: 'combo',
  menuItemId: 'lunch',
  unitPrice: 9.99,
  quantity,
  notes,
});

describe('counterLineKey', () => {
  it('ignores the order options were tapped in and a blank or padded note', () => {
    expect(counterLineKey(dish('a', ['medium', 'chicken']))).toBe(counterLineKey(dish('b', ['chicken', 'medium'], '  ')));
    expect(counterLineKey(dish('a', [], ' no salt '))).toBe(counterLineKey(dish('b', [], 'no salt')));
  });

  it('tells different options, notes, dishes and combos apart', () => {
    expect(counterLineKey(dish('a', ['no-egg']))).not.toBe(counterLineKey(dish('b', ['runny-egg'])));
    expect(counterLineKey(dish('a', [], 'no salt'))).not.toBe(counterLineKey(dish('b')));
    expect(counterLineKey({ ...dish('a'), menuItemId: 'lunch' })).not.toBe(counterLineKey(deal('b')));
  });

  it('reads a cart parked before the till could sell a combo, with no kind, as dishes', () => {
    const parked = { menuItemId: 'set-a', modifiers: undefined, notes: undefined };
    expect(counterLineKey(parked)).toBe(counterLineKey(dish('a')));
  });
});

describe('addCounterLine', () => {
  it('holds a line to 99, which place-order enforces after folding', () => {
    let cart: TestLine[] = [];
    cart = addCounterLine(cart, dish('1', ['no-egg'], undefined, 60));
    cart = addCounterLine(cart, dish('2', ['no-egg'], undefined, 50));
    cart = addCounterLine(cart, dish('3', ['egg'], undefined, 120));
    expect(cart.map((l) => [l.id, l.quantity])).toEqual([
      ['1', 99],
      ['3', 99],
    ]);
  });

  it('adds the same selection to the line already in the cart', () => {
    let cart: TestLine[] = [];
    cart = addCounterLine(cart, dish('1', ['no-egg'], undefined, 7));
    cart = addCounterLine(cart, { ...dish('2'), menuItemId: 'tom-yum', unitPrice: 15.99 });
    cart = addCounterLine(cart, dish('3', ['no-egg'], ''));
    expect(cart.map((l) => [l.id, l.quantity])).toEqual([
      ['1', 8],
      ['2', 1],
    ]);
  });

  it('takes the unit and the option prices as just rung up, keeping the line id and place', () => {
    // The fried egg went from +$2.00 to +$2.50 between the two adds. The till re-prices a line
    // from the live dish and the line's own option deltas, so the merged line has to carry the
    // new delta, or the till quotes $2.00 for eggs place-order charges at $2.50.
    type Priced = Omit<CounterCartLine, 'modifiers'> & {
      id: string;
      modifiers: Array<{ option_id: string; price_delta: number }>;
    };
    const withEgg = (id: string, delta: number, unitPrice: number, quantity = 1): Priced => ({
      id,
      menuItemId: 'set-a',
      unitPrice,
      quantity,
      modifiers: [{ option_id: 'egg', price_delta: delta }],
    });
    let cart: Priced[] = [];
    cart = addCounterLine(cart, withEgg('1', 2, 17.99, 7));
    cart = addCounterLine(cart, { ...withEgg('2', 0, 15.99), menuItemId: 'tom-yum', modifiers: [] });
    cart = addCounterLine(cart, withEgg('3', 2.5, 18.49));
    expect(cart.map((l) => [l.id, l.quantity, l.unitPrice, l.modifiers.map((m) => m.price_delta)])).toEqual([
      ['1', 8, 18.49, [2.5]],
      ['2', 1, 15.99, []],
    ]);
  });

  it('keeps different options apart, as the bill will', () => {
    let cart: TestLine[] = [];
    cart = addCounterLine(cart, dish('1', ['no-egg'], undefined, 7));
    cart = addCounterLine(cart, dish('2', ['runny-egg']));
    expect(cart.map((l) => [l.id, l.quantity])).toEqual([
      ['1', 7],
      ['2', 1],
    ]);
  });

  it('merges the same deal with the same note, and never a deal into a dish', () => {
    let cart: TestLine[] = [];
    cart = addCounterLine(cart, deal('1'));
    cart = addCounterLine(cart, deal('2', undefined, 2));
    cart = addCounterLine(cart, deal('3', 'no ice'));
    cart = addCounterLine(cart, { ...dish('4'), menuItemId: 'lunch' });
    expect(cart.map((l) => [l.id, l.quantity])).toEqual([
      ['1', 3],
      ['3', 1],
      ['4', 1],
    ]);
  });
});

describe('counterLineSubtotals', () => {
  it('matches what place-order charges for the same lines, consolidated', () => {
    const lines: TestLine[] = [
      dish('1', ['no-egg'], undefined, 1),
      deal('2'),
      dish('3', ['no-egg'], '  ', 2),
      dish('4', ['runny-egg'], undefined, 1, 9.995),
      deal('5'),
    ];
    const { itemSubtotals, comboSubtotals } = counterLineSubtotals(lines);
    expect(itemSubtotals).toEqual([23.99, 10]);
    expect(comboSubtotals).toEqual([19.98]);

    // place-order's side: consolidate the payload, then lineTotal each line at its unit price.
    const unitOf = new Map([['no-egg', 7.995], ['runny-egg', 9.995]]);
    const sent = consolidateOrderLines(
      lines
        .filter((l) => l.kind !== 'combo')
        .map((l) => ({
          menu_item_id: l.menuItemId,
          quantity: l.quantity,
          notes: l.notes,
          modifier_option_ids: (l.modifiers ?? []).map((m) => m.option_id),
        })),
      lines.filter((l) => l.kind === 'combo').map((l) => ({ combo_id: l.menuItemId, quantity: l.quantity, notes: l.notes })),
    );
    const charged = sumMoney([
      ...sent.items.map((l) => lineTotal(unitOf.get(l.modifier_option_ids[0]!)!, 0, l.quantity)),
      ...sent.combos.map((c) => lineTotal(9.99, 0, c.quantity)),
    ]);
    expect(quoteCounterCart({ ...base, itemSubtotals, comboSubtotals }).subtotal).toBe(charged);
  });
});
