// dispatch-driver v2 — offer-based dispatch with TTL + scoring (Phase 3).
//
// POST { delivery_id: uuid }  — or  { order_id: uuid }
//
// v2 (2026-06-11):
//   • Offers (not hard-assigns): sets offered_at + offer_expires_at
//     (branches.settings.offer_ttl_seconds, default 75s). accept_dispatch stamps
//     accepted_at/assigned_at; the pg_cron sweep private.expire_dispatch_offers()
//     (every 30s) returns ignored offers to the pool and re-invokes this fn.
//   • Candidate scoring via find_dispatch_candidates(branch, radius, exclude):
//     distance + reject_streak − rating; excludes drivers already tried for this
//     delivery (read from dispatch_history).
//   • driver_earnings = driver_base_pay + driver_per_km_pay × trip distance_km
//     (deliveries.distance_km — branch→customer trip, set by place-order v9).
//     v2 does NOT overwrite distance_km (v1 used to clobber it with the
//     driver→branch distance, which now lives only in dispatch_history).
//   • Trims dispatch_history to the last 10 entries.
// v2.1 (2026-06-23):
//   • Only EXPLICIT rejects exclude a driver from re-offers for a delivery; an
//     expired offer no longer does (so a lone/few-driver branch keeps re-offering
//     the same rider until accept/reject/maxAttempts).
//   • POST { reset: true } clears dispatch_attempts + dispatch_history so the
//     kitchen can re-dispatch an exhausted order from scratch.
// v1 history: single-shot nearest-driver assign; source committed 2026-06-11
//   after living only on the remote.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(s: number, b: unknown) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// US market: distances/rates are stored in km / $-per-km but default to round miles.
const KM_PER_MILE = 1.609344;

type HistoryEntry = Record<string, unknown>;

function trimHistory(history: unknown, keep: number): HistoryEntry[] {
  const arr = Array.isArray(history) ? (history as HistoryEntry[]) : [];
  return arr.length > keep ? arr.slice(arr.length - keep) : arr;
}

