import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getEntitlementsForBranch, isPlatformAdmin } from '@favornoms/database/queries';
import type { TenantTheme } from '@favornoms/shared';
import { getBranchAccess, type BranchAccess } from '@/lib/capabilities';
import { PATHNAME_HEADER } from '@favornoms/database/middleware';
import { Sidebar } from '@/components/sidebar';
import { AccessDenied } from '@/components/access-denied';
import { PlatformAdminBanner } from '@/components/platform-admin-banner';

interface Props {
  params: Promise<{ branchId: string }>;
  children: React.ReactNode;
}

/**
 * The mark the back office should wear for one branch — the admin-side twin of the
 * logoUrl resolveTenantBySlug hands the storefront header.
 *
 * Same ladder as the storefront's asset fallback (the branch's own brand, else the
 * restaurant's default brand), plus a tier the storefront does not need: the
 * restaurant-level theme. `restaurants` has no logo column, so
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
    supabase.from('branches').select('brand_id').eq('id', branchId).maybeSingle(),
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

  // A brands row exists for almost everyone once the Branding card has saved once, so the
  // test is the logo and not the row: an empty logo_url has to fall through, not win.
  if (brand?.logo_url) return { logoUrl: brand.logo_url, brandName: brand.name };

  const theme = (restaurantRow?.brand_settings ?? {}) as unknown as TenantTheme;
  return { logoUrl: theme.logoUrl ?? null, brandName: theme.brandName ?? null };
}

export default async function BranchLayout({ params, children }: Props) {
  const { branchId } = await params;
  const { supabase, branch, capabilities, can, role } = await getBranchAccess(
    branchId,
    `/b/${branchId}/dashboard`,
  );

  // A platform superadmin opens branches from /platform to support merchants. They are
  // staff of nobody, so they hold no capabilities via staff_members -- my_capabilities()
  // grants them the owner set separately, and this flag drives the impersonation banner.
  const platformAdmin = await isPlatformAdmin(supabase);

  if (!can('backoffice.access')) {
    return (
      <AccessDenied
        title="No admin access"
        reason={
          role
            ? `A ${role} account cannot open the back office for ${branch.name}. Your work is on the counter or kitchen screen.`
            : `Your account isn't a member of staff at ${branch.name}.`
        }
      />
    );
  }

  // Sibling branches (for the switcher) + entitlements (for nav gating and the
  // suspension gate). getEntitlementsForBranch returns DENIED on any error, so
  // a failed read locks the back office rather than opening it.
  const [{ data: branches }, entitlements, mark] = await Promise.all([
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
        branches={branches ?? []}
        entitlements={entitlements}
        capabilities={caps}
        logoUrl={mark.logoUrl}
        brandName={mark.brandName}
      />
      <main className="flex-1 lg:ml-0">
        {impersonating && <PlatformAdminBanner branchName={branch.name} />}
        {children}
      </main>
    </div>
  );
}
