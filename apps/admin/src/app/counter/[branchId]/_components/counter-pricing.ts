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
 * Every rounding step below is place-order's, in place-order's order: a line is rounded, then the
 * lines are summed and rounded, and so on. Summing unrounded lines instead lands a cent away often
 * enough to matter at a till.
 */

export type CounterPayMethod = 'cash' | 'card' | 'transfer';

/** place-order's r2, character for character. */
export const r2 = (n: number) => Math.round(n * 100) / 100;

/** Ceiling place-order clamps the service fee to (SERVICE_FEE_MAX_PERCENT in @favornoms/shared). */
const SERVICE_FEE_MAX_PERCENT = 25;

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
 * used unrounded -- place-order rounds once the options are added, and so does unitPrice().
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

/** One unit of a dish with its options, rounded as place-order rounds it. */
export function unitPrice(
  basePrice: number,
  modifiers?: ReadonlyArray<{ price_delta: number | string }> | null,
): number {
  const delta = (modifiers ?? []).reduce((sum, m) => sum + Number(m.price_delta), 0);
  return r2(Number(basePrice) + delta);
}

/** A line: units times quantity, rounded. place-order clamps a combo's quantity to 1..99. */
export function lineSubtotal(unit: number, quantity: number): number {
  return r2(unit * quantity);
}

export interface CounterQuoteInput {
  /** Each dish line's lineSubtotal(), in cart order. */
  itemSubtotals: readonly number[];
  /** Each combo line's lineSubtotal(), in cart order. */
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
  const itemsSum = input.itemSubtotals.reduce((sum, s) => sum + s, 0);
  const combosSum = input.comboSubtotals.reduce((sum, s) => sum + s, 0);
  const subtotal = r2(itemsSum + combosSum);

  const pct = Math.max(0, Math.min(100, Number(input.discountPercent) || 0));
  const discount = Math.min(subtotal, r2(subtotal * (pct / 100)));
  const taxableBase = Math.max(0, subtotal - discount);

  const feePct = Math.max(0, Math.min(SERVICE_FEE_MAX_PERCENT, Number(input.serviceFeePercent) || 0));
  const serviceFee = input.method === 'card' ? r2(taxableBase * (feePct / 100)) : 0;
  const tax = r2(taxableBase * (Number(input.salesTaxRate) || 0));
  const deliveryFee = r2(Math.max(0, Number(input.deliveryFee) || 0));

  // place-order's own order of addition (the tip and gift card are always zero at the till).
  const total = r2(Math.max(0, taxableBase + deliveryFee + serviceFee + tax));
  return { subtotal, discount, serviceFee, tax, deliveryFee, total };
}
