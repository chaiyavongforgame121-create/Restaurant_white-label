import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getMyStaffAccessRows } from '@favornoms/database/queries';
import { hasFeature, type TenantTheme } from '@favornoms/shared';
import { getBranchAccess, type BranchAccess } from '@/lib/capabilities';
import { NO_WIND_DOWN, resolveDeliveryWindDown } from '@/lib/delivery-gate';
import { branchLayoutRedirect } from '@/lib/subscription-gate';
import { PATHNAME_HEADER } from '@favornoms/database/middleware';
import { Sidebar } from '@/components/sidebar';
import { AccessDenied } from '@/components/access-denied';
import { PlatformAdminBanner } from '@/components/platform-admin-banner';
import { SubscriptionUnknownBanner } from '@/components/suspension-screen';
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
  // Signed out, the login page sends the user back to the page they asked for, not always the
  // dashboard. Only a path inside this branch is passed on.
  const pathname = (await headers()).get(PATHNAME_HEADER) ?? '';
  const { supabase, user, branch, capabilities, can, role, subscription } = await getBranchAccess(
    branchId,
    pathname.startsWith(`/b/${branchId}/`) ? pathname : `/b/${branchId}/dashboard`,
    // This layout sits over Plan & billing itself, so it decides about an ended subscription here.
    { whileLocked: 'allow' },
  );

  // Suspension, decided from the address on a full load (branchLayoutRedirect): the back office
  // goes to Plan & billing, which is never redirected (that would loop), and someone without it
  // (a server, a cook) to /suspended/<branch> rather than "No admin access", whose "Back to my
  // screen" led to the locked till again (D5). A click inside the branch does not run this layout
  // again; each page's own getBranchAccess call sends it to the same place (D1).
  const away = branchLayoutRedirect({ branchId, pathname, locked: subscription.locked, capabilities });
  if (away) redirect(away);

  // A platform superadmin opens branches from /platform to support merchants. They are
  // staff of nobody, so they hold no capabilities via staff_members -- my_capabilities()
  // grants them the owner set separately, and the flag (read with the subscription) drives the
  // impersonation banner. The viewer's own staff rows are what this render was decided from, and
  // StaffAccessWatcher reloads the page when the restaurant changes them.
  const { platformAdmin, entitlements } = subscription;
  const myRows = await getMyStaffAccessRows(supabase, user.id, branch.restaurant_id);
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
    // The watcher stays on the denied screen too: a manager made server lands here, and one
    // made manager again is let back in without having to think of reloading. (A cashier has
    // the back office since owner decision D1; each page then asks for its own capability.)
    return (
      <>
        <AccessDenied title={t('title')} reason={reason} />
        {watcher}
      </>
    );
  }

  // Sibling branches (for the switcher). The entitlements for nav gating came with the
  // subscription; a failed read of them (subscription.known false) fails the gated entries
  // closed but locks nothing, and says so (D8).
  const [{ data: allBranches }, mark] = await Promise.all([
    supabase
      .from('branches')
      .select('id, name')
      .eq('restaurant_id', branch.restaurant_id)
      .eq('is_active', true)
      .order('name'),
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

  // Delivery switched off here, but riders still out or still owed. The Live deliveries board
  // and Driver payouts deliberately stay open in that state; without this the nav dropped them
  // the instant the switch moved and the merchant had no way in but the URL. Each flag is the
  // exact rule its page locks on (resolveDeliveryWindDown), so an entry is shown precisely
  // while its screen is open. Asked only when delivery is off, so the common path pays nothing.
  // Not at all while locked: the menu then has Plan & billing alone.
  const deliveryWindDown = subscription.locked
    ? NO_WIND_DOWN
    : await resolveDeliveryWindDown(supabase, branchId, hasFeature(entitlements, 'delivery'));

  // Membership, not the claim, decides whether this is impersonation: a platform
  // admin who is also an owner here is just an owner, and banner-ing their own
  // restaurant would train them to ignore it on the tenants that matter. An ended subscription is
  // the exception: they keep the whole back office, so the banner is the only place it shows (D7).
  const impersonating = platformAdmin && role === null;
  const platformSuspended = platformAdmin && subscription.ended;

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
        deliveryWindDown={deliveryWindDown}
        capabilities={caps}
        logoUrl={mark.logoUrl}
        brandName={mark.brandName}
        locked={subscription.locked}
      />
      <main className="min-w-0 flex-1 lg:ml-0">
        {(impersonating || platformSuspended) && (
          <PlatformAdminBanner
            branchName={branch.name}
            impersonating={impersonating}
            suspended={platformSuspended}
          />
        )}
        {!subscription.known && <SubscriptionUnknownBanner className="pl-16 lg:pl-5" />}
        {children}
      </main>
      {watcher}
    </div>
  );
}
