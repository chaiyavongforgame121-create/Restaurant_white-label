// Issue US sales-tax receipt — generates a printable HTML receipt for the order.
//
// The Thai E-Tax XML payload has been replaced with a US-style sales receipt:
//   • Itemized lines
//   • Subtotal, sales tax, tip (if any), total
//   • Branch + customer details
//
// We render HTML (not raw PDF) because every browser / OS can print HTML to PDF
// or paper natively, and the receipt can also be emailed to the customer.
//
// Input:  { tax_invoice_id }
// Output: { html, receipt_number, total }
//
// The legacy `tax_invoices` table + RPC name are kept to avoid a breaking
// schema rename — semantically the row is now a "receipt".

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { billingInactiveBody, loadEntitlements } from '../_shared/entitlements.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Platform-wide fallbacks only. The seller on a receipt is the branch that made the sale: every
// restaurant and every branch of one is its own seller, so these must never print over the
// branch's own name or address (they used to, on every tenant's receipts).
const SELLER_NAME = Deno.env.get('RECEIPT_SELLER_NAME');
const SELLER_ADDRESS = Deno.env.get('RECEIPT_SELLER_ADDRESS');
const SELLER_PHONE = Deno.env.get('RECEIPT_SELLER_PHONE');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors(new Response('ok'));
  if (req.method !== 'POST') return cors(new Response('method_not_allowed', { status: 405 }));

  let body: { tax_invoice_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    return cors(json({ error: 'invalid_body' }, 400));
  }
  if (!body.tax_invoice_id) return cors(json({ error: 'tax_invoice_id_required' }, 400));

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return cors(json({ error: 'auth_required' }, 401));
  // The caller's own token decides what they can read (tax_invoices RLS: staff of the invoice's
  // branch, owner rows covering every branch); the anon key only identifies the project.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: invoice, error: invErr } = await userClient
    .from('tax_invoices')
    .select('*, branches(name, address, settings, timezone), orders(order_number, tip_amount)')
    .eq('id', body.tax_invoice_id)
    .maybeSingle();
  if (invErr || !invoice) return cors(json({ error: 'receipt_not_found_or_unauthorized' }, 404));

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Issuing a receipt writes to tax_invoices, so it is a back-office action and
  // stops at suspension. The row is untouched — the receipt re-issues intact the
  // moment billing is restored.
  const ent = await loadEntitlements(adminClient, { branchId: invoice.branch_id as string });
  if (!ent.entitled) return cors(json(billingInactiveBody('receipts'), 402));

  const seller = await resolveSeller(adminClient, invoice.branch_id as string);
  const html = buildReceiptHtml(invoice, seller);

  await adminClient
    .from('tax_invoices')
    .update({ xml_payload: html, status: 'issued' })
    .eq('id', invoice.id);

  return cors(json({
    html,
    receipt_number: invoice.invoice_number,
    total: invoice.total,
  }));
});

interface InvoiceRow {
  invoice_number: string;
  issued_at?: string | null;
  buyer_name?: string | null;
  buyer_address?: string | null;
  subtotal: number | string;
  vat_amount: number | string;
  total: number | string;
  line_items?: InvoiceLine[];
  branches?: { name?: string; address?: string; settings?: { currency?: string }; timezone?: string };
  orders?: { order_number?: string; tip_amount?: number | string };
}

/** One line of the snapshot issue_tax_invoice keeps. Numbers may arrive as JSON numbers or text. */
interface InvoiceLine {
  name: string;
  quantity: number | string;
  unit_price: number | string;
  line_total: number | string | null;
}

interface Seller {
  name: string;
  address: string;
  phone: string;
}

// Postgres round(): half away from zero. `+ 0` turns a -0 into 0.
function roundHalfUp(n: number): number {
  return (n < 0 ? -Math.round(-n) : Math.round(n)) + 0;
}

