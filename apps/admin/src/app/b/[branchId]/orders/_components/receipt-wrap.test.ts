import { describe, expect, it } from 'vitest';
import { buildReceipt, receiptChannelLabel, receiptDate, receiptHtml, wrapText, type ReceiptInput } from '@favornoms/ui/printer';

/**
 * A counter receipt printed after payment ran off the paper: the browser fallback was 42-column
 * text under `white-space: pre`, so a long note never wrapped, and on a small page (A8, a 58mm
 * roll) the amounts were cut off. The thermal receipt cut dish names at 28 characters. These lock
 * the wrapping on both.
 */
const longNote = '6× Craft Root Beer, 6× Bacon Deluxe Burger, 6× Onion Rings, 6× Veggie Burger';
const input: ReceiptInput = {
  branchName: 'Hamburger',
  orderNumber: 'A-2610-0002',
  channel: 'dine_in',
  createdAt: '2026-10-17T15:53:57.000Z',
  items: [
    { name: 'Gang 6', quantity: 1, unit_price: 199, line_total: 199, notes: longNote },
    { name: 'Extra Large Double Smash Burger With Everything On It', quantity: 2, unit_price: 12.5, line_total: 25 },
  ],
  subtotal: 224,
  taxAmount: 15.68,
  total: 239.68,
  paymentMethod: 'transfer',
};

/** What the thermal printer would print, without the ESC/POS control bytes. */
function paperLines(bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes);
  // eslint-disable-next-line no-control-regex
  return text.split('\n').map((l) => l.replace(/\x1b[@Ed!a]./g, '').replace(/\x1d[!V]./g, '').replace(/\x1b\x40/g, ''));
}

describe('wrapText', () => {
  it('breaks at spaces and indents the following lines', () => {
    expect(wrapText('one two three four', 9, '  ')).toEqual(['one two', '  three', '  four']);
  });
  it('splits a word longer than the line', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
  it('keeps an empty string as one empty line', () => {
    expect(wrapText('', 10)).toEqual(['']);
  });
});

describe('thermal receipt', () => {
  const lines = paperLines(buildReceipt(input));
  /** Bytes, not characters: the printer prints one glyph per byte in its default code page. */
  const bytes = (l: string) => new TextEncoder().encode(l).length;

  it('keeps every normal-size line within 42 printed columns', () => {
    // The branch name and TOTAL are printed double-width and padded to 21; everything else is 42.
    for (const l of lines) expect(bytes(l)).toBeLessThanOrEqual(42);
  });

  it('prints the whole dish name, continued under itself, with the price on its first line', () => {
    const first = lines.find((l) => l.startsWith('2x Extra Large'));
    expect(first).toMatch(/^2x Extra Large Double Smash Burger +\$25\.00$/);
    expect(lines[lines.indexOf(first!) + 1]).toBe('   With Everything On It');
  });

  it('indents the note under its dish and keeps all of it, with x for the counter’s ×', () => {
    const note = lines.findIndex((l) => l.startsWith('  Note: 6x Craft Root Beer'));
    expect(note).toBeGreaterThan(-1);
    expect(lines[note + 1]).toMatch(/^ {8}\S/);
    expect(lines.join(' ')).toContain('Veggie Burger');
    expect(lines.join('')).not.toContain('×');
  });

  it('names the channel the way a diner reads it', () => {
    expect(lines.some((l) => /^Channel +Dine-in$/.test(l))).toBe(true);
  });

  it('never breaks a short label letter by letter when the value is long', () => {
    const name = 'Maria Fernanda Rodriguez de la Cruz Santos';
    const paper = paperLines(buildReceipt({ ...input, customerName: name }));
    const at = paper.indexOf('Customer');
    expect(at).toBeGreaterThan(-1);
    expect(paper[at + 1]?.trim()).toBe(name);
    expect(paper.some((l) => l === 'C')).toBe(false);
    const big = paperLines(buildReceipt({ ...input, total: 123456789, currency: 'VND' }));
    const total = big.indexOf('TOTAL');
    expect(total).toBeGreaterThan(-1);
    expect(big[total + 1]?.trim()).toBe('VND 123456789.00');
  });
});

describe('wrapText with non-ASCII text', () => {
  it('never splits inside a character', () => {
    expect(wrapText('😀😀😀😀😀', 3)).toEqual(['😀😀😀', '😀😀']);
  });
  it('counts × and — as the one ASCII character they print as', () => {
    expect(wrapText('6× Coke — large', 15)).toEqual(['6x Coke - large']);
  });
});

describe('browser receipt', () => {
  const html = receiptHtml(input);

  it('wraps instead of printing fixed-width text', () => {
    expect(html).not.toContain('white-space: pre;');
    expect(html).not.toMatch(/size:\s*80mm/);
    expect(html).toContain('overflow-wrap: anywhere');
  });

  it('carries the whole note and keeps each amount in its own right-hand cell', () => {
    expect(html).toContain(`Note: ${longNote}`);
    expect(html).toContain('<span class="r">199.00 USD</span>');
    expect(html).toContain('<span class="l">1× Gang 6</span>');
  });

  it('shows the channel label and escapes markup', () => {
    expect(html).toContain('<span class="r">Dine-in</span>');
    const hostile = receiptHtml({ ...input, branchName: '<b>x</b>' });
    expect(hostile).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('receiptChannelLabel', () => {
  it('maps every order channel', () => {
    expect(['dine_in', 'pickup', 'delivery', 'qr_ordering'].map(receiptChannelLabel)).toEqual([
      'Dine-in',
      'Pickup',
      'Delivery',
      'QR order',
    ]);
  });
});

describe('receiptDate', () => {
  it('writes a US date with a Gregorian year whatever the device language', () => {
    const printed = receiptDate('2026-10-17T15:53:57.000Z');
    expect(printed).toMatch(/^Oct 1[78], 2026, \d{1,2}:\d{2}\s?[AP]M$/);
    expect(printed).not.toContain('2569');
  });
  it('prints an unreadable value as it is rather than "Invalid Date"', () => {
    expect(receiptDate('not a date')).toBe('not a date');
  });
});
