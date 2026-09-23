// Shared entitlement loader for edge functions.
//
// Edge functions run as SERVICE ROLE, so RLS does not protect them. The SQL
// triggers still do (they fire for service_role too), but a trigger raises a
// P0001 in the middle of a multi-step handler — after an order row, before its
// items. Checking up front turns that into a clean 402/403 with nothing half
// written.
//
// Fail-closed by construction: every failure path returns DENIED.
//
// IN-FLIGHT DELIVERIES — the one rule, stated here and nowhere else in the edge:
//
//   A deliveries row that exists was entitled when it was inserted, so it is finished,
//   whatever the branch's delivery switch or the restaurant's billing says now. Only
//   CREATING delivery work asks whether this branch delivers today.
//
// The BEFORE INSERT trigger deliveries_billing_gate (tg_billing_gate_delivery ->
// private.branch_has_feature) is what makes the first half true: no row reaches the table
// without passing it, service role included. So dispatch-driver, which only ever offers,
// re-offers or resets rows that already exist, asks no entitlement question at all, while
// place-order, which creates them, asks edgeHasFeature(ent, 'delivery') for the branch.
//
// There is deliberately no "does this branch own delivery" answer in this file. The last one
// (a branch_addons row, first ANDed with the restaurant-wide grant and later not) disagreed
// with both SQL definitions of the word, and the disagreement stranded every run at a
// restaurant whose last delivering branch was switched off, and every run of a trial that
// ended without buying the add-on (review DELIV-1, DELIV-5, 2026-09-23). A trial that ended,
// a bill that lapsed and a switch turned off are the same event to a rider halfway to a
// customer, and none of them may strand the food.
//
// NOTE ON DEPLOYMENT — the Supabase CLI uploads the whole `supabase/functions`
// tree, so `../_shared/entitlements.ts` resolves. When deploying through the
// Management API / MCP, pass BOTH files with their paths relative to the
// functions dir (`_shared/entitlements.ts` + `<fn>/index.ts`) and set
// entrypoint_path to `<fn>/index.ts`.

// deno-lint-ignore-file no-explicit-any

export type FeatureKey =
  | 'card_payment'
  | 'ai_menu_import'
  | 'delivery'
  | 'ai_suite'
  | 'digital_signage'
  | 'ai_voice';

export interface EdgeEntitlements {
  restaurantId: string;
  /**
   * The branch this payload was resolved for, or null for a restaurant-wide load.
   * `delivery` is sold per branch (docs/PACKAGING-2026-09-23.md §2), so the answer
   * only means "this branch delivers" when a branch id was given.
   */
  branchId: string | null;
  planCode: string;
  status: string;
  entitled: boolean;
  entitledThrough: string | null;
  branchSeats: number;
  /**
   * What is live for this scope right now. For a branch-loaded payload `delivery` is "this
   * branch delivers today"; every other key is the restaurant's.
   */
  features: Record<string, boolean>;
}

export const DENIED: EdgeEntitlements = Object.freeze({
  restaurantId: '',
  branchId: null,
  planCode: 'none',
  status: 'none',
  entitled: false,
  entitledThrough: null,
  branchSeats: 0,
  features: Object.freeze({}) as Record<string, boolean>,
});

function parse(raw: unknown): EdgeEntitlements {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DENIED;
  const r = raw as Record<string, unknown>;

  const features: Record<string, boolean> = {};
  const f = r.features;
  if (f && typeof f === 'object' && !Array.isArray(f)) {
    for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
      if (v === true) features[k] = true;
    }
  }

  const through = typeof r.entitled_through === 'string' ? r.entitled_through : null;
  // entitled_through IS the switch — there is no boolean column and no cron to
  // wait for. `billing_entitlements` rows carry no `entitled` key, so the
  // deadline decides; a jsonb payload that says entitled:false still wins.
  const live = through !== null && Date.parse(through) > Date.now();

  return {
    restaurantId: typeof r.restaurant_id === 'string' ? r.restaurant_id : '',
    branchId: null,
    planCode: typeof r.plan_code === 'string' ? r.plan_code : 'none',
    status: typeof r.status === 'string' ? r.status : 'none',
    entitled: live && r.entitled !== false,
    entitledThrough: through,
    branchSeats: Number(r.branch_seats ?? 0) || 0,
    features,
  };
}

/** The plan every branch delivers under, whatever it has bought (packaging §2). */
const TRIAL_PLAN = 'trial';

/**
 * Does THIS branch deliver today? The one question an edge function asks before it creates
 * delivery work (place-order). Nothing that finishes existing work asks it — see the rule at
 * the top of this file.
 *
 * It mirrors private.branch_has_feature(branch, 'delivery'), the function the BEFORE INSERT
 * triggers read, so the up-front 403 and the trigger cannot disagree: the restaurant's
 * package must grant delivery at all, and then either the restaurant is on the trial (every
 * branch delivers) or this branch's branch_addons row is switched on
 * (docs/PACKAGING-2026-09-23.md §3.2). Whether billing is paid up is edgeHasFeature's
 * `entitled` test, not this one. A read that fails is a "no": an edge function may not sell
 * a delivery it cannot prove this branch offers.
 */
