import { describe, expect, it } from 'vitest';
import {
  askedInRound,
  canRestartDispatch,
  describeDispatchFailure,
  dispatchLine,
  findRiderAction,
  noRiderReasonOf,
  readDispatchAnswer,
  stackPeers,
  withKnownDispatchColumns,
  type DispatchRowFields,
} from './dispatch-model';

// The shapes behind the 2026-10-05 report from Food Thai Thai: a kitchen card that said "No rider
// found" 120 seconds after "ready" while nothing on the server was searching, a retry that asked
// the rider who had just declined, two stacked orders stuck together, and riders on a cooldown
// reported as "no rider available".

const NOW = Date.parse('2026-10-05T15:40:00Z');
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();
const ROUND = at(600);

function row(over: Partial<DispatchRowFields & { id: string }> = {}): DispatchRowFields & { id: string } {
  return {
    id: 'd1',
    status: 'dispatching',
    driver_id: null,
    accepted_at: null,
    offer_expires_at: null,
    dispatch_state: 'searching',
    dispatch_round_started_at: ROUND,
    dispatch_history: [],
    batch_id: null,
    ...over,
  };
}

// The log entry as private.dispatch_delivery writes it: { type, driver_id, at, round }.
const offered = (driver: string, secAgo: number, round: string | null = ROUND) => ({
  type: 'offered',
  driver_id: driver,
  at: at(secAgo),
  ...(round ? { round } : {}),
});

describe('describeDispatchFailure', () => {
  it('takes the server’s funnel verdict over the independent counts', () => {
    // dispatch_candidate_diagnostics' counts are independent (3 online, 3 not cooling down — over
    // every approved rider), so only private.dispatch_funnel can say which gate emptied the list.
    const base = { branch_has_pin: true, approved: 3, online: 3, not_cooling_down: 3, has_location: 3, gps_fresh: 3, in_radius: 3, not_busy: 3 };
    expect(describeDispatchFailure({ diagnostics: { ...base, reason: 'cooling_down', cooling_down: 3 } })).toEqual({
      key: 'allCoolingDown',
      values: { online: 3 },
    });
    expect(describeDispatchFailure({ diagnostics: { ...base, reason: 'everyone_asked', already_asked: 3, cooling_down: 0 } })).toEqual({
      key: 'alreadyAsked',
      values: { asked: 3, cooling: 0 },
    });
    expect(describeDispatchFailure({ diagnostics: { ...base, reason: 'riders_busy' } })).toEqual({
      key: 'allBusy',
      values: { online: 3 },
    });
    expect(describeDispatchFailure({ diagnostics: { ...base, reason: 'kyc_not_verified' } })).toEqual({
      key: 'noneVerified',
      values: { online: 3 },
    });
    expect(describeDispatchFailure({ diagnostics: { ...base, reason: 'no_fresh_gps', max_gps_age_min: 5 } })).toEqual({
      key: 'gpsStale',
      values: { online: 3, minutes: 5 },
    });
    // A verdict this screen does not know falls back to reading the counts.
    expect(describeDispatchFailure({ diagnostics: { ...base, online: 0, reason: 'something_new' } })).toEqual({
      key: 'noneOnline',
      values: { approved: 3 },
    });
  });

  it('names the cooldown when every online rider is on one', () => {
    expect(
      describeDispatchFailure({
        diagnostics: { branch_has_pin: true, approved: 3, online: 3, kyc_verified: 3, not_cooling_down: 0 },
      }),
    ).toEqual({ key: 'allCoolingDown', values: { online: 3 } });
    expect(
      describeDispatchFailure({ diagnostics: { approved: 3, online: 2, cooling_down: 2, not_cooling_down: 1 } }),
    ).toEqual({ key: 'allCoolingDown', values: { online: 2 } });
  });

  it('says the free riders were already asked, rather than "no rider available"', () => {
    expect(
      describeDispatchFailure({
        diagnostics: {
          branch_has_pin: true,
          approved: 3,
          online: 3,
          kyc_verified: 3,
          not_cooling_down: 2,
          cooling_down: 1,
          has_location: 3,
          gps_fresh: 3,
          not_busy: 3,
          in_radius: 3,
          already_asked: 2,
        },
      }),
    ).toEqual({ key: 'alreadyAsked', values: { asked: 2, cooling: 1 } });
  });

  it('mentions a partial cooldown when nothing else explains it', () => {
    expect(
      describeDispatchFailure({
        diagnostics: { approved: 3, online: 3, has_location: 3, gps_fresh: 3, not_busy: 3, in_radius: 3, cooling_down: 1 },
      }),
    ).toEqual({ key: 'someCoolingDown', values: { online: 3, cooling: 1 } });
  });

  it('stops at unverified documents before anything about location', () => {
    expect(
      describeDispatchFailure({ diagnostics: { approved: 2, online: 2, kyc_verified: 0, has_location: 0 } }),
    ).toEqual({ key: 'noneVerified', values: { online: 2 } });
  });

  it('skips a count the server did not send instead of reading it as zero', () => {
    // An older diagnostics payload has no kyc / cooldown / asked counts at all.
    expect(
      describeDispatchFailure({
        diagnostics: { branch_has_pin: true, approved: 3, online: 2, has_location: 2, gps_fresh: 0, max_gps_age_min: 5 },
      }),
    ).toEqual({ key: 'gpsStale', values: { online: 2, minutes: 5 } });
    expect(describeDispatchFailure({ diagnostics: {} })).toEqual({ key: 'noneAvailable' });
  });

  it('reads the D6 refusal and a vanished delivery as their own sentences', () => {
    expect(describeDispatchFailure({ error: 'already_accepted' }, 409)).toEqual({ key: 'alreadyAccepted' });
    expect(describeDispatchFailure({ error: 'delivery_not_found' }, 404)).toEqual({ key: 'notDispatchable' });
  });
});

