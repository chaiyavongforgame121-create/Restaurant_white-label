// ai-menu-optimize — analyzes menu performance (sales mix vs. inventory cost)
// and returns 5–10 prioritized recommendations (price changes, promote/hide).
// POST { branch_id } → { recommendations: [...] }

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5-20251001';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors(new Response('ok'));
  if (req.method !== 'POST') return cors(json({ error: 'method_not_allowed' }, 405));
  if (!ANTHROPIC_API_KEY) return cors(json({ error: 'ai_not_configured' }, 503));

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return cors(json({ error: 'auth_required' }, 401));

  let body: { branch_id?: string };
  try { body = await req.json(); } catch { return cors(json({ error: 'invalid_json' }, 400)); }
  if (!body.branch_id) return cors(json({ error: 'branch_id_required' }, 400));

  const userClient = createClient(SUPABASE_URL, auth.slice(7), {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });
  // Authorize: only managers can run.
  const { data: sm } = await userClient.from('staff_members').select('role')
    .eq('branch_id', body.branch_id).maybeSingle();
  if (!sm || !['owner', 'manager'].includes(sm.role)) {
    return cors(json({ error: 'not_authorized' }, 403));
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // Pull sales mix (last 60 days).
  const { data: mix } = await admin.rpc('get_branch_reviews', { p_branch_id: body.branch_id, p_limit: 0 });
  const { data: salesRows } = await admin
    .from('order_items')
    .select('menu_item_id, quantity, subtotal, orders!inner(branch_id, created_at, status)')
    .eq('orders.branch_id', body.branch_id)
    .gte('orders.created_at', since)
    .in('orders.status', ['completed', 'confirmed', 'preparing', 'ready', 'out_for_delivery']);

  const salesByItem = new Map<string, { qty: number; revenue: number }>();
  for (const row of (salesRows ?? []) as Array<{ menu_item_id: string; quantity: number; subtotal: number | string }>) {
    if (!row.menu_item_id) continue;
    const cur = salesByItem.get(row.menu_item_id) ?? { qty: 0, revenue: 0 };
    cur.qty += row.quantity;
    cur.revenue += Number(row.subtotal);
    salesByItem.set(row.menu_item_id, cur);
  }

  const { data: items } = await admin
    .from('menu_items')
    .select('id, name, price, category_id, is_active')
    .eq('branch_id', body.branch_id);

  const totalSold = Array.from(salesByItem.values()).reduce((s, v) => s + v.qty, 0) || 1;
  const lines = (items ?? []).map((it) => {
    const s = salesByItem.get(it.id) ?? { qty: 0, revenue: 0 };
    const share = ((s.qty / totalSold) * 100).toFixed(1);
    return `- ${it.name} ($${Number(it.price).toFixed(2)}): sold ${s.qty} units in 60d (${share}% of mix, revenue $${s.revenue.toFixed(0)})`;
  });

  const system = [
    'You are a restaurant menu-optimization consultant analyzing 60-day sales data.',
    'Return 5-10 SPECIFIC, ACTIONABLE recommendations as JSON.',
    'Each recommendation must have: type ("price_change", "promote", "deprioritize", "bundle", "review"), item_name, current_price, suggested_action, rationale (1 sentence).',
    'Do not recommend anything for items with zero sales unless suggesting removal.',
    'Format: { "recommendations": [...] }',
  ].join(' ');

  const userMessage = `Menu performance (last 60 days):\n${lines.join('\n')}\n\n${(mix as { summary?: { rating?: number } } | null)?.summary?.rating ? `Average rating: ${(mix as { summary: { rating: number } }).summary.rating}/5` : ''}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) return cors(json({ error: 'anthropic_error', detail: await res.text() }, 502));
  const data = await res.json();
  const text: string = data?.content?.find((b: { type: string }) => b.type === 'text')?.text ?? '';

  // Parse JSON out of the response.
  let recommendations: unknown = [];
  try {
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      recommendations = JSON.parse(text.slice(jsonStart, jsonEnd + 1)).recommendations;
    }
  } catch {
    // Fall through.
  }

  return cors(json({ recommendations, raw: text.slice(0, 4000) }));
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function cors(res: Response) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  return res;
}
