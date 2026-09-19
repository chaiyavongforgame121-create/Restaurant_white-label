import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  getEntitlementsForBranch,
  getMyStaffAccessRows,
  isPlatformAdmin,
} from '@favornoms/database/queries';
import type { TenantTheme } from '@favornoms/shared';
import { getBranchAccess, type BranchAccess } from '@/lib/capabilities';
import { PATHNAME_HEADER } from '@favornoms/database/middleware';
import { Sidebar } from '@/components/sidebar';
import { AccessDenied } from '@/components/access-denied';
import { PlatformAdminBanner } from '@/components/platform-admin-banner';
import { StaffAccessWatcher } from '@/components/staff-access-watcher';

/** staff_role values with a translated name under shell.branchAccess.roles. */
const STAFF_ROLES: readonly string[] = ['owner', 'admin', 'manager', 'cashier', 'server', 'kitchen', 'staff', 'driver'];

interface Props {
  params: Promise<{ branchId: string }>;
  children: React.ReactNode;
}

/**
 * The mark the back office should wear for one branch — the admin-side twin of the
 * logoUrl resolveTenantBySlug hands the storefront header.
 *
 * Same ladder as the storefront's logo: the branch's own logo (every branch owns one since
 * 20260917150000_branch_own_identity, so two branches of one restaurant each show theirs),
 * else its brand's (the linked brand, or the restaurant's default one), plus a tier the
 * storefront does not need: the restaurant-level theme. `restaurants` has no logo column, so
 * restaurants.brand_settings.logoUrl is the only restaurant-scoped place a logo can live.
 * Nothing writes that field yet, so the tier is inert until an editor for it exists — it
 * costs nothing here because the row is already being read in parallel.
 *
 * Deliberately uncached. Branding is saved inside this very app and the Branding card
 * calls router.refresh() afterwards, so pressing "Save branding" must show the new mark
 * on the next paint; a cache window between saving and seeing it is what makes a merchant
 * upload the same file three times.
 */
async function getBranchBrandMark(
  supabase: BranchAccess['supabase'],
  branchId: string,
  restaurantId: string,
): Promise<{ logoUrl: string | null; brandName: string | null }> {
  // brand_id and the restaurant-level theme do not depend on each other, so they go
  // together; the brand row is the only forced second hop.
  const [{ data: branchRow }, { data: restaurantRow }] = await Promise.all([
    supabase.from('branches').select('brand_id, logo_url').eq('id', branchId).maybeSingle(),
    supabase.from('restaurants').select('brand_settings').eq('id', restaurantId).maybeSingle(),
  ]);

  // Linking a branch to a brand is optional and nothing prompts for it, so brand_id is
  // routinely null — the same reason the storefront falls back for its assets.
  const brandQuery = branchRow?.brand_id
    ? supabase.from('brands').select('name, logo_url').eq('id', branchRow.brand_id).maybeSingle()
    : supabase
        .from('brands')
        .select('name, logo_url')
        .eq('restaurant_id', restaurantId)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
  const { data: brand } = await brandQuery;

  // The test is the logo and not the row: an empty logo_url has to fall through, not win.
  // The brand is still read when the branch has a logo, for its name (the logo's alt text).
  if (branchRow?.logo_url) return { logoUrl: branchRow.logo_url, brandName: brand?.name ?? null };
  if (brand?.logo_url) return { logoUrl: brand.logo_url, brandName: brand.name };

  const theme = (restaurantRow?.brand_settings ?? {}) as unknown as TenantTheme;
  return { logoUrl: theme.logoUrl ?? null, brandName: theme.brandName ?? null };
}

/**
 * The branches the switcher offers: the restaurant's active branches whose back office this
 * viewer can open. It used to list every branch, so a cashier or an admin of one branch was
 * offered the other and landed on "Access denied".
 *
 * An owner (an owner row pins a branch but covers them all), the restaurant's owner_user_id and
 * a platform admin open every branch without a lookup. Anyone else is asked per candidate
 * branch through my_capabilities, the same answer the page itself gates on; the candidates
 * are the branches they have a row at, or all of them when they have a restaurant-wide row.
 */
