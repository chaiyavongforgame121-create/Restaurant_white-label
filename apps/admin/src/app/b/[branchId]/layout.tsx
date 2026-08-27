import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getEntitlementsForBranch, isPlatformAdmin } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { PATHNAME_HEADER } from '@favornoms/database/middleware';
import { Sidebar } from '@/components/sidebar';
import { AccessDenied } from '@/components/access-denied';
import { PlatformAdminBanner } from '@/components/platform-admin-banner';

interface Props {
  params: Promise<{ branchId: string }>;
  children: React.ReactNode;
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
  const [{ data: branches }, entitlements] = await Promise.all([
    supabase
      .from('branches')
      .select('id, name')
      .eq('restaurant_id', branch.restaurant_id)
      .eq('is_active', true)
      .order('name'),
    getEntitlementsForBranch(supabase, branchId),
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
      />
      <main className="flex-1 lg:ml-0">
        {impersonating && <PlatformAdminBanner branchName={branch.name} />}
        {children}
      </main>
    </div>
  );
}
