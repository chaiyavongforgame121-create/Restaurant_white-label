// What the dispatch-driver edge function answers (docs/DISPATCH-FIXES-2026-10-05.md D1, D6, D7).
//
// Dispatch runs in the database now: public.staff_dispatch_delivery() picks the rider and stamps
// the offer in one transaction and returns a jsonb verdict. dispatch-driver is only the door the
// kitchen board and Live deliveries knock on, so its HTTP answers must stay the ones those screens
// already read (describeDispatchFailure in kitchen-view.tsx and live-ops-model.ts):
//   200 {status:'offered', ...}                       a rider has the offer
//   503 {error:'no_drivers_available', diagnostics}   nobody to offer it to; diagnostics say why
//   409 {error:'delivery_not_dispatchable', status}   the delivery is past dispatching
//   401 {error:'auth_required'} / 403 {error:'not_authorized'}
// The new verdicts fit around them without changing what an old screen shows:
//   202 {status:'waiting', ...}   nobody new to ask yet; the round stays open and the 30-second
//                                 sweep offers it to the next rider who becomes free. Nothing
//                                 failed, so it is a success to an old screen (which keeps
//                                 showing "searching", now true).
//   503 no_drivers_available      also carries result:'no_rider_found' and reason: the round
//                                 ended (everyone asked, or the search window ran out).
//   409 {error:'already_accepted'}  a restart refused because a rider has accepted (D6).
// Every body carries `result`, the SQL's own word, so a newer screen need not decode the status.
//
// PURE ON PURPOSE. Nothing here imports, reads Deno.env or touches a database, so the admin app's
// vitest pins every answer (apps/admin/src/lib/dispatch-answer-edge.test.ts).
//
// NOTE ON DEPLOYMENT: the Supabase CLI uploads the whole `supabase/functions` tree, so
// `../_shared/dispatch-answer.ts` resolves. Through the Management API / MCP, pass this file as
// `_shared/dispatch-answer.ts` next to `dispatch-driver/index.ts`.

export interface HttpAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** What a caller asked for, once the body has been read. */
export interface DispatchRequest {
  deliveryId: string | null;
  orderId: string | null;
  /** `reset: true` — staff "Find rider again": a new round (D2), refused once accepted (D6). */
  restart: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * `{ delivery_id }` or `{ order_id }`, with an optional `reset`. Null when neither names a row,
 * so nothing is looked up for a malformed id. Only a literal `true` restarts: a restart withdraws
 * an open offer and asks everyone again, so anything less than an explicit yes continues instead.
 */
export function parseDispatchRequest(body: unknown): DispatchRequest | null {
  const b = isRecord(body) ? body : {};
  const deliveryId = str(b.delivery_id);
  const orderId = str(b.order_id);
  const restart = b.reset === true;
  if (deliveryId) return UUID.test(deliveryId) ? { deliveryId, orderId: null, restart } : null;
  if (orderId) return UUID.test(orderId) ? { deliveryId: null, orderId, restart } : null;
  return null;
}

/** Fields an offer answer passes on when the SQL sent them. */
function offerFields(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    driver_id: str(raw.driver_id),
    offer_expires_at: str(raw.offer_expires_at),
  };
  for (const key of ['driver_distance_km', 'earnings', 'net_tip'] as const) {
    const n = num(raw[key]);
    if (n !== null) out[key] = n;
  }
  return out;
}

/** The diagnostics object, or null: the screens treat null as "no reason known". */
function diagnosticsOf(raw: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(raw.diagnostics) ? raw.diagnostics : null;
}

/**
 * The HTTP answer for staff_dispatch_delivery's verdict on `deliveryId`.
 *
 * Fails closed: a verdict this function does not recognise is a 500, never a 200, so a screen
 * never reports an offer the database did not make.
 */
