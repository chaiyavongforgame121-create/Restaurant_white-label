// "Accept ASAP delivery orders": branches.settings.asap_delivery_enabled, one switch per branch
// (owner request 2026-10-26, docs/ASAP-AND-SCHEDULING-2026-10-25.md §1). Off, the storefront shows
// no "As soon as possible" box for a delivery and every web delivery is booked for a day and time.
//
// ONLY `true` turns it on. A missing key, false, "true", 1 or anything else is off. Missing has to
// be off in code, not just seeded: the first branch of every new restaurant is inserted with the
// column-default settings, never with private.default_branch_settings, and existing branches were
// not backfilled — a branch that has not ticked the box shows no ASAP, as the owner asked.
//
// ONE rule, read in three places that must agree, or the storefront offers an ASAP delivery that
// place-order then refuses (or hides one it would take):
//   - here, for the storefront resolver, the checkout and the admin settings card;
//   - place-order: supabase/functions/place-order/asap-delivery.ts, a copy because a Deno function
//     cannot import this package (asap-delivery.test.ts fails if the two ever answer differently);
//   - SQL: patch_branch_settings accepts only a JSON boolean or null for the key
//     (supabase/migrations/20261026100000_asap_delivery_switch.sql), so `=== true` and a SQL
//     `= 'true'::jsonb` can never read one stored value two ways.

/** A branch that has never ticked the box: off. What private.default_branch_settings seeds. */
export const ASAP_DELIVERY_DEFAULT = false;

/**
 * Whether this branch takes ASAP deliveries from the storefront. Takes the raw settings object as
 * read from the row (any shape: null, a non-object or a junk value all read as off). Staff at the
 * counter and the POS are not asked: their deliveries are always for now.
 */
export function asapDeliveryEnabled(settings: unknown): boolean {
  if (settings === null || typeof settings !== 'object') return ASAP_DELIVERY_DEFAULT;
  return (settings as Record<string, unknown>).asap_delivery_enabled === true;
}