/**
 * The unit to print beside a line: the one it was charged at, so quantity x unit is the line.
 *
 * issue_tax_invoice snapshots that unit, options included, from migration
 * 20260922120000_order_lines_menu_order. A snapshot taken before copied order_items.unit_price, the
 * plain dish without its options, which printed "1 | $8.00 | $10.00" for a dish with a $2.00
 * option. When the unit cannot reproduce the line (qty x unit, rounded to the cent once, as
 * lineTotal does) the line is split evenly instead, to four decimals: the fallback of
 * orderLineUnitPrice in packages/shared/src/utils/money.ts, which a Deno function cannot import.
 * Never line / qty to the cent: $55.97 / 7 would print as the $8.00 the owner saw on the bill.
 */
function chargedUnitPrice(line: InvoiceLine): number {
  const qty = Math.max(1, Number(line.quantity) || 1);
  const unit = Number(line.unit_price);
  // A missing total is unknown, not $0 (Number(null) is 0): the unit is then all there is.
  const charged =
    line.line_total == null || line.line_total === '' ? Number.NaN : Number(line.line_total);
  if (!Number.isFinite(charged)) return Number.isFinite(unit) ? unit : 0;
  if (
    Number.isFinite(unit) &&
    roundHalfUp((roundHalfUp(unit * 10000) * qty) / 100) === roundHalfUp(charged * 100)
  ) {
    return unit;
  }
  return roundHalfUp((charged / qty) * 10000) / 10000;
}

/**
 * The seller printed on the receipt: the branch that made the sale, named the way the storefront
 * names it ("<brand> - <branch>", one name when both are the same; brand = the branch's brand
 * within the same restaurant, else the restaurant's default brand, else the restaurant name; see
 * apps/web/src/lib/app-identity.ts). The RECEIPT_SELLER_* values only fill a field the branch
 * leaves empty.
 */
async function resolveSeller(
  admin: SupabaseClient,
  branchId: string,
): Promise<Seller> {
  const { data: branch } = await admin
    .from('branches')
    .select('name, address, settings, restaurant_id, brand_id')
    .eq('id', branchId)
    .maybeSingle();
  const b = (branch ?? null) as {
    name?: string | null;
    address?: string | null;
    settings?: Record<string, unknown> | null;
    restaurant_id?: string | null;
    brand_id?: string | null;
  } | null;

  let brandName = '';
  let restaurantName = '';
  if (b?.restaurant_id) {
    const [{ data: brands }, { data: restaurant }] = await Promise.all([
      admin.from('brands').select('id, name, is_default').eq('restaurant_id', b.restaurant_id),
      admin.from('restaurants').select('name').eq('id', b.restaurant_id).maybeSingle(),
    ]);
    const list = (brands ?? []) as Array<{ id: string; name: string | null; is_default: boolean | null }>;
    const brand = list.find((x) => x.id === b.brand_id) ?? list.find((x) => x.is_default);
    brandName = brand?.name?.trim() ?? '';
    restaurantName = ((restaurant as { name?: string | null } | null)?.name ?? '').trim();
  }
  const brand = brandName || restaurantName;
  const branchName = b?.name?.trim() ?? '';
  const sameName = brand.toLowerCase() === branchName.toLowerCase();
  const fullName = brand && branchName && !sameName ? `${brand} - ${branchName}` : brand || branchName;
  const phone = typeof b?.settings?.phone === 'string' ? (b.settings.phone as string).trim() : '';

  return {
    name: fullName || SELLER_NAME || 'Restaurant',
    address: b?.address?.trim() || SELLER_ADDRESS || '',
    phone: phone || SELLER_PHONE || '',
  };
}

