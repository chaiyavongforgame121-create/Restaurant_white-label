// Admin CSV export — orders / revenue / menu / payments / refunds / customers / loyalty.
// Auth required + the reports.view capability on the branch (my_capabilities, the same answer
// the back office's sidebar and Reports screen get).
//
// Everything is this branch's alone. customers rows are per branch (a diner who uses two branches
// has a row at each), so the customers file lists this branch's records with this branch's
// totals and points; the loyalty file lists this branch's ledger only.
//
// Every kind except `customers` honours the ?from=&to= window the Reports screen is showing,
// as branch-local calendar dates with `to` inclusive — the same contract as the six
// get_branch_*_report RPCs. Without it the CSV was "the last 10 000 rows of all time",
// which never matched the report the merchant was looking at when they clicked Export.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { billingInactiveBody, loadEntitlements } from '../_shared/entitlements.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// The same rules as packages/database/src/queries/customers.ts and the database's
// private.is_placeholder_customer_name / private.is_synthetic_email, so the file names a
// customer exactly as the Customers page does.
const PLACEHOLDER_NAME = /^(walk[- ]?in|guest|customer|deleted user|table\s*\S+)$/i;
const SYNTHETIC_EMAIL = /@([a-z0-9-]+\.)*favornoms\.local$/i;
const PLACEHOLDER_PHONE = '+10000000000';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const branchId = url.searchParams.get('branch_id');
  const kind = url.searchParams.get('kind') ?? 'orders';
  if (!branchId) return json({ error: 'branch_id_required' }, 400);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'auth_required' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Validate the caller's JWT with the SERVICE-ROLE client, passing the token explicitly.
  const { data: authData } = await admin.auth.getUser(authHeader.slice(7));
  const uid = authData.user?.id;
  if (!uid) return json({ error: 'auth_required' }, 401);

  const { data: branchRow } = await admin
    .from('branches')
    .select('restaurant_id, timezone')
    .eq('id', branchId)
    .maybeSingle();
  if (!branchRow) return json({ error: 'branch_not_found' }, 404);

  // Capability check, as the caller. my_capabilities is the one answer the whole back office
  // uses for "what may this person do at this branch": it covers an owner row filed under any
  // branch of the restaurant (an owner owns every branch), restaurant-wide rows, the
  // restaurant's owner_user_id and platform admins, and it ignores suspended or removed rows.
  // The hand-written
  // staff_members check this replaces only accepted a row for exactly this branch, so the owner,
  // whose row names the first branch, got 403 on every branch opened after it.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: caps, error: capsError } = await asCaller.rpc('my_capabilities', { p_branch_id: branchId });
  if (capsError) {
    console.error('my_capabilities failed', capsError.message);
    return json({ error: 'not_authorized' }, 403);
  }
  const capabilities = new Set(
    ((caps ?? []) as unknown[]).map((c) =>
      typeof c === 'string' ? c : String((c as Record<string, unknown>)?.my_capabilities ?? ''),
    ),
  );
  if (!capabilities.has('reports.view')) return json({ error: 'not_authorized' }, 403);

  // Back-office data egress stops at suspension. Nothing is deleted — paying
  // restores the export immediately.
  const ent = await loadEntitlements(admin, { branchId });
  if (!ent.entitled) return json(billingInactiveBody('export'), 402);

  // The window, resolved in the BRANCH's timezone so an export lines up with the report
  // beside it. Absent or malformed dates mean "everything", which is what every existing
  // bookmark of this endpoint asks for.
  const tz = branchRow.timezone || 'UTC';
  const fromDay = url.searchParams.get('from');
  const toDay = url.searchParams.get('to');
  let fromIso: string | null = null;
  let toIso: string | null = null;
  if (fromDay && toDay && ISO_DAY.test(fromDay) && ISO_DAY.test(toDay)) {
    const [lo, hi] = fromDay <= toDay ? [fromDay, toDay] : [toDay, fromDay];
    fromIso = startOfLocalDay(lo, tz);
    toIso = startOfLocalDay(addDay(hi, 1), tz); // half-open: `to` is inclusive
  }
  // Loosely typed on purpose: the column may be an embedded one ('orders.created_at'),
  // which the generated row types cannot describe.
  // deno-lint-ignore no-explicit-any
  const windowed = (query: any, column: string): any =>
    fromIso && toIso ? query.gte(column, fromIso).lt(column, toIso) : query;
  const stamp = fromDay && toDay ? `${fromDay}_${toDay}` : new Date().toISOString().slice(0, 10);

  let rows: Record<string, unknown>[] = [];
  let headers: string[] = [];
  let filename = 'export.csv';
  let queryError: string | null = null;

  // Data reads go through the SERVICE-ROLE client, explicitly scoped by branch_id. The
  // caller's authorisation for this branch was established above; the `supabase` client is
  // built with the user's JWT in the apikey slot, and reading through it returned zero rows
  // while the destructure ignored `error` — so every export downloaded as a headers-only
  // file that looked like "this branch has no data" instead of a failure.
  if (kind === 'orders') {
    const { data, error } = await windowed(
      admin
        .from('orders')
        .select('order_number, channel, source, status, customer_name, customer_phone, subtotal, discount_amount, promo_code, promo_discount, tax_amount, delivery_fee, service_fee, tip_amount, total, created_at, completed_at')
        .eq('branch_id', branchId),
      'created_at',
    )
      .order('created_at', { ascending: false })
      .limit(10000);
    rows = data ?? []; queryError = error?.message ?? queryError;
    headers = ['order_number', 'channel', 'source', 'status', 'customer_name', 'customer_phone', 'subtotal', 'discount_amount', 'promo_code', 'promo_discount', 'tax_amount', 'delivery_fee', 'service_fee', 'tip_amount', 'total', 'created_at', 'completed_at'];
    filename = `orders-${stamp}.csv`;
  } else if (kind === 'customers') {
    // This branch's customer records with this branch's totals (completed orders), wallet and
    // the name the Customers page shows: profile name, else the latest real name they gave on an
    // order here, else their email. The address is where the food last went, else the default
    // saved address. Every embed is pinned to this branch.
    const { data, error } = await admin
      .from('customers')
      .select(
        'id, full_name, phone, email, total_orders, total_spent, last_order_at, marketing_consent, created_at, ' +
          'recent:orders(customer_name, customer_phone, created_at), ' +
          'delivered:orders(delivery_address, created_at), ' +
          'customer_addresses(address_line1, address_line2, city, state, postal_code, is_default, created_at), ' +
          'loyalty_points(points_balance, tier)',
      )
      .eq('branch_id', branchId)
      .eq('recent.branch_id', branchId)
      .order('created_at', { referencedTable: 'recent', ascending: false })
      .limit(5, { referencedTable: 'recent' })
      .eq('delivered.branch_id', branchId)
      .eq('delivered.channel', 'delivery')
      .not('delivered.delivery_address', 'is', null)
      .order('created_at', { referencedTable: 'delivered', ascending: false })
      .limit(1, { referencedTable: 'delivered' })
      .eq('loyalty_points.branch_id', branchId)
      .order('total_spent', { ascending: false })
      .order('id', { ascending: true })
      .limit(10000);
    queryError = error?.message ?? queryError;
    rows = ((data ?? []) as unknown as CustomerExportRow[]).map(customerCsvRow);
    headers = [
      'id', 'name', 'name_source', 'phone', 'email', 'address', 'total_orders', 'total_spent',
      'last_order_at', 'points_balance', 'tier', 'marketing_consent', 'created_at',
    ];
    filename = `customers-${stamp}.csv`;
  } else if (kind === 'loyalty') {
    // This branch's ledger only. Each branch runs its own loyalty programme, so a row belongs to
    // exactly one branch; the old restaurant-wide filter mixed every branch's points into one
    // file once a second branch existed.
    const { data, error } = await windowed(
      admin
        .from('loyalty_transactions')
        .select('id, customer_id, points, balance_after, type, reference_type, reference_id, description, created_at, customers(full_name)')
        .eq('branch_id', branchId),
      'created_at',
    )
      .order('created_at', { ascending: false })
      .limit(10000);
    queryError = error?.message ?? queryError;
    rows = ((data ?? []) as Array<Record<string, unknown> & { customers?: unknown }>).map((r) => {
      const c = Array.isArray(r.customers) ? r.customers[0] : r.customers;
      const { customers: _customers, ...rest } = r;
      return { ...rest, customer_name: (c as { full_name?: string | null } | null)?.full_name ?? '' };
    });
    headers = ['id', 'customer_id', 'customer_name', 'points', 'balance_after', 'type', 'reference_type', 'reference_id', 'description', 'created_at'];
    filename = `loyalty-${stamp}.csv`;
  } else if (kind === 'revenue') {
    const { data, error } = await windowed(
      admin
        .from('orders')
        .select('created_at, channel, subtotal, discount_amount, tax_amount, delivery_fee, service_fee, tip_amount, total')
        .eq('branch_id', branchId)
        .eq('status', 'completed'),
      'created_at',
    )
      .order('created_at', { ascending: false })
      .limit(50000);
    rows = data ?? []; queryError = error?.message ?? queryError;
    headers = ['created_at', 'channel', 'subtotal', 'discount_amount', 'tax_amount', 'delivery_fee', 'service_fee', 'tip_amount', 'total'];
    filename = `revenue-${stamp}.csv`;
  } else if (kind === 'payments') {
    // !inner so the window applies to the ORDER's date, matching the Payments section.
    // Bucketing on payments.paid_at would drop every pending row — exactly the ones a
    // merchant reconciling the till is chasing.
    const { data, error } = await windowed(
      admin
        .from('payments')
        .select('amount, method, status, gateway, paid_at, created_at, orders!inner(order_number, status, created_at)')
        .eq('branch_id', branchId),
      'orders.created_at',
    )
      .order('created_at', { ascending: false })
      .limit(20000);
    queryError = error?.message ?? queryError;
    type EmbeddedOrder = { order_number?: string; status?: string };
    const paymentRows = (data ?? []) as Array<{
      amount: number;
      method: string;
      status: string;
      gateway: string | null;
      paid_at: string | null;
      created_at: string;
      orders: EmbeddedOrder | EmbeddedOrder[] | null;
    }>;
    rows = paymentRows.map((p) => {
      const order = Array.isArray(p.orders) ? p.orders[0] : p.orders;
      return {
        order_number: order?.order_number ?? '',
        order_status: order?.status ?? '',
        method: p.method,
        status: p.status,
        amount: p.amount,
        gateway: p.gateway,
        paid_at: p.paid_at,
        created_at: p.created_at,
      };
    });
    headers = ['order_number', 'order_status', 'method', 'status', 'amount', 'gateway', 'paid_at', 'created_at'];
    filename = `payments-${stamp}.csv`;
  } else if (kind === 'refunds') {
    // audit_logs is the ONLY refund ledger in this schema: refund_order() writes nothing to
    // payments, and it only touches orders.status when the refund covers the whole total —
    // so a partial refund exists here and nowhere else.
    const { data, error } = await windowed(
      admin
        .from('audit_logs')
        .select('created_at, entity_id, actor_id, metadata')
        .eq('branch_id', branchId)
        .eq('action', 'refund')
        .eq('entity_type', 'order'),
      'created_at',
    )
      .order('created_at', { ascending: false })
      .limit(20000);
    queryError = error?.message ?? queryError;
    const auditRows = (data ?? []) as Array<{
      created_at: string;
      entity_id: string | null;
      actor_id: string | null;
      metadata: Record<string, unknown> | null;
    }>;
    rows = auditRows.map((r) => {
      const meta = r.metadata ?? {};
      return {
        created_at: r.created_at,
        order_id: r.entity_id,
        amount: meta.amount ?? '',
        reason: meta.reason ?? '',
        actor_id: r.actor_id,
      };
    });
    headers = ['created_at', 'order_id', 'amount', 'reason', 'actor_id'];
    filename = `refunds-${stamp}.csv`;
  } else if (kind === 'menu') {
    // Aggregated in this function rather than by the report RPC: the RPC is security
    // definer against auth.uid(), and this handler reads as the service role.
    const { data, error } = await windowed(
      admin
        .from('order_items')
        .select('item_name, quantity, subtotal, modifier_total, combo_id, order_id, orders!inner(branch_id, status, created_at)')
        .eq('orders.branch_id', branchId)
        .neq('orders.status', 'cancelled'),
      'orders.created_at',
    ).limit(100000);
    queryError = error?.message ?? queryError;
    const lineRows = (data ?? []) as Array<{
      item_name: string | null;
      quantity: number | null;
      subtotal: number | null;
      combo_id: string | null;
      order_id: string;
    }>;
    const byItem = new Map<
      string,
      { item_name: string; is_combo: string; quantity: number; revenue: number; orders: Set<string> }
    >();
    for (const line of lineRows) {
      const name = String(line.item_name ?? '');
      const entry = byItem.get(name) ?? {
        item_name: name,
        is_combo: line.combo_id ? 'yes' : 'no',
        quantity: 0,
        revenue: 0,
        orders: new Set<string>(),
      };
      entry.quantity += Number(line.quantity ?? 0);
      entry.revenue += Number(line.subtotal ?? 0);
      entry.orders.add(String(line.order_id));
      byItem.set(name, entry);
    }
    rows = [...byItem.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .map((e) => ({
        item_name: e.item_name,
        is_combo: e.is_combo,
        quantity: e.quantity,
        orders: e.orders.size,
        revenue: e.revenue.toFixed(2),
      }));
    headers = ['item_name', 'is_combo', 'quantity', 'orders', 'revenue'];
    filename = `menu-${stamp}.csv`;
  } else {
    return json({ error: 'unknown_kind' }, 400);
  }

  // Never hand back a headers-only CSV that silently means "the read failed".
  if (queryError) return json({ error: 'export_query_failed', detail: queryError }, 500);

  const csv = toCsv(headers, rows);
  return new Response(csv, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});

