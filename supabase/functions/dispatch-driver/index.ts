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
// v2.2 (2026-07-10): stamps net_tip (+ tip_visible_total in transparent mode) so the
//   driver sees their tip on the offer without exposing the restaurant's cut.
// v2.3 (2026-07-10): batched offers (งานพ่วง). Before candidate search we try
//   claim_batch_sibling() — same branch, both READY (dispatching), gated by
//   branches.settings.batch_enabled (default OFF). A batch is offered to ONE driver
//   atomically via stamp_batch_offer(); accept/reject/expire treat the batch as a
//   unit. v2.3.1: exhausted batches alert staff for BOTH legs; single-path offer
//   race no longer sends a phantom push.
// v2.3.2 (2026-07-24): the pairing gate is now a same-DIRECTION detour test, not a
//   dropoff-proximity radius — claim_batch_sibling pairs two orders only when the
//   second is roughly on the way (detour = dist(A,B) − |dist(R,A) − dist(R,B)| ≤
//   settings.batch_max_detour_mi, default 1.0 mi). No edge-fn change; SQL-only.
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

// D2 — percent (0-100) of the order tip the driver keeps on a delivery order.
// SYNC POINT: R1 stores tip_config.delivery.distribution.driver as a PERCENT and the
// SQL trigger orders_on_complete_record_tip_split() (and staff_assign_driver) compute
// round(tip * pct / 100, 2). This Deno edge fn cannot import @favornoms/shared, so the
// convention is replicated here — keep both sides in lockstep. Unconfigured (key absent
// OR explicit null/'') => whole tip to the driver, matching the SQL coalesce(...,100).
function driverTipPct(tipConfig: unknown): number {
  const cfg = (tipConfig ?? {}) as Record<string, unknown>;
  const delivery = (cfg.delivery ?? {}) as Record<string, unknown>;
  const dist = (delivery.distribution ?? {}) as Record<string, unknown>;
  const raw = dist.driver;
  if (raw === null || raw === undefined || raw === '') return 100;
  const pct = Number(raw);
  if (!Number.isFinite(pct)) return 100;
  return Math.min(100, Math.max(0, pct));
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
    .select('id, order_id, branch_id, status, dispatch_attempts, dispatch_history, distance_km, batch_id')
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
    // A manual reset also dissolves any batch pairing — both legs restart clean
    // (they may re-pair on the next claim if still eligible).
    if (delivery.batch_id) {
      await admin
        .from('deliveries')
        .update({ batch_id: null, batch_seq: null })
        .eq('batch_id', delivery.batch_id);
    }
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

  // Exhausted? Alert branch staff and stop. A batched pair dissolves so the sibling
  // isn't stuck behind this delivery's exhausted attempt counter — and staff get an
  // alert for EVERY leg (batch attempts move in lockstep, so the sibling is equally
  // exhausted and nothing else would ever re-dispatch or flag it).
  if (attempts >= maxAttempts) {
    const failedLegs: Array<{ id: string; order_id: string }> = [
      { id: delivery.id as string, order_id: delivery.order_id as string },
    ];
    if (delivery.batch_id) {
      const { data: sibs } = await admin
        .from('deliveries')
        .select('id, order_id')
        .eq('batch_id', delivery.batch_id)
        .neq('id', delivery.id);
      for (const s of sibs ?? []) {
        failedLegs.push(s as { id: string; order_id: string });
      }
      await admin
        .from('deliveries')
        .update({ batch_id: null, batch_seq: null })
        .eq('batch_id', delivery.batch_id);
    }
    await admin.from('notifications_outbox').insert(
      failedLegs.map((leg) => ({
        branch_id: delivery.branch_id,
        recipient_type: 'staff',
        recipient_id: delivery.branch_id, // broadcast — recipients resolved at send time
        channel: 'in_app',
        template: 'dispatch_failed',
        variables: { delivery_id: leg.id, order_id: leg.order_id, reason: 'max_attempts_reached' },
      })),
    );
    return json(503, { error: 'max_attempts_reached' });
  }

  // ---- Batching (งานพ่วง): try to pair with a same-branch sibling. Flag-gated in
  // SQL (branches.settings.batch_enabled, default off) — returns null when disabled,
  // so this whole block is inert until the driver-app batch UI ships.
  type BatchRow = {
    id: string;
    order_id: string;
    distance_km: number | null;
    batch_seq: number | null;
    dispatch_history: unknown;
  };
  let batchRows: BatchRow[] | null = null;
  let batchId: string | null = null;
  const { data: claim } = await admin.rpc('claim_batch_sibling', { p_delivery_id: delivery.id });
  const claimedBatchId = (claim as { batch_id?: string } | null)?.batch_id ?? null;
  if (claimedBatchId) {
    const { data: rows } = await admin
      .from('deliveries')
      .select('id, order_id, distance_km, batch_seq, dispatch_history')
      .eq('batch_id', claimedBatchId)
      .in('status', ['pending', 'dispatching'])
      .order('batch_seq');
    if (Array.isArray(rows) && rows.length >= 2) {
      batchRows = rows as BatchRow[];
      batchId = claimedBatchId;
    }
  }

  // A driver who declined ANY leg of the pair is excluded from the batch re-offer.
  const exclude = batchRows
    ? [...new Set(batchRows.flatMap((r) => rejectedDriverIds(r.dispatch_history)))]
    : rejectedDriverIds(history0);
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

  // ---- Batched offer path: one driver, both legs, atomically. Per-leg earnings
  // and net tip (same math as the single path) — pay is per order, so a batch is
  // pure upside for the driver.
  if (batchRows && batchId) {
    const nowB = new Date();
    const expiresB = new Date(nowB.getTime() + offerTtlSeconds * 1000);
    const { data: platformB } = await admin
      .from('platform_settings')
      .select('tips')
      .eq('id', 1)
      .maybeSingle();
    const tipModeB =
      (platformB?.tips as { mode?: string } | null)?.mode === 'transparent' ? 'transparent' : 'hidden';
    const tipPctB = driverTipPct(
      (branch?.settings as Record<string, unknown> | undefined)?.tip_config,
    );
    const { data: batchOrders } = await admin
      .from('orders')
      .select('id, tip_amount')
      .in('id', batchRows.map((r) => r.order_id));
    const tipByOrder = new Map(
      (batchOrders ?? []).map((o) => [
        (o as { id: string }).id,
        Math.max(0, Number((o as { tip_amount?: number }).tip_amount ?? 0)),
      ]),
    );
    const rowsPayload = batchRows.map((r) => {
      const km = Number(r.distance_km ?? 0);
      const tip = tipByOrder.get(r.order_id) ?? 0;
      return {
        id: r.id,
        earnings: Math.round((driverBasePay + driverPerKmPay * km) * 100) / 100,
        net_tip: Math.round((Math.round(tip * 100) * tipPctB) / 100) / 100,
        tip_visible_total: tipModeB === 'transparent' ? Math.round(tip * 100) / 100 : null,
      };
    });
    const totalEarnings = Math.round(rowsPayload.reduce((s, r) => s + r.earnings, 0) * 100) / 100;
    const totalNetTip = Math.round(rowsPayload.reduce((s, r) => s + r.net_tip, 0) * 100) / 100;

    const { error: bErr } = await admin.rpc('stamp_batch_offer', {
      p_batch_id: batchId,
      p_driver_id: chosen.driver_id,
      p_offered_at: nowB.toISOString(),
      p_expires_at: expiresB.toISOString(),
      p_rows: rowsPayload,
      p_history_entry: {
        type: 'offered',
        driver_id: chosen.driver_id,
        driver_distance_km: chosen.distance_km,
        score: chosen.score,
        at: nowB.toISOString(),
        batch: true,
      },
    });
    if (bErr) return json(500, { error: 'offer_failed', detail: bErr.message });

    const seq1 = batchRows[0];
    await admin.from('notifications_outbox').insert({
      branch_id: delivery.branch_id,
      recipient_type: 'driver',
      recipient_id: chosen.driver_id,
      channel: 'push',
      template: 'new_dispatch',
      variables: {
        delivery_id: seq1.id,
        order_id: seq1.order_id,
        batch_id: batchId,
        batch_size: batchRows.length,
        distance_km: chosen.distance_km,
        earnings: totalEarnings,
        net_tip: totalNetTip,
        expires_in_seconds: offerTtlSeconds,
      },
    });

    return json(200, {
      delivery_id: delivery.id,
      batch_id: batchId,
      batch_size: batchRows.length,
      driver_id: chosen.driver_id,
      driver_distance_km: chosen.distance_km,
      earnings: totalEarnings,
      net_tip: totalNetTip,
      offer_expires_at: expiresB.toISOString(),
      status: 'offered',
    });
  }

  const tripKm = Number(delivery.distance_km ?? 0);
  const earnings = Math.round((driverBasePay + driverPerKmPay * tripKm) * 100) / 100;

  // D2 — net tip the driver will receive on this delivery.
  const { data: order } = await admin
    .from('orders')
    .select('tip_amount')
    .eq('id', delivery.order_id)
    .maybeSingle();
  // platform_settings is a single row (id=1); service role bypasses RLS.
  // private.platform_json('tips') is in the private schema and NOT reachable via
  // admin.rpc(), so read public.platform_settings.tips directly.
  const { data: platform } = await admin
    .from('platform_settings')
    .select('tips')
    .eq('id', 1)
    .maybeSingle();
  const tipMode =
    (platform?.tips as { mode?: string } | null)?.mode === 'transparent' ? 'transparent' : 'hidden';
  const tipAmount = Math.max(0, Number(order?.tip_amount ?? 0));
  const tipPct = driverTipPct(
    (branch?.settings as Record<string, unknown> | undefined)?.tip_config,
  );
  // Integer-cent math so net_tip (offer time) matches the SQL numeric rounding of
  // order_tip_splits.driver_cut (completion time): round(tip * pct / 100, 2).
  const netTip = Math.round((Math.round(tipAmount * 100) * tipPct) / 100) / 100;
  // Full tip surfaces to the driver ONLY in transparent mode; NULL in hidden mode
  // so the restaurant's cut can never be reverse-engineered.
  const tipVisibleTotal = tipMode === 'transparent' ? Math.round(tipAmount * 100) / 100 : null;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + offerTtlSeconds * 1000);

  history.push({
    type: 'offered',
    driver_id: chosen.driver_id,
    driver_distance_km: chosen.distance_km,
    score: chosen.score,
    at: now.toISOString(),
  });

  const { data: offered, error: aErr } = await admin
    .from('deliveries')
    .update({
      driver_id: chosen.driver_id,
      status: 'assigned',
      offered_at: now.toISOString(),
      offer_expires_at: expiresAt.toISOString(),
      driver_earnings: earnings,
      net_tip: netTip,
      tip_visible_total: tipVisibleTotal,
      dispatch_attempts: attempts + 1,
      dispatch_history: history,
    })
    .eq('id', delivery.id)
    .in('status', ['pending', 'dispatching']) // race guard: don't clobber a concurrent offer
    .select('id');
  if (aErr) return json(500, { error: 'offer_failed', detail: aErr.message });
  // Race guard tripped (a concurrent dispatch/claim already moved this row): no offer
  // was made, so don't push a phantom notification to the driver.
  if (!Array.isArray(offered) || offered.length === 0) {
    return json(409, { error: 'offer_conflict' });
  }

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
      net_tip: netTip,
      expires_in_seconds: offerTtlSeconds,
    },
  });

  return json(200, {
    delivery_id: delivery.id,
    driver_id: chosen.driver_id,
    driver_distance_km: chosen.distance_km,
    earnings,
    net_tip: netTip,
    offer_expires_at: expiresAt.toISOString(),
    status: 'offered',
  });
});