function buildReceiptHtml(invoice: Record<string, unknown>, seller: Seller): string {
  const inv = invoice as unknown as InvoiceRow;
  const lines = inv.line_items ?? [];
  const branch = inv.branches ?? {};
  const currency = (branch.settings as { currency?: string } | undefined)?.currency ?? 'USD';
  const fmt = (n: number | string) =>
    `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // A UNIT price keeps up to four decimals (order_items.unit_price is numeric(12,4)): a 50% happy
  // hour on $15.99 is $7.995, and printing it as $8.00 beside a $55.97 line for seven is a receipt
  // that does not add up. formatUnitPrice() in packages/shared does the same for the apps.
  const fmtUnit = (n: number | string) =>
    `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  const sellerName = seller.name;
  const sellerAddr = seller.address;
  const sellerPhone = seller.phone;
  const issuedAt = inv.issued_at ?? new Date().toISOString();
  const issuedDate = new Date(issuedAt).toLocaleString('en-US', {
    timeZone: branch.timezone ?? 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const tipAmount = Number(inv.orders?.tip_amount ?? 0);

  const rows = lines
    .map(
      (l) => `<tr>
      <td>${escape(l.name)}</td>
      <td style="text-align:center">${l.quantity}</td>
      <td style="text-align:right">${fmtUnit(chargedUnitPrice(l))}</td>
      <td style="text-align:right">${fmt(l.line_total ?? 0)}</td>
    </tr>`,
    )
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
  <title>Receipt #${escape(inv.invoice_number)}</title>
  <style>
    @page { size: letter; margin: 0.5in; }
    body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 13px; line-height: 1.45; max-width: 480px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 22px; margin: 0; font-weight: 800; }
    .muted { color: #5b6470; font-size: 11px; }
    .center { text-align: center; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { padding: 8px 4px; border-bottom: 1px solid #e5e7ec; vertical-align: top; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #5b6470; font-weight: 600; }
    tfoot td { border-bottom: none; padding: 4px; }
    .totals td.label { text-align: right; color: #5b6470; }
    .totals td.amount { text-align: right; font-variant-numeric: tabular-nums; }
    .grand td { font-weight: 800; font-size: 16px; border-top: 2px solid #1a1a1a; padding-top: 8px; }
    .badge { display: inline-block; background: #f4f5f7; border-radius: 999px; padding: 2px 10px; font-size: 11px; margin-top: 6px; }
    .footer { margin-top: 24px; padding-top: 12px; border-top: 1px dashed #c9cfd6; font-size: 11px; color: #5b6470; text-align: center; }
  </style></head><body>
  <header class="center">
    <h1>${escape(sellerName)}</h1>
    ${sellerAddr ? `<div class="muted">${escape(sellerAddr)}</div>` : ''}
    ${sellerPhone ? `<div class="muted">${escape(sellerPhone)}</div>` : ''}
    <div class="badge">Receipt #${escape(inv.invoice_number)}</div>
  </header>

  <section style="margin-top:16px">
    <div><strong>Date:</strong> ${escape(issuedDate)}</div>
    ${inv.orders?.order_number ? `<div><strong>Order #:</strong> ${escape(inv.orders.order_number)}</div>` : ''}
    ${inv.buyer_name ? `<div><strong>Customer:</strong> ${escape(inv.buyer_name)}</div>` : ''}
    ${inv.buyer_address ? `<div><strong>Address:</strong> ${escape(inv.buyer_address)}</div>` : ''}
  </section>

  <table>
    <thead><tr>
      <th>Item</th>
      <th style="text-align:center">Qty</th>
      <th style="text-align:right">Unit</th>
      <th style="text-align:right">Total</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot class="totals">
      <tr><td colspan="3" class="label">Subtotal</td><td class="amount">${fmt(inv.subtotal)}</td></tr>
      <tr><td colspan="3" class="label">Sales tax</td><td class="amount">${fmt(inv.vat_amount)}</td></tr>
      ${tipAmount > 0 ? `<tr><td colspan="3" class="label">Tip</td><td class="amount">${fmt(tipAmount)}</td></tr>` : ''}
      <tr class="grand"><td colspan="3" class="label">Grand total (${currency})</td><td class="amount">${fmt(inv.total)}</td></tr>
    </tfoot>
  </table>

  <p class="footer">Thank you for your order — please come back soon!</p>
  </body></html>`;
}

function escape(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cors(res: Response) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
  return res;
}
