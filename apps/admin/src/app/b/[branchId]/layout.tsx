import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { getEntitlementsForBranch, isPlatformAdmin } from '@favornoms/database/queries';
import { PATHNAME_HEADER } from '@favornoms/database/middleware';
import { Sidebar } from '@/components/sidebar';
import { AccessDenied } from '@/components/access-denied';
import { PlatformAdminBanner } from '@/components/platform-admin-banner';

const ADMIN_ROLES = ['owner', 'manager'] as const;

interface Props {
  params: Promise<{ branchId: string }>;
  children: React.ReactNode;
}

export default async function BranchLayout({ params, children }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect(`/login?next=${encodeURIComponent(`/b/${branchId}/dashboard`)}`);
  }

  const { data: branch } = await supabase
    .from('branches')
    .select('id, restaurant_id, name')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();

  // A platform superadmin opens branches from /platform to support merchants.
  // They are staff of nobody and their tenants are frequently the lapsed ones,
  // so both gates below would fire on exactly the branches they need to reach.
  // Neither read depends on the other, so they go together — this sits in front
  // of every page in the back office and a serial round trip is paid by all.
  const [platformAdmin, { data: membership }] = await Promise.all([
    isPlatformAdmin(supabase),
    supabase
      .from('staff_members')
      .select('id, role, branch_id')
      .eq('user_id', userData.user.id)
      .eq('restaurant_id', branch.restaurant_id)
      .eq('status', 'active')
      .in('role', [...ADMIN_ROLES])
      .or(`branch_id.eq.${branchId},branch_id.is.null`)
      .maybeSingle(),
  ]);

  if (!membership && !platformAdmin) {
    return (
      <AccessDenied
        title="No admin access"
        reason={`Your account isn't an owner or manager of ${branch.name}.`}
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
  const impersonating = platformAdmin && !membership;

  return (
    <div className="flex min-h-dynamic-screen flex-col lg:flex-row">
      <Sidebar
        branchId={branchId}
        branchName={branch.name}
        branches={branches ?? []}
        entitlements={entitlements}
      />
      <main className="flex-1 lg:ml-0">
        {impersonating && <PlatformAdminBanner branchName={branch.name} />}
        {children}
      </main>
    </div>
  );
}