describe('noRiderReasonOf', () => {
  it('reads every reason code private.dispatch_funnel writes', () => {
    expect(noRiderReasonOf('everyone_asked')).toBe('everyoneAsked');
    expect(noRiderReasonOf('cooling_down')).toBe('cooldown');
    expect(noRiderReasonOf('nobody_online')).toBe('nobodyOnline');
    expect(noRiderReasonOf('no_fresh_gps')).toBe('noFreshGps');
    expect(noRiderReasonOf('riders_busy')).toBe('allBusy');
    expect(noRiderReasonOf('none_approved')).toBe('notSetUp');
    expect(noRiderReasonOf('kyc_not_verified')).toBe('notSetUp');
    expect(noRiderReasonOf('no_branch_pin')).toBe('notSetUp');
    expect(noRiderReasonOf('out_of_radius')).toBe('notSetUp');
    expect(noRiderReasonOf('round_over')).toBe('windowOver');
  });

  it('reads the server reason however it is spelled', () => {
    expect(noRiderReasonOf('riders_on_cooldown')).toBe('cooldown');
    expect(noRiderReasonOf('cooling_down')).toBe('cooldown');
    expect(noRiderReasonOf('nobody_online')).toBe('nobodyOnline');
    expect(noRiderReasonOf('no_fresh_gps')).toBe('noFreshGps');
    expect(noRiderReasonOf('all_asked')).toBe('everyoneAsked');
    expect(noRiderReasonOf('every_rider_declined')).toBe('everyoneAsked');
    expect(noRiderReasonOf('search_window_over')).toBe('windowOver');
    expect(noRiderReasonOf('all_busy')).toBe('allBusy');
  });

  it('falls back to the gate counts, and to nothing when neither says anything', () => {
    expect(noRiderReasonOf(null, { approved: 2, online: 0 })).toBe('nobodyOnline');
    expect(noRiderReasonOf('', { approved: 2, online: 2, not_cooling_down: 0 })).toBe('cooldown');
    expect(noRiderReasonOf('something_new')).toBeNull();
    expect(noRiderReasonOf(undefined)).toBeNull();
  });
});

