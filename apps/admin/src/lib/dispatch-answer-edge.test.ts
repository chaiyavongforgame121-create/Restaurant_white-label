import { describe, expect, it } from 'vitest';
import {
  answerForDispatch,
  answerForRpcError,
  parseDispatchRequest,
} from '../../../../supabase/functions/_shared/dispatch-answer';
import {
  describeDispatchFailure,
  readDispatchAnswer,
} from '../app/b/[branchId]/deliveries/_components/dispatch-model';

/**
 * What dispatch-driver answers (docs/DISPATCH-FIXES-2026-10-05.md D1, D6), pinned from here
 * because a Deno function cannot run under this app's test runner but a module with no imports
 * can: supabase/functions/_shared/dispatch-answer.ts imports nothing for that reason.
 *
 * What is at stake: the kitchen board and Live deliveries turn these answers into the sentence
 * staff read after tapping "Find rider". An answer they misread says "no rider" when a rider has
 * the offer, or "couldn't search" when the truth is "every rider is on cooldown".
 */

const D = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const O = '33333333-3333-4333-8333-333333333333';
const R = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';

const DIAG = {
  branch_has_pin: true,
  approved: 3,
  online: 3,
  kyc_verified: 3,
  not_cooling_down: 1,
  cooling_down: 2,
  has_location: 3,
  gps_fresh: 3,
  in_radius: 3,
  not_busy: 3,
  already_asked: 1,
  max_gps_age_min: 5,
  radius_km: 20116.8,
};

describe('the request', () => {
  it('names a delivery, or an order, as before', () => {
    expect(parseDispatchRequest({ delivery_id: D })).toEqual({ deliveryId: D, orderId: null, restart: false });
    expect(parseDispatchRequest({ order_id: O, reset: false })).toEqual({ deliveryId: null, orderId: O, restart: false });
    // v2 read delivery_id first; so does v3.
    expect(parseDispatchRequest({ delivery_id: D, order_id: O })?.deliveryId).toBe(D);
  });

  it('restarts only on a literal true: a restart withdraws an open offer and asks everyone again', () => {
    expect(parseDispatchRequest({ order_id: O, reset: true })?.restart).toBe(true);
    for (const reset of ['true', 1, 'yes', {}, null]) {
      expect(parseDispatchRequest({ order_id: O, reset })?.restart).toBe(false);
    }
  });

  it('refuses a body that names no row, before anything is looked up', () => {
    for (const body of [null, undefined, 'x', [], {}, { delivery_id: '' }, { delivery_id: 'abc' }, { order_id: 42 }]) {
      expect(parseDispatchRequest(body)).toBeNull();
    }
    // A malformed delivery_id is not quietly replaced by a valid order_id.
    expect(parseDispatchRequest({ delivery_id: 'abc', order_id: O })).toBeNull();
  });
});

describe('the verdicts', () => {
  it('answers an offer 200 {status:"offered"}, as v2 did', () => {
    const a = answerForDispatch(D, {
      ok: true,
      result: 'offered',
      driver_id: R,
      offer_expires_at: '2026-10-05T16:01:15Z',
      asked_count: 2,
      earnings: '4.10',
    });
    expect(a).toEqual({
      status: 200,
      body: {
        status: 'offered',
        delivery_id: D,
        result: 'offered',
        asked_count: 2,
        driver_id: R,
        offer_expires_at: '2026-10-05T16:01:15Z',
        earnings: 4.1,
      },
    });
  });

  it('answers a stacked offer 200 with both stops', () => {
    const a = answerForDispatch(D, {
      ok: true,
      result: 'offered_batch',
      driver_id: R,
      batch_id: B,
      delivery_ids: [D, D2, 7],
      offer_expires_at: '2026-10-05T16:01:15Z',
      asked_count: 1,
    });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({
      status: 'offered',
      result: 'offered_batch',
      batch_id: B,
      delivery_ids: [D, D2],
      batch_size: 2,
      driver_id: R,
    });
  });

  it('answers "waiting" 202: nothing failed, the round stays open for the sweep', () => {
    const a = answerForDispatch(D, { ok: true, result: 'waiting', asked_count: 3, reason: 'riders_on_cooldown', diagnostics: DIAG });
    expect(a).toEqual({
      status: 202,
      body: {
        status: 'waiting',
        delivery_id: D,
        result: 'waiting',
        asked_count: 3,
        reason: 'riders_on_cooldown',
        diagnostics: DIAG,
      },
    });
  });

  it('answers "no rider found" with the 503 no_drivers_available every screen already explains', () => {
    const a = answerForDispatch(D, { ok: true, result: 'no_rider_found', asked_count: 3, reason: 'everyone_asked', diagnostics: DIAG });
    expect(a.status).toBe(503);
    expect(a.body).toMatchObject({
      error: 'no_drivers_available',
      result: 'no_rider_found',
      reason: 'everyone_asked',
      asked_count: 3,
      diagnostics: DIAG,
      radius_km: 20116.8,
      excluded: 1,
    });
    // Without diagnostics the screens say "no rider available", never a made-up gate.
    expect(answerForDispatch(D, { result: 'no_rider_found' }).body).toMatchObject({ diagnostics: null, excluded: 0 });
  });

  it('refuses a restart once a rider has accepted: 409 already_accepted (D6)', () => {
    expect(answerForDispatch(D, { ok: false, result: 'already_accepted', delivery_status: 'assigned', asked_count: 1 })).toEqual({
      status: 409,
      body: { error: 'already_accepted', delivery_id: D, result: 'already_accepted', asked_count: 1, status: 'assigned' },
    });
  });

  it('answers a delivery past dispatching with v2\'s 409 delivery_not_dispatchable', () => {
    const a = answerForDispatch(D, { ok: false, result: 'not_dispatchable', delivery_status: 'delivered' });
    expect(a.status).toBe(409);
    expect(a.body).toMatchObject({ error: 'delivery_not_dispatchable', result: 'not_dispatchable', status: 'delivered' });
  });

  it('never reports an offer it cannot read: an unknown verdict is a 500', () => {
    for (const raw of [null, 'offered', [], 42, {}, { ok: true }, { result: 'searching' }, { result: 'max_attempts' }]) {
      const a = answerForDispatch(D, raw);
      expect(a.status).toBe(500);
      expect(a.body.error).toBe('dispatch_failed');
    }
  });

  it('reads a refusal the SQL wrote in words instead of raising it', () => {
    expect(answerForDispatch(D, { ok: false, error: 'forbidden' }).status).toBe(403);
    expect(answerForDispatch(D, { ok: false, reason: 'delivery_not_found' }).status).toBe(404);
    expect(answerForDispatch(D, { ok: false, error: 'auth_required' }).status).toBe(401);
  });
});

