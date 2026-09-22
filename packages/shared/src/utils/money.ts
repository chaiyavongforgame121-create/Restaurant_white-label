/**
 * Money on an order line, rounded once and only where money actually changes hands.
 *
 * A UNIT price is not money yet. A percent happy hour makes one out of a list price, and half of
 * $15.99 is $7.995: a price nobody pays on its own, only as part of a line. Rounding it to $8.00
 * first and multiplying after is what put "7 x $8.00 = $56.00" on Food Thai Thai's bill while the
 * cart line above it read $55.97 (7 x 7.995 = 55.965). So:
 *
 *   - a unit price carries up to four decimals and is never rounded to the cent;
 *   - a LINE is money: (unit + options) x quantity, rounded half-up to the cent exactly once;
 *   - an order's subtotal is the exact sum of its lines, with nothing rounded after that.
 *
 * Tax, fees, discounts and the total are computed from that subtotal and stay in cents as before.
 * On screen a unit price goes through formatUnitPrice (beside formatCurrency in ./index), which
 * shows the extra decimals instead of rounding them away.
 *
 * supabase/functions/place-order is the authoritative writer and mirrors lineTotal() by hand,
 * because a Deno edge function cannot import this package. The two must be edited together;
 * money.test.ts pins this side of the pair.
 */

/** Postgres round(): half away from zero, so a negative amount mirrors a positive one. */
function roundHalfUp(n: number): number {
  // `+ 0` turns the -0 that Math.round(-0.2) leaves behind into a plain 0.
  return (n < 0 ? -Math.round(-n) : Math.round(n)) + 0;
}

/**
 * A unit price to four decimals, the precision order_items.unit_price and get_effective_prices
 * keep. Four is enough for any whole or half percent off a two-decimal price (15.99 x 67% =
 * 10.7133), and it wipes the float dust (7.995 arrives as 7.99500000000000010658...).
 */
export function unitPrice4(n: number): number {
  return roundHalfUp(Number(n) * 10000) / 10000;
}

/**
 * What one line costs: (unit + options) x quantity, rounded half-up to the cent once.
 *
 * Worked in whole ten-thousandths so no float product decides a cent: 7.995 x 7 is 559,650
 * ten-thousandths, 5,596.5 cents, charged as $55.97. `modifierDelta` is the sum of the chosen
 * options' price_delta, or the options themselves.
 */
export function lineTotal(
  unitPrice: number,
  modifierDelta: number | readonly number[],
  quantity: number,
): number {
  const delta =
    typeof modifierDelta === 'number'
      ? modifierDelta
      : modifierDelta.reduce((sum, d) => sum + (Number(d) || 0), 0);
  const u4 = roundHalfUp((Number(unitPrice) + (Number(delta) || 0)) * 10000);
  const qty = Number(quantity) || 0;
  return roundHalfUp((u4 * qty) / 100) / 100;
}

/**
 * The exact sum of amounts that are already money (line totals, fees): added as whole cents, so
 * 0.1 + 0.2 is 0.3 and not 0.30000000000000004. Nothing is rounded beyond the cent each amount
 * already is.
 */
export function sumMoney(amounts: Iterable<number>): number {
  let cents = 0;
  for (const a of amounts) cents += roundHalfUp(Number(a) * 100);
  return cents / 100;
}

/** A stored order_items row as a bill needs it. Money columns arrive as strings over PostgREST. */
export interface StoredOrderLine {
  unit_price: number | string;
  quantity: number | string;
  /** What the line was charged, options included: the authority on every bill. */
  subtotal: number | string;
  /** The options' share of `subtotal` (price_delta x quantity). Absent reads as none. */
  modifier_total?: number | string | null;
}

/**
 * The unit price to print beside a stored line, options included, so the bill reads
 * "7 x $7.995 = $55.97" and adds up.
 *
 * unit_price is the plain dish; the options live in modifier_total. When the two reproduce the
 * charged subtotal they are the unit. When they cannot (a row from before modifier_total was
 * kept, a line edited by hand) the charged line is split evenly instead, to four decimals, so
 * the bill still agrees with what was paid. Never subtotal / quantity rounded to the cent:
 * $55.97 / 7 is $7.9957, which rounds to the $8.00 the owner saw on the bill.
 */
export function orderLineUnitPrice(line: StoredOrderLine): number {
  const qty = Math.max(1, Number(line.quantity) || 1);
  const charged = Number(line.subtotal);
  const perUnitOptions = line.modifier_total == null ? 0 : (Number(line.modifier_total) || 0) / qty;
  const unit = unitPrice4(Number(line.unit_price) + perUnitOptions);
  if (!Number.isFinite(charged)) return Number.isFinite(unit) ? unit : 0;
  const cents = (n: number) => roundHalfUp(n * 100);
  if (Number.isFinite(unit) && cents(lineTotal(unit, 0, qty)) === cents(charged)) return unit;
  return unitPrice4(charged / qty);
}