async function openableBranches(
  supabase: BranchAccess['supabase'],
  userId: string,
  restaurantId: string,
  currentBranchId: string,
  all: Array<{ id: string; name: string }>,
  platformAdmin: boolean,
): Promise<Array<{ id: string; name: string }>> {
  if (platformAdmin || all.length === 0) return all;
  const [{ data: rows }, { data: restaurant }] = await Promise.all([
    supabase
      .from('staff_members')
      .select('role, branch_id')
      .eq('user_id', userId)
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active'),
    supabase.from('restaurants').select('owner_user_id').eq('id', restaurantId).maybeSingle(),
  ]);
  const mine = rows ?? [];
  if (restaurant?.owner_user_id === userId || mine.some((r) => r.role === 'owner')) return all;
  const restaurantWide = mine.some((r) => r.branch_id === null);
  const candidates = all.filter(
    (b) => b.id === currentBranchId || restaurantWide || mine.some((r) => r.branch_id === b.id),
  );
  const open = await Promise.all(
    candidates.map(async (b) => {
      // Already checked by the caller: this layout only renders past backoffice.access.
      if (b.id === currentBranchId) return true;
      const { data } = await supabase.rpc('my_capabilities', { p_branch_id: b.id });
      return ((data ?? []) as string[]).includes('backoffice.access');
    }),
  );
  return candidates.filter((_, i) => open[i]);
}

export default async function BranchLayout({ params, children }: Props) {
  const { branchId } = await params;
  const { supabase, user, branch, capabilities, can, role } = await getBranchAccess(
    branchId,
    `/b/${branchId}/dashboard`,
  );

  // A platform superadmin opens branches from /platform to support merchants. They are
  // staff of nobody, so they hold no capabilities via staff_members -- my_capabilities()
  // grants them the owner set separately, and this flag drives the impersonation banner.
  // The viewer's own staff rows go alongside: they are what this render was decided from, and
  // StaffAccessWatcher reloads the page when the restaurant changes them.
  const [platformAdmin, myRows] = await Promise.all([
    isPlatformAdmin(supabase),
    getMyStaffAccessRows(supabase, user.id, branch.restaurant_id),
  ]);
  const watcher = (
    <StaffAccessWatcher userId={user.id} restaurantId={branch.restaurant_id} initialRows={myRows} />
  );

  if (!can('backoffice.access')) {
    const t = await getTranslations('shell.branchAccess');
    // The role is a stored staff_role value: only a known one has a name to show.
    const reason = !role
      ? t('notStaff', { branch: branch.name })
      : STAFF_ROLES.includes(role)
        ? t('roleCannotOpen', { role: t(`roles.${role}`), branch: branch.name })
        : t('accountCannotOpen', { branch: branch.name });
    // The watcher stays on the denied screen too: a manager made cashier lands here, and one
    // made manager again is let back in without having to think of reloading.
    return (
      <>
        <AccessDenied title={t('title')} reason={reason} />
        {watcher}
      </>
    );
  }

  // Sibling branches (for the switcher) + entitlements (for nav gating and the
  // suspension gate). getEntitlementsForBranch returns DENIED on any error, so
  // a failed read locks the back office rather than opening it.
  const [{ data: allBranches }, entitlements, mark] = await Promise.all([
    supabase
      .from('branches')
      .select('id, name')
      .eq('restaurant_id', branch.restaurant_id)
      .eq('is_active', true)
      .order('name'),
    getEntitlementsForBranch(supabase, branchId),
    // The merchant's own logo, for the chrome they spend the day inside. It is uploaded
    // two screens away on /b/[branchId]/branch and until now was only ever shown to
    // customers. It joins the existing Promise.all rather than awaiting on its own,
    // because this layout sits in front of every back-office page.
    getBranchBrandMark(supabase, branchId, branch.restaurant_id),
  ]);

  const branches = await openableBranches(
    supabase,
    user.id,
    branch.restaurant_id,
    branchId,
    allBranches ?? [],
    platformAdmin,
  );

  // Suspension: lock the back office, but never the billing page itself — that
  // is where the merchant fixes it. Redirecting to a page that redirects would
  // be an infinite loop, so the exemption is load-bearing, not a nicety.
  const planPath = `/b/${branchId}/settings/plan`;
  const pathname = (await headers()).get(PATHNAME_HEADER) ?? '';
  if (!platformAdmin && !entitlements.entitled && !pathname.startsWith(planPath)) {
    redirect(`${planPath}?suspended=1`);
  }

  // Membership, not the claim, decides whether this is impersonation: a platform
  // admin who is also an owner here is just an owner, and banner-ing their own
  // restaurant would train them to ignore it on the tenants that matter.
  const impersonating = platformAdmin && role === null;

  // Nav gating is now capability-driven rather than a single owner/not-owner flag, so
  // Admin and Manager can differ from each other instead of collapsing into "not owner".
  const caps = Array.from(capabilities);

  return (
    <div className="flex min-h-dynamic-screen flex-col lg:flex-row">
      <Sidebar
        branchId={branchId}
        branchName={branch.name}
        branches={branches}
        entitlements={entitlements}
        capabilities={caps}
        logoUrl={mark.logoUrl}
        brandName={mark.brandName}
      />
      <main className="min-w-0 flex-1 lg:ml-0">
        {impersonating && <PlatformAdminBanner branchName={branch.name} />}
        {children}
      </main>
      {watcher}
    </div>
  );
}
