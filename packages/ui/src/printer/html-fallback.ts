import type { ReceiptInput } from './escpos';

/**
 * Fallback when WebUSB isn't available: open a print-friendly window with the
 * receipt rendered as plain text in a monospace font, then trigger `window.print()`.
 * The user picks their local printer in the OS dialog.
 */
export function printReceiptViaBrowser(input: ReceiptInput) {
  const win = window.open('', '_blank', 'width=420,height=720');
  if (!win) {
    alert('Pop-up blocked. Allow pop-ups to print receipts via the browser.');
    return;
  }
  const currency = input.currency ?? 'USD';
  const lines: string[] = [];
  const hr = '-'.repeat(42);
  lines.push(input.branchName.toUpperCase());
  if (input.branchAddress) lines.push(input.branchAddress);
  if (input.branchPhone) lines.push(`Tel: ${input.branchPhone}`);
  lines.push('');
  lines.push(hr);
  lines.push(`Order   ${input.orderNumber}`);
  lines.push(`Channel ${input.channel}`);
  if (input.cashierName) lines.push(`Cashier ${input.cashierName}`);
  lines.push(`Date    ${new Date(input.createdAt).toLocaleString()}`);
  if (input.customerName) lines.push(`Customer ${input.customerName}`);
  if (input.customerPhone) lines.push(`Phone    ${input.customerPhone}`);
  lines.push(hr);
  for (const item of input.items) {
    const left = `${item.quantity}x ${item.name}`;
    const right = `${(item.unit_price * item.quantity).toFixed(2)} ${currency}`;
    lines.push(padTo(left, right, 42));
    if (item.notes) lines.push(`  Note: ${item.notes}`);
  }
  lines.push(hr);
  lines.push(padTo('Subtotal', `${input.subtotal.toFixed(2)} ${currency}`, 42));
  if (input.deliveryFee)
    lines.push(padTo('Delivery', `${input.deliveryFee.toFixed(2)} ${currency}`, 42));
  if (input.serviceFee)
    lines.push(padTo('Service', `${input.serviceFee.toFixed(2)} ${currency}`, 42));
  lines.push(padTo('TOTAL', `${input.total.toFixed(2)} ${currency}`, 42));
  lines.push(`Paid via ${input.paymentMethod}`);
  if (input.cashTendered !== undefined) {
    lines.push(padTo('Tendered', `${input.cashTendered.toFixed(2)} ${currency}`, 42));
    lines.push(
      padTo('Change', `${Math.max(0, input.cashTendered - input.total).toFixed(2)} ${currency}`, 42),
    );
  }
  lines.push(hr);
  if (input.customerAddress) {
    lines.push('Delivery to:');
    lines.push(input.customerAddress);
    lines.push(hr);
  }
  lines.push('');
  lines.push(centered(input.footerNote ?? 'Thank you — come back soon!', 42));

  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <title>Receipt ${input.orderNumber}</title>
    <style>
      @page { size: 80mm auto; margin: 6mm 4mm; }
      body { font-family: 'Menlo','Consolas','Sarabun',monospace; font-size: 12px; line-height: 1.35; white-space: pre; }
    </style></head><body>${escapeHtml(lines.join('\n'))}</body></html>`;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => {
    win.print();
  }, 200);
}

function padTo(left: string, right: string, width: number) {
  const slack = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(slack) + right;
}

function centered(s: string, width: number) {
  if (s.length >= width) return s;
  const pad = Math.floor((width - s.length) / 2);
  return ' '.repeat(pad) + s;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] ?? c));
}