describe('a raised error', () => {
  it('turns the SQL\'s bare refusals into v2\'s answers', () => {
    expect(answerForRpcError({ message: 'auth_required', code: '42501' })).toEqual({ status: 401, body: { error: 'auth_required' } });
    expect(answerForRpcError({ message: 'forbidden', code: '42501' })).toEqual({ status: 403, body: { error: 'not_authorized' } });
    expect(answerForRpcError({ message: 'permission denied for function staff_dispatch_delivery', code: '42501' }).status).toBe(403);
    expect(answerForRpcError({ message: 'delivery_not_found', code: 'P0002' })).toEqual({ status: 404, body: { error: 'delivery_not_found' } });
    expect(answerForRpcError({ message: 'already_accepted', code: 'P0001' }).body).toMatchObject({ error: 'already_accepted' });
    expect(answerForRpcError({ message: 'not_dispatchable', code: 'P0001' }).body).toMatchObject({ error: 'delivery_not_dispatchable' });
  });

  it('names a function missing from the schema cache (deployed before its migration)', () => {
    expect(answerForRpcError({ message: 'Could not find the function public.staff_dispatch_delivery', code: 'PGRST202' })).toEqual({
      status: 500,
      body: { error: 'dispatch_failed', code: 'dispatch_sql_missing' },
    });
  });

  it('calls anything else our failure, never a reason about riders', () => {
    expect(answerForRpcError({ message: 'deadlock detected', code: '40P01' })).toEqual({ status: 500, body: { error: 'dispatch_failed' } });
    expect(answerForRpcError(null)).toEqual({ status: 500, body: { error: 'dispatch_failed' } });
  });
});

describe('the boards read every answer as meant', () => {
  const read = (raw: unknown) => {
    const a = answerForDispatch(D, raw);
    return readDispatchAnswer(a.status, a.body);
  };

  it('an offer, a wait, a round that ended, a refused restart', () => {
    expect(read({ result: 'offered', driver_id: R, offer_expires_at: 'x', asked_count: 1 })).toMatchObject({ kind: 'offered', driverId: R });
    expect(read({ result: 'offered_batch', driver_id: R, delivery_ids: [D, D2], asked_count: 1 })).toMatchObject({ kind: 'offered' });
    expect(read({ result: 'waiting', asked_count: 2, diagnostics: DIAG })).toMatchObject({ kind: 'waiting', asked: 2 });
    expect(read({ result: 'no_rider_found', asked_count: 3, diagnostics: DIAG })).toMatchObject({ kind: 'noRiderFound', asked: 3 });
    expect(read({ result: 'already_accepted' })).toEqual({ kind: 'alreadyAccepted' });
    expect(read({ result: 'not_dispatchable' })).toMatchObject({ kind: 'refused', failure: { key: 'notDispatchable' } });
  });

  it('a pre-rounds reader still finds its gate sentence in the 503', () => {
    const a = answerForDispatch(D, { result: 'no_rider_found', diagnostics: { ...DIAG, online: 0 } });
    expect(describeDispatchFailure(a.body as never, a.status)).toMatchObject({ key: 'noneOnline' });
  });

  it('a refusal reads as signed out or not allowed, not as "no rider"', () => {
    const signedOut = answerForRpcError({ message: 'auth_required' });
    expect(describeDispatchFailure(signedOut.body as never, signedOut.status).key).toBe('authRequired');
    const notAllowed = answerForRpcError({ message: 'forbidden' });
    expect(describeDispatchFailure(notAllowed.body as never, notAllowed.status).key).toBe('notAuthorized');
  });
});
