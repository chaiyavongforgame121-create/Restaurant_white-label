import { getTranslations } from 'next-intl/server';
import { Clock, Lock } from 'lucide-react';
import {
  getBillingOverview,
  getEntitlementsForBranch,
  getPendingBillingRequest,
  listBillingProducts,
} from '@favornoms/database/queries';
import {
  ADDON_DELIVERY,
  isValidTimeZone,
  type BillingPaidState,
  type BillingProduct,
} from '@favornoms/shared';
import { Card } from '@favornoms/ui';
import { getBranchAccess } from '@/lib/capabilities';
import { fallbackOverview, type PlanBranch } from './_components/plan-model';
import { PlanView, type DecidedRequest } from './_components/plan-view';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{
    suspended?: string;
    checkout?: string;
    add?: string;
    branch?: string;
    no_trial?: string;
    renew?: string;
  }>;
}

export async function generateMetadata() {
  const t = await getTranslations('settings.plan');
  return { title: t('metaTitle') };
}

/**
 * `?add=` arrives from an upsell card, which may only know its own title ("Delivery"), so
 * it is matched against the catalog code and the product name alike. Delivery is the only
 * thing left to add — the AI Suite was withdrawn on 2026-09-23 — so this answers yes or no
 * rather than returning a code: anything else in the query string adds nothing.
 */
function wantsDelivery(raw: string | undefined, catalog: BillingProduct[]): boolean {
  if (!raw) return false;
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const wanted = slug(raw);
  const delivery = catalog.find((p) => p.code === ADDON_DELIVERY && p.kind === 'addon');
  if (!delivery) return false;
  return wanted === delivery.code || slug(delivery.name) === wanted;
}

/**
 * get_latest_billing_decision returns to_jsonb of a billing_requests row, or null. It is read
 * as unknown because the RPC is not in the generated types, so every field is checked here
 * rather than trusted.
 */
/**
 * When the all-monthly catalog was retired (docs/PACKAGING-2026-09-23.md). A request filed
 * before it was priced in dollars that no longer exist: Coastal Grill's last one reads
 * "3 branches, no delivery — $397 every month", which on today's page looks like today's
 * price. Such a decision is history, not news, so the banner leaves it out.
 */
const REPRICED_AT_MS = Date.parse('2026-09-23T00:00:00Z');

function readDecision(raw: unknown): DecidedRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const filedMs = typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN;
  if (Number.isFinite(filedMs) && filedMs < REPRICED_AT_MS) return null;
  const status = r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected' : null;
  const id = r.id;
  const planCode = r.plan_code;
  const decided = r.decided_at;
  const created = r.created_at;
  const decidedAt =
    typeof decided === 'string' ? decided : typeof created === 'string' ? created : null;
  if (!status || typeof id !== 'string' || typeof planCode !== 'string' || !decidedAt) return null;
  const note = r.decision_note;
  const delivery = r.delivery_branch_ids;
  return {
    id,
    status,
    planCode,
    branchSeats: Math.max(1, Math.trunc(Number(r.branch_seats) || 1)),
    deliveryBranchIds: Array.isArray(delivery)
      ? delivery.filter((b): b is string => typeof b === 'string')
      : [],
    monthlyTotal: Number(r.monthly_total ?? 0),
    // A row written before the packaging migration has no one-time total, and 0 is the
    // truth for it: nothing one-time was ever charged under the old all-monthly model.
    oneTimeTotal: Number(r.one_time_total ?? 0),
    decisionNote: typeof note === 'string' && note.trim() !== '' ? note : null,
    decidedAt,
  };
}

// This page is the escape hatch: the branch layout skips its suspension
// redirect for exactly this path, so a lapsed merchant can always reach it.
export default async function PlanPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const query = await searchParams;
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/settings/plan`);

  // Whoever holds billing.manage in public.role_capabilities — today the owner alone. It is
  // the same question request_package_change, validate_billing_discount and
  // get_billing_overview ask (private.user_can_manage_billing), and the one the sidebar asks
  // before it shows this page. An admin used to be let through here as well, on the theory
  // that the RPC accepted them; it no longer does, so the builder would only have produced a
  // submit the server refuses. Everyone else still lands on this page whenever the store is
  // suspended (the layout sends every user here) and reads PlanNotYours instead.
  const canManageBilling = can('billing.manage');

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

  const [entitlements, overview, catalog, pendingRequest, decidedRes] = await Promise.all([
    // Read on its own as well as inside the overview: this RPC predates get_billing_overview
    // and answers even when that one cannot, and whether the store is suspended is what
    // decides the whole page. Everything this page reads from it (seats, branches used, the
    // delivering branches, the deadline) is restaurant-wide in both payloads.
    getEntitlementsForBranch(supabase, branchId),
    getBillingOverview(supabase, branch.restaurant_id),
    listBillingProducts(supabase),
    getPendingBillingRequest(supabase, branch.restaurant_id),
    // Only the pending request used to be read, so a rejection simply made the banner
    // vanish and the platform owner's note never reached the merchant. It goes through the
    // RPC because billing_requests has no table grant for signed-in users: a direct select
    // fails with permission denied and the banner would never appear. A failed read costs
    // the merchant that note, not the page, so its error is not surfaced.
    rpcAny('get_latest_billing_decision', { p_restaurant_id: branch.restaurant_id }),
  ]);

  // A successful overview always carries the restaurant it was asked about; the denied
  // value carries an empty id. That is the one signal that separates "nothing is bought"
  // from "we could not read what is bought".
  const overviewOk = overview.entitlements.restaurantId === branch.restaurant_id;

  let branches: PlanBranch[] = overview.branches;
  let paid: BillingPaidState = overview.paid;
  if (!overviewOk) {
    const { data: rows } = await supabase
      .from('branches')
      .select('id, name')
      .eq('restaurant_id', branch.restaurant_id)
      .eq('is_active', true)
      .order('created_at', { ascending: true });
    ({ branches, paid } = fallbackOverview(entitlements, rows ?? []));
  }

  const latestDecision = decidedRes.error ? null : readDecision(decidedRes.data);
  const preselect = typeof query.branch === 'string' ? query.branch : null;

  return (
    <PlanView
      branchId={branchId}
      restaurantId={branch.restaurant_id}
      entitlements={overviewOk ? overview.entitlements : entitlements}
      catalog={catalog}
      branches={branches}
      paid={paid}
      pendingRequest={pendingRequest}
      latestDecision={latestDecision}
      timezone={timezone}
      suspended={!entitlements.entitled}
      addDelivery={wantsDelivery(query.add, catalog)}
      // Only a branch of this restaurant may be pre-selected; the view drops anything else.
      preselectBranchId={branches.some((b) => b.id === preselect) ? preselect : null}
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
async function PlanNotYours({ inactive, branchName }: { inactive: boolean; branchName: string }) {
  const t = await getTranslations('settings.plan');
  return (
    <div className="container max-w-2xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0 lg:pl-0">
        <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
      </header>
      <Card className="flex items-start gap-3 p-5">
        {inactive ? (
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        ) : (
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        )}
        <div className="text-sm">
          <p className="font-semibold">
            {inactive ? t('notYours.inactiveTitle') : t('notYours.lockedTitle')}
          </p>
          <p className="mt-1 text-muted-foreground">
            {inactive
              ? t('notYours.inactiveBody', { branch: branchName })
              : t('notYours.lockedBody', { branch: branchName })}
          </p>
        </div>
      </Card>
    </div>
  );
}
