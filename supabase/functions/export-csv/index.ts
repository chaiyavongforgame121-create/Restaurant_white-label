// Admin CSV export — orders / revenue / menu / payments / refunds / customers / loyalty.
// Auth required + owner/admin/manager on the branch.
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
  const supabase = createClient(SUPABASE_URL, authHeader.slice(7), {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Role check.
  //
  // This used to be `.select('role').eq('branch_id', branchId).maybeSingle()` with no
  // user filter, leaning on RLS to narrow the rows. But staff_owner_manage lets an owner
  // read EVERY staff row in their restaurant, so on any branch with more than one staff
  // member the query matched several rows, maybeSingle() failed, `staff` came back null and
  // the owner got 403 — i.e. the export was broken for precisely the people allowed to use
  // it, and only ever worked on a branch staffed by exactly one person. Brooklyn returns 5.
  //
  // Resolve the CALLER's own membership explicitly instead, and honour the two ways a
  // person can be staff on a branch: a row for that branch, or a restaurant-wide row
  // (branch_id IS NULL) covering every branch of the restaurant.
  // Validate the caller's JWT with the SERVICE-ROLE client, passing the token explicitly.
  // `supabase` above is built with the user's JWT standing in for the anon key, so calling
  // getUser() on it sends that JWT as the apikey and comes back 401.
  const { data: authData } = await admin.auth.getUser(authHeader.slice(7));
  const uid = authData.user?.id;
  if (!uid) return json({ error: 'auth_required' }, 401);

  const { data: branchRow } = await admin
    .from('branches')
    .select('restaurant_id, timezone')
    .eq('id', branchId)
    .maybeSingle();
  if (!branchRow) return json({ error: 'branch_not_found' }, 404);

  const { data: memberships } = await admin
    .from('staff_members')
    .select('role, branch_id')
    .eq('user_id', uid)
    .eq('status', 'active')
    .eq('restaurant_id', branchRow.restaurant_id);

  // `admin` belongs here: role_capabilities grants it reports.view, so the sidebar shows it
  // Reports and the screen renders the export buttons — leaving it out of this list meant
  // the one role added after this function was written got a 403 from its own screen.
  const allowed = (memberships ?? []).some(
    (m) =>
      ['owner', 'admin', 'manager'].includes(m.role as string) &&
      (m.branch_id === branchId || m.branch_id === null),
  );

  // Platform admins operate across tenants and must not be locked out of a tenant's export.
  let isPlatformAdmin = false;
  if (!allowed) {
    const { data: pa } = await supabase.rpc('is_platform_admin');
    isPlatformAdmin = pa === true;
  }
  if (!allowed && !isPlatformAdmin) return json({ error: 'not_authorized' }, 403);

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
    const { data, error } = await admin
      .from('customers')
      .select('id, full_name, phone, email, total_orders, total_spent, last_order_at, marketing_consent, created_at')
      .eq('branch_id', branchId)
      .order('total_spent', { ascending: false })
      .limit(10000);
    rows = data ?? []; queryError = error?.message ?? queryError;
    headers = ['id', 'full_name', 'phone', 'email', 'total_orders', 'total_spent', 'last_order_at', 'marketing_consent', 'created_at'];
    filename = `customers-${stamp}.csv`;
  } else if (kind === 'loyalty') {
    // Scoped by RESTAURANT, not branch. Loyalty is brand-wide by design (the owner-locked
    // decision: points follow the diner across every branch of a restaurant), so every
    // loyalty_transactions row carries restaurant_id and leaves branch_id NULL. Filtering
    // on branch_id matched 0 of 19 live rows and made this export download an empty file.
    const { data, error } = await windowed(
      admin
        .from('loyalty_transactions')
        .select('id, customer_id, points, balance_after, type, reference_type, reference_id, description, created_at')
        .eq('restaurant_id', branchRow.restaurant_id),
      'created_at',
    )
      .order('created_at', { ascending: false })
      .limit(10000);
    rows = data ?? []; queryError = error?.message ?? queryError;
    headers = ['id', 'customer_id', 'points', 'balance_after', 'type', 'reference_type', 'reference_id', 'description', 'created_at'];
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
