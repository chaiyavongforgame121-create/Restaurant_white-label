// Admin CSV export — orders / customers / loyalty / revenue.
// Auth required + owner/manager role on the branch.

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
    .select('restaurant_id')
    .eq('id', branchId)
    .maybeSingle();
  if (!branchRow) return json({ error: 'branch_not_found' }, 404);

  const { data: memberships } = await admin
    .from('staff_members')
    .select('role, branch_id')
    .eq('user_id', uid)
    .eq('status', 'active')
    .eq('restaurant_id', branchRow.restaurant_id);

  const allowed = (memberships ?? []).some(
    (m) =>
      ['owner', 'manager'].includes(m.role as string) &&
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
    const { data, error } = await admin
      .from('orders')
      .select('order_number, channel, status, customer_name, customer_phone, subtotal, delivery_fee, service_fee, tip_amount, discount_amount, total, created_at, completed_at')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(10000);
    rows = data ?? []; queryError = error?.message ?? queryError;
    headers = ['order_number', 'channel', 'status', 'customer_name', 'customer_phone', 'subtotal', 'delivery_fee', 'service_fee', 'tip_amount', 'discount_amount', 'total', 'created_at', 'completed_at'];
    filename = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
  } else if (kind === 'customers') {
    const { data, error } = await admin
      .from('customers')
      .select('id, full_name, phone, email, total_orders, total_spent, last_order_at, marketing_consent, created_at')
      .eq('branch_id', branchId)
      .order('total_spent', { ascending: false })
      .limit(10000);
    rows = data ?? []; queryError = error?.message ?? queryError;
    headers = ['id', 'full_name', 'phone', 'email', 'total_orders', 'total_spent', 'last_order_at', 'marketing_consent', 'created_at'];
    filename = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
  } else if (kind === 'loyalty') {
    // Scoped by RESTAURANT, not branch. Loyalty is brand-wide by design (the owner-locked
    // decision: points follow the diner across every branch of a restaurant), so every
    // loyalty_transactions row carries restaurant_id and leaves branch_id NULL. Filtering
    // on branch_id matched 0 of 19 live rows and made this export download an empty file.
    const { data, error } = await admin
      .from('loyalty_transactions')
      .select('id, customer_id, points, balance_after, type, reference_type, description, created_at')
      .eq('restaurant_id', branchRow.restaurant_id)
      .order('created_at', { ascending: false })
      .limit(10000);
    rows = data ?? []; queryError = error?.message ?? queryError;
    headers = ['id', 'customer_id', 'points', 'balance_after', 'type', 'reference_type', 'description', 'created_at'];
    filename = `loyalty-${new Date().toISOString().slice(0, 10)}.csv`;
  } else if (kind === 'revenue') {
    const { data, error } = await admin
      .from('orders')
      .select('created_at, channel, total')
      .eq('branch_id', branchId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(50000);
    rows = data ?? []; queryError = error?.message ?? queryError;
    headers = ['created_at', 'channel', 'total'];
    filename = `revenue-${new Date().toISOString().slice(0, 10)}.csv`;
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
