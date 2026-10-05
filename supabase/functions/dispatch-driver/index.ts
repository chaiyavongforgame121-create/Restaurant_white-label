// dispatch-driver v3 — a thin, authenticated door to the database's dispatch.
//
// POST { delivery_id: uuid } or { order_id: uuid }, optional { reset: true }
//
// v3 (2026-10-05, docs/DISPATCH-FIXES-2026-10-05.md D1): the decision moved into the database.
//   Choosing a rider here and stamping the offer in a second call, with no lock between them, is
//   how two runs 254 ms apart gave one rider three offers at once (15:52:18 that day). And every
//   automatic run reached this function through pg_net with a service-role key read from
//   private.app_settings, which was empty, so the ready trigger, a rider's decline and an expired
//   offer never offered the order to anyone: every offer that day came from a staff tap.
//   private.dispatch_delivery() now picks and stamps in one transaction under a per-branch lock,
//   and the triggers, reject_dispatch and the 30-second sweep call it directly. What is left here
//   is what the kitchen board and Live deliveries call when staff tap "Find rider":
//   • the same callers as v2.4: `Bearer <service role key>`, or a signed-in user holding
//     delivery.manage or kitchen.access at the DELIVERY's branch (my_capabilities; checked again
//     inside the SQL, so neither check alone is the only lock);
//   • order_id resolved to its delivery;
//   • public.staff_dispatch_delivery(p_delivery_id, p_restart) called AS THE CALLER (their JWT),
//     so the database sees who asked. `reset: true` is p_restart: a new round in which everyone
//     may be asked again (D2), refused with 409 already_accepted once a rider has accepted (D6).
//     v2's reset wiped the history instead, so the rider who had just declined was offered the
//     same order again — two declines in a day is a 60-minute cooldown, which is how two riders
//     were "banned" by staff taps;
//   • the verdict mapped to the HTTP answers the screens already read (../_shared/dispatch-answer.ts).
//   Earnings, the driver's tip share, stacking, the rider push and the "nobody found" staff alert
//   are all written by the SQL now; nothing here writes a row.
//
// v2.5 (2026-09-23): no entitlement gate — a delivery that exists is dispatched whatever the
//   branch's delivery switch or billing says now (the rule in ../_shared/entitlements.ts).
// v2.4 (2026-09-18): callers must be authorized (401 auth_required, 403 not_authorized, both
//   before anything is written). It used to act on any delivery id for anyone holding the anon key.
// v2–v2.3 (2026-06-11 … 2026-07-24): offers with a TTL, candidate scoring, batched offers. All of
//   that lives in private.dispatch_delivery now.
//
// DEPLOYMENT: imports ../_shared/dispatch-answer.ts. Deploy AFTER the migration that creates
// staff_dispatch_delivery; before it, every call answers 500 dispatch_failed (dispatch_sql_missing).

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  answerForDispatch,
  answerForRpcError,
  parseDispatchRequest,
} from '../_shared/dispatch-answer.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(s: number, b: unknown) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Who is calling. The service role key is an internal caller; anything else must be a
  // signed-in user, whose capability at the delivery's branch is checked once that is known.
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = /^bearer\s+/i.test(authHeader) ? authHeader.replace(/^bearer\s+/i, '').trim() : '';
  if (!token) return json(401, { error: 'auth_required' });
  let userClient: SupabaseClient | null = null;
  if (token !== serviceKey) {
    userClient = createClient(url, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    // The token is passed explicitly: without a stored session, getUser() relies on the client
    // noticing the custom Authorization header, which older supabase-js builds did not do.
    const { data: userData } = await userClient.auth.getUser(token);
    if (!userData?.user) return json(401, { error: 'auth_required' });
  }

  const request = parseDispatchRequest(await req.json().catch(() => null));
  if (!request) return json(400, { error: 'delivery_id_or_order_id_required' });

  // Read with the service role: the caller's own read could be hidden by RLS, which would answer
  // "not found" for a delivery they simply may not see — the capability check below says so instead.
  const { data: delivery, error: dErr } = await admin
    .from('deliveries')
    .select('id, branch_id')
    .eq(request.deliveryId ? 'id' : 'order_id', request.deliveryId ?? request.orderId!)
    .maybeSingle();
  if (dErr) {
    console.error('dispatch-driver: delivery lookup failed', dErr.code, dErr.message);
    return json(500, { error: 'dispatch_failed' });
  }
  if (!delivery) return json(404, { error: 'delivery_not_found' });

  // A signed-in caller dispatches only for a branch they run deliveries or the kitchen at.
  // staff_dispatch_delivery checks the same rule; this one answers before the database is asked
  // to do anything, and keeps the 403 the screens already explain.
  if (userClient) {
    const { data: caps, error: capErr } = await userClient.rpc('my_capabilities', {
      p_branch_id: delivery.branch_id,
    });
    const held = !capErr && Array.isArray(caps) ? (caps as unknown[]) : [];
    if (!held.includes('delivery.manage') && !held.includes('kitchen.access')) {
      return json(403, { error: 'not_authorized' });
    }
  }

  // As the caller, so the SQL's own check and its audit trail see the real user. The service role
  // has no auth.uid(); staff_dispatch_delivery treats it as the trusted internal caller.
  const { data: verdict, error: rpcErr } = await (userClient ?? admin).rpc('staff_dispatch_delivery', {
    p_delivery_id: delivery.id,
    p_restart: request.restart,
  });
  if (rpcErr) {
    const answer = answerForRpcError(rpcErr);
    if (answer.status >= 500) {
      console.error('dispatch-driver: staff_dispatch_delivery failed', rpcErr.code, rpcErr.message);
    }
    return json(answer.status, answer.body);
  }

  const answer = answerForDispatch(delivery.id as string, verdict);
  if (answer.status === 500) {
    console.error('dispatch-driver: unreadable verdict', JSON.stringify(verdict)?.slice(0, 300));
  }
  return json(answer.status, answer.body);
});
