/**
 * What place-order will charge for the cart on the till, computed the way place-order computes it.
 *
 * The cashier says this number out loud and takes the money BEFORE the order exists: the notes
 * are counted, or the customer has already sent the transfer from their banking app. So the till
 * cannot learn the price from the server afterwards -- it has to arrive at the same cent first.
 * Two things made it disagree:
 *
 *   - Happy hour. place-order re-prices every dish through get_effective_prices, and the till
 *     quoted the list price. During Food Thai Thai's "Happy Dinner" (Pad Thai at half price) the
 *     customer paid the list price, the order recorded the happy-hour one, and the till showed
 *     "quote mismatch" and printed no receipt.
 *   - The discount. The till took its percentage off the server's total afterwards, so tax and the
 *     card fee stayed on the undiscounted food, and a browser then overwrote orders.total. The
 *     percentage now travels to place-order, which takes it off the food BEFORE tax and the fee.
 *
 * Every rounding step below is place-order's, in place-order's order: a line is rounded to the cent
 * once (lineTotal, never the unit before it: half of $15.99 is $7.995, and seven of them are
 * $55.97, not 7 x $8.00), the lines are summed exactly, and tax and the fee are rounded from that.
 * Summing unrounded lines instead lands a cent away often enough to matter at a till.
 */

import {
  comboLineSignature,
  lineTotal,
  MAX_LINE_QUANTITY,
  mergeIdenticalLines,
  optionLineSignature,
  SERVICE_FEE_MAX_PERCENT,
  sumMoney,
  unitPrice4,
} from '@favornoms/shared';

export type CounterPayMethod = 'cash' | 'card' | 'transfer';

/** place-order's r2, character for character. */
export const r2 = (n: number) => Math.round(n * 100) / 100;

/** One row of get_effective_prices. numeric columns arrive as strings over PostgREST. */
export interface EffectivePriceRow {
  menu_item_id: string | null;
  list_price: number | string | null;
  effective_price: number | string | null;
  discount_label?: string | null;
}

/** A dish that is cheaper right now, and the name of the happy hour that makes it so. */
export interface EffectivePrice {
  price: number;
  label: string | null;
}

/**
 * The dishes whose price is lower right now, by menu item id.
 *
 * The same rule as place-order: only a LOWER effective price replaces the list price, and it is
 * used unrounded -- place-order rounds only the line, once the options and the quantity are in,
 * and so does lineSubtotal().
 */
export function effectivePriceMap(
  rows: readonly EffectivePriceRow[] | null | undefined,
): Record<string, EffectivePrice> {
  const out: Record<string, EffectivePrice> = {};
  for (const row of rows ?? []) {
    if (!row?.menu_item_id) continue;
    const eff = Number(row.effective_price);
    const list = Number(row.list_price);
    if (Number.isFinite(eff) && Number.isFinite(list) && eff < list) {
      out[row.menu_item_id] = { price: eff, label: row.discount_label?.trim() || null };
    }
  }
  return out;
}

/**
 * One unit of a dish with its options, to the four decimals place-order stores it at. Not money
 * yet, so never rounded to the cent: a happy-hour $7.995 with a $1.50 option is $9.495.
 */
export function unitPrice(
  basePrice: number,
  modifiers?: ReadonlyArray<{ price_delta: number | string }> | null,
): number {
  const delta = (modifiers ?? []).reduce((sum, m) => sum + Number(m.price_delta), 0);
  return unitPrice4(Number(basePrice) + delta);
}

/**
 * A line: units times quantity, rounded to the cent once (place-order's lineTotal). `unit` already
 * carries the options, so none are added here. place-order holds a combo's quantity to 1..99.
 */
export function lineSubtotal(unit: number, quantity: number): number {
  return lineTotal(unit, 0, quantity);
}

/** What the till needs of one of its cart lines to tell selections apart and price them. */
export interface CounterCartLine {
  /** Absent on carts parked before the till could sell a combo, which were all items. */
  kind?: 'item' | 'combo';
  /** The menu item id, or for a combo line the combo_set id. */
  menuItemId: string;
  /** One unit, options included (unitPrice() above). */
  unitPrice: number;
  quantity: number;
  modifiers?: ReadonlyArray<{ option_id: string }> | null;
  notes?: string | null;
}

/**
 * Which selection a till line is: the dish, the SET of options on it (in any order) and its
 * trimmed note, or the combo and its note. The key place-order consolidates the order on
 * (consolidateOrderLines in @favornoms/shared), so the till merges, quotes and prints lines the
 * way the bill will have them.
 */
