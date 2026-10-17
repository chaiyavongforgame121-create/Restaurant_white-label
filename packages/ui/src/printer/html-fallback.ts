import { formatPhone } from '@favornoms/shared';
import {
  receiptChannelLabel,
  receiptDate,
  receiptLineTotal,
  receiptLinesInMenuOrder,
  receiptPaymentLabel,
  type ReceiptInput,
} from './escpos';

/**
 * Fallback when WebUSB isn't available: open a print-friendly window with the receipt, then
 * trigger `window.print()`. The user picks their local printer (or Save as PDF) in the dialog.
 *
 * The receipt is laid out with HTML rows, not as fixed-width text. It used to be 42-column text
 * under `white-space: pre`, which never wrapped: a long note or dish name ran off the paper, the
 * 42 columns at 12px were wider than an 80mm roll's printable area, and on a small page (a 58mm
 * roll, or A8 in Android's print dialog) the right-hand amounts were cut off. Now every row wraps
 * inside the page, amounts stay pinned right, and the column is at most a receipt's width, so an
 * A4 page or a PDF shows a normal receipt instead of a strip of text in the corner.
 */
export function printReceiptViaBrowser(input: ReceiptInput) {
  const win = window.open('', '_blank', 'width=420,height=720');
  if (!win) {
    alert('Pop-up blocked. Allow pop-ups to print receipts via the browser.');
    return;
  }
  const html = receiptHtml(input);
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => {
    win.print();
  }, 200);
}

/** The whole print document, exported for tests. */
export function receiptHtml(input: ReceiptInput): string {
  const currency = input.currency ?? 'USD';
  const money = (n: number) => `${n.toFixed(2)} ${currency}`;
  const parts: string[] = [];

  parts.push(`<header>`);
  parts.push(`<h1>${esc(input.branchName)}</h1>`);
  if (input.branchAddress) parts.push(`<p>${esc(input.branchAddress)}</p>`);
  const branchPhone = formatPhone(input.branchPhone);
  if (branchPhone) parts.push(`<p>Tel: ${esc(branchPhone)}</p>`);
  parts.push(`</header>`);

  parts.push(`<section class="meta">`);
  parts.push(row('Order', input.orderNumber));
  parts.push(row('Channel', receiptChannelLabel(input.channel)));
  if (input.cashierName) parts.push(row('Cashier', input.cashierName));
  parts.push(row('Date', receiptDate(input.createdAt)));
  if (input.customerName) parts.push(row('Customer', input.customerName));
  const customerPhone = formatPhone(input.customerPhone);
  if (customerPhone) parts.push(row('Phone', customerPhone));
  parts.push(`</section>`);

  parts.push(`<section class="items">`);
  for (const item of receiptLinesInMenuOrder(input.items)) {
    parts.push(`<div class="item">`);
    parts.push(row(`${item.quantity}× ${item.name}`, money(receiptLineTotal(item))));
    if (item.notes) parts.push(`<p class="note">Note: ${esc(item.notes)}</p>`);
    parts.push(`</div>`);
  }
  parts.push(`</section>`);

  parts.push(`<section class="totals">`);
  parts.push(row('Subtotal', money(input.subtotal)));
  if (input.deliveryFee) parts.push(row('Delivery', money(input.deliveryFee)));
  if (input.serviceFee) parts.push(row('Service', money(input.serviceFee)));
  if (input.discount) parts.push(row('Discount', `-${money(input.discount)}`));
  if (input.taxAmount) parts.push(row('Sales tax', money(input.taxAmount)));
  if (input.tipAmount) parts.push(row('Tip', money(input.tipAmount)));
  parts.push(row('TOTAL', money(input.total), 'total'));
  parts.push(row('Paid via', receiptPaymentLabel(input.paymentMethod)));
  if (input.cashTendered !== undefined) {
    parts.push(row('Tendered', money(input.cashTendered)));
    parts.push(row('Change', money(Math.max(0, input.cashTendered - input.total))));
  }
  parts.push(`</section>`);

  if (input.customerAddress) {
    parts.push(`<section class="address"><p class="label">Delivery to:</p><p>${esc(input.customerAddress)}</p></section>`);
  }

  parts.push(`<footer>${esc(input.footerNote ?? 'Thank you — come back soon!')}</footer>`);

  return `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Receipt ${esc(input.orderNumber)}</title>
    <style>
      /* No fixed page size: the printer's paper (an 80mm or 58mm roll, Letter, A4, A8) decides,
         and the receipt narrows to fit it. */
      @page { margin: 4mm; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; color: #000; }
      body { padding: 8px; font-family: 'Sarabun', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
             font-size: 12px; line-height: 1.4; }
      @media print { body { padding: 0; } }
      .receipt { width: 100%; max-width: 76mm; margin: 0 auto; }
      header { text-align: center; padding-bottom: 6px; }
      h1 { margin: 0 0 2px; font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: .02em;
           overflow-wrap: anywhere; }
      header p { margin: 0; overflow-wrap: anywhere; }
      section { border-top: 1px dashed #000; padding: 5px 0; }
      .row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .row .l { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
      .row .r { flex: 0 0 auto; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .meta .row .l { flex: 0 0 auto; color: #333; }
      .meta .row .r { flex: 1 1 auto; min-width: 0; white-space: normal; overflow-wrap: anywhere; }
      .item + .item { margin-top: 3px; }
      .note { margin: 1px 0 0 12px; font-size: 11px; color: #333; overflow-wrap: anywhere; }
      .total { font-size: 15px; font-weight: 700; margin: 3px 0; }
      .address p { margin: 0; overflow-wrap: anywhere; }
      .address .label { font-weight: 600; }
      footer { border-top: 1px dashed #000; padding-top: 8px; text-align: center; overflow-wrap: anywhere; }
    </style></head><body><main class="receipt">${parts.join('')}</main></body></html>`;
}

function row(left: string, right: string, extra?: string) {
  return `<div class="row${extra ? ` ${extra}` : ''}"><span class="l">${esc(left)}</span><span class="r">${esc(right)}</span></div>`;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
