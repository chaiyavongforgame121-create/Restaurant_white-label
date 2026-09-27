// Retired (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §4.4). Package payments moved to the
// `stripe-billing` function (actions start / confirm / portal), which files the request first and
// lets the server price it; this function charged the dormant rail's own prices instead.
//
// It stays deployed only so an old tab gets a clear answer rather than a 404, and answers every
// call with 410 { error: 'moved', use: 'stripe-billing' }. It reads no secret and calls nothing.
// The owner can delete it from the Supabase dashboard.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  return new Response(JSON.stringify({ error: 'moved', use: 'stripe-billing' }), {
    status: 410,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