export function counterLineKey(line: Pick<CounterCartLine, 'kind' | 'menuItemId' | 'modifiers' | 'notes'>): string {
  return line.kind === 'combo'
    ? comboLineSignature(line.menuItemId, line.notes)
    : optionLineSignature(
        line.menuItemId,
        (line.modifiers ?? []).map((m) => m.option_id),
        line.notes,
      );
}

/**
 * The cart with `line` added: onto the line of the same selection when there is one (its
 * quantity added, and its unit price and options as just rung up; the line keeps its id and its
 * place), else as a new line at the end. A combo never lands on a dish line, even one sharing its
 * id.
 *
 * The options are the same ones (that is what the key says), but what each adds is read fresh
 * every time the item sheet opens. The till re-prices a line's unit from the live menu and the
 * line's own option deltas, so keeping the first add's deltas quoted a raised option at its old
 * price, and place-order charged the new one.
 */
export function addCounterLine<L extends CounterCartLine>(lines: readonly L[], line: L): L[] {
  const key = counterLineKey(line);
  const existing = lines.find((l) => counterLineKey(l) === key);
  // Held to MAX_LINE_QUANTITY, which place-order enforces per line after folding the same way.
  if (!existing) return [...lines, { ...line, quantity: Math.min(MAX_LINE_QUANTITY, line.quantity) }];
  return lines.map((l) =>
    l === existing
      ? {
          ...l,
          unitPrice: line.unitPrice,
          modifiers: line.modifiers,
          quantity: Math.min(MAX_LINE_QUANTITY, l.quantity + line.quantity),
        }
      : l,
  );
}

/**
 * Each line's subtotal as place-order will charge it, dishes and combos apart, for
 * quoteCounterCart. Lines of one selection are priced as the ONE line place-order makes of them,
 * because a line is rounded once on its whole quantity: two lines of one $7.995 SET A are $8.00 +
 * $8.00 = $16.00, one line of two is $15.99, and the till has to name the cent it is charged.
 */
export function counterLineSubtotals(lines: readonly CounterCartLine[]): {
  itemSubtotals: number[];
  comboSubtotals: number[];
} {
  const merged = mergeIdenticalLines(lines, counterLineKey);
  return {
    itemSubtotals: merged
      .filter((l) => l.kind !== 'combo')
      .map((l) => lineSubtotal(l.unitPrice, l.quantity)),
    comboSubtotals: merged
      .filter((l) => l.kind === 'combo')
      .map((l) => lineSubtotal(l.unitPrice, l.quantity)),
  };
}

export interface CounterQuoteInput {
  /** Each dish line's lineSubtotal(), lines of one selection priced as one (counterLineSubtotals). */
  itemSubtotals: readonly number[];
  /** Each combo line's lineSubtotal(), the same way. */
  comboSubtotals: readonly number[];
  /** The till's discount, a whole percentage 0..100. */
  discountPercent: number;
  /** branches.sales_tax_rate as a decimal (0.0701 = 7.01%). */
  salesTaxRate: number;
  /** branches.settings.service_fee_percent. Card only. */
  serviceFeePercent: number;
  /** Zero off delivery; the quoted or flat fee on it. */
  deliveryFee: number;
  method: CounterPayMethod;
}

export interface CounterQuote {
  subtotal: number;
  discount: number;
  serviceFee: number;
  tax: number;
  deliveryFee: number;
  total: number;
}

export function quoteCounterCart(input: CounterQuoteInput): CounterQuote {
  // The lines added up exactly: each is whole cents already, so nothing more is rounded.
  const subtotal = sumMoney([...input.itemSubtotals, ...input.comboSubtotals]);

  const pct = Math.max(0, Math.min(100, Number(input.discountPercent) || 0));
  const discount = Math.min(subtotal, r2(subtotal * (pct / 100)));
  const taxableBase = Math.max(0, subtotal - discount);

  // The one ceiling in @favornoms/shared (the US 3% card-surcharge cap), not a copy of it: a
  // private 25 here kept quoting a branch saved at 5% at 5% after the cap came down to 3, so the
  // till would ask a card customer for more than place-order charges.
  const feePct = Math.max(0, Math.min(SERVICE_FEE_MAX_PERCENT, Number(input.serviceFeePercent) || 0));
  const serviceFee = input.method === 'card' ? r2(taxableBase * (feePct / 100)) : 0;
  const tax = r2(taxableBase * (Number(input.salesTaxRate) || 0));
  const deliveryFee = r2(Math.max(0, Number(input.deliveryFee) || 0));

  // place-order's own order of addition (the tip and gift card are always zero at the till).
  const total = r2(Math.max(0, taxableBase + deliveryFee + serviceFee + tax));
  return { subtotal, discount, serviceFee, tax, deliveryFee, total };
}
