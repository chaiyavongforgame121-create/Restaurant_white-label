// Admin CSV export — orders / customers / loyalty / revenue.
// Auth required + owner/manager role on the branch.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

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

  // Role check
  const { data: staff } = await supabase.from('staff_members').select('role').eq('branch_id', branchId).maybeSingle();
  if (!staff || !['owner', 'manager'].includes(staff.role)) return json({ error: 'not_authorized' }, 403);

  let rows: Record<string, unknown>[] = [];
  let headers: string[] = [];
  let filename = 'export.csv';

  if (kind === 'orders') {
    const { data } = await supabase
      .from('orders')
      .select('order_number, channel, status, customer_name, customer_phone, subtotal, delivery_fee, service_fee, tip_amount, discount_amount, total, created_at, completed_at')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(10000);
    rows = data ?? [];
    headers = ['order_number', 'channel', 'status', 'customer_name', 'customer_phone', 'subtotal', 'delivery_fee', 'service_fee', 'tip_amount', 'discount_amount', 'total', 'created_at', 'completed_at'];
    filename = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
  } else if (kind === 'customers') {
    const { data } = await supabase
      .from('customers')
      .select('id, full_name, phone, email, total_orders, total_spent, last_order_at, marketing_consent, created_at')
      .eq('branch_id', branchId)
      .order('total_spent', { ascending: false })
      .limit(10000);
    rows = data ?? [];
    headers = ['id', 'full_name', 'phone', 'email', 'total_orders', 'total_spent', 'last_order_at', 'marketing_consent', 'created_at'];
    filename = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
  } else if (kind === 'loyalty') {
    const { data } = await supabase
      .from('loyalty_transactions')
      .select('id, customer_id, points, balance_after, type, reference_type, description, created_at')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(10000);
    rows = data ?? [];
    headers = ['id', 'customer_id', 'points', 'balance_after', 'type', 'reference_type', 'description', 'created_at'];
    filename = `loyalty-${new Date().toISOString().slice(0, 10)}.csv`;
  } else if (kind === 'revenue') {
    const { data } = await supabase
      .from('orders')
      .select('created_at, channel, total')
      .eq('branch_id', branchId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(50000);
    rows = data ?? [];
    headers = ['created_at', 'channel', 'total'];
    filename = `revenue-${new Date().toISOString().slice(0, 10)}.csv`;
  } else {
    return json({ error: 'unknown_kind' }, 400);
  }

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
