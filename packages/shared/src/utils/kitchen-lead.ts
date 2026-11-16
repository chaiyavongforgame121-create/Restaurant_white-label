// When a booked order reaches the kitchen: its branch's Prep time (branches.settings.prep_time_min,
// the Delivery card's "Prep time (min)") plus busy mode
// (busy_extra_prep_min) minutes before its booked time. The owner decided on 2026-11-16 that this is
// one figure, not a separate "Send to kitchen (minutes before)" (schedule_lead_time_min, no longer
// read): the time the diner is quoted is the time the kitchen gets, and a new prep time moves both.
// Busy is in it because the diner's ETA is prep + busy (heuristicEtaMin, quote_delivery). A booking
// for 11:30 at a prep time of 20 is held until 11:10, then released to the kitchen board; in busy
// mode with 10 extra, until 11:00 (docs/ASAP-AND-SCHEDULING-2026-10-25.md §3).
//
// ONE rule, read in three places that must agree, or a booking is held by one reading and released
// (or drawn on the board) by another:
//   - SQL: private.branch_kitchen_lead_min(settings jsonb), which release_scheduled_orders uses
//     (supabase/migrations/20261116200000_kitchen_lead_is_prep_time.sql);
//   - place-order: supabase/functions/place-order/kitchen-lead.ts, a copy because a Deno function
//     cannot import this package (kitchen-lead.test.ts fails if the two ever answer differently);
//   - here, for the kitchen board, the counter, the dashboard and the settings cards.
// All three run the case table in supabase/functions/place-order/kitchen-lead.cases.ts.
//
// Only a whole number of minutes from 0 to a week counts. Anything else (7.5, "15", -1, null) is
// skipped rather than coerced: Number("15 ") and a raw `::int` cast each read some of those values
// their own way, and one value the release job could not cast stopped every branch's releases.

/** The prep time when none is saved, and what a new branch is seeded with (private.default_branch_settings). */
export const KITCHEN_LEAD_DEFAULT_MIN = 15;

/** One week: the most either part may be, and the most the lead may be. */
export const KITCHEN_MINUTES_MAX = 7 * 24 * 60;

/**
 * A value the resolver takes: a whole number of minutes from 0 to KITCHEN_MINUTES_MAX. These are
 * also the only values patch_branch_settings accepts for prep_time_min (and for the unread
 * schedule_lead_time_min); it keeps busy_extra_prep_min to 0-240, inside this range.
 */
export function isKitchenMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= KITCHEN_MINUTES_MAX;
}

/**
 * How many minutes before its booked time a scheduled order goes to the kitchen: prep_time_min if
 * it is valid, else 15, plus busy_extra_prep_min if that is valid, else 0, at most a week. A saved
 * prep time of 0 is an answer ("at the booked time"), not a gap. Takes the raw settings object as
 * read from the row (any shape: null, a non-object or junk values all fall through to the default).
 */
export function kitchenLeadMin(settings: unknown): number {
  const s = (settings !== null && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  const prep = isKitchenMinutes(s.prep_time_min) ? s.prep_time_min : KITCHEN_LEAD_DEFAULT_MIN;
  const busy = isKitchenMinutes(s.busy_extra_prep_min) ? s.busy_extra_prep_min : 0;
  // `+ 0` turns a -0 (JSON "-0") into 0, which is what the SQL resolver returns for it.
  return Math.min(prep + busy, KITCHEN_MINUTES_MAX) + 0;
}