interface CustomerExportRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  total_orders: number | null;
  total_spent: number | null;
  last_order_at: string | null;
  marketing_consent: boolean | null;
  created_at: string;
  recent?: unknown;
  delivered?: unknown;
  customer_addresses?: unknown;
  loyalty_points?: unknown;
}

const asList = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : value ? [value as T] : [];

const joinParts = (parts: unknown[]): string =>
  parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p.length > 0)
    .join(', ');

/** One customers row as its CSV line, named and addressed the way the Customers page shows it. */
function customerCsvRow(c: CustomerExportRow): Record<string, unknown> {
  const recent = asList<{ customer_name: string | null; customer_phone: string | null; created_at: string }>(c.recent)
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const email = c.email?.trim() && !SYNTHETIC_EMAIL.test(c.email.trim()) ? c.email.trim() : '';
  const profileName = c.full_name?.trim() ?? '';
  const orderName =
    recent.map((o) => o.customer_name?.trim() ?? '').find((n) => n !== '' && !PLACEHOLDER_NAME.test(n)) ?? '';
  const name = profileName || orderName || email;
  const nameSource = profileName ? 'profile' : orderName ? 'order' : email ? 'email' : '';
  const phone =
    c.phone?.trim() ||
    recent.map((o) => o.customer_phone?.trim() ?? '').find((p) => p !== '' && p !== PLACEHOLDER_PHONE) ||
    '';

  const lastDelivery = asList<{ delivery_address: unknown; created_at: string }>(c.delivered)
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const deliveredTo =
    lastDelivery?.delivery_address && typeof lastDelivery.delivery_address === 'object'
      ? (() => {
          const a = lastDelivery.delivery_address as Record<string, unknown>;
          return joinParts([a.line1, a.line2, a.city, a.state, a.postal_code]);
        })()
      : '';
  const saved = asList<{
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    is_default: boolean | null;
    created_at: string;
  }>(c.customer_addresses)
    .slice()
    .sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default) || b.created_at.localeCompare(a.created_at))[0];
  const savedAt = saved
    ? joinParts([saved.address_line1, saved.address_line2, saved.city, saved.state, saved.postal_code])
    : '';
  const wallet = asList<{ points_balance: number | null; tier: string | null }>(c.loyalty_points)[0];

  return {
    id: c.id,
    name,
    name_source: nameSource,
    phone,
    email,
    address: deliveredTo || savedAt,
    total_orders: c.total_orders ?? 0,
    total_spent: c.total_spent ?? 0,
    last_order_at: c.last_order_at,
    points_balance: wallet ? (wallet.points_balance ?? 0) : '',
    tier: wallet?.tier ?? '',
    marketing_consent: c.marketing_consent ?? false,
    created_at: c.created_at,
  };
}

/** Step whole days from a YYYY-MM-DD, anchored at noon UTC so a DST shift cannot move it. */
function addDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** The UTC instant at which `day` begins in `timeZone`. */
function startOfLocalDay(day: string, timeZone: string): string {
  const wall = Date.parse(`${day}T00:00:00Z`);
  // Two passes: the first offset is read at the wrong instant on a DST changeover day,
  // and re-reading it at the corrected instant settles it.
  let instant = wall - zoneOffsetMs(new Date(wall), timeZone);
  instant = wall - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant).toISOString();
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - at.getTime();
}

function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const escape = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
