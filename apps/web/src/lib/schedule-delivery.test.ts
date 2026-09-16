import { describe, expect, it } from 'vitest';
import type { StorefrontStatus } from '@favornoms/database/queries';
import { ordersPaused, resolveScheduleDelivery } from './schedule-delivery';

/** 2026-08-30 is a Sunday. 12:00 UTC = 07:00 in Chicago. */
const SUNDAY_NOON_UTC = new Date('2026-08-30T12:00:00Z');

const status = (over: Partial<StorefrontStatus> = {}): StorefrontStatus => ({
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
    expect(r).toEqual({ canDeliver: true, paused: false });
  });

  it('offers nothing while orders are paused', async () => {
    const r = await resolveScheduleDelivery(fakeClient({ orders_paused: true }), 'b', status(), SUNDAY_NOON_UTC);
    expect(r).toEqual({ canDeliver: false, paused: true });
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
