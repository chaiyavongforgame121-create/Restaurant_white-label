import { describe, expect, it } from 'vitest';
import type { BranchRider, LiveDelivery } from '@favornoms/database/queries';
import type { DeliveryAssignmentRef, DispatchFailure } from './live-ops-model';
import {
  ageSpan,
  boardCounts,
  canAssign,
  canCancelDelivery,
  canFindRider,
  describeDelivery,
  describeDispatchFailure,
  detailQuote,
  lastEndedWithReason,
  isStale,
  mergeRefetch,
  partitionStale,
  rpcErrorKey,
  riderPinState,
  riderPosition,
  saneEta,
} from './live-ops-model';

// The shapes here are the ones that actually broke the Live deliveries board on the live
// project: a card reading "ETA 37104 min", a scooter drawn for a delivery no rider held,
// nineteen June-to-September test runs counted as "in flight".

const NOW = Date.parse('2026-09-06T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function delivery(over: Partial<LiveDelivery> = {}): LiveDelivery {
  return {
    id: 'd1',
    status: 'pending',
    driver_id: null,
    driver_lat: null,
    driver_lng: null,
    driver_location_updated_at: null,
    dropoff_lat: 30.15,
    dropoff_lng: -95.48,
    current_eta_min: null,
    estimated_duration_min: null,
    arriving_at: null,
    offered_at: null,
    offer_expires_at: null,
    accepted_at: null,
    picked_up_at: null,
    created_at: minsAgo(5),
    failed_reason: null,
    dispatch_attempts: 0,
    order: {
      id: 'o1',
      order_number: 'A-2609-991284',
      status: 'preparing',
      customer_name: 'Dana',
      customer_phone: '5552345678',
      delivery_address: { line1: '1 Main St', city: 'Conroe' },
    },
    driver: null,
    ...over,
  };
}

function rider(over: Partial<BranchRider> = {}): BranchRider {
  return {
    driver_id: 'r1',
    full_name: 'Alex Morgan',
    phone: '5551112222',
    vehicle_type: 'motorcycle',
    online: true,
    kyc_verified: true,
    cooling_down: false,
    lat: 30.1566,
    lng: -95.4889,
    location_updated_at: minsAgo(1),
    battery_level: 72,
    active_delivery_id: null,
    ...over,
  };
}

function assignment(over: Partial<DeliveryAssignmentRef> = {}): DeliveryAssignmentRef {
  return {
    id: 'a1',
    delivery_id: 'd1',
    seq: 1,
    driver_id: 'r1',
    status: 'cancelled',
    end_kind: 'driver_cancelled',
    end_reason: null,
    offered_at: minsAgo(20),
    ended_at: minsAgo(5),
    ...over,
  };
}

describe('lastEndedWithReason', () => {
  it('picks the newest turn that actually said something', () => {
    const found = lastEndedWithReason([
      assignment({ id: 'a1', seq: 1, end_reason: 'Flat tyre' }),
      assignment({ id: 'a2', seq: 2, end_reason: 'Customer never came down' }),
      // An open turn cannot be a reason: nothing has ended yet.
      assignment({ id: 'a3', seq: 3, ended_at: null, end_reason: 'not yet' }),
    ]);
    expect(found?.id).toBe('a2');
  });

  it('is null when every turn ended silently', () => {
    expect(lastEndedWithReason([assignment({ end_reason: null })])).toBeNull();
  });
});