// Only drivers who EXPLICITLY declined are excluded from re-offers for this
// delivery. NOT excluded: a server-side expiry (type:'offer_expired') OR a
// client-side countdown timeout (type:'rejected' but reason:'timeout') — in both
// cases the driver simply didn't respond in time, so they stay eligible. This
// makes single-/few-driver branches work: the lone rider keeps getting re-offered
// until they accept, deliberately decline, or maxAttempts is hit.
function rejectedDriverIds(history: unknown): string[] {
  const arr = Array.isArray(history) ? (history as HistoryEntry[]) : [];
  const ids = new Set<string>();
  for (const e of arr) {
    if (e?.type === 'rejected' && e?.reason !== 'timeout' && typeof e?.driver_id === 'string') {
      ids.add(e.driver_id as string);
    }
  }
  return [...ids];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const body = await req.json().catch(() => ({}));
  let deliveryId: string | undefined = body.delivery_id;

  if (!deliveryId && body.order_id) {
    const { data } = await admin.from('deliveries').select('id').eq('order_id', body.order_id).maybeSingle();
    deliveryId = data?.id;
  }
  if (!deliveryId) return json(400, { error: 'delivery_id_or_order_id_required' });

  const { data: delivery, error: dErr } = await admin
    .from('deliveries')
    .select('id, order_id, branch_id, status, dispatch_attempts, dispatch_history, distance_km')
    .eq('id', deliveryId)
    .single();
  if (dErr || !delivery) return json(404, { error: 'delivery_not_found' });

  let status = delivery.status as string;
  let attempts = Number(delivery.dispatch_attempts ?? 0);
  let history0: unknown = delivery.dispatch_history;

  // Manual "re-dispatch from scratch" (kitchen): clear the attempt counter and
  // history so an exhausted order can be offered again — including to drivers who
  // previously rejected. Never touches a job already accepted / in flight.
  if (body.reset && !['picked_up', 'in_transit', 'delivered', 'cancelled'].includes(status)) {
    await admin
      .from('deliveries')
      .update({
        dispatch_attempts: 0,
        dispatch_history: [],
        status: 'dispatching',
        driver_id: null,
        offered_at: null,
        offer_expires_at: null,
        accepted_at: null,
      })
      .eq('id', delivery.id);
    status = 'dispatching';
    attempts = 0;
    history0 = [];
  }

  if (status !== 'pending' && status !== 'dispatching') {
    return json(409, { error: 'delivery_not_dispatchable', status });
  }

  const { data: branch } = await admin
    .from('branches')
    .select('id, settings')
    .eq('id', delivery.branch_id)
    .single();
  const settings = (branch?.settings ?? {}) as Record<string, number>;
  const radiusKm = Number(settings.driver_search_radius_km ?? 3 * KM_PER_MILE); // 3 miles
  const maxAttempts = Number(settings.driver_max_attempts ?? 3);
  const offerTtlSeconds = Number(settings.offer_ttl_seconds ?? 75);
  const driverBasePay = Number(settings.driver_base_pay ?? 2.0);
  const driverPerKmPay = Number(settings.driver_per_km_pay ?? 1 / KM_PER_MILE); // $1.00 / mile

  // Exhausted? Alert branch staff and stop.
  if (attempts >= maxAttempts) {
    await admin.from('notifications_outbox').insert({
      branch_id: delivery.branch_id,
      recipient_type: 'staff',
      recipient_id: delivery.branch_id, // broadcast — recipients resolved at send time
      channel: 'in_app',
      template: 'dispatch_failed',
      variables: { delivery_id: delivery.id, order_id: delivery.order_id, reason: 'max_attempts_reached' },
    });
    return json(503, { error: 'max_attempts_reached' });
  }

  const exclude = rejectedDriverIds(history0);
  const { data: candidates } = await admin.rpc('find_dispatch_candidates', {
    p_branch_id: delivery.branch_id,
    p_radius_km: radiusKm,
    p_exclude: exclude,
  }) as unknown as { data: Array<{ driver_id: string; distance_km: number; score: number }> | null };

  const history = trimHistory(history0, 9);

  if (!Array.isArray(candidates) || candidates.length === 0) {
    history.push({ attempted_at: new Date().toISOString(), result: 'no_drivers', excluded: exclude.length });
    await admin
      .from('deliveries')
      .update({
        dispatch_attempts: attempts + 1,
        dispatch_history: history,
        status: 'dispatching',
      })
      .eq('id', delivery.id);
    return json(503, { error: 'no_drivers_available', radius_km: radiusKm, excluded: exclude.length });
  }

  const chosen = candidates[0];
  const tripKm = Number(delivery.distance_km ?? 0);
  const earnings = Math.round((driverBasePay + driverPerKmPay * tripKm) * 100) / 100;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + offerTtlSeconds * 1000);

  history.push({
    type: 'offered',
    driver_id: chosen.driver_id,
    driver_distance_km: chosen.distance_km,
    score: chosen.score,
    at: now.toISOString(),
  });

  const { error: aErr } = await admin
    .from('deliveries')
    .update({
      driver_id: chosen.driver_id,
      status: 'assigned',
      offered_at: now.toISOString(),
      offer_expires_at: expiresAt.toISOString(),
      driver_earnings: earnings,
      dispatch_attempts: attempts + 1,
      dispatch_history: history,
    })
    .eq('id', delivery.id)
    .in('status', ['pending', 'dispatching']); // race guard: don't clobber a concurrent offer
  if (aErr) return json(500, { error: 'offer_failed', detail: aErr.message });

  await admin.from('notifications_outbox').insert({
    branch_id: delivery.branch_id,
    recipient_type: 'driver',
    recipient_id: chosen.driver_id,
    channel: 'push',
    template: 'new_dispatch',
    variables: {
      delivery_id: delivery.id,
      order_id: delivery.order_id,
      distance_km: chosen.distance_km,
      earnings,
      expires_in_seconds: offerTtlSeconds,
    },
  });

  return json(200, {
    delivery_id: delivery.id,
    driver_id: chosen.driver_id,
    driver_distance_km: chosen.distance_km,
    earnings,
    offer_expires_at: expiresAt.toISOString(),
    status: 'offered',
  });
});
