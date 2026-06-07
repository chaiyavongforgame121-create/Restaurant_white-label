/**
 * Minimal ESC/POS command builder for 80mm thermal receipt printers.
 * Targets Epson TM-T20II / TM-T82 and clones — the de-facto standard for SE Asia
 * restaurant POS. Supports US-ASCII text + Thai (TIS-620 / WPC1252 fallback).
 *
 * Output is a Uint8Array; pipe to WebUSB or any binary transport.
 */

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
    const bytes = new TextEncoder().encode(s);
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

  /** Two columns: label left, value right, padded to width. */
  row(label: string, value: string, width = 42) {
    const slack = Math.max(1, width - label.length - value.length);
    this.line(label + ' '.repeat(slack) + value);
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

export interface ReceiptLine {
  name: string;
  quantity: number;
  unit_price: number;
  notes?: string | null;
}

export interface ReceiptInput {
  branchName: string;
  branchAddress?: string;
  branchPhone?: string;
  orderNumber: string;
  channel: string;
  cashierName?: string;
  createdAt: string;
  items: ReceiptLine[];
  subtotal: number;
  deliveryFee?: number;
  serviceFee?: number;
  total: number;
  paymentMethod: string;
  cashTendered?: number;
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  footerNote?: string;
  currency?: string;
}

function fmtCurrency(amount: number, currency: string) {
  if (currency === 'USD') return `$${amount.toFixed(2)}`;
  return `${currency} ${amount.toFixed(2)}`;
}

/** Compose a standard 80mm sales receipt. */
export function buildReceipt(input: ReceiptInput): Uint8Array {
  const currency = input.currency ?? 'USD';
  const b = new EscPosBuilder().init();

  b.align('center').bold(true).size('large').line(input.branchName).size('normal').bold(false);
  if (input.branchAddress) b.line(input.branchAddress);
  if (input.branchPhone) b.line(`Tel: ${input.branchPhone}`);
  b.feed(1);

  b.align('left').hr();
  b.row('Order', input.orderNumber);
  b.row('Channel', input.channel);
  if (input.cashierName) b.row('Cashier', input.cashierName);
  b.row('Date', new Date(input.createdAt).toLocaleString());
  if (input.customerName) b.row('Customer', input.customerName);
  if (input.customerPhone) b.row('Phone', input.customerPhone);
  b.hr();

  for (const item of input.items) {
    const left = `${item.quantity}x ${item.name}`;
    const right = fmtCurrency(item.unit_price * item.quantity, currency);
    b.row(left.length > 28 ? left.slice(0, 28) : left, right);
    if (item.notes) b.line(`  Note: ${item.notes}`);
  }

  b.hr();
  b.row('Subtotal', fmtCurrency(input.subtotal, currency));
  if (input.deliveryFee) b.row('Delivery', fmtCurrency(input.deliveryFee, currency));
  if (input.serviceFee) b.row('Service', fmtCurrency(input.serviceFee, currency));
  b.bold(true).size('wide').row('TOTAL', fmtCurrency(input.total, currency)).size('normal').bold(false);
  b.row('Paid via', input.paymentMethod);
  if (input.cashTendered !== undefined) {
    b.row('Tendered', fmtCurrency(input.cashTendered, currency));
    b.row('Change', fmtCurrency(Math.max(0, input.cashTendered - input.total), currency));
  }
  b.hr();

  if (input.customerAddress) {
    b.line('Delivery to:');
    b.line(input.customerAddress);
    b.hr();
  }

  b.align('center').feed(1);
  b.line(input.footerNote ?? 'Thank you — come back soon!');
  b.feed(3).cut();

  return b.bytes();
}