describe('askedInRound', () => {
  it('counts each rider once, and only in the current round', () => {
    const d = row({
      dispatch_history: [
        offered('peter', 900, at(1000)), // an earlier round: does not count in this one
        offered('peter', 500),
        { type: 'rejected', driver_id: 'peter', at: at(480), round: ROUND },
        offered('bobby', 470),
        { type: 'offer_expired', driver_id: 'bobby', at: at(390), round: ROUND },
      ],
    });
    expect(askedInRound([d])).toBe(2);
  });

  it('counts every rider the round named, as the server does: a withdrawn offer, a job handed back', () => {
    const d = row({
      dispatch_history: [
        offered('peter', 500),
        { type: 'withdrawn', driver_id: 'peter', at: at(450), round: ROUND, by_user: 'u1' },
        // A rider who handed back an accepted job is written into the round that cancel started.
        { type: 'driver_cancelled', driver_id: 'alex', reason: 'flat tyre', at: at(400), round: ROUND },
        { type: 'dispatch_error', error: 'boom', at: at(300), round: ROUND },
      ],
    });
    expect(askedInRound([d])).toBe(2);
  });

  it('never counts fewer riders than the server wrote on its own waiting entry', () => {
    const d = row({
      dispatch_state: 'waiting',
      dispatch_history: [offered('peter', 500), { type: 'waiting', reason: 'everyone_asked', asked: 3, at: at(60), round: ROUND }],
    });
    expect(askedInRound([d])).toBe(3);
  });

  it('reads entries that only carry a time by when they were written', () => {
    const d = row({ dispatch_history: [offered('alex', 900, null), offered('bobby', 300, null)] });
    expect(askedInRound([d])).toBe(1);
  });

  it('counts a stack as one unit: a rider asked for either stop is asked once', () => {
    const a = row({ id: 'a', batch_id: 'b1', dispatch_history: [offered('peter', 400), offered('bobby', 200)] });
    const b = row({ id: 'b', batch_id: 'b1', dispatch_history: [offered('peter', 400)] });
    expect(askedInRound([a, b])).toBe(2);
  });

  it('adds rider turns the log no longer carries, from after the round began', () => {
    const d = row({ dispatch_history: [offered('peter', 400)] });
    const offers = [
      { driver_id: 'peter', offered_at: at(400) },
      { driver_id: 'alex', offered_at: at(300) },
      { driver_id: 'bobby', offered_at: at(5000) }, // a previous round
    ];
    expect(askedInRound([d], offers)).toBe(2);
  });
});

describe('readDispatchAnswer', () => {
  it('reads an offer, single or stacked', () => {
    expect(
      readDispatchAnswer(200, {
        status: 'offered',
        result: 'offered',
        asked_count: 1,
        driver_id: 'peter',
        offer_expires_at: at(-75),
      }),
    ).toEqual({ kind: 'offered', driverId: 'peter', expiresAt: at(-75), asked: 1 });
    expect(readDispatchAnswer(200, { status: 'offered', result: 'offered_batch', driver_id: 'peter' }).kind).toBe(
      'offered',
    );
  });

  it('reads a waiting round (202) as waiting, with its reason and gate sentence', () => {
    const a = readDispatchAnswer(202, {
      status: 'waiting',
      result: 'waiting',
      asked_count: 3,
      reason: 'everyone_asked',
      diagnostics: { approved: 3, online: 3, already_asked: 3, cooling_down: 0, reason: 'everyone_asked' },
    });
    expect(a).toEqual({
      kind: 'waiting',
      asked: 3,
      why: 'everyoneAsked',
      failure: { key: 'alreadyAsked', values: { asked: 3, cooling: 0 } },
    });
  });

  it('reads the 503 that carries result no_rider_found as the end of the round, not a failure', () => {
    const a = readDispatchAnswer(503, {
      error: 'no_drivers_available',
      result: 'no_rider_found',
      asked_count: 0,
      reason: 'cooling_down',
      diagnostics: { approved: 2, online: 2, not_cooling_down: 0, reason: 'cooling_down' },
    });
    expect(a).toMatchObject({
      kind: 'noRiderFound',
      reason: 'cooldown',
      failure: { key: 'allCoolingDown', values: { online: 2 } },
    });
  });

  it('defaults a round that ended without a reason to "the search time ran out"', () => {
    expect(readDispatchAnswer(503, { error: 'no_drivers_available', result: 'no_rider_found' })).toMatchObject({
      kind: 'noRiderFound',
      reason: 'windowOver',
    });
  });

  it('reads a restart refused after acceptance (D6)', () => {
    expect(readDispatchAnswer(409, { error: 'already_accepted', result: 'already_accepted' })).toEqual({
      kind: 'alreadyAccepted',
    });
    expect(readDispatchAnswer(409, { error: 'already_accepted' })).toEqual({ kind: 'alreadyAccepted' });
  });

  it('reads the refusals as sentences, never as riders', () => {
    expect(readDispatchAnswer(409, { error: 'delivery_not_dispatchable', result: 'not_dispatchable' })).toEqual({
      kind: 'refused',
      failure: { key: 'notDispatchable' },
    });
    expect(readDispatchAnswer(401, { error: 'auth_required' })).toEqual({
      kind: 'refused',
      failure: { key: 'authRequired' },
    });
    expect(readDispatchAnswer(403, { error: 'not_authorized' })).toEqual({
      kind: 'refused',
      failure: { key: 'notAuthorized' },
    });
    expect(readDispatchAnswer(500, { error: 'dispatch_failed', code: 'dispatch_sql_missing' })).toEqual({
      kind: 'refused',
      failure: { key: 'failed', code: 'dispatch_failed' },
    });
    // No answer at all (offline): a failure, not "nobody available".
    expect(readDispatchAnswer(null, null)).toEqual({ kind: 'refused', failure: { key: 'failed' } });
  });

  it('still reads a server from before the rounds', () => {
    expect(readDispatchAnswer(200, { status: 'offered', driver_id: 'peter', offer_expires_at: at(-60) })).toMatchObject(
      { kind: 'offered', driverId: 'peter' },
    );
    expect(
      readDispatchAnswer(503, { error: 'no_drivers_available', diagnostics: { approved: 3, online: 0 } }),
    ).toEqual({ kind: 'refused', failure: { key: 'noneOnline', values: { approved: 3 } } });
    expect(readDispatchAnswer(503, { error: 'max_attempts_reached' })).toEqual({
      kind: 'refused',
      failure: { key: 'maxAttempts' },
    });
  });
});

