/**
 * Minimal ESC/POS command builder for 80mm thermal receipt printers.
 * Targets Epson TM-T20II / TM-T82 and clones — the de-facto standard for SE Asia
 * restaurant POS. Supports US-ASCII text + Thai (TIS-620 / WPC1252 fallback).
 *
 * Output is a Uint8Array; pipe to WebUSB or any binary transport.
 */

import { formatPhone, lineTotal, sortOrderLines } from '@favornoms/shared';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Align = 'left' | 'center' | 'right';
export type FontSize = 'normal' | 'wide' | 'tall' | 'large';

export class EscPosBuilder {
  private chunks: number[] = [];

  // Initialize / reset
  init() {
    this.chunks.push(ESC, 0x40);
    return this;
  }

  text(s: string) {
    // The printer is driven in its single-byte default code page; × or — sent as UTF-8 came out
    // as two or three garbage glyphs and pushed the line past the paper.
    const bytes = new TextEncoder().encode(printerText(s));
    for (const b of bytes) this.chunks.push(b);
    return this;
  }

  line(s = '') {
    this.text(s);
    this.chunks.push(LF);
    return this;
  }

  feed(n = 1) {
    this.chunks.push(ESC, 0x64, Math.max(0, Math.min(255, n)));
    return this;
  }

  align(a: Align) {
    const v = a === 'left' ? 0 : a === 'center' ? 1 : 2;
    this.chunks.push(ESC, 0x61, v);
    return this;
  }

  bold(on: boolean) {
    this.chunks.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }

  size(s: FontSize) {
    const map: Record<FontSize, number> = {
      normal: 0x00,
      wide: 0x10,
      tall: 0x01,
      large: 0x11,
    };
    this.chunks.push(GS, 0x21, map[s]);
    return this;
  }

  hr(char = '-', width = 42) {
    this.line(char.repeat(width));
    return this;
  }

  /**
   * Two columns: label left, value right, padded to width. The value sits on the first line, as
   * on the browser receipt; a label too long to share it wraps at word boundaries, and its
   * following lines start with `indent` (an item's name continues under itself, not at column 0
   * where it read as an item of its own). A value too long to leave the label a word's room
   * (a long customer name, a large TOTAL) goes right-aligned on the lines after the label instead
   * of the label being broken one letter per line.
   */
  row(rawLabel: string, rawValue: string, width = 42, indent = '') {
    // Measured as printed: printerText turns "…" into three characters.
    const label = printerText(rawLabel);
    const value = printerText(rawValue);
    const room = width - cols(value) - 1;
    const longestWord = Math.max(0, ...label.split(/\s+/).map(cols));
    if (room < Math.min(longestWord, 12)) {
      this.wrapped(label, width, indent);
      for (const piece of wrapText(value, width)) this.line(' '.repeat(Math.max(0, width - cols(piece))) + piece);
      return this;
    }
    const [first = '', ...rest] = wrapText(label, width, indent, room);
    this.line(first + ' '.repeat(Math.max(1, width - cols(first) - cols(value))) + value);
    for (const piece of rest) this.line(piece);
    return this;
  }

  /** Text wrapped at word boundaries to the paper's width, each line after the first indented. */
  wrapped(s: string, width = 42, indent = '') {
    for (const piece of wrapText(s, width, indent)) this.line(piece);
    return this;
  }

  /** Full cut (most TM-T20/T82 models support partial too via 0x42 = 1, 0x41 = 0). */
  cut(partial = false) {
    this.chunks.push(GS, 0x56, partial ? 1 : 0);
    return this;
  }

