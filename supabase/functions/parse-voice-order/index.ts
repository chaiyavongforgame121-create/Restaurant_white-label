// Voice ordering — convert a transcribed customer utterance into cart actions.
//
// Input:  { transcript: string, branch_id: string, locale?: 'th'|'en' }
// Output: { actions: [{ type: 'add', menu_item_id, quantity, notes? } | { type: 'clear' }],
//           explanation: string }
//
// The function:
//  1. Loads the active menu for branch_id (server-side, public-read RLS).
//  2. Sends transcript + menu to Claude as a constrained tool call.
//  3. Returns structured actions for the web client to apply locally.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5-20251001';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors(new Response('ok'));
  if (req.method !== 'POST') return cors(new Response('method_not_allowed', { status: 405 }));

  let body: { transcript?: string; branch_id?: string; locale?: string } = {};
  try {
    body = await req.json();
  } catch {
    return cors(json({ error: 'invalid_body' }, 400));
  }
  if (!body.transcript || !body.branch_id) {
    return cors(json({ error: 'transcript_and_branch_id_required' }, 400));
  }
  if (!ANTHROPIC_API_KEY) {
    return cors(json({ error: 'anthropic_not_configured' }, 503));
  }

  // Rate limit by client IP + branch (10/min). Uses service-role to call RPC.
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: rl } = await admin.rpc('check_rate_limit', {
    p_bucket_key: `voice:${ip}:${body.branch_id}`,
    p_max_count: 10,
    p_window_seconds: 60,
  });
  if (rl && !(rl as { allowed: boolean }).allowed) {
    return cors(json({ error: 'rate_limited', retry_after_seconds: 60 }, 429));
  }

  // Public-read menu via anon key (RLS allows it on active branches).
  const supabase = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: items, error: menuErr } = await supabase
    .from('menu_items')
    .select('id, name, name_translations, price, description, category_id')
    .eq('branch_id', body.branch_id)
    .eq('is_active', true)
    .limit(200);
  if (menuErr) return cors(json({ error: menuErr.message }, 500));
  if (!items || items.length === 0) return cors(json({ error: 'menu_empty' }, 404));

  const menuLines = items.map((m) => `- ${m.id} | ${m.name} | $${Number(m.price).toFixed(2)}`);

  const system = [
    'You convert a voice order transcript into structured cart actions.',
    'Match each requested item to a real menu_item_id from the list provided.',
    'If the user is ambiguous, pick the closest match or skip that item.',
    'If the user says "clear cart" or similar, emit a clear action first.',
    'Quantity defaults to 1 if unstated.',
    'Never invent items not in the menu.',
    `Locale hint: ${body.locale ?? 'en'}.`,
  ].join(' ');

  const tools = [
    {
      name: 'apply_cart_actions',
      description: 'Apply the requested cart actions.',
      input_schema: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['add', 'clear'] },
                menu_item_id: { type: 'string' },
                quantity: { type: 'integer', minimum: 1, maximum: 20 },
                notes: { type: 'string' },
              },
              required: ['type'],
            },
          },
          explanation: { type: 'string' },
        },
        required: ['actions', 'explanation'],
      },
    },
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system,
      tools,
      tool_choice: { type: 'tool', name: 'apply_cart_actions' },
      messages: [
        {
          role: 'user',
          content: `Menu:\n${menuLines.join('\n')}\n\nUser said:\n"""\n${body.transcript}\n"""`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return cors(json({ error: `anthropic_${res.status}`, detail: text.slice(0, 300) }, 502));
  }
  const data = await res.json();
  const toolUse = (data.content ?? []).find(
    (c: { type: string; name?: string }) => c.type === 'tool_use' && c.name === 'apply_cart_actions',
  );
  if (!toolUse) return cors(json({ error: 'no_tool_use' }, 502));

  const input = toolUse.input as {
    actions?: Array<{ type: string; menu_item_id?: string; quantity?: number; notes?: string }>;
    explanation?: string;
  };

  // Filter: only allow ids that exist in our menu
  const validIds = new Set(items.map((i) => i.id));
  const actions = (input.actions ?? []).filter(
    (a) => a.type === 'clear' || (a.menu_item_id && validIds.has(a.menu_item_id)),
  );

  return cors(json({ actions, explanation: input.explanation ?? '' }));
});

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