describe('dispatchLine', () => {
  it('counts down an open offer and names who has it', () => {
    const d = row({ status: 'assigned', driver_id: 'peter', offer_expires_at: at(-42), dispatch_history: [offered('peter', 33)] });
    expect(dispatchLine(d, { nowMs: NOW })).toEqual({ kind: 'offered', driverId: 'peter', expiresAt: at(-42), asked: 1 });
  });

  it('says an offer ran out until the sweep moves it on, and never "no rider found"', () => {
    const d = row({ status: 'assigned', driver_id: 'peter', offer_expires_at: at(5) });
    expect(dispatchLine(d, { nowMs: NOW }).kind).toBe('offerLapsed');
  });

  it('stops talking about the search once the rider accepted or left', () => {
    expect(dispatchLine(row({ status: 'assigned', driver_id: 'peter', accepted_at: at(30) }), { nowMs: NOW })).toEqual({
      kind: 'accepted',
    });
    expect(dispatchLine(row({ status: 'picked_up', driver_id: 'peter' }), { nowMs: NOW })).toEqual({ kind: 'withRider' });
    expect(dispatchLine(row({ status: 'delivered' }), { nowMs: NOW })).toEqual({ kind: 'closed' });
  });

  it('reports a searching round with the riders it has asked', () => {
    const d = row({ dispatch_history: [offered('peter', 300), offered('bobby', 200)] });
    expect(dispatchLine(d, { nowMs: NOW })).toEqual({ kind: 'searching', asked: 2 });
  });

  it('says what a waiting round is waiting for', () => {
    const d = row({
      dispatch_state: 'waiting',
      dispatch_history: [
        offered('peter', 300),
        { type: 'waiting', reason: 'cooling_down', asked: 1, at: at(100), round: ROUND },
      ],
    });
    expect(dispatchLine(d, { nowMs: NOW })).toEqual({ kind: 'waiting', asked: 1, why: 'cooldown' });
  });

  it('says "no rider found" only when the server does, with its reason', () => {
    const d = row({
      dispatch_state: 'no_rider_found',
      dispatch_history: [
        offered('peter', 500),
        offered('bobby', 400),
        { type: 'no_rider_found', reason: 'everyone_asked', asked: 2, at: at(10), round: ROUND },
      ],
    });
    expect(dispatchLine(d, { nowMs: NOW })).toEqual({ kind: 'noRiderFound', asked: 2, reason: 'everyoneAsked' });
  });

  it('takes the reason from the answer when the log has none, and defaults to the window', () => {
    const d = row({ dispatch_state: 'no_rider_found' });
    expect(
      dispatchLine(d, {
        nowMs: NOW,
        answer: { kind: 'noRiderFound', asked: 3, reason: 'nobodyOnline', failure: null },
      }),
    ).toEqual({ kind: 'noRiderFound', asked: 3, reason: 'nobodyOnline' });
    expect(dispatchLine(d, { nowMs: NOW })).toEqual({ kind: 'noRiderFound', asked: 0, reason: 'windowOver' });
  });

  it('never decides "no rider found" from a clock: an hour-old ready order still searching is searching', () => {
    const d = row({ dispatch_round_started_at: at(3600), dispatch_history: [] });
    expect(dispatchLine(d, { nowMs: NOW }).kind).toBe('searching');
    // Read without the column, it is "searching" too — never a verdict this side made up.
    const legacy = row({ dispatch_state: undefined, dispatch_round_started_at: undefined });
    expect(dispatchLine(legacy, { nowMs: NOW }).kind).toBe('unknown');
  });

  it('leaves a self-delivery order parked for the shop’s own staff alone', () => {
    const parked = row({ status: 'assigned', driver_id: null, dispatch_state: null });
    expect(dispatchLine(parked, { nowMs: NOW })).toEqual({ kind: 'selfDelivery' });
    expect(findRiderAction(dispatchLine(parked, { nowMs: NOW }))).toBeNull();
    expect(canRestartDispatch(parked)).toBe(false);
  });

  it('says nothing is looking when the server has no round running', () => {
    expect(dispatchLine(row({ dispatch_state: null, dispatch_round_started_at: null }), { nowMs: NOW })).toEqual({
      kind: 'notStarted',
    });
  });

  it('lets a fresh answer speak while the row has no state yet', () => {
    const d = row({ dispatch_state: null });
    expect(
      dispatchLine(d, { nowMs: NOW, answer: { kind: 'waiting', asked: 2, why: 'allBusy', failure: null } }),
    ).toEqual({ kind: 'waiting', asked: 2, why: 'allBusy' });
  });

  it('gives both stops of a stack the same round', () => {
    const a = row({ id: 'a', batch_id: 'b1', dispatch_history: [offered('peter', 300)] });
    const b = row({ id: 'b', batch_id: 'b1', dispatch_history: [offered('peter', 300), offered('alex', 100)] });
    const single = row({ id: 'c', dispatch_history: [offered('bobby', 100)] });
    const all = [a, b, single];
    expect(stackPeers(a, all).map((r) => r.id)).toEqual(['b']);
    expect(stackPeers(single, all)).toEqual([]);
    expect(dispatchLine(a, { nowMs: NOW, stack: stackPeers(a, all) })).toEqual({ kind: 'searching', asked: 2 });
    expect(dispatchLine(b, { nowMs: NOW, stack: stackPeers(b, all) })).toEqual({ kind: 'searching', asked: 2 });
    expect(dispatchLine(single, { nowMs: NOW, stack: stackPeers(single, all) })).toEqual({ kind: 'searching', asked: 1 });
  });
});

