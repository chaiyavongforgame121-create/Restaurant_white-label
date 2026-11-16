// place-order's reading of when a booking reaches the kitchen, with no I/O, so it can be unit-tested.
// Since v11.12 that is the branch's Prep time plus busy mode, the figure the diner's ETA is built
// from; "Send to kitchen (minutes before)" (schedule_lead_time_min) is not read any more.
//
// Imports nothing on purpose: index.ts (Deno) imports it as './kitchen-lead.ts', and
// packages/shared/src/utils/kitchen-lead.test.ts imports it from Node and fails if it ever answers
// differently from kitchenLeadMin() in packages/shared/src/utils/kitchen-lead.ts, the copy the apps
// use (a Deno function cannot import the workspace package). The SQL side is
// private.branch_kitchen_lead_min(), which the release job uses: place-order holds a booking by
// this number and the job lets it out by that one, so the three must stay the same rule. All three
// run ./kitchen-lead.cases.ts (./kitchen-lead.test.ts here). When deploying through the Management
// API / MCP rather than the CLI, pass this file with index.ts.

/** The prep time when none is saved, and what a new branch is seeded with. */
export const KITCHEN_LEAD_DEFAULT_MIN = 15;

/** One week: the most either part may be, and the most the lead may be. */
export const KITCHEN_MINUTES_MAX = 7 * 24 * 60;

/** A whole number of minutes from 0 to a week; anything else is skipped, never coerced. */
function isKitchenMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= KITCHEN_MINUTES_MAX;
}

/**
 * Minutes before its booked time a scheduled order goes to the kitchen: prep_time_min if valid,
 * else 15, plus busy_extra_prep_min if valid, else 0, at most a week. Busy counts because the
 * diner's ETA is prep + busy: a busy kitchen needs the booking that much earlier. It used to be
 * Math.max(0, Number(schedule_lead_time_min ?? prep_time_min ?? 15)), which read a bad value as
 * NaN, and NaN compared as "not held": a booking for next week went straight to the kitchen.
 */
export function kitchenLeadMin(settings: unknown): number {
  const s = (settings !== null && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  const prep = isKitchenMinutes(s.prep_time_min) ? s.prep_time_min : KITCHEN_LEAD_DEFAULT_MIN;
  const busy = isKitchenMinutes(s.busy_extra_prep_min) ? s.busy_extra_prep_min : 0;
  // `+ 0` turns a -0 (JSON "-0") into 0, which is what the SQL resolver returns for it.
  return Math.min(prep + busy, KITCHEN_MINUTES_MAX) + 0;
}
