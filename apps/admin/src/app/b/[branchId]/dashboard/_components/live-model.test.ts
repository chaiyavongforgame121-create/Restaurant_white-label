import { describe, expect, it } from 'vitest';
import {
  CATCH_UP_SKIP_MS,
  catchUpWorthIt,
  changeMatters,
  fallbackDue,
  HIDDEN_FALLBACK_FACTOR,
  REFRESH_MIN_GAP_MS,
  REFRESH_SETTLE_MS,
  refreshDelay,
} from './live-model';

const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  status: 'accepted',
  driver_id: 'r1',
  accepted_at: '2026-09-19T17:00:00Z',
  offered_at: '2026-09-19T16:59:00Z',
  offer_expires_at: null,
  dispatch_attempts: 1,
  failed_reason: null,
  picked_up_at: null,
  driver_lat: 13.75,
  driver_lng: 100.5,
  driver_location_updated_at: '2026-09-19T17:05:00Z',
  ...over,
});

describe('changeMatters', () => {
  it('ignores a rider’s GPS pings once the row is known', () => {
    const memory = new Map<string, string>();
    // The first UPDATE this tab sees for a row counts: the page may show it in an older state.
    expect(changeMatters('deliveries', 'UPDATE', delivery(), memory)).toBe(true);
    expect(
      changeMatters('deliveries', 'UPDATE', delivery({ driver_lat: 13.76, driver_lng: 100.51 }), memory),
    ).toBe(false);
    expect(
      changeMatters('deliveries', 'UPDATE', delivery({ driver_location_updated_at: 'later' }), memory),
    ).toBe(false);
  });

  it('refreshes when a delivery changes in a way a bucket can see', () => {
    const memory = new Map<string, string>();
    changeMatters('deliveries', 'UPDATE', delivery(), memory);
    expect(changeMatters('deliveries', 'UPDATE', delivery({ status: 'failed' }), memory)).toBe(true);
    expect(
      changeMatters('deliveries', 'UPDATE', delivery({ status: 'failed', failed_reason: 'Closed' }), memory),
    ).toBe(true);
  });

  it('always refreshes for a new or deleted row', () => {
    const memory = new Map<string, string>();
    expect(changeMatters('orders', 'INSERT', { id: 'o1', status: 'pending' }, memory)).toBe(true);
    expect(changeMatters('orders', 'DELETE', { id: 'o1' }, memory)).toBe(true);
    expect(memory.has('orders:o1')).toBe(false);
  });

  it('follows an order through its statuses but not through a note being edited', () => {
    const memory = new Map<string, string>();
    const order = { id: 'o1', status: 'pending', held: true, awaiting_payment: false, channel: 'delivery' };
    changeMatters('orders', 'INSERT', order, memory);
    expect(changeMatters('orders', 'UPDATE', { ...order, kitchen_notes: 'no onion' }, memory)).toBe(false);
    expect(changeMatters('orders', 'UPDATE', { ...order, status: 'confirmed' }, memory)).toBe(true);
    expect(
      changeMatters('orders', 'UPDATE', { ...order, status: 'confirmed', held: false }, memory),
    ).toBe(true);
  });

  it('follows a transfer order through every step of its slip, not just the approval', () => {
    // payments is not published; each payments write reaches the page as an orders UPDATE from
    // private.sync_order_awaiting_payment, which rewrites awaiting_payment to the same value.
    const memory = new Map<string, string>();
    const order = { id: 'o1', status: 'pending', held: false, awaiting_payment: false, channel: 'delivery' };
    const awaiting = { ...order, awaiting_payment: true };
    expect(changeMatters('orders', 'INSERT', order, memory)).toBe(true);
    // The payment row is created.
    expect(changeMatters('orders', 'UPDATE', awaiting, memory)).toBe(true);
    // The slip is uploaded.
    expect(changeMatters('orders', 'UPDATE', awaiting, memory)).toBe(true);
    // The diner presses "I've paid": this is what puts it in the slips-to-approve bucket.
    expect(changeMatters('orders', 'UPDATE', awaiting, memory)).toBe(true);
    // Approved: the flag clears and the order moves on.
    expect(changeMatters('orders', 'UPDATE', { ...order, status: 'confirmed' }, memory)).toBe(true);
    // Paid for, so a same-state UPDATE is back to being noise.
    expect(changeMatters('orders', 'UPDATE', { ...order, status: 'confirmed' }, memory)).toBe(false);
  });

  it('refreshes for a payload it cannot identify rather than guess', () => {
    expect(changeMatters('orders', 'UPDATE', null, new Map())).toBe(true);
    expect(changeMatters('orders', 'UPDATE', { status: 'pending' }, new Map())).toBe(true);
  });

  it('ignores tables the dashboard does not watch', () => {
    expect(changeMatters('menu_items', 'UPDATE', { id: 'm1' }, new Map())).toBe(false);
  });
});

describe('refresh pacing', () => {
  const T = Date.parse('2026-09-19T18:00:00Z');

  it('lets a burst settle, and never renders twice inside the minimum gap', () => {
    expect(refreshDelay(T, T - 60_000)).toBe(REFRESH_SETTLE_MS);
    expect(refreshDelay(T, T - 1_000)).toBe(REFRESH_MIN_GAP_MS - 1_000);
    expect(refreshDelay(T, T)).toBe(REFRESH_MIN_GAP_MS);
  });

  it('skips a catch-up right after a render — including the first connect', () => {
    expect(catchUpWorthIt(T, T - 2_000)).toBe(false);
    expect(catchUpWorthIt(T, T - CATCH_UP_SKIP_MS)).toBe(true);
  });

  it('keeps rendering a hidden tab on the fallback, at the slower pace', () => {
    const minute = 60_000;
    // Visible: every time the timer fires, one interval after the last render.
    expect(fallbackDue(T, T - minute, minute, true)).toBe(true);
    // Hidden: the first firing is let pass, the second renders. Never "not until it is shown".
    expect(fallbackDue(T, T - minute, minute, false)).toBe(false);
    expect(fallbackDue(T, T - HIDDEN_FALLBACK_FACTOR * minute, minute, false)).toBe(true);
    // A timer that fires a few ms early by this clock still counts.
    expect(fallbackDue(T, T - minute + 5, minute, true)).toBe(true);
  });
});