describe('describeDelivery', () => {
  it('says the kitchen still has it while the delivery is pending', () => {
    const d = describeDelivery(delivery({ status: 'pending' }), NOW, false);
    expect(d.label).toEqual({ key: 'waitingKitchen' });
    expect(d.detail).toEqual({ key: 'kitchenStatus', status: 'preparing' });
    expect(d.overdue).toBe(false);
  });

  it('flags a pending row nobody has moved for half an hour', () => {
    const d = describeDelivery(delivery({ created_at: minsAgo(45) }), NOW, false);
    expect(d.overdue).toBe(true);
  });

  it('reports how many riders dispatch has already asked', () => {
    const d = describeDelivery(
      delivery({ status: 'dispatching', dispatch_attempts: 3 }),
      NOW,
      false,
    );
    expect(d.label).toEqual({ key: 'findingRider' });
    expect(d.detail).toEqual({ key: 'askedRiders', count: 3 });
  });

  it('prefers the rider’s own cancellation reason over the attempt count', () => {
    const d = describeDelivery(
      delivery({ status: 'dispatching', dispatch_attempts: 3 }),
      NOW,
      false,
      [assignment({ end_kind: 'driver_cancelled', end_reason: 'Bike chain snapped on Silom' })],
    );
    expect(d.label).toEqual({ key: 'findingRider' });
    expect(d.detail).toEqual({ key: 'riderCancelled', reason: 'Bike chain snapped on Silom' });
    expect(detailQuote(d.detail)).toBe('Bike chain snapped on Silom');
  });

  it('falls back to the attempt count when the turn ended without words', () => {
    const d = describeDelivery(
      delivery({ status: 'dispatching', dispatch_attempts: 3 }),
      NOW,
      false,
      [assignment({ end_kind: 'offer_expired', end_reason: null })],
    );
    expect(d.detail).toEqual({ key: 'askedRiders', count: 3 });
  });

  it('still explains a failed row after requeue nulled failed_reason', () => {
    const d = describeDelivery(delivery({ status: 'failed', failed_reason: null }), NOW, false, [
      assignment({ end_kind: 'failed_at_door', end_reason: 'Nobody answered the door' }),
    ]);
    expect(d.label).toEqual({ key: 'failed' });
    expect(d.detail).toEqual({ key: 'reason', reason: 'Nobody answered the door' });
  });

  it('counts down an open offer', () => {
    const d = describeDelivery(
      delivery({
        status: 'assigned',
        driver_id: 'r1',
        offer_expires_at: new Date(NOW + 74_000).toISOString(),
      }),
      NOW,
      false,
    );
    expect(d.label).toEqual({ key: 'offered' });
    expect(d.detail).toEqual({ key: 'expiresIn', countdown: '1:14' });
  });

  it('does not keep saying "Offered" once the rider has accepted', () => {
    const d = describeDelivery(
      delivery({ status: 'assigned', driver_id: 'r1', accepted_at: minsAgo(2) }),
      NOW,
      false,
    );
    expect(d.label).toEqual({ key: 'riderAccepted' });
    expect(d.detail).toEqual({ key: 'acceptedAgo', age: { unit: 'minutes', minutes: 2 } });
  });

  it('marks an expired offer as going back to the pool', () => {
    const d = describeDelivery(
      delivery({
        status: 'assigned',
        driver_id: 'r1',
        offer_expires_at: new Date(NOW - 5_000).toISOString(),
      }),
      NOW,
      false,
    );
    expect(d.detail).toEqual({ key: 'offerExpired' });
    expect(d.overdue).toBe(true);
  });

  it('reads a self-delivery parked at assigned as ready to go out, not as an offer', () => {
    const d = describeDelivery(delivery({ status: 'assigned', driver_id: null }), NOW, true);
    expect(d.label).toEqual({ key: 'readyToGo' });
    expect(d.detail).toEqual({ key: 'selfStaff' });
  });

  it('never prints an ETA computed from a week-old fix', () => {
    const d = describeDelivery(
      delivery({
        status: 'in_transit',
        driver_id: 'r1',
        current_eta_min: 37104,
        driver_location_updated_at: minsAgo(40_000),
      }),
      NOW,
      false,
    );
    expect(JSON.stringify(d.detail)).not.toContain('37104');
    expect(d.detail).toEqual({ key: 'etaUnknown' });
  });

  it('prints a fresh ETA', () => {
    const d = describeDelivery(
      delivery({
        status: 'in_transit',
        driver_id: 'r1',
        current_eta_min: 12,
        driver_location_updated_at: minsAgo(0.5),
      }),
      NOW,
      false,
    );
    expect(d.detail).toEqual({ key: 'eta', minutes: 12 });
  });

  it('surfaces the recorded reason on a failed delivery', () => {
    const d = describeDelivery(
      delivery({ status: 'failed', failed_reason: 'Customer never answered' }),
      NOW,
      false,
    );
    expect(d.label).toEqual({ key: 'failed' });
    expect(d.detail).toEqual({ key: 'reason', reason: 'Customer never answered' });
  });

  it('says so when a failed delivery carries no reason at all', () => {
    const d = describeDelivery(delivery({ status: 'failed', failed_reason: null }), NOW, false);
    expect(d.detail).toEqual({ key: 'noReason' });
    expect(detailQuote(d.detail)).toBeNull();
  });

  it('keeps an unexpected status as the raw code for the view to show', () => {
    const d = describeDelivery(
      delivery({ status: 'mystery' as unknown as LiveDelivery['status'] }),
      NOW,
      false,
    );
    expect(d.label).toEqual({ key: 'unknown', status: 'mystery' });
    expect(d.detail).toEqual({ key: 'none' });
  });
});

