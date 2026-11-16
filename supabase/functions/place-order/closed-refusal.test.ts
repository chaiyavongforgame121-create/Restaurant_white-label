// Run: deno test closed-refusal.test.ts (no permissions, no network). Nothing outside Deno imports
// this folder's index.ts, so the rule is pinned here rather than from a workspace package.
import { closedRefusalCode, deliveryHoursEnabled, type ClosedRefusalInput } from './closed-refusal.ts';

function eq(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
}

// Thai Burrito: open 09:00-17:30, delivers 08:00-09:00 and 18:00-19:00 with delivery hours on.
const deliversOwnHours = { is_active: true, settings: { delivery_hours_enabled: true } };
const base: ClosedRefusalInput = { channel: 'delivery', scheduled: false, branch: deliversOwnHours, closureCovers: false };

Deno.test('a delivery refused for its own delivery hours is told so, ASAP or booked', () => {
  eq(closedRefusalCode(base), 'delivery_not_available_at_that_time');
  eq(closedRefusalCode({ ...base, scheduled: true }), 'delivery_not_available_at_that_time');
});

Deno.test('the string "true" counts, as settings->>key = \'true\' does', () => {
  eq(closedRefusalCode({ ...base, branch: { is_active: true, settings: { delivery_hours_enabled: 'true' } } }), 'delivery_not_available_at_that_time');
});

Deno.test('delivery hours off or unreadable: the branch is closed, as before', () => {
  for (const settings of [{}, { delivery_hours_enabled: false }, { delivery_hours_enabled: 1 }, null, 'x']) {
    eq(closedRefusalCode({ ...base, branch: { is_active: true, settings } }), 'branch_closed');
    eq(closedRefusalCode({ ...base, scheduled: true, branch: { is_active: true, settings } }), 'branch_closed_at_scheduled_time');
  }
});

Deno.test('a paused, closed, inactive or unread branch is closed for delivery too', () => {
  eq(closedRefusalCode({ ...base, branch: { is_active: true, settings: { delivery_hours_enabled: true, orders_paused: true } } }), 'branch_closed');
  eq(closedRefusalCode({ ...base, branch: { is_active: true, settings: { delivery_hours_enabled: true, orders_paused: 'true' } } }), 'branch_closed');
  eq(closedRefusalCode({ ...base, closureCovers: true }), 'branch_closed');
  eq(closedRefusalCode({ ...base, scheduled: true, closureCovers: true }), 'branch_closed_at_scheduled_time');
  eq(closedRefusalCode({ ...base, branch: { is_active: false, settings: { delivery_hours_enabled: true } } }), 'branch_closed');
  eq(closedRefusalCode({ ...base, branch: null }), 'branch_closed');
});

Deno.test('every other channel keeps the opening-hours codes', () => {
  for (const channel of ['pickup', 'dine_in', 'qr_ordering']) {
    eq(closedRefusalCode({ ...base, channel }), 'branch_closed');
    eq(closedRefusalCode({ ...base, channel, scheduled: true }), 'branch_closed_at_scheduled_time');
  }
});

Deno.test('deliveryHoursEnabled is on only for true or "true"', () => {
  eq(deliveryHoursEnabled({ delivery_hours_enabled: true }), true);
  eq(deliveryHoursEnabled({ delivery_hours_enabled: 'true' }), true);
  eq(deliveryHoursEnabled({ delivery_hours_enabled: 'yes' }), false);
  eq(deliveryHoursEnabled({}), false);
  eq(deliveryHoursEnabled(undefined), false);
});
