import { describe, expect, it } from 'vitest';
import type { BranchRider, LiveDelivery } from '@favornoms/database/queries';
import {
  ageLabel,
  boardCounts,
  canAssign,
  canCancelDelivery,
  canFindRider,
  describeDelivery,
  describeDispatchFailure,
  isStale,
  mergeRefetch,
  partitionStale,
  readableRpcError,
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

describe('describeDelivery', () => {
  it('says the kitchen still has it while the delivery is pending', () => {
    const d = describeDelivery(delivery({ status: 'pending' }), NOW, false);
    expect(d.label).toBe('Waiting for the kitchen');
    expect(d.detail).toBe('Kitchen: preparing');
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
    expect(d.label).toBe('Finding a rider');
    expect(d.detail).toBe('Asked 3 riders so far');
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
    expect(d.label).toBe('Offered to rider');
    expect(d.detail).toBe('Expires in 1:14');
  });

  it('does not keep saying "Offered" once the rider has accepted', () => {
    const d = describeDelivery(
      delivery({ status: 'assigned', driver_id: 'r1', accepted_at: minsAgo(2) }),
      NOW,
      false,
    );
    expect(d.label).toBe('Rider accepted · heading to shop');
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
    expect(d.detail).toBe('Offer expired — returning to the pool');
    expect(d.overdue).toBe(true);
  });

  it('reads a self-delivery parked at assigned as ready to go out, not as an offer', () => {
    const d = describeDelivery(delivery({ status: 'assigned', driver_id: null }), NOW, true);
    expect(d.label).toBe('Ready to go out');
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
    expect(d.detail).not.toContain('37104');
    expect(d.detail).toBe('ETA unknown — waiting for the rider’s GPS');
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
    expect(d.detail).toBe('ETA 12 min');
  });

  it('surfaces the recorded reason on a failed delivery', () => {
    const d = describeDelivery(
      delivery({ status: 'failed', failed_reason: 'Customer never answered' }),
      NOW,
      false,
    );
    expect(d.label).toBe('Failed — needs you');
    expect(d.detail).toBe('Customer never answered');
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

describe('ageLabel', () => {
  it('reads in the units a person would use', () => {
    expect(ageLabel(minsAgo(0.2), NOW)).toBe('<1 min');
    expect(ageLabel(minsAgo(3), NOW)).toBe('3 min');
    expect(ageLabel(minsAgo(130), NOW)).toBe('2 h 10 min');
    expect(ageLabel(new Date(NOW - 3 * 864e5).toISOString(), NOW)).toBe('3 d');
    expect(ageLabel(null, NOW)).toBe('—');
  });
});

describe('describeDispatchFailure', () => {
  it('points at the setting when every rider has been tried', () => {
    expect(describeDispatchFailure({ error: 'max_attempts_reached' })).toContain(
      'Max dispatch attempts',
    );
  });

  it('reports the first gate that emptied the candidate list', () => {
    expect(
      describeDispatchFailure({
        diagnostics: { branch_has_pin: true, approved: 8, online: 4, has_location: 0 },
      }),
    ).toContain('none have shared a location');
  });

  it('sends the merchant to Branch settings when there is no pin', () => {
    expect(describeDispatchFailure({ diagnostics: { branch_has_pin: false } })).toContain(
      'no map pin',
    );
  });
});

describe('readableRpcError', () => {
  it('turns a bare postgres exception into the rule it stands for', () => {
    expect(readableRpcError('already_accepted')).toContain('hand it back');
    expect(readableRpcError('driver_busy')).toBe('That rider is already on a delivery.');
  });

  it('leaves an unrecognised message alone', () => {
    expect(readableRpcError('connection reset')).toBe('connection reset');
  });
});
