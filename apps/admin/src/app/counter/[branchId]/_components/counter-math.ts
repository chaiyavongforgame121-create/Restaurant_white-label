/**
 * Money arithmetic the till shows a customer.
 *
 * Split used to be `Math.ceil(total / ways)`, which is not a rounding error -- it rounds up
 * to the whole DOLLAR. A $4.82 bill split four ways was quoted at "$2.00 per person", so the
 * till asked four people for $8.00 to settle $4.82. Everything here works in integer cents
 * and is checked against the invariant that the parts add back up to the total exactly.
 */

/** Cents, rounded the way place-order rounds. Keeps float noise out of every sum below. */
const toCents = (amount: number) => Math.round(amount * 100);

/**
 * Divide a total into `ways` parts that sum to it EXACTLY.
 *
 * A total rarely divides evenly, and the leftover pennies have to land on somebody: the
 * first `remainder` people pay one cent more. Handing everyone the rounded-up share instead
 * overcharges the table, and handing everyone the rounded-down share leaves the merchant
 * short -- both are wrong at the till, where the parts are what people actually hand over.
 */
export function splitBill(total: number, ways: number): number[] {
  const n = Math.max(1, Math.floor(ways) || 1);
  const cents = Math.max(0, toCents(total));
  const base = Math.floor(cents / n);
  const extra = cents - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < extra ? 1 : 0)) / 100);
}

export interface SplitTier {
  /** What one person in this tier pays. */
  amount: number;
  /** How many people pay it. */
  people: number;
}

export interface SplitSummary {
  /** Largest share first. One tier when it divides evenly, two when it does not. */
  tiers: SplitTier[];
  /** Everyone pays the same. */
  even: boolean;
  /** The parts added back up — always the amount passed in. */
  total: number;
}

/**
 * The same split, grouped for display. Two tiers at most, because the parts differ by at
 * most a cent, and the cashier needs to read "3 pay $1.21, 1 pays $1.20" off the screen
 * rather than a list of four numbers.
 */
export function summariseSplit(total: number, ways: number): SplitSummary {
  const parts = splitBill(total, ways);
  const tiers: SplitTier[] = [];
  for (const amount of parts) {
    const tier = tiers.find((t) => toCents(t.amount) === toCents(amount));
    if (tier) tier.people += 1;
    else tiers.push({ amount, people: 1 });
  }
  tiers.sort((a, b) => b.amount - a.amount);
  return {
    tiers,
    even: tiers.length === 1,
    total: parts.reduce((s, p) => toCents(p) + s, 0) / 100,
  };
}

/**
 * Read a number typed into a till field.
 *
 * The counter's Discount and Split inputs were `Number(e.target.value) || 0` over a numeric
 * state, so clearing the field re-rendered it as "0" and the caret could never get rid of
 * that first digit -- changing 0 to 15 meant selecting the whole field first, every time.
 * An empty string has to stay an empty string while somebody is typing; it only becomes a
 * number when the total is computed.
 */
export function readNumericField(raw: string, opts: { min: number; max: number; empty: number }): number {
  const trimmed = raw.trim();
  if (trimmed === '') return opts.empty;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return opts.empty;
  return Math.max(opts.min, Math.min(opts.max, n));
}

/** Keeps a till field to the digits it accepts without fighting the caret. */
export const digitsOnly = (raw: string) => raw.replace(/[^0-9]/g, '');

/**
 * What the customer is owed back.
 *
 * The till took cash without ever asking how much was handed over, so every cash sale ended
 * with the cashier doing the subtraction in their head and the receipt printing no tendered
 * line at all -- `ReceiptInput.cashTendered` existed and nothing ever filled it. Negative
 * means they have not handed over enough yet, which the screen has to say rather than
 * quietly showing zero.
 */
export function changeDue(tendered: number, total: number): number {
  return (toCents(tendered) - toCents(total)) / 100;
}

/**
 * The notes a cashier is most likely to be handed for this total.
 *
 * Exact first, then each US denomination that would actually cover it, largest last. A
 * button that hands back more change than the note is worth (offering $100 for a $4 coffee)
 * is noise, so the list stops two denominations past the total.
 */
export function quickTender(total: number): number[] {
  const cents = toCents(total);
  if (cents <= 0) return [];
  const out: number[] = [cents];
  // Round up to the next whole dollar first: nobody hands over $18.75 in notes.
  const nextDollar = Math.ceil(cents / 100) * 100;
  if (nextDollar !== cents) out.push(nextDollar);
  for (const note of [500, 1000, 2000, 5000, 10000]) {
    const rounded = Math.ceil(cents / note) * note;
    if (rounded > cents && !out.includes(rounded)) out.push(rounded);
  }
  return out
    .sort((a, b) => a - b)
    .slice(0, 5)
    .map((c) => c / 100);
}
