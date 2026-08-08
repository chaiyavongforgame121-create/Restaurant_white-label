import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { listBillingProducts, listRestaurantSubscriptions } from '@favornoms/database/queries';
import { PlatformAccessDenied } from './_components/platform-nav';
import { PlatformDashboard } from './_components/platform-dashboard';
import type { BranchClosureLite, BranchLite, TenantRow } from './_components/tenant-health';

export default async function PlatformPage() {
  const supabase = await getServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/platform');

  const { data: summary, error } = await supabase.rpc('platform_ops_summary');
  if (error) return <PlatformAccessDenied />;

  // billing_entitlements is granted to service_role only, so the entitlement
  // truth cannot be selected even by a superadmin — it has to come through this
  // SECURITY DEFINER RPC. It also returns every restaurant, uncapped.
  const subRows = await listRestaurantSubscriptions(supabase);
  const ids = subRows.map((r) => r.restaurant_id);
  const nowIso = new Date().toISOString();

  // Scope the child reads to the rows actually being rendered, so the result
  // sets are consistent by construction instead of by four limits.
  const [restaurantsRes, branchesRes, subsRes, catalog] = await Promise.all([
    supabase.from('restaurants').select('id, franchise_group_id, loyalty_scope').in('id', ids),
    // The closure filters are on the EMBEDDED resource, so they prune the child
    // rows to the window that is open right now without dropping the branch.
    supabase
      .from('branches')
      .select(
        `id, restaurant_id, name, slug, is_active, settings, timezone, entitled_through, custom_domain,
         branch_hours(day_of_week),
         branch_closures(starts_at, ends_at, reason)`,
      )
      .in('restaurant_id', ids)
      .lte('branch_closures.starts_at', nowIso)
      .gte('branch_closures.ends_at', nowIso)
      .order('name', { ascending: true }),
    // Only for cancel_at_period_end — entitlements_json does not expose it.
    supabase.from('subscriptions').select('restaurant_id, cancel_at_period_end').in('restaurant_id', ids),
    listBillingProducts(supabase),
  ]);

  const meta = new Map((restaurantsRes.data ?? []).map((r) => [r.id, r]));
  const subs = new Map((subsRes.data ?? []).map((s) => [s.restaurant_id, s]));

  // Narrow the jsonb and the hours array server-side: shipping every branch's
  // full settings blob and weekly schedule to the browser for two booleans would
  // be a large, pointless payload.
  const branches: BranchLite[] = (branchesRes.data ?? []).map((b) => ({
    id: b.id,
    restaurant_id: b.restaurant_id,
    name: b.name,
    slug: b.slug,
    is_active: b.is_active,
    orders_paused: readOrdersPaused(b.settings),
    entitled_through: b.entitled_through,
    timezone: b.timezone,
    custom_domain: b.custom_domain,
    has_hours: (b.branch_hours ?? []).length > 0,
    closure: firstClosure(b.branch_closures),
  }));

  const rows: TenantRow[] = subRows.map((row) => ({
    id: row.restaurant_id,
    name: row.restaurant_name,
    slug: row.restaurant_slug,
    createdAt: row.created_at,
    ent: row.entitlements,
    franchise: Boolean(meta.get(row.restaurant_id)?.franchise_group_id),
    loyaltyScope: meta.get(row.restaurant_id)?.loyalty_scope ?? 'branch',
    cancelAtPeriodEnd: subs.get(row.restaurant_id)?.cancel_at_period_end === true,
  }));

  // A discarded `.error` turns "the read was denied" into "this tenant has no
  // branches" — the single most misleading thing this page could say, because a
  // dark tenant then renders as the healthiest row on the screen. Name the
  // failure and let the dashboard warn on it.
  const failed = [
    restaurantsRes.error && 'restaurant metadata',
    branchesRes.error && 'branches',
    subsRes.error && 'subscription flags',
  ].filter((v): v is string => typeof v === 'string');

  return (
    <PlatformDashboard
      summary={summary as Record<string, number>}
      rows={rows}
      branches={branches}
      nowMs={Date.now()}
      catalog={catalog}
      siteBase={(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000').replace(/\/$/, '')}
      loadError={failed.length > 0 ? `Could not load ${failed.join(', ')}.` : null}
    />
  );
}

// One branch stores `false`, another omits the key entirely — both mean "not
// paused", so only an explicit `true` counts.
function readOrdersPaused(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  return (settings as Record<string, unknown>).orders_paused === true;
}

function firstClosure(rows: BranchClosureLite[] | null): BranchClosureLite | null {
  const c = (rows ?? [])[0];
  return c ? { starts_at: c.starts_at, ends_at: c.ends_at, reason: c.reason } : null;
}
