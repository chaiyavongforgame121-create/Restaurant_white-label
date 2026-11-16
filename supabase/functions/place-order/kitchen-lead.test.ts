// Run: deno test kitchen-lead.test.ts (no permissions, no network). The rows are
// ./kitchen-lead.cases.ts, the table private.branch_kitchen_lead_min runs in
// supabase/tests/kitchen_lead_is_prep_time.sql and the shared copy runs in
// packages/shared/src/utils/kitchen-lead.test.ts: the hold decided here and the release job's
// let-out must be the same number, or a booking reaches the kitchen early or late.
import { KITCHEN_LEAD_CASES } from './kitchen-lead.cases.ts';
import { KITCHEN_LEAD_DEFAULT_MIN, KITCHEN_MINUTES_MAX, kitchenLeadMin } from './kitchen-lead.ts';

// Object.is, so a -0 does not pass for the 0 the SQL resolver returns.
function eq(actual: unknown, expected: unknown) {
  if (!Object.is(actual, expected)) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
}

for (const [label, settings, lead] of KITCHEN_LEAD_CASES) {
  Deno.test(`${label}: ${settings} -> ${lead}`, () => {
    eq(kitchenLeadMin(JSON.parse(settings)), lead);
  });
}

Deno.test('the default prep time is 15 and the ceiling a week', () => {
  eq(KITCHEN_LEAD_DEFAULT_MIN, 15);
  eq(KITCHEN_MINUTES_MAX, 10080);
});

// Values no JSON can hold, which only a caller in code could pass: skipped like any bad value.
Deno.test('NaN, Infinity and undefined are skipped too', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined]) {
    eq(kitchenLeadMin({ prep_time_min: value }), 15);
    eq(kitchenLeadMin({ prep_time_min: 20, busy_extra_prep_min: value }), 20);
  }
  eq(kitchenLeadMin(undefined), 15);
});

Deno.test('a booking for 11:30 at prep 20 is held until 11:10, in busy mode (10) until 11:00', () => {
  const booked = Date.parse('2026-11-16T11:30:00Z');
  const at = (settings: unknown) => new Date(booked - kitchenLeadMin(settings) * 60_000).toISOString();
  eq(at({ prep_time_min: 20 }), '2026-11-16T11:10:00.000Z');
  eq(at({ prep_time_min: 20, busy_extra_prep_min: 10 }), '2026-11-16T11:00:00.000Z');
  // The card's old "Send to kitchen" figure no longer moves it.
  eq(at({ prep_time_min: 20, schedule_lead_time_min: 5 }), '2026-11-16T11:10:00.000Z');
});
