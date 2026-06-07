// ai-chat-support — Claude-powered support chatbot for customers.
// POST { branch_id, history: [{role, content}], message } → { reply, source_refs[] }

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

  let body: { branch_id?: string; message?: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> };
  try { body = await req.json(); } catch { return cors(json({ error: 'invalid_json' }, 400)); }
  if (!body.branch_id || !body.message) return cors(json({ error: 'missing_fields' }, 400));

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const [{ data: branch }, { data: items }] = await Promise.all([
    admin.from('branches').select('name, address, settings').eq('id', body.branch_id).maybeSingle(),
    admin.from('menu_items').select('name, description, price').eq('branch_id', body.branch_id).eq('is_active', true).limit(50),
  ]);

  const systemPrompt = [
    `You are a friendly customer-support assistant for ${branch?.name ?? 'the restaurant'}.`,
    `Address: ${branch?.address ?? 'see menu page'}.`,
    'You can answer questions about: menu items, hours, ingredients, allergens, delivery times, refunds, and order status.',
    'If a user asks for sensitive actions (refunds, cancellations beyond pending), tell them you\'ll create a support ticket and a human will follow up.',
    'Keep replies under 4 sentences. Do not invent items or prices.',
    `Active menu (subset):\n${(items ?? []).map((i) => `- ${i.name} ($${Number(i.price).toFixed(2)})${i.description ? ': ' + i.description : ''}`).join('\n')}`,
  ].join('\n');

  const messages = [
    ...(body.history ?? []).slice(-10),
    { role: 'user' as const, content: body.message },
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system: systemPrompt,
      messages,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    return cors(json({ error: 'anthropic_error', detail: errBody }, 502));
  }
  const data = await res.json();
  const reply: string =
    data?.content?.find((b: { type: string }) => b.type === 'text')?.text ?? '';
  return cors(json({ reply }));
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
