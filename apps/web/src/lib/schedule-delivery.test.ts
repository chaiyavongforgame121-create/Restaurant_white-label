import { describe, expect, it } from 'vitest';
import type { StorefrontStatus } from '@favornoms/database/queries';
import { ordersPaused, resolveScheduleDelivery } from './schedule-delivery';

/** 2026-08-30 is a Sunday. 12:00 UTC = 07:00 in Chicago. */
const SUNDAY_NOON_UTC = new Date('2026-08-30T12:00:00Z');

const status = (over: Partial<StorefrontStatus> = {}): StorefrontStatus => ({
  known: true,
  entitled: true,
  delivery: false,
  delivery_entitled: true,
  delivery_available: false,
  delivery_hours_on: false,
  delivery_mode: 'platform',
  delivery_windows: [],
  card_payment: false,
  timezone: 'America/Chicago',
  opening_hours: [{ day_of_week: 0, opens_at: '09:00', closes_at: '18:00' }],
  scheduling_enabled: true,
  schedule_min_lead_min: 15,
  schedule_max_days: 0,
  schedule_slot_minutes: 60,
  ...over,
});

function fakeClient(settings: Record<string, unknown> | null, policy: unknown = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: settings ? { settings } : null }) }),
      }),
    }),
    rpc: async () => ({ data: policy }),
  };
}

describe('ordersPaused', () => {
  it('reads the flag the way the database casts it', () => {
    expect(ordersPaused({ orders_paused: true })).toBe(true);
    expect(ordersPaused({ orders_paused: 'true' })).toBe(true);
    expect(ordersPaused({ orders_paused: 'on' })).toBe(true);
    expect(ordersPaused({ orders_paused: false })).toBe(false);
    expect(ordersPaused({ orders_paused: 'false' })).toBe(false);
    expect(ordersPaused({})).toBe(false);
    expect(ordersPaused(null)).toBe(false);
  });
});

describe('resolveScheduleDelivery', () => {
  it('offers delivery booked ahead even though delivery is not open right now', async () => {
    const r = await resolveScheduleDelivery(fakeClient({}), 'b', status(), SUNDAY_NOON_UTC);
    expect(r).toEqual({ canDeliver: true, paused: false, offered: true });
  });

  it('offers nothing while orders are paused', async () => {
    const r = await resolveScheduleDelivery(fakeClient({ orders_paused: true }), 'b', status(), SUNDAY_NOON_UTC);
    expect(r).toEqual({ canDeliver: false, paused: true, offered: true });
  });

  it('offers nothing without the add-on or without advance orders', async () => {
    expect(
      (await resolveScheduleDelivery(fakeClient({}), 'b', status({ delivery_entitled: false }), SUNDAY_NOON_UTC))
        .canDeliver,
    ).toBe(false);
    expect(
      (await resolveScheduleDelivery(fakeClient({}), 'b', status({ scheduling_enabled: false }), SUNDAY_NOON_UTC))
        .canDeliver,
    ).toBe(false);
  });

  // Delivery is bought per branch, and the storefront has to say which of the two it is:
  // "this branch does not deliver" is permanent, "not right now" is not. Every other way
  // of getting canDeliver:false leaves `offered` true, so the copy can tell them apart.
  it('separates "this branch does not deliver" from "not bookable right now"', async () => {
    const notSold = await resolveScheduleDelivery(
      fakeClient({}),
      'b',
      status({ delivery_entitled: false }),
      SUNDAY_NOON_UTC,
    );
    expect(notSold).toEqual({ canDeliver: false, paused: false, offered: false });

    // A status that could not be read (STOREFRONT_UNKNOWN: known:false, every flag closed)
    // is NOT evidence that the branch stopped delivering. It used to take the same path as
    // `delivery_entitled: false` and print the permanent sentence over a cold database.
    const unreadable = await resolveScheduleDelivery(
      fakeClient({}),
      'b',
      status({ known: false, delivery_entitled: false, scheduling_enabled: false }),
      SUNDAY_NOON_UTC,
    );
    expect(unreadable).toEqual({ canDeliver: false, paused: false, offered: true });

    for (const closed of [
      // Booked ahead is switched off at this branch.
      status({ scheduling_enabled: false }),
      // Delivery hours are armed with no window, so no slot survives.
      status({ delivery_hours_on: true, delivery_windows: [] }),
    ]) {
      const r = await resolveScheduleDelivery(fakeClient({}), 'b', closed, SUNDAY_NOON_UTC);
      expect(r.canDeliver).toBe(false);
      expect(r.offered).toBe(true);
    }

    // Paused is about the whole kitchen, not about delivery being sold here.
    const paused = await resolveScheduleDelivery(
      fakeClient({ orders_paused: true }),
      'b',
      status(),
      SUNDAY_NOON_UTC,
    );
    expect(paused.offered).toBe(true);
  });

  it('offers nothing when no slot survives delivery hours', async () => {
    const r = await resolveScheduleDelivery(
      fakeClient({}),
      'b',
      status({ delivery_hours_on: true, delivery_windows: [] }),
      SUNDAY_NOON_UTC,
    );
    expect(r.canDeliver).toBe(false);
  });

  it('offers nothing when booking windows and delivery hours never overlap', async () => {
    const r = await resolveScheduleDelivery(
      fakeClient({}, {
        schedule_hours_enabled: true,
        schedule_windows: [{ day_of_week: 0, opens_at: '10:00', closes_at: '12:00' }],
        closures: [],
      }),
      'b',
      status({
        delivery_hours_on: true,
        delivery_windows: [{ day_of_week: 0, opens_at: '15:00', closes_at: '17:00' }],
      }),
      SUNDAY_NOON_UTC,
    );
    expect(r.canDeliver).toBe(false);
  });
});
