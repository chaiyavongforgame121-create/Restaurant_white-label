import type { ReceiptInput } from '@favornoms/ui/printer';
import { parseLineModifiers } from './order-lines';

export interface ReceiptOrderItem {
  item_name: string;
  quantity: number;
  unit_price: number | string;
  subtotal: number | string;
  notes?: string | null;
  /** order_items.modifiers jsonb — the options the diner picked, priced into subtotal. */
  modifiers?: unknown;
}

/** The order shape a receipt needs — money columns arrive as strings over PostgREST. */
export interface ReceiptOrder {
  order_number: string;
  status: string;
  channel: string;
  created_at: string;
  subtotal: number | string;
  delivery_fee: number | string;
  service_fee: number | string;
  tax_amount: number | string;
  tip_amount: number | string;
  discount_amount: number | string;
  total: number | string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: Record<string, unknown> | null;
  order_items: ReceiptOrderItem[];
}

export interface ReceiptContext {
  branchName: string;
  branchAddress?: string | null;
  branchPhone?: string | null;
  /** payments.method for the settled payment, when the reader may see payments at all. */
  paymentMethod?: string | null;
  currency?: string;
}

const num = (v: number | string) => Number(v);

/**
 * orders.delivery_address is the jsonb the storefront writes (line1/line2/city/state/
 * postal_code). A delivery receipt with no address on it is the one a driver cannot use.
 */
export function formatReceiptAddress(address: Record<string, unknown> | null): string | null {
  if (!address) return null;
  const parts = ['line1', 'line2', 'city', 'state', 'postal_code']
    .map((key) => (typeof address[key] === 'string' ? (address[key] as string).trim() : ''))
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Map an order onto the printer package's ReceiptInput, so the back office puts the same
 * 80mm receipt on paper that the counter already prints after a sale.
 *
 * A zero fee is passed as undefined rather than 0 because buildReceipt tests truthiness —
 * either way the row is omitted, but undefined says "there was no delivery charge" instead
 * of asserting a $0.00 one.
 */
export function toReceiptInput(order: ReceiptOrder, ctx: ReceiptContext): ReceiptInput {
  const tax = num(order.tax_amount);
  const tip = num(order.tip_amount);
  const discount = num(order.discount_amount);

  // ReceiptInput carries subtotal/delivery/service and nothing else, so a taxed or tipped
  // order would print a TOTAL its own lines never reach. Until the printer package grows
  // rows of its own, these ride on the one free-text line the format has, which keeps the
  // paper adding up. Kept short: the 80mm page is 42 columns and does not wrap.
  const adjustments = [
    tax > 0 ? `Tax ${tax.toFixed(2)}` : null,
    tip > 0 ? `Tip ${tip.toFixed(2)}` : null,
    discount > 0 ? `Discount -${discount.toFixed(2)}` : null,
  ].filter((line): line is string => line !== null);

  return {
    branchName: ctx.branchName,
    branchAddress: ctx.branchAddress ?? undefined,
    branchPhone: ctx.branchPhone ?? undefined,
    orderNumber: order.order_number,
    channel: order.channel.replace('_', ' '),
    createdAt: order.created_at,
    // unit_price is the price of the plain dish; subtotal is what the line actually cost,
    // options included (place-order: subtotal = r2((price + modDelta) x qty)). buildReceipt
    // prints quantity × unit_price, so handing it the base price made every modified line
    // fall short of the Subtotal printed two rows below it. The option names ride on the
    // notes line, which is the one piece of free text the 80mm format gives a line.
    items: order.order_items.map((item) => {
      const qty = Math.max(1, Number(item.quantity) || 1);
      const lineTotal = num(item.subtotal);
      // A line with no readable subtotal still has to print something a cashier can read,
      // so it falls back to the base price rather than to NaN.
      const effectiveUnit = Number.isFinite(lineTotal)
        ? Math.round((lineTotal / qty) * 100) / 100
        : num(item.unit_price);
      const options = parseLineModifiers(item.modifiers).map((m) => m.name);
      const notes = [options.length > 0 ? options.join(', ') : null, item.notes ?? null]
        .filter(Boolean)
        .join(' · ');
      return {
        name: item.item_name,
        quantity: item.quantity,
        unit_price: effectiveUnit,
        notes: notes || null,
      };
    }),
    subtotal: num(order.subtotal),
    deliveryFee: num(order.delivery_fee) || undefined,
    serviceFee: num(order.service_fee) || undefined,
    total: num(order.total),
    paymentMethod: ctx.paymentMethod ?? 'unpaid',
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    customerAddress: formatReceiptAddress(order.delivery_address),
    footerNote: adjustments.length > 0 ? adjustments.join(' · ') : undefined,
    currency: ctx.currency ?? 'USD',
  };
}
