// place-order's reading of "Accept ASAP delivery orders" (branches.settings.asap_delivery_enabled),
// with no I/O, so it can be unit-tested.
//
// Imports nothing on purpose: index.ts (Deno) imports it as './asap-delivery.ts', and
// packages/shared/src/utils/asap-delivery.test.ts imports it from Node and fails if it ever answers
// differently from asapDeliveryEnabled() in packages/shared/src/utils/asap-delivery.ts, the copy the
// storefront and the admin card use (a Deno function cannot import the workspace package). The
// storefront hides the "As soon as possible" box by that copy and this one refuses an ASAP delivery,
// so the two must stay the same rule. When deploying through the Management API / MCP rather than
// the CLI, pass this file with index.ts.

/** A branch that has never ticked the box: off. */
export const ASAP_DELIVERY_DEFAULT = false;

/** Only `true` is on: a missing key, false, "true", 1 or any other value is off. */
export function asapDeliveryEnabled(settings: unknown): boolean {
  if (settings === null || typeof settings !== 'object') return ASAP_DELIVERY_DEFAULT;
  return (settings as Record<string, unknown>).asap_delivery_enabled === true;
}
