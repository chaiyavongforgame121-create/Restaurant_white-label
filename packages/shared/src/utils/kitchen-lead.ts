// When a booked order reaches the kitchen: branches.settings.schedule_lead_time_min minutes before
// its booked time ("Send to kitchen (minutes before)", docs/ASAP-AND-SCHEDULING-2026-10-25.md §3).
// A booking for 11:30 with 5 is held until 11:25, then released to the kitchen board.
//
// ONE rule, read in three places that must agree, or a booking is held by one reading and released
// (or drawn on the board) by another:
//   - SQL: private.branch_kitchen_lead_min(settings jsonb), which release_scheduled_orders uses
//     (supabase/migrations/20261025100000_scheduling_release.sql);
//   - place-order: supabase/functions/place-order/kitchen-lead.ts, a copy because a Deno function
//     cannot import this package (kitchen-lead.test.ts fails if the two ever answer differently);
//   - here, for the kitchen board, the counter, the dashboard and the settings card.
//
// Only a whole number of minutes from 0 to a week counts. Anything else (7.5, "15", -1, null) is
// skipped rather than coerced: Number("15 ") and a raw `::int` cast each read some of those values
// their own way, and one value the release job could not cast stopped every branch's releases.

/** The last fallback, and what a new branch is seeded with (private.default_branch_settings). */
export const KITCHEN_LEAD_DEFAULT_MIN = 15;

/** One week. patch_branch_settings refuses a lead or a prep time above it. */
export const KITCHEN_MINUTES_MAX = 7 * 24 * 60;

/**
 * A value the resolver takes: a whole number of minutes from 0 to KITCHEN_MINUTES_MAX. These are
 * also the only values patch_branch_settings accepts for schedule_lead_time_min and prep_time_min.
 */
export function isKitchenMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= KITCHEN_MINUTES_MAX;
}

/**
 * How many minutes before its booked time a scheduled order goes to the kitchen:
 * schedule_lead_time_min if it is valid, else prep_time_min if that is, else 15. A saved 0 is an
 * answer ("at the booked time"), not a gap. Takes the raw settings object as read from the row
 * (any shape: null, a non-object or junk values all fall through to the default).
 */
export function kitchenLeadMin(settings: unknown): number {
  const s = (settings !== null && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  // `+ 0` turns a -0 (JSON "-0") into 0, which is what the SQL resolver returns for it.
  if (isKitchenMinutes(s.schedule_lead_time_min)) return s.schedule_lead_time_min + 0;
  if (isKitchenMinutes(s.prep_time_min)) return s.prep_time_min + 0;
  return KITCHEN_LEAD_DEFAULT_MIN;
}