describe('riderPosition', () => {
  it('ignores coordinates left behind on a row with no rider', () => {
    // reject_dispatch / offer expiry clear driver_id but leave the last fix in place.
    expect(
      riderPosition({
        driver_id: null,
        driver_lat: 30.1567,
        driver_lng: -95.4889,
        status: 'dispatching',
      }),
    ).toBeNull();
  });

  it('ignores coordinates on a row the rider is not riding for yet', () => {
    expect(
      riderPosition({ driver_id: 'r1', driver_lat: 30.15, driver_lng: -95.48, status: 'pending' }),
    ).toBeNull();
  });

  it('returns the fix while a rider holds the job', () => {
    expect(
      riderPosition({ driver_id: 'r1', driver_lat: 30.15, driver_lng: -95.48, status: 'in_transit' }),
    ).toEqual({ lat: 30.15, lng: -95.48 });
  });

  it('rejects an out-of-range fix', () => {
    expect(
      riderPosition({ driver_id: 'r1', driver_lat: 991, driver_lng: -95.48, status: 'picked_up' }),
    ).toBeNull();
  });
});

describe('saneEta', () => {
  it('refuses 25 days as an estimate', () => {
    expect(saneEta(37104, minsAgo(1), NOW)).toBeNull();
  });

  it('refuses a plausible number computed from a dead session', () => {
    expect(saneEta(12, minsAgo(20), NOW)).toBeNull();
  });

  it('accepts a fresh estimate', () => {
    expect(saneEta(12, minsAgo(0.5), NOW)).toBe(12);
  });

  it('refuses an estimate with no fix behind it', () => {
    expect(saneEta(12, null, NOW)).toBeNull();
  });
});

describe('riderPinState', () => {
  it('draws a rider on a job as busy whatever their flags say', () => {
    expect(riderPinState(rider({ active_delivery_id: 'd9', online: false }), NOW, 5)).toBe('busy');
  });

  it('is available when online with a fresh fix', () => {
    expect(riderPinState(rider(), NOW, 5)).toBe('available');
  });

  it('is stale when online but the fix is older than dispatch will accept', () => {
    // driver_branch_availability.is_online is sticky — riders forget to toggle off.
    expect(riderPinState(rider({ location_updated_at: minsAgo(90) }), NOW, 5)).toBe('stale');
  });

  it('is offline when the branch flag is off', () => {
    expect(riderPinState(rider({ online: false }), NOW, 5)).toBe('offline');
  });
});

describe('action gates', () => {
  it('offers a manual assign until the rider accepts', () => {
    expect(canAssign(delivery({ status: 'dispatching' }), false)).toBe(true);
    expect(
      canAssign(delivery({ status: 'assigned', driver_id: 'r1', accepted_at: minsAgo(1) }), false),
    ).toBe(false);
  });

  it('never offers a manual assign in self-delivery mode', () => {
    expect(canAssign(delivery({ status: 'dispatching' }), true)).toBe(false);
  });

  it('only sends a rider once the kitchen says the food is ready', () => {
    expect(canFindRider(delivery({ status: 'dispatching' }), false)).toBe(false);
    const ready = delivery({ status: 'dispatching' });
    ready.order = { ...ready.order!, status: 'ready' };
    expect(canFindRider(ready, false)).toBe(true);
  });

  it('stops offering cancel once the food is with the rider', () => {
    expect(canCancelDelivery(delivery({ status: 'dispatching' }))).toBe(true);
    expect(canCancelDelivery(delivery({ status: 'picked_up' }))).toBe(false);
  });
});

describe('staleness', () => {
  it('parks a row nobody has touched since June', () => {
    expect(isStale(delivery({ created_at: new Date(NOW - 40 * 864e5).toISOString() }), NOW)).toBe(
      true,
    );
  });

  it('never parks a delivery a rider is actually carrying', () => {
    const old = delivery({
      status: 'in_transit',
      driver_id: 'r1',
      created_at: new Date(NOW - 40 * 864e5).toISOString(),
    });
    expect(isStale(old, NOW)).toBe(false);
  });

  it('splits the board into what is moving and what is not', () => {
    const fresh = delivery({ id: 'fresh' });
    const old = delivery({ id: 'old', created_at: new Date(NOW - 40 * 864e5).toISOString() });
    const { live, stale } = partitionStale([fresh, old], NOW);
    expect(live.map((d) => d.id)).toEqual(['fresh']);
    expect(stale.map((d) => d.id)).toEqual(['old']);
  });
});

describe('boardCounts', () => {
  it('separates offered from accepted, and does not call a cooking order in flight', () => {
    const c = boardCounts([
      delivery({ id: '1', status: 'pending' }),
      delivery({ id: '2', status: 'dispatching' }),
      delivery({ id: '3', status: 'assigned', driver_id: 'r1' }),
      delivery({ id: '4', status: 'assigned', driver_id: 'r1', accepted_at: minsAgo(1) }),
      delivery({ id: '5', status: 'assigned', driver_id: null }),
      delivery({ id: '6', status: 'in_transit', driver_id: 'r1' }),
      delivery({ id: '7', status: 'failed' }),
    ]);
    expect(c).toEqual({
      waitingKitchen: 1,
      findingRider: 2,
      offered: 1,
      accepted: 1,
      onTheWay: 1,
      failed: 1,
    });
  });
});

