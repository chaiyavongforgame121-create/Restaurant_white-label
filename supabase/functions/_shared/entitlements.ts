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
  planCode: string;
  status: string;
  entitled: boolean;
  entitledThrough: string | null;
  branchSeats: number;
  features: Record<string, boolean>;
}

export const DENIED: EdgeEntitlements = Object.freeze({
  restaurantId: '',
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
    planCode: typeof r.plan_code === 'string' ? r.plan_code : 'none',
    status: typeof r.status === 'string' ? r.status : 'none',
    entitled: live && r.entitled !== false,
    entitledThrough: through,
    branchSeats: Number(r.branch_seats ?? 0) || 0,
    features,
  };
}

/**
 * Load entitlements by restaurant or branch, using the service-role client.
 *
 * Reads `public.billing_entitlements` directly rather than calling
 * get_entitlements(), because that RPC requires auth.uid() — which a
 * service-role edge function does not have.
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

    return parse(data);
  } catch (_e) {
    return DENIED;
  }
}

/** Paid up AND the package includes the feature. */
export function edgeHasFeature(ent: EdgeEntitlements | null | undefined, key: FeatureKey): boolean {
  if (!ent || !ent.entitled) return false;
  return ent.features[key] === true;
}

/**
 * Owns the feature regardless of whether billing has lapsed.
 *
 * Used by dispatch-driver: an order accepted while the account was live must
 * still reach a rider after suspension. Suspension blocks NEW work, it does not
 * strand food that is already cooked.
 */
export function edgeOwnsFeature(ent: EdgeEntitlements | null | undefined, key: FeatureKey): boolean {
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