  /** Open cash drawer kick pulse on pin 2 (most common). */
  drawerKick() {
    this.chunks.push(ESC, 0x70, 0x00, 0x19, 0xfa);
    return this;
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/** Columns a string takes on the paper: one per character (code point), not per UTF-16 unit. */
function cols(s: string): number {
  return [...s].length;
}

/**
 * Text as the thermal printer can print it: common typographic punctuation mapped to ASCII. The
 * printer runs in its single-byte code page and nothing switches it, so a UTF-8 "×" printed as
 * two glyphs of nonsense and took two columns. Other non-ASCII text is left as it was.
 */
export function printerText(s: string): string {
  return s
    .replace(/[\u00d7\u2715]/g, 'x')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201a]/g, "'")
    .replace(/[\u201c\u201d\u201e]/g, '"')
    .replace(/[\u00b7\u2022]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ');
}

/**
 * Word-wrap for fixed-width paper. Breaks at spaces; a single word longer than the line is split
 * between characters (code points, never inside one). Lines after the first start with `indent`
 * and fit the width with it; the first line may be given a narrower `firstWidth` (the room left
 * beside a right-hand value).
 */
export function wrapText(text: string, width: number, indent = '', firstWidth = width): string[] {
  const s = printerText(text);
  const out: string[] = [];
  let line = '';
  const limit = () => Math.max(1, out.length === 0 ? firstWidth : width - cols(indent));
  const push = () => {
    out.push(out.length === 0 ? line : indent + line);
    line = '';
  };
  for (const word of s.split(/\s+/).filter(Boolean)) {
    let w = [...word];
    while (w.length > 0) {
      const room = limit() - (line ? cols(line) + 1 : 0);
      if (w.length <= room) {
        line = line ? `${line} ${w.join('')}` : w.join('');
        w = [];
      } else if (line) {
        push();
      } else {
        line = w.slice(0, limit()).join('');
        w = w.slice(limit());
        push();
      }
    }
  }
  if (line || out.length === 0) push();
  return out;
}

/**
 * When the order was placed, written for a US receipt ("Oct 17, 2026, 10:53 AM") whatever the
 * device's language: toLocaleString() on a tablet set to Thai printed the Buddhist year (2569).
 * The clock is the device's, which is the restaurant's.
 */
export function receiptDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** orders.channel as a diner reads it: "dine_in" on paper looked like a bug. */
export function receiptChannelLabel(channel: string | null | undefined): string {
  switch (channel) {
    case 'dine_in':
      return 'Dine-in';
    case 'pickup':
      return 'Pickup';
    case 'delivery':
      return 'Delivery';
    case 'qr_ordering':
      return 'QR order';
    default:
      return (channel ?? '').replace(/_/g, ' ');
  }
}

export interface ReceiptLine {
  name: string;
  quantity: number;
  /** One unit with its options, to up to four decimals (a happy-hour $7.995 is not rounded). */
  unit_price: number;
  /**
   * What the line was charged: order_items.subtotal, or place-order's lineTotal for a sale that
   * was just rung up. Printed as it is when given. Without it the line is worked out the same
   * way, rounded once, never as unit_price rounded to the cent and then multiplied.
   */
  line_total?: number;
  notes?: string | null;
  /**
   * Where the dish sits on the menu (order_items.category_position / item_position). The paper
   * lists lines category by category. The counter's sale receipt passes none: it hands over its
   * cart already in menu order (menuLinePositions), which is kept.
   */
  category_position?: number | null;
  item_position?: number | null;
}

/** The amount a receipt prints for a line: the charged total, as place-order computes it. */
export function receiptLineTotal(item: ReceiptLine): number {
  return item.line_total != null && Number.isFinite(item.line_total)
    ? item.line_total
    : lineTotal(item.unit_price, 0, item.quantity);
}

/**
 * The lines in the order the paper prints them: the menu's, as on the bill on screen and the
 * kitchen ticket. The same dish twice (other options) keeps the order the caller gave, which
 * callers take from sortOrderLines. A receipt whose lines carry no position at all (the legacy
 * POS) keeps the order it was given rather than coming out alphabetical.
 */
export function receiptLinesInMenuOrder(items: readonly ReceiptLine[]): ReceiptLine[] {
  const positioned = items.some((item) => item.category_position != null || item.item_position != null);
  if (!positioned) return [...items];
  return sortOrderLines(items, (item) => ({
    category_position: item.category_position,
    item_position: item.item_position,
    item_name: item.name,
  }));
}

export interface ReceiptInput {
  branchName: string;
  branchAddress?: string;
  /** As stored (E.164). Both printers format it; see customerPhone. */
  branchPhone?: string;
  orderNumber: string;
  channel: string;
  cashierName?: string;
  createdAt: string;
  items: ReceiptLine[];
  subtotal: number;
  deliveryFee?: number;
  serviceFee?: number;
  /** Money off the food line, printed as a negative. */
  discount?: number;
  /** Sales tax. A US receipt is expected to itemise it, and a TOTAL that sits above the
   *  lines with no row to explain the gap is one neither the diner nor a bookkeeper can
   *  reconcile. Zero and undefined both omit the row. */
  taxAmount?: number;
  tipAmount?: number;
  total: number;
  paymentMethod: string;
  cashTendered?: number;
  customerName?: string | null;
  /**
   * As stored (E.164). Both printers put it through formatPhone, so the paper reads
   * "+1 (555) 234-5678" like every screen and no caller has to remember to. That also prints
   * no Phone row for the till's +10000000000 walk-in stand-in, a number nobody answers.
   */
  customerPhone?: string | null;
  customerAddress?: string | null;
  footerNote?: string;
  currency?: string;
}

function fmtCurrency(amount: number, currency: string) {
  if (currency === 'USD') return `$${amount.toFixed(2)}`;
  return `${currency} ${amount.toFixed(2)}`;
}

/**
 * The "Paid via" line. payments.method is a stored code, and a receipt reading "Paid via
 * transfer" does not tell a diner it was the branch's QR code they scanned at the counter.
 * Unknown codes print as they are rather than as nothing.
 */
export function receiptPaymentLabel(method: string | null | undefined): string {
  switch (method) {
    case 'cash':
      return 'Cash';
    case 'card':
      return 'Card';
    case 'transfer':
      return 'QR transfer';
    default:
      return method ?? '';
  }
}

/** Compose a standard 80mm sales receipt. */
export function buildReceipt(input: ReceiptInput): Uint8Array {
  const currency = input.currency ?? 'USD';
  const b = new EscPosBuilder().init();

  // 'large' doubles the width, so the name gets half the columns.
  b.align('center').bold(true).size('large').wrapped(input.branchName, 21).size('normal').bold(false);
  if (input.branchAddress) b.wrapped(input.branchAddress);
  const branchPhone = formatPhone(input.branchPhone);
  if (branchPhone) b.line(`Tel: ${branchPhone}`);
  b.feed(1);

  b.align('left').hr();
  b.row('Order', input.orderNumber);
  b.row('Channel', receiptChannelLabel(input.channel));
  if (input.cashierName) b.row('Cashier', input.cashierName);
  b.row('Date', receiptDate(input.createdAt));
  if (input.customerName) b.row('Customer', input.customerName);
  const customerPhone = formatPhone(input.customerPhone);
  if (customerPhone) b.row('Phone', customerPhone);
  b.hr();

  for (const item of receiptLinesInMenuOrder(input.items)) {
    // The whole name, wrapped: it was cut at 28 characters, so a long dish name lost its end.
    b.row(`${item.quantity}x ${item.name}`, fmtCurrency(receiptLineTotal(item), currency), 42, '   ');
    // Indented under its dish; the continuation lines line up after "Note: ".
    if (item.notes) for (const piece of wrapText(`Note: ${item.notes}`, 40, '      ')) b.line(`  ${piece}`);
  }

  b.hr();
  b.row('Subtotal', fmtCurrency(input.subtotal, currency));
  if (input.deliveryFee) b.row('Delivery', fmtCurrency(input.deliveryFee, currency));
  if (input.serviceFee) b.row('Service', fmtCurrency(input.serviceFee, currency));
  if (input.discount) b.row('Discount', `-${fmtCurrency(input.discount, currency)}`);
  if (input.taxAmount) b.row('Sales tax', fmtCurrency(input.taxAmount, currency));
  if (input.tipAmount) b.row('Tip', fmtCurrency(input.tipAmount, currency));
  // 'wide' doubles each character, so the row is padded to half the paper or it wraps.
  b.bold(true).size('wide').row('TOTAL', fmtCurrency(input.total, currency), 21).size('normal').bold(false);
  b.row('Paid via', receiptPaymentLabel(input.paymentMethod));
  if (input.cashTendered !== undefined) {
    b.row('Tendered', fmtCurrency(input.cashTendered, currency));
    b.row('Change', fmtCurrency(Math.max(0, input.cashTendered - input.total), currency));
  }
  b.hr();

  if (input.customerAddress) {
    b.line('Delivery to:');
    b.wrapped(input.customerAddress);
    b.hr();
  }

  b.align('center').feed(1);
  b.wrapped(input.footerNote ?? 'Thank you — come back soon!');
  b.feed(3).cut();

  return b.bytes();
}