export function answerForDispatch(deliveryId: string, raw: unknown): HttpAnswer {
  if (!isRecord(raw)) return { status: 500, body: { error: 'dispatch_failed', code: 'no_verdict' } };
  const result = str(raw.result);
  const askedCount = num(raw.asked_count) ?? 0;
  const reason = str(raw.reason);
  const base = { delivery_id: deliveryId, result, asked_count: askedCount };

  switch (result) {
    case 'offered':
      return { status: 200, body: { status: 'offered', ...base, ...offerFields(raw) } };

    case 'offered_batch': {
      const ids = Array.isArray(raw.delivery_ids)
        ? raw.delivery_ids.filter((x): x is string => typeof x === 'string')
        : [];
      return {
        status: 200,
        body: {
          status: 'offered',
          ...base,
          ...offerFields(raw),
          batch_id: str(raw.batch_id),
          delivery_ids: ids,
          batch_size: ids.length,
        },
      };
    }

    case 'waiting':
      return {
        status: 202,
        body: { status: 'waiting', ...base, reason, diagnostics: diagnosticsOf(raw) },
      };

    case 'no_rider_found': {
      const diagnostics = diagnosticsOf(raw);
      const radiusKm = num(diagnostics?.radius_km);
      return {
        status: 503,
        body: {
          // The code every screen already turns into "why nobody": kept, not renamed.
          error: 'no_drivers_available',
          ...base,
          reason,
          diagnostics,
          // v2's top-level fields, for any reader that took them from there.
          radius_km: radiusKm,
          excluded: num(diagnostics?.already_asked) ?? askedCount,
        },
      };
    }

    case 'already_accepted':
      return {
        status: 409,
        body: { error: 'already_accepted', ...base, status: str(raw.delivery_status) ?? str(raw.status) },
      };

    case 'not_dispatchable':
      return {
        status: 409,
        body: {
          error: 'delivery_not_dispatchable',
          ...base,
          reason,
          status: str(raw.delivery_status) ?? str(raw.status),
        },
      };

    default: {
      // No verdict word: the SQL may still have refused in its own words ({ok:false, error}).
      const refusal = answerForRefusal(str(raw.error) ?? reason ?? '', null);
      if (refusal) return refusal;
      return { status: 500, body: { error: 'dispatch_failed', code: result ?? 'no_result' } };
    }
  }
}

/** A refusal named in an error message, or null when the message names none of them. */
function answerForRefusal(message: string, code: string | null): HttpAnswer | null {
  const m = message.toLowerCase();
  // Order matters: 'delivery_not_found' must not read as 'forbidden', and an auth_required raised
  // with SQLSTATE 42501 is still "sign in again", not "not allowed".
  if (m.includes('auth_required')) return { status: 401, body: { error: 'auth_required' } };
  if (m.includes('not_found')) return { status: 404, body: { error: 'delivery_not_found' } };
  if (m.includes('already_accepted')) return { status: 409, body: { error: 'already_accepted', result: 'already_accepted' } };
  if (m.includes('not_dispatchable')) {
    return { status: 409, body: { error: 'delivery_not_dispatchable', result: 'not_dispatchable' } };
  }
  if (m.includes('forbidden') || m.includes('not_authorized') || code === '42501') {
    return { status: 403, body: { error: 'not_authorized' } };
  }
  return null;
}

/**
 * The HTTP answer for an RPC that raised instead of answering. The SQL refuses with bare exception
 * names (auth_required, forbidden, delivery_not_found); anything else is our failure, logged by the
 * caller and shown to staff as "couldn't search", never as a reason about riders.
 */
export function answerForRpcError(error: { message?: string | null; code?: string | null } | null): HttpAnswer {
  const message = error?.message ?? '';
  const code = error?.code ?? null;
  const refusal = answerForRefusal(message, code);
  if (refusal) return refusal;
  // PGRST202: the function is not in PostgREST's schema cache — this edge function was deployed
  // before the migration that creates staff_dispatch_delivery. Named so the log says so.
  if (code === 'PGRST202') return { status: 500, body: { error: 'dispatch_failed', code: 'dispatch_sql_missing' } };
  return { status: 500, body: { error: 'dispatch_failed' } };
}