describe('mergeRefetch', () => {
  it('keeps the board when the read failed', () => {
    const prev = [delivery()];
    expect(mergeRefetch(prev, [], true)).toBe(prev);
  });

  it('clears the board when the read succeeded and there is genuinely nothing', () => {
    // The last delivery completing while the tab was hidden must clear on wake-up.
    expect(mergeRefetch([delivery()], [], false)).toEqual([]);
  });
});

describe('ageSpan', () => {
  it('reads in the units a person would use', () => {
    expect(ageSpan(minsAgo(0.2), NOW)).toEqual({ unit: 'underMinute' });
    expect(ageSpan(minsAgo(3), NOW)).toEqual({ unit: 'minutes', minutes: 3 });
    expect(ageSpan(minsAgo(130), NOW)).toEqual({ unit: 'hours', hours: 2, minutes: 10 });
    expect(ageSpan(minsAgo(120), NOW)).toEqual({ unit: 'hours', hours: 2, minutes: 0 });
    expect(ageSpan(new Date(NOW - 3 * 864e5).toISOString(), NOW)).toEqual({ unit: 'days', days: 3 });
    expect(ageSpan(null, NOW)).toEqual({ unit: 'unknown' });
  });

  it('never goes negative for a stamp slightly in the future', () => {
    expect(ageSpan(new Date(NOW + 30_000).toISOString(), NOW)).toEqual({ unit: 'underMinute' });
  });
});

describe('describeDispatchFailure', () => {
  it('points at the setting when every rider has been tried', () => {
    expect(describeDispatchFailure({ error: 'max_attempts_reached' })).toEqual({
      key: 'maxAttempts',
    });
  });

  it('reports the first gate that emptied the candidate list', () => {
    expect(
      describeDispatchFailure({
        diagnostics: { branch_has_pin: true, approved: 8, online: 4, has_location: 0 },
      }),
    ).toEqual({ key: 'noLocation', values: { online: 4 } });
  });

  it('sends the merchant to Branch settings when there is no pin', () => {
    expect(describeDispatchFailure({ diagnostics: { branch_has_pin: false } })).toEqual({
      key: 'noPin',
    });
  });

  it('converts the search radius to miles', () => {
    expect(
      describeDispatchFailure({
        diagnostics: {
          branch_has_pin: true,
          approved: 3,
          online: 2,
          has_location: 2,
          gps_fresh: 2,
          not_busy: 2,
          in_radius: 0,
          radius_km: 8,
        },
      }),
    ).toEqual({ key: 'outOfRangeMiles', values: { online: 2, miles: 5 } });
  });

  it('names the two refusals instead of "try again"', () => {
    expect(describeDispatchFailure({ error: 'auth_required' })).toEqual({ key: 'authRequired' });
    expect(describeDispatchFailure({ error: 'not_authorized' })).toEqual({ key: 'notAuthorized' });
  });

  it('reads the status when the gateway, not dispatch-driver, answered', () => {
    const invalidJwt = { code: 401, message: 'Invalid JWT' } as DispatchFailure;
    expect(describeDispatchFailure(invalidJwt, 401)).toEqual({ key: 'authRequired' });
    expect(describeDispatchFailure({}, 403)).toEqual({ key: 'notAuthorized' });
    // A gateway 5xx is a failure to log, not "no rider available".
    expect(describeDispatchFailure({ message: 'boom' } as DispatchFailure, 502)).toEqual({
      key: 'failed',
      code: 'http_502',
    });
    expect(describeDispatchFailure(null)).toEqual({ key: 'failed' });
  });

  it('still says "no rider" when dispatch-driver found none but sent no diagnostics', () => {
    expect(describeDispatchFailure({ error: 'no_drivers_available', diagnostics: null }, 503)).toEqual({
      key: 'noneAvailable',
    });
  });

  it('keeps an unknown server code for the log instead of printing it', () => {
    expect(describeDispatchFailure({ error: 'something_new' })).toEqual({
      key: 'failed',
      code: 'something_new',
    });
  });
});

describe('rpcErrorKey', () => {
  it('turns a bare postgres exception into the rule it stands for', () => {
    expect(rpcErrorKey('already_accepted')).toBe('alreadyAccepted');
    expect(rpcErrorKey('driver_busy')).toBe('driverBusy');
  });

  it('finds the code inside a wrapped message', () => {
    expect(rpcErrorKey('cannot_cancel_status:picked_up')).toBe('cannotCancelStatus');
    expect(rpcErrorKey('P0001: order_not_found')).toBe('orderNotFound');
    expect(rpcErrorKey('delivery_not_found')).toBe('notFound');
  });

  it('does not recognise a message that is none of ours', () => {
    expect(rpcErrorKey('connection reset')).toBeNull();
  });
});
