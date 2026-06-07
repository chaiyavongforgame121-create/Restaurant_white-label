// AI menu import — accepts a public image URL (e.g. a photo of a printed menu)
// and returns a structured list of menu items via Claude vision.
//
// Caller flow:
//  1. Upload the image to the `branch-assets` bucket from the admin app.
//  2. Get a public URL.
//  3. Call this function: { image_url, branch_id } → returns proposed items.
//  4. Admin reviews + edits → bulk insert via supabase client.
//
// We DO NOT auto-insert. The admin must confirm.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5-20251001';

interface ProposedItem {
  category: string;
  name: string;
  description?: string;
  price: number;
  station?: 'hot' | 'cold' | 'bar' | 'dessert' | 'expo';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors(new Response('ok'));
  if (req.method !== 'POST') return cors(new Response('method_not_allowed', { status: 405 }));

  let body: { image_url?: string; branch_id?: string; hint?: string } = {};
  try {
    body = await req.json();
  } catch {
    return cors(json({ error: 'invalid_body' }, 400));
  }
  if (!body.image_url || !body.branch_id) {
    return cors(json({ error: 'image_url_and_branch_id_required' }, 400));
  }

  // Verify caller is owner/manager of the branch.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return cors(json({ error: 'auth_required' }, 401));
  }
  const userJwt = authHeader.slice(7);
  const supabase = createClient(SUPABASE_URL, userJwt, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
  });

  const { data: staffRow } = await supabase
    .from('staff_members')
    .select('role')
    .eq('branch_id', body.branch_id)
    .maybeSingle();
  if (!staffRow || !['owner', 'manager'].includes(staffRow.role)) {
    return cors(json({ error: 'not_authorized' }, 403));
  }

  if (!ANTHROPIC_API_KEY) {
    return cors(json({ error: 'anthropic_not_configured' }, 503));
  }

  // Rate limit: 20 imports/hour per branch
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: rl } = await admin.rpc('check_rate_limit', {
    p_bucket_key: `import:branch:${body.branch_id}`,
    p_max_count: 20,
    p_window_seconds: 3600,
  });
  if (rl && !(rl as { allowed: boolean }).allowed) {
    return cors(json({ error: 'rate_limited', retry_after_seconds: 3600 }, 429));
  }

  const items = await proposeItems(body.image_url, body.hint).catch((err: Error) => {
    return { error: err.message };
  });
  if (Array.isArray(items)) {
    return cors(json({ items }));
  }
  return cors(json(items, 502));
});

async function proposeItems(imageUrl: string, hint?: string): Promise<ProposedItem[]> {
  const system = [
    'You are extracting menu items from a restaurant menu image.',
    'Return ONLY structured data via the propose_items tool.',
    'Infer prices in the local currency shown. If currency is unclear, assume US Dollars (USD).',
    'Group items by category. If categories are not labeled, infer from item type.',
    'Map each item to a kitchen station: hot (cooked savory), cold (salads/raw), bar (drinks), dessert (sweets), expo (default).',
    hint ? `Hint from operator: ${hint}` : '',
  ].filter(Boolean).join(' ');

  const tools = [
    {
      name: 'propose_items',
      description: 'Submit the extracted menu items.',
      input_schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                price: { type: 'number' },
                station: { type: 'string', enum: ['hot', 'cold', 'bar', 'dessert', 'expo'] },
              },
              required: ['category', 'name', 'price'],
            },
          },
        },
        required: ['items'],
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
      max_tokens: 4000,
      system,
      tools,
      tool_choice: { type: 'tool', name: 'propose_items' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            { type: 'text', text: 'Extract every visible item with its price and category.' },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`anthropic_${res.status}:${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const toolUse = (data.content ?? []).find(
    (c: { type: string; name?: string }) => c.type === 'tool_use' && c.name === 'propose_items',
  );
  if (!toolUse) throw new Error('no_tool_use_in_response');
  const items = (toolUse.input?.items ?? []) as ProposedItem[];
  if (!Array.isArray(items) || items.length === 0) throw new Error('no_items_extracted');
  return items.slice(0, 200);
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
