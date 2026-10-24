// place-order's reading of "Send to kitchen (minutes before)", with no I/O, so it can be unit-tested.
//
// Imports nothing on purpose: index.ts (Deno) imports it as './kitchen-lead.ts', and
// packages/shared/src/utils/kitchen-lead.test.ts imports it from Node and fails if it ever answers
// differently from kitchenLeadMin() in packages/shared/src/utils/kitchen-lead.ts, the copy the apps
// use (a Deno function cannot import the workspace package). The SQL side is
// private.branch_kitchen_lead_min(), which the release job uses: place-order holds a booking by
// this number and the job lets it out by that one, so the three must stay the same rule. When
// deploying through the Management API / MCP rather than the CLI, pass this file with index.ts.

/** The last fallback, and what a new branch is seeded with. */
export const KITCHEN_LEAD_DEFAULT_MIN = 15;

/** One week. patch_branch_settings refuses a lead or a prep time above it. */
export const KITCHEN_MINUTES_MAX = 7 * 24 * 60;

/** A whole number of minutes from 0 to a week; anything else is skipped, never coerced. */
function isKitchenMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= KITCHEN_MINUTES_MAX;
}

/**
 * Minutes before its booked time a scheduled order goes to the kitchen: schedule_lead_time_min if
 * valid, else prep_time_min if valid, else 15. It used to be
 * Math.max(0, Number(schedule_lead_time_min ?? prep_time_min ?? 15)), which read a bad value as
 * NaN, and NaN compared as "not held": a booking for next week went straight to the kitchen.
 */
export function kitchenLeadMin(settings: unknown): number {
  const s = (settings !== null && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  // `+ 0` turns a -0 (JSON "-0") into 0, which is what the SQL resolver returns for it.
  if (isKitchenMinutes(s.schedule_lead_time_min)) return s.schedule_lead_time_min + 0;
  if (isKitchenMinutes(s.prep_time_min)) return s.prep_time_min + 0;
  return KITCHEN_LEAD_DEFAULT_MIN;
}