async function branchDeliversToday(
  admin: any,
  branchId: string,
  restaurant: EdgeEntitlements,
): Promise<boolean> {
  // billing_compute rebuilds billing_entitlements.features as the union of the subscription
  // items' feature maps, so the key is present exactly while some branch of the restaurant is
  // sold delivery (or restaurants.feature_overrides forces it on). Without it no branch may
  // sell a new delivery, whatever its own row says.
  if (restaurant.features.delivery !== true) return false;
  // The 14-day trial has everything on at every branch and buys no add-on rows, so it would
  // otherwise read as "this branch does not deliver". The SQL expresses the same rule as
  // `billing_products.trial_days > 0` for the restaurant's plan; `trial` is the only plan that
  // has trial days, and matching on the code keeps this to the one query. If a second
  // trial-bearing plan is ever added, this has to read trial_days too or the edge will refuse
  // deliveries the triggers would have allowed.
  if (restaurant.planCode === TRIAL_PLAN) return true;
  const { data, error } = await admin
    .from('branch_addons')
    .select('active')
    .eq('branch_id', branchId)
    .eq('code', 'delivery')
    .maybeSingle();
  if (error) {
    // Logged, not swallowed: the one way this happens in practice is a function deployed
    // ahead of the migration that creates branch_addons, and the symptom — delivery
    // refused everywhere at once — is otherwise indistinguishable from a billing problem.
    console.error('branch_addons_unreadable', { branch_id: branchId, message: error.message });
    return false;
  }
  return data?.active === true;
}

/**
 * Load entitlements by restaurant or branch, using the service-role client.
 *
 * Reads `public.billing_entitlements` directly rather than calling
 * get_entitlements(), because that RPC requires auth.uid() — which a
 * service-role edge function does not have.
 *
 * Pass `branchId` whenever the answer is about one branch: `delivery` is then
 * that branch's answer instead of the restaurant's. Passing BOTH ids is the
 * cheapest call — a caller that already read `branches.restaurant_id` saves the
 * lookup and still gets the per-branch answer.
 */
export async function loadEntitlements(
  admin: any,
  key: { restaurantId?: string | null; branchId?: string | null },
): Promise<EdgeEntitlements> {
  try {
    let restaurantId = key.restaurantId ?? null;

    if (!restaurantId && key.branchId) {
      const { data: b, error } = await admin
        .from('branches')
        .select('restaurant_id')
        .eq('id', key.branchId)
        .maybeSingle();
      if (error || !b?.restaurant_id) return DENIED;
      restaurantId = b.restaurant_id as string;
    }
    if (!restaurantId) return DENIED;

    const { data, error } = await admin
      .from('billing_entitlements')
      .select(
        'restaurant_id, plan_code, status, entitled_through, trial_ends_at, branch_seats, monthly_total, features, addons',
      )
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (error || !data) return DENIED;

    const ent = parse(data);
    if (!key.branchId) return ent;

    return {
      ...ent,
      branchId: key.branchId,
      features: { ...ent.features, delivery: await branchDeliversToday(admin, key.branchId, ent) },
    };
  } catch (_e) {
    return DENIED;
  }
}

/** Paid up AND the package includes the feature. */
export function edgeHasFeature(ent: EdgeEntitlements | null | undefined, key: FeatureKey): boolean {
  if (!ent || !ent.entitled) return false;
  return ent.features[key] === true;
}

/** The keys that are one answer for the whole restaurant; `delivery` is per branch. */
export type RestaurantFeatureKey = Exclude<FeatureKey, 'delivery'>;

/**
 * The package includes the feature, whether or not billing has lapsed.
 *
 * For finishing a payment the restaurant already accepted (stripe-create-payment-intent):
 * suspension blocks new work, it does not refuse money for an order taken while the account
 * was live.
 *
 * Typed to refuse `delivery` on purpose. Delivery work in flight is not an ownership question
 * at all — it is finished because the row exists (the rule at the top of this file) — and a
 * per-branch "owns delivery" here is exactly the third definition that stranded runs.
 */
export function edgeOwnsFeature(
  ent: EdgeEntitlements | null | undefined,
  key: RestaurantFeatureKey,
): boolean {
  return ent?.features[key] === true;
}

/** 402 — nothing is paid for. */
export function billingInactiveBody(scope: string) {
  return { error: 'billing_inactive', scope };
}

/** 403 — paid up, but this is not in the package. */
export function featureNotEntitledBody(feature: FeatureKey) {
  return { error: 'feature_not_entitled', feature };
}