describe('withKnownDispatchColumns', () => {
  it('keeps the dispatch state realtime brought when a refetch did not select it', () => {
    const known = row({ dispatch_state: 'no_rider_found', status: 'dispatching' });
    const read = { id: 'd1', status: 'dispatching', driver_id: null, accepted_at: null, batch_id: null };
    const merged = withKnownDispatchColumns(read as typeof known, known);
    expect(merged.dispatch_state).toBe('no_rider_found');
    expect(merged.dispatch_round_started_at).toBe(ROUND);
    // Nothing to fill: the very object comes back.
    expect(withKnownDispatchColumns(known, known)).toBe(known);
  });

  it('lets a read that named the columns win, nulls included, and never mixes two rows', () => {
    const known = row({ dispatch_state: 'waiting' });
    const read = row({ dispatch_state: null, dispatch_round_started_at: null });
    expect(withKnownDispatchColumns(read, known).dispatch_state).toBeNull();
    const other = { id: 'other', status: 'dispatching', driver_id: null } as ReturnType<typeof row>;
    expect(withKnownDispatchColumns(other, known)).toBe(other);
    expect(withKnownDispatchColumns(other, undefined)).toBe(other);
  });
});

describe('buttons', () => {
  it('offers "Find rider again" only after the server found nobody, and "Find a rider" only when nothing runs', () => {
    expect(findRiderAction({ kind: 'noRiderFound', asked: 2, reason: 'everyoneAsked' })).toBe('restart');
    expect(findRiderAction({ kind: 'notStarted' })).toBe('start');
    // While a round is running the server is already on it: a second search on top of it is how
    // one rider was offered the same order three times in a minute.
    expect(findRiderAction({ kind: 'searching', asked: 1 })).toBeNull();
    expect(findRiderAction({ kind: 'waiting', asked: 3, why: null })).toBeNull();
    expect(findRiderAction({ kind: 'offered', driverId: 'peter', expiresAt: at(-30), asked: 1 })).toBeNull();
    expect(findRiderAction({ kind: 'accepted' })).toBeNull();
  });

  it('hides a restart once a rider has accepted, and allows it over an open offer (D6)', () => {
    expect(canRestartDispatch({ status: 'assigned', driver_id: 'peter', accepted_at: at(20) })).toBe(false);
    expect(canRestartDispatch({ status: 'picked_up', driver_id: 'peter', accepted_at: at(200) })).toBe(false);
    expect(canRestartDispatch({ status: 'assigned', driver_id: 'peter', accepted_at: null })).toBe(true);
    expect(canRestartDispatch({ status: 'dispatching', driver_id: null, accepted_at: null })).toBe(true);
    expect(canRestartDispatch({ status: 'failed', driver_id: null, accepted_at: null })).toBe(false);
  });
});
