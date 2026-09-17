import { describe, expect, it } from 'vitest';
import { branchDayKey, shiftDayKey, startOfBranchDayUtc } from '@favornoms/database/queries';
import type {
  DashboardKitchenOrder,
  DashboardScheduledOrder,
  LiveDelivery,
} from '@favornoms/database/queries';
import {
  lastReadyAt,
  parseStamp,
  readDeliveries,
  readKitchen,
  readScheduled,
  spanOf,
  unacceptedReason,
} from './action-model';

// The shapes here are the ones the live project actually carries: twenty-two kitchen
// tickets left on the board since June, thirteen June deliveries still "Finding a rider",
// and a `preparing` order wearing a `ready` stamp from a recall three months ago.

const NOW = Date.parse('2026-09-08T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const LEAD_MS = 15 * 60_000;
const BRANCH = '44444444-4444-4444-4444-444444444444';

function kitchenOrder(over: Partial<DashboardKitchenOrder> = {}): DashboardKitchenOrder {
  return {
    id: 'o1',
    order_number: 'A-2609-100001',
    status: 'preparing',
    channel: 'pickup',
    created_at: minsAgo(4),
    scheduled_for: null,
    held: false,
    awaiting_payment: false,
    customer_name: 'Dana',
    status_history: [],
    ...over,
  };
}

function delivery(over: Partial<LiveDelivery> = {}): LiveDelivery {
  return {
    id: 'd1',
    status: 'dispatching',
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
      id: 'ord1',
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

function booking(over: Partial<DashboardScheduledOrder> = {}): DashboardScheduledOrder {
  return {
    id: 's1',
    order_number: 'A-2609-200001',
    status: 'pending',
    held: true,
    scheduled_for: new Date(NOW + 40 * 60_000).toISOString(),
    customer_name: 'Priya',
    ...over,
  };
}

describe('parseStamp', () => {
  it('reads both stamp formats status_history carries', () => {
    // place-order writes ISO; the orders_after_status_update trigger writes now()::text.
    expect(parseStamp('2026-09-06T15:22:07.534Z')).toBe(Date.parse('2026-09-06T15:22:07.534Z'));
    expect(parseStamp('2026-09-06 15:26:50.190222+00')).toBe(
      Date.parse('2026-09-06T15:26:50.190Z'),
    );
  });

  it('is null rather than NaN for anything else', () => {
    expect(parseStamp(null)).toBeNull();
    expect(parseStamp('nope')).toBeNull();
    expect(parseStamp(1757337600000)).toBeNull();
  });
});

describe('lastReadyAt', () => {
  it('takes the most recent ready entry', () => {
    const o = kitchenOrder({
      status_history: [
        { status: 'ready', at: '2026-06-04 10:00:00+00' },
        { status: 'preparing', at: '2026-09-08 11:00:00+00' },
        { status: 'ready', at: '2026-09-08 11:40:00+00' },
      ],
    });
    expect(lastReadyAt(o)).toBe(Date.parse('2026-09-08T11:40:00.000Z'));
  });

  it('is ignored for a recalled ticket, which is back at preparing', () => {
    // Live row A-2606-471738: preparing, carrying a June `ready` entry. Reading it would
    // have printed a three-month-old age on a ticket that is cooking right now.
    const recalled = kitchenOrder({
      status: 'preparing',
      created_at: minsAgo(20),
      status_history: [{ status: 'ready', at: '2026-06-04 10:00:00+00' }],
    });
    const reading = readKitchen([recalled], NOW, LEAD_MS, BRANCH);
    expect(reading.abandoned).toBe(0);
    expect(reading.kitchenLate).toHaveLength(1);
    expect(reading.kitchenLate[0]?.age).toEqual({
      kind: 'waited',
      span: { unit: 'minutes', minutes: 20 },
    });
  });
});

describe('readKitchen', () => {
  it('counts the same lanes the kitchen board draws', () => {
    const reading = readKitchen(
      [
        kitchenOrder({ id: 'a', status: 'pending' }),
        kitchenOrder({ id: 'b', status: 'confirmed' }),
        kitchenOrder({ id: 'c', status: 'preparing' }),
        kitchenOrder({ id: 'd', status: 'ready' }),
      ],
      NOW,
      LEAD_MS,
      BRANCH,
    );
    expect(reading.waiting).toBe(2);
    expect(reading.cooking).toBe(1);
    expect(reading.ready).toBe(1);
  });

  it('leaves held and awaiting_payment tickets off the board entirely', () => {
    const reading = readKitchen(
      [
        kitchenOrder({ id: 'a', status: 'pending', held: true, created_at: minsAgo(60) }),
        kitchenOrder({
          id: 'b',
          status: 'pending',
          awaiting_payment: true,
          created_at: minsAgo(60),
        }),
      ],
      NOW,
      LEAD_MS,
      BRANCH,
    );
    expect(reading).toMatchObject({ waiting: 0, cooking: 0, ready: 0, abandoned: 0 });
    expect(reading.kitchenLate).toHaveLength(0);
    expect(reading.customersWaiting).toHaveLength(0);
  });

  it('calls a week-old ticket abandoned, not late', () => {
    const reading = readKitchen(
      [kitchenOrder({ status: 'preparing', created_at: daysAgo(7) })],
      NOW,
      LEAD_MS,
      BRANCH,
    );
    expect(reading.cooking).toBe(1);
    expect(reading.abandoned).toBe(1);
    expect(reading.kitchenLate).toHaveLength(0);
  });

  it('flags a ticket cooking past the board’s own late threshold', () => {
    const reading = readKitchen(
      [kitchenOrder({ status: 'preparing', created_at: minsAgo(20) })],
      NOW,
      LEAD_MS,
      BRANCH,
    );
    expect(reading.abandoned).toBe(0);
    expect(reading.kitchenLate).toHaveLength(1);
    expect(reading.kitchenLate[0]?.why).toEqual({ code: 'cookingLong', minutes: 15 });
  });

  it('measures a scheduled order from its release, not from when it was booked', () => {
    // Booked this morning for five minutes from now: the kitchen has not been sitting on it.
    const reading = readKitchen(
      [
        kitchenOrder({
          status: 'confirmed',
          created_at: daysAgo(0.2),
          scheduled_for: new Date(NOW + 5 * 60_000).toISOString(),
        }),
      ],
      NOW,
      LEAD_MS,
      BRANCH,
    );
    expect(reading.kitchenLate).toHaveLength(0);
  });

  it('separates a diner waiting to be accepted from a kitchen running late', () => {
    const reading = readKitchen(
      [kitchenOrder({ status: 'pending', created_at: minsAgo(12) })],
      NOW,
      LEAD_MS,
      BRANCH,
    );
    expect(reading.customersWaiting).toHaveLength(1);
    expect(reading.customersWaiting[0]?.why).toEqual({ code: 'orderNotAccepted' });
    expect(reading.kitchenLate).toHaveLength(0);
  });

  it('chases food sitting on the pass, but not a delivery waiting for its rider', () => {
    const readyAt = { status: 'ready', at: new Date(NOW - 10 * 60_000).toISOString() };
    const pickup = readKitchen(
      [kitchenOrder({ status: 'ready', channel: 'pickup', status_history: [readyAt] })],
      NOW,
      LEAD_MS,
      BRANCH,
    );
    expect(pickup.customersWaiting).toHaveLength(1);
    expect(pickup.customersWaiting[0]?.why).toEqual({ code: 'readyNotCollected' });

    const forDelivery = readKitchen(
      [kitchenOrder({ status: 'ready', channel: 'delivery', status_history: [readyAt] })],
      NOW,
      LEAD_MS,
      BRANCH,
    );
    expect(forDelivery.customersWaiting).toHaveLength(0);
  });
});

describe('readDeliveries', () => {
  it('reports thirteen forgotten June rows as none in flight', () => {
    // The live shape at branch 4444: a naive count of the same rows says 13.
    const rows = Array.from({ length: 13 }, (_, i) =>
      delivery({ id: `d${i}`, status: 'dispatching', created_at: '2026-06-04T18:00:00Z' }),
    );
    const reading = readDeliveries(rows, NOW, false, BRANCH);
    expect(reading.inFlight).toBe(0);
    expect(reading.stalled).toBe(13);
    expect(reading.unaccepted).toHaveLength(0);
  });

  it('counts a live row and chases it once it is overdue', () => {
    const overdue = readDeliveries([delivery({ created_at: minsAgo(45) })], NOW, false, BRANCH);
    expect(overdue).toMatchObject({ inFlight: 1, stalled: 0 });
    expect(overdue.unaccepted).toHaveLength(1);
    expect(overdue.unaccepted[0]?.why).toEqual({ code: 'deliveryLookingForRider' });
    expect(overdue.unaccepted[0]?.title).toBe('#A-2609-991284');

    const fresh = readDeliveries([delivery({ created_at: minsAgo(10) })], NOW, false, BRANCH);
    expect(fresh).toMatchObject({ inFlight: 1, stalled: 0 });
    expect(fresh.unaccepted).toHaveLength(0);
  });

  it('keeps a rider’s problem even after the board has parked the row', () => {
    const reading = readDeliveries(
      [delivery({ status: 'failed', failed_reason: 'Nobody at the door', created_at: daysAgo(3) })],
      NOW,
      false,
      BRANCH,
    );
    expect(reading.stalled).toBe(1);
    expect(reading.inFlight).toBe(0);
    expect(reading.failed).toHaveLength(1);
    expect(reading.failed[0]?.why).toEqual({
      code: 'deliveryFailed',
      reason: 'Nobody at the door',
      startedAgo: { unit: 'days', days: 3 },
    });
  });
});

describe('unacceptedReason', () => {
  // The same second line the Live deliveries board prints for each of these rows.
  it('follows the kitchen while no rider has been asked', () => {
    expect(unacceptedReason(delivery({ status: 'pending' }), false)).toEqual({
      code: 'deliveryKitchenStatus',
      status: 'preparing',
    });
    const ready = delivery({ status: 'pending' });
    expect(unacceptedReason({ ...ready, order: { ...ready.order!, status: 'ready' } }, false)).toEqual({
      code: 'deliveryKitchenReady',
    });
    expect(unacceptedReason(delivery({ status: 'pending', order: null }), false)).toEqual({
      code: 'deliveryWaitingKitchen',
    });
  });

  it('counts the riders already asked', () => {
    expect(unacceptedReason(delivery({ dispatch_attempts: 3 }), false)).toEqual({
      code: 'deliveryAskedRiders',
      count: 3,
    });
  });

  it('separates self-delivery, an empty assignment and an expired offer', () => {
    expect(unacceptedReason(delivery({ status: 'assigned' }), true)).toEqual({ code: 'deliveryOwnStaff' });
    expect(unacceptedReason(delivery({ status: 'assigned' }), false)).toEqual({
      code: 'deliveryNoRiderHolds',
    });
    expect(unacceptedReason(delivery({ status: 'assigned', driver_id: 'r1' }), false)).toEqual({
      code: 'deliveryOfferExpired',
    });
  });
});

describe('spanOf', () => {
  it('uses the delivery board’s cut-offs', () => {
    expect(spanOf(30_000)).toEqual({ unit: 'underMinute' });
    expect(spanOf(-5_000)).toEqual({ unit: 'underMinute' });
    expect(spanOf(59 * 60_000)).toEqual({ unit: 'minutes', minutes: 59 });
    expect(spanOf(130 * 60_000)).toEqual({ unit: 'hours', hours: 2, minutes: 10 });
    expect(spanOf(3 * 86_400_000)).toEqual({ unit: 'days', days: 3 });
    expect(spanOf(Number.NaN)).toEqual({ unit: 'unknown' });
  });
});

describe('readScheduled', () => {
  it('chases a booking nobody has accepted', () => {
    const rows = readScheduled([booking({ status: 'pending' })], NOW, LEAD_MS, BRANCH);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.why).toEqual({ code: 'bookingNotAccepted' });
    expect(rows[0]?.age).toEqual({ kind: 'dueIn', span: { unit: 'minutes', minutes: 40 } });
  });

  it('leaves an accepted booking that is not due yet alone', () => {
    const rows = readScheduled([booking({ status: 'confirmed', held: true })], NOW, LEAD_MS, BRANCH);
    expect(rows).toHaveLength(0);
  });

  it('flags a held booking whose lead time has already passed', () => {
    const rows = readScheduled(
      [
        booking({
          status: 'confirmed',
          held: true,
          scheduled_for: new Date(NOW + 5 * 60_000).toISOString(),
        }),
      ],
      NOW,
      LEAD_MS,
      BRANCH,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.why).toEqual({ code: 'bookingStillHeld' });
  });
});

describe('branch-local days', () => {
  it('starts the day at the branch’s midnight, on both sides of DST', () => {
    expect(startOfBranchDayUtc('2026-09-08', 'America/Chicago').toISOString()).toBe(
      '2026-09-08T05:00:00.000Z',
    );
    expect(startOfBranchDayUtc('2026-01-08', 'America/Chicago').toISOString()).toBe(
      '2026-01-08T06:00:00.000Z',
    );
    // Spring-forward day: the reason the offset is measured twice.
    expect(startOfBranchDayUtc('2026-03-08', 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });

  it('buckets an evening order into the branch’s day, not the server’s', () => {
    // 23:30 UTC is still 18:30 in Chicago — the same day, not tomorrow.
    expect(branchDayKey(new Date('2026-09-08T23:30:00Z'), 'America/Chicago')).toBe('2026-09-08');
  });

  it('steps whole days across a DST boundary', () => {
    expect(shiftDayKey('2026-03-08', -1)).toBe('2026-03-07');
    expect(shiftDayKey('2026-01-01', -1)).toBe('2025-12-31');
  });
});
