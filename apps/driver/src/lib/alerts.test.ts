import { describe, expect, it } from 'vitest';
import {
  OFFER_FALLBACK_MS,
  OFFER_MIN_SHOWN_MS,
  OFFER_RING_EVERY_MS,
  dispatchNotice,
  jobIds,
  offerDeadlineMs,
  offerKey,
  offerRingDue,
  offerShouldRing,
  offerSightings,
  offersOver,
  parseTimeMs,
  parseWorkerMessage,
  readOnOff,
  secondsLeft,
  sightJobs,
  wantsWakeLock,
} from './alerts';

const T0 = Date.parse('2026-10-05T15:30:00Z');

describe('offer deadline', () => {
  it('uses the server deadline when the offer carries one', () => {
    expect(offerDeadlineMs(T0 + 75_000, T0)).toBe(T0 + 75_000);
  });

  it('never gives the rider less than a few seconds, however late the offer reached the phone', () => {
    // A push held back by a sleeping phone, or a phone clock running ahead of the server.
    expect(offerDeadlineMs(T0 - 20_000, T0)).toBe(T0 + OFFER_MIN_SHOWN_MS);
  });

  it('falls back to the sheet’s own countdown for an offer without a deadline', () => {
    expect(offerDeadlineMs(null, T0)).toBe(T0 + OFFER_FALLBACK_MS);
  });

  it('parses timestamps without ever producing NaN', () => {
    expect(parseTimeMs('2026-10-05T15:30:00Z')).toBe(T0);
    expect(parseTimeMs('not a date')).toBeNull();
    expect(parseTimeMs(null)).toBeNull();
    expect(parseTimeMs('')).toBeNull();
  });

  it('counts whole seconds down to zero and no further', () => {
    expect(secondsLeft(T0 + 75_000, T0)).toBe(75);
    expect(secondsLeft(T0 + 74_100, T0)).toBe(75);
    expect(secondsLeft(T0, T0)).toBe(0);
    expect(secondsLeft(T0, T0 + 9_000)).toBe(0);
  });
});

describe('when an offer rings', () => {
  const live = { offerId: 'd1', deadlineMs: T0 + 75_000, responding: false, now: T0 };

  it('rings while there is an unanswered offer inside its deadline', () => {
    expect(offerShouldRing(live)).toBe(true);
    expect(offerShouldRing({ ...live, now: T0 + 74_999 })).toBe(true);
  });

  it('stops when the offer is accepted or declined (it leaves the screen)', () => {
    expect(offerShouldRing({ ...live, offerId: null })).toBe(false);
  });

  it('stops the moment the rider taps, before the server answers', () => {
    expect(offerShouldRing({ ...live, responding: true })).toBe(false);
  });

  it('stops when the offer expires', () => {
    expect(offerShouldRing({ ...live, now: T0 + 75_000 })).toBe(false);
    expect(offerShouldRing({ ...live, now: T0 + 90_000 })).toBe(false);
  });

  it('does not ring without a deadline to stop at', () => {
    expect(offerShouldRing({ ...live, deadlineMs: null })).toBe(false);
  });
});

describe('ring cadence', () => {
  it('rings at once when nothing has been heard yet', () => {
    expect(offerRingDue(null, T0)).toBe(true);
  });

  it('rings again about every three seconds', () => {
    expect(OFFER_RING_EVERY_MS).toBe(3_000);
    expect(offerRingDue(T0, T0 + 1_000)).toBe(false);
    expect(offerRingDue(T0, T0 + 2_700)).toBe(false);
    expect(offerRingDue(T0, T0 + 3_000)).toBe(true);
  });

  it('counts a timer that fires a hair early, so the cadence does not slip to six seconds', () => {
    expect(offerRingDue(T0, T0 + 2_900)).toBe(true);
  });

  it('simulated over a 75-second offer checked every half second: one ring per three seconds', () => {
    const deadline = offerDeadlineMs(T0 + 75_000, T0);
    let last: number | null = null;
    const rings: number[] = [];
    for (let now = T0; now <= T0 + 80_000; now += 500) {
      if (!offerShouldRing({ offerId: 'd1', deadlineMs: deadline, responding: false, now })) continue;
      if (!offerRingDue(last, now)) continue;
      rings.push(now - T0);
      last = now;
    }
    expect(rings[0]).toBe(0);
    expect(rings.at(-1)).toBeLessThan(75_000);
    expect(rings).toHaveLength(25);
    for (let i = 1; i < rings.length; i++) expect(rings[i]! - rings[i - 1]!).toBe(3_000);
  });
});

describe('a job that arrives without an offer', () => {
  it('lists a job and its stacked stop', () => {
    expect(jobIds(null)).toEqual([]);
    expect(jobIds({ id: 'a', batchMate: null })).toEqual(['a']);
    expect(jobIds({ id: 'a', batchMate: { id: 'b' } })).toEqual(['a', 'b']);
  });

  it('takes the first read as the baseline: a job already in hand when the app opens is not news', () => {
    expect(sightJobs(null, [], ['a'])).toEqual({ seen: ['a'], ringJob: false });
  });

  it('rings for a job handed over by staff', () => {
    expect(sightJobs([], [], ['a']).ringJob).toBe(true);
  });

  it('does not ring again when the rider accepts an offer (it was already on screen)', () => {
    const offered = sightJobs([], ['a', 'b'], []);
    expect(offered.ringJob).toBe(false);
    expect(sightJobs(offered.seen, [], ['a', 'b']).ringJob).toBe(false);
  });

  it('rings when a second stop is added to the job in hand', () => {
    expect(sightJobs(['a'], [], ['a', 'b']).ringJob).toBe(true);
  });

  it('does not ring for the same job read again', () => {
    expect(sightJobs(['a'], [], ['a']).ringJob).toBe(false);
  });

  it('forgets a job that left, so the same delivery handed back later rings', () => {
    const gone = sightJobs(['a'], [], []);
    expect(gone.seen).toEqual([]);
    expect(sightJobs(gone.seen, [], ['a']).ringJob).toBe(true);
  });
});

