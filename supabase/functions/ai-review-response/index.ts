// ai-review-response — drafts a brand-voiced reply to a customer review.
// Owner/manager hits this from admin; the draft is returned, NOT auto-posted.
// POST { rating_id } → { draft, sentiment }

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

  let body: { rating_id?: string };
  try { body = await req.json(); } catch { return cors(json({ error: 'invalid_json' }, 400)); }
  if (!body.rating_id) return cors(json({ error: 'rating_id_required' }, 400));

  const userClient = createClient(SUPABASE_URL, auth.slice(7), {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });
  const { data: rating, error: rErr } = await userClient
    .from('order_ratings')
    .select('id, food_stars, delivery_stars, comment, branch_id, branches(name)')
    .eq('id', body.rating_id)
    .maybeSingle();
  if (rErr || !rating) return cors(json({ error: 'not_found_or_not_authorized' }, 404));

  const branchName = (rating.branches as { name?: string } | null)?.name ?? 'our restaurant';
  const avgStars = (Number(rating.food_stars ?? 0) + Number(rating.delivery_stars ?? 0)) / 2;
  const sentiment = avgStars >= 4.5 ? 'positive' : avgStars >= 3 ? 'neutral' : 'negative';

  const system = [
    `You are the public-relations voice of ${branchName}, a US restaurant.`,
    'Write a warm, concise reply (under 80 words) to a customer review.',
    'Acknowledge specific points the reviewer raised. Never sound defensive or generic.',
    sentiment === 'negative'
      ? 'Apologize sincerely, offer a fix or refund path, invite them to email support@favornoms.com.'
      : sentiment === 'neutral'
      ? 'Thank them, mention something specific, invite them back.'
      : 'Thank them, repeat a specific compliment, invite them back.',
  ].join('\n');

  const userMessage = `Stars (food): ${rating.food_stars}\nStars (delivery): ${rating.delivery_stars ?? 'n/a'}\nComment: ${rating.comment ?? '(no text)'}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) return cors(json({ error: 'anthropic_error', detail: await res.text() }, 502));
  const data = await res.json();
  const draft: string = data?.content?.find((b: { type: string }) => b.type === 'text')?.text ?? '';
  return cors(json({ draft, sentiment }));
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
