// What a diner ordered, for the back-office orders list.
//
// order_items.modifiers is jsonb written by place-order as
//   [{ group_id, option_id, name, price_delta }]
// (that is the shape of every live row as of 2026-09-06). The parser still accepts the
// looser shapes the kitchen board tolerates — bare strings, {label}/{option_name} — because
// a jsonb column has no schema and one odd row must not blank the list for the whole day.
//
// Nothing here returns interface words. Counts and summaries come back as numbers and the
// merchant's own dish names; the row puts them into a sentence in the reader's language.
import { formatCurrency, lineTotal, orderLineUnitPrice } from '@favornoms/shared';

export interface OrderLineModifier {
  name: string;
  priceDelta: number;
}

/** One order_items row as the list needs it. Money columns arrive as strings over PostgREST. */
export interface OrderLine {
  id: string;
  item_name: string;
  quantity: number;
  unit_price: number | string;
  subtotal: number | string;
  modifiers: unknown;
  notes: string | null;
  combo_id?: string | null;
  /** Where the dish sits on the menu; the list shows lines in that order (sortOrderLines). */
  category_position?: number | null;
  item_position?: number | null;
  created_at?: string | null;
}

export function parseLineModifiers(raw: unknown): OrderLineModifier[] {
  let entries: unknown[] = [];
  if (Array.isArray(raw)) entries = raw;
  else if (raw && typeof raw === 'object') entries = Object.values(raw as Record<string, unknown>);
  const out: OrderLineModifier[] = [];
  for (const entry of entries) {
    if (entry == null) continue;
    if (typeof entry === 'string') {
      if (entry.trim()) out.push({ name: entry.trim(), priceDelta: 0 });
      continue;
    }
    if (typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const name = [o.name, o.label, o.option_name, o.title, o.value].find(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    if (!name) continue;
    const delta = Number(o.price_delta ?? o.price ?? o.extra_price ?? 0);
    out.push({ name: name.trim(), priceDelta: Number.isFinite(delta) ? delta : 0 });
  }
  return out;
}

/** What lineUnitPrice and refundLineAmount need of an order_items row. */
export interface PricedLine {
  unit_price: number | string;
  quantity: number | string;
  subtotal: number | string;
  modifiers?: unknown;
  modifier_total?: number | string | null;
}

/**
 * The unit printed beside a line, options included, to four decimals: "7 × $7.995" beside a
 * $55.97 line. It used to be the charged line divided by the quantity and rounded to the cent,
 * which printed $55.97 / 7 as $8.00, the "7 × $8.00" the owner saw on the bill.
 *
 * The options' share is order_items.modifier_total where the query read it, else the price_delta
 * of each option in the modifiers jsonb (the kitchen tolerates rows with neither, so this does).
 */
export function lineUnitPrice(line: PricedLine): number {
  const qty = Math.max(1, Number(line.quantity) || 1);
  const modifierTotal =
    line.modifier_total != null
      ? line.modifier_total
      : parseLineModifiers(line.modifiers).reduce((sum, m) => sum + m.priceDelta, 0) * qty;
  return orderLineUnitPrice({
    unit_price: line.unit_price,
    quantity: qty,
    subtotal: line.subtotal,
    modifier_total: modifierTotal,
  });
}

/**
 * What giving back `refundQty` of a line is worth. All of it is exactly what the line was
 * charged; part of it is that many units priced as a line of their own (rounded once, like
 * place-order), never a unit rounded to the cent and multiplied.
 */
export function refundLineAmount(line: PricedLine, refundQty: number): number {
  const qty = Math.max(0, Number(line.quantity) || 0);
  const n = Math.max(0, Math.min(qty, Math.floor(Number(refundQty) || 0)));
  if (n === 0) return 0;
  const charged = Number(line.subtotal);
  if (n === qty && Number.isFinite(charged)) return charged;
  return lineTotal(lineUnitPrice(line), 0, n);
}

/** "Jalapeños (+$0.75)", "No cheese (−$0.50)", or just "Regular" when the option is free. */
export function modifierLabel(m: OrderLineModifier, currency: string): string {
  if (m.priceDelta === 0) return m.name;
  const sign = m.priceDelta > 0 ? '+' : '−';
  return `${m.name} (${sign}${formatCurrency(Math.abs(m.priceDelta), currency)})`;
}

/**
 * A "No cheese" option is a subtraction, not an extra. The kitchen board already tells the
 * two apart with the same test, so a chip that is red on the pass is red in the office.
 */
export function isRemovedOption(name: string): boolean {
  return /^(no|without|no-)\b/i.test(name.trim());
}

/** Sum of quantities — 2× Pad Thai + 1× Tea is "3 items", which is how a diner counts. */
export function countItems(lines: OrderLine[]): number {
  return lines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
}

export interface LinesSummary {
  /** "2× Pad Thai, 1× Iced Tea": quantities and the dish names exactly as the merchant typed them. */
  shown: string;
  /** How many lines were left out of `shown`; the row words it ("+1 more") in the reader's language. */
  more: number;
}

/** The first `max` lines, and how many were left out. */
export function summarizeLines(lines: OrderLine[], max = 2): LinesSummary {
  const shown = lines.slice(0, max).map((l) => `${l.quantity}× ${l.item_name}`);
  return { shown: shown.join(', '), more: lines.length - shown.length };
}

/**
 * True when anything beyond names and quantities was recorded — an option, a per-line
 * note or an order-level note — so the row can carry a "has requests" marker.
 */
export function hasSpecialRequests(
  lines: OrderLine[],
  orderNotes: Array<string | null | undefined>,
): boolean {
  if (orderNotes.some((n) => typeof n === 'string' && n.trim().length > 0)) return true;
  return lines.some(
    (l) =>
      (l.notes != null && l.notes.trim().length > 0) || parseLineModifiers(l.modifiers).length > 0,
  );
}

// Same rule as the kitchen board (kitchen-view.tsx ALLERGY_RE) plus the Thai word for
// "allergic", so a note is red on both screens.
export const ALLERGY_RE =
  /allerg|peanut|\bnut\b|gluten|shellfish|dairy|lactose|sesame|\bsoy\b|vegan|coeliac|celiac|แพ้/i;