describe('screen wake lock', () => {
  it('holds while online when the rider wants it', () => {
    expect(wantsWakeLock({ online: true, onDelivery: false, keepAwake: true })).toBe(true);
  });

  it('lets the screen lock while online when the rider turned it off', () => {
    expect(wantsWakeLock({ online: true, onDelivery: false, keepAwake: false })).toBe(false);
  });

  it('always holds during a job, whatever the switch says', () => {
    expect(wantsWakeLock({ online: true, onDelivery: true, keepAwake: false })).toBe(true);
    expect(wantsWakeLock({ online: false, onDelivery: true, keepAwake: false })).toBe(true);
  });

  it('never holds for a rider who is offline with nothing to do', () => {
    expect(wantsWakeLock({ online: false, onDelivery: false, keepAwake: true })).toBe(false);
  });
});

describe('device switches', () => {
  it('reads only the two words it writes', () => {
    expect(readOnOff('on', false)).toBe(true);
    expect(readOnOff('off', true)).toBe(false);
    expect(readOnOff(null, true)).toBe(true);
    expect(readOnOff('true', false)).toBe(false);
    expect(readOnOff(undefined, true)).toBe(true);
  });
});

describe('a refused answer to an offer', () => {
  it('says the offer moved on when the server says it is no longer this rider’s', () => {
    expect(dispatchNotice('forbidden', 'decline')).toBe('offerGone');
    expect(dispatchNotice('forbidden', 'accept')).toBe('offerGone');
  });

  it('says the offer expired when an accept came too late', () => {
    expect(dispatchNotice('offer_expired', 'accept')).toBe('offerExpired');
  });

  it('says there was no signal when the request never got a reply', () => {
    expect(dispatchNotice('no_answer', 'decline')).toBe('noSignal');
  });

  it('falls back to a plain failure for anything else, per action', () => {
    expect(dispatchNotice('auth_required', 'decline')).toBe('declineFailed');
    expect(dispatchNotice('JWT expired', 'accept')).toBe('acceptFailed');
    expect(dispatchNotice('', 'decline')).toBe('declineFailed');
  });
});

describe('service worker messages', () => {
  it('reads a push notice', () => {
    expect(parseWorkerMessage({ type: 'push', tag: 'new_dispatch:d1', deliveryId: 'd1', offer: true })).toEqual({
      type: 'push',
      deliveryId: 'd1',
      offer: true,
    });
    expect(parseWorkerMessage({ type: 'push' })).toEqual({ type: 'push', deliveryId: null, offer: false });
  });

  it('reads a rotated push subscription', () => {
    expect(parseWorkerMessage({ type: 'push-subscription-changed', subscription: {} })).toEqual({
      type: 'push-subscription-changed',
    });
  });

  it('ignores anything else', () => {
    expect(parseWorkerMessage(null)).toBeNull();
    expect(parseWorkerMessage('push')).toBeNull();
    expect(parseWorkerMessage({ type: 'something' })).toBeNull();
  });
});

describe('telling one offer from another', () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const offer = (id: string, expiresMs: number | null, mate: string | null = null) => ({
    id,
    offerExpiresAt: expiresMs == null ? null : at(expiresMs),
    batchMate: mate ? { id: mate, offerExpiresAt: expiresMs == null ? null : at(expiresMs) } : null,
  });

  it('keys an offer by its delivery and its deadline, so a re-offer is a new sheet', () => {
    expect(offerKey(offer('d1', T0))).toBe(`d1@${T0}`);
    expect(offerKey(offer('d1', T0 + 300_000))).not.toBe(offerKey(offer('d1', T0)));
    expect(offerKey(offer('d1', null))).toBe('d1@');
    expect(offerKey(null)).toBe('');
  });

  it('reads the same deadline the same way at any precision the server writes it', () => {
    expect(offerKey({ id: 'd1', offerExpiresAt: '2026-10-05T15:30:00+00:00' })).toBe(`d1@${T0}`);
    expect(offerKey({ id: 'd1', offerExpiresAt: '2026-10-05T15:30:00.000Z' })).toBe(`d1@${T0}`);
  });

  it('lists each stop of a stack under the offer’s deadline', () => {
    expect(offerSightings(offer('d1', T0, 'd2'))).toEqual([
      { deliveryId: 'd1', expiresAtMs: T0 },
      { deliveryId: 'd2', expiresAtMs: T0 },
    ]);
    expect(offerSightings({ id: 'd1', offerExpiresAt: at(T0), batchMate: { id: 'd2', offerExpiresAt: null } })).toEqual([
      { deliveryId: 'd1', expiresAtMs: T0 },
      { deliveryId: 'd2', expiresAtMs: T0 },
    ]);
    expect(offerSightings(null)).toEqual([]);
  });

  it('names the offers that left the screen, and only those', () => {
    const a = offerSightings(offer('d1', T0, 'd2'));
    const b = offerSightings(offer('d3', T0 + 60_000));
    expect(offersOver([], a)).toEqual([]);
    expect(offersOver(a, a)).toEqual([]);
    expect(offersOver(a, [])).toEqual(a);
    expect(offersOver(a, b)).toEqual(a);
  });

  it('counts the same delivery offered again under a new deadline as the old offer ending', () => {
    const first = offerSightings(offer('d1', T0));
    const again = offerSightings(offer('d1', T0 + 300_000));
    expect(offersOver(first, again)).toEqual(first);
  });
});
