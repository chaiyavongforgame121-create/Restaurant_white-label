import { Clock, Lock } from 'lucide-react';
import {
  getEntitlementsForBranch,
  getPendingBillingRequest,
  listBillingProducts,
} from '@favornoms/database/queries';
import { isValidTimeZone, type BillingProduct } from '@favornoms/shared';
import { Card } from '@favornoms/ui';
import { getBranchAccess } from '@/lib/capabilities';
import { PlanView, type DecidedRequest } from './_components/plan-view';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{
    suspended?: string;
    checkout?: string;
    add?: string;
    no_trial?: string;
    renew?: string;
  }>;
}

export const metadata = { title: 'Plan & billing · Favornoms' };

/**
 * `?add=` arrives from an upsell card, which may only know its own title ("Delivery"),
 * so it is matched against the catalog code and the product name alike. Anything that
 * is not a live add-on is dropped: pre-ticking a code the catalog does not sell would
 * price a line the server then refuses.
 */
function resolveAddon(raw: string | undefined, catalog: BillingProduct[]): string | null {
  if (!raw) return null;
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const wanted = slug(raw);
  const match = catalog.find(
    (p) => p.kind === 'addon' && (p.code === wanted || slug(p.name) === wanted),
  );
  return match?.code ?? null;
}

/**
 * get_latest_billing_decision returns to_jsonb of a billing_requests row, or null. It is read
 * as unknown because the RPC is not in the generated types, so every field is checked here
 * rather than trusted.
 */
function readDecision(raw: unknown): DecidedRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const status = r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected' : null;
  const id = r.id;
  const planCode = r.plan_code;
  const decided = r.decided_at;
  const created = r.created_at;
  const decidedAt =
    typeof decided === 'string' ? decided : typeof created === 'string' ? created : null;
  if (!status || typeof id !== 'string' || typeof planCode !== 'string' || !decidedAt) return null;
  const note = r.decision_note;
  const addons = r.addons;
  return {
    id,
    status,
    planCode,
    addons: Array.isArray(addons) ? addons.filter((a): a is string => typeof a === 'string') : [],
    branchSeats: Math.max(1, Math.trunc(Number(r.branch_seats) || 1)),
    monthlyTotal: Number(r.monthly_total ?? 0),
    decisionNote: typeof note === 'string' && note.trim() !== '' ? note : null,
    decidedAt,
  };
}

// This page is the escape hatch: the branch layout skips its suspension
// redirect for exactly this path, so a lapsed merchant can always reach it.
export default async function PlanPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const query = await searchParams;
  const { supabase, branch, can, role } = await getBranchAccess(
    branchId,
    `/b/${branchId}/settings/plan`,
  );

  // The matrix gives billing.manage to the owner only, but request_package_change
  // accepts the owner's admin as well, so an admin is let through here too. Everyone
  // else still lands on this page whenever the store is suspended (the layout sends
  // every user here), and used to get a package builder whose submit the server refused.
  const canManageBilling = can('billing.manage') || role === 'admin';

  const { data: branchRow } = await supabase
    .from('branches')
    .select('timezone')
    .eq('id', branchId)
    .maybeSingle();
  const timezone =
    branchRow?.timezone && isValidTimeZone(branchRow.timezone)
      ? branchRow.timezone
      : 'America/New_York';

  if (!canManageBilling) {
    const entitlements = await getEntitlementsForBranch(supabase, branchId);
    return <PlanNotYours inactive={!entitlements.entitled} branchName={branch.name} />;
  }

  // get_latest_billing_decision is not in the generated types yet — thin typed escape.
  const rpcAny = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  const [entitlements, catalog, pendingRequest, decidedRes] = await Promise.all([
    getEntitlementsForBranch(supabase, branchId),
    listBillingProducts(supabase),
    getPendingBillingRequest(supabase, branch.restaurant_id),
    // Only the pending request used to be read, so a rejection simply made the banner
    // vanish and the platform owner's note never reached the merchant. It goes through the
    // RPC because billing_requests has no table grant for signed-in users: a direct select
    // fails with permission denied and the banner would never appear. A failed read costs
    // the merchant that note, not the page, so its error is not surfaced.
    rpcAny('get_latest_billing_decision', { p_restaurant_id: branch.restaurant_id }),
  ]);

  const latestDecision = decidedRes.error ? null : readDecision(decidedRes.data);

  return (
    <PlanView
      branchId={branchId}
      restaurantId={branch.restaurant_id}
      entitlements={entitlements}
      catalog={catalog}
      pendingRequest={pendingRequest}
      latestDecision={latestDecision}
      timezone={timezone}
      suspended={!entitlements.entitled}
      preselectAddon={resolveAddon(query.add, catalog)}
      noTrial={query.no_trial === '1'}
      renew={query.renew === '1'}
    />
  );
}

/**
 * What a manager, cashier or anyone else without billing rights sees. The suspension
 * redirect sends every role here, and an AccessDenied card with a Sign out button reads
 * as "your account is broken" to a cashier whose only real problem is an unpaid package.
 */
function PlanNotYours({ inactive, branchName }: { inactive: boolean; branchName: string }) {
  return (
    <div className="container max-w-2xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0 lg:pl-0">
        <h1 className="font-display text-3xl font-bold">Plan &amp; billing</h1>
      </header>
      <Card className="flex items-start gap-3 p-5">
        {inactive ? (
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        ) : (
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        )}
        <div className="text-sm">
          <p className="font-semibold">
            {inactive
              ? 'Your restaurant’s package is inactive — ask the owner'
              : 'Only the owner or an admin can change the package'}
          </p>
          <p className="mt-1 text-muted-foreground">
            {inactive
              ? `The storefront and back office for ${branchName} are paused until the restaurant owner or an admin chooses a package. Nothing has been deleted, and your work comes back as soon as it is active again.`
              : `${branchName}'s package is managed by the restaurant owner. Ask them if you need a feature that is not switched on.`}
          </p>
        </div>
      </Card>
    </div>
  );
}
