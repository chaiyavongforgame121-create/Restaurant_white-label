import { getTranslations } from 'next-intl/server';
import { Clock, Lock } from 'lucide-react';
import {
  getBillingOverview,
  getPendingBillingRequest,
  listBillingProducts,
} from '@favornoms/database/queries';
import { isValidTimeZone, type BillingPaidState } from '@favornoms/shared';
import { Card } from '@favornoms/ui';
import { getBranchAccess } from '@/lib/capabilities';
import { branchHasOrdersInProgress } from '@/lib/subscription-gate';
import { SidebarLockSync } from '@/components/sidebar';
import { CheckAgainButton, LockedAutoRefresh, StillOpenLinks } from '@/components/suspension-screen';
import { readCheckoutReturn, readPortalReturn } from './_components/plan-billing';
import { fallbackOverview, type PlanBranch } from './_components/plan-model';
import { PlanView, type DecidedRequest } from './_components/plan-view';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{
    /** 'success' | 'cancelled': Stripe Checkout sending the merchant back. */
    checkout?: string;
    /** The Checkout Session, on the success URL only ({CHECKOUT_SESSION_ID}). */
    session_id?: string;
    /** 'return': Stripe's customer portal sending the merchant back. */
    portal?: string;
    no_trial?: string;
    renew?: string;
  }>;
}

export async function generateMetadata() {
  const t = await getTranslations('settings.plan');
  return { title: t('metaTitle') };
}

/**
 * When the catalog was last repriced: the one plan of docs/PACKAGING-2026-10-24.md replaced
 * the per-branch delivery add-on and every earlier price. A request filed before it was priced
 * in dollars that no longer exist, and its total on today's page reads as today's price for
 * the same branches. Such a decision is history, not news, so the banner leaves it out. (It
 * was 2026-09-23, the retirement of the all-monthly catalog, until this repricing.)
 */
const REPRICED_AT_MS = Date.parse('2026-10-24T00:00:00Z');

/**
 * get_latest_billing_decision returns to_jsonb of a billing_requests row, or null. It is read
 * as unknown because the RPC is not in the generated types, so every field is checked here
 * rather than trusted.
 */
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
  return {
    id,
    status,
    planCode,
    branchSeats: Math.max(1, Math.trunc(Number(r.branch_seats) || 1)),
    monthlyTotal: Number(r.monthly_total ?? 0),
    // A row written before the packaging migration has no one-time total, and 0 is the
    // truth for it: nothing one-time was ever charged under the old all-monthly model.
    oneTimeTotal: Number(r.one_time_total ?? 0),
    decisionNote: typeof note === 'string' && note.trim() !== '' ? note : null,
    decidedAt,
    // Settled by a card payment (billing_settle_stripe_request), not decided by the team: its
    // decision_note is the settlement's own "Paid by card (Stripe)", which is no note to the
    // merchant. Paid is also the truer word than "approved" for money the owner just paid.
    paidByCard: status === 'approved' && r.rail === 'stripe',
  };
}

// This page is the escape hatch: while the subscription has ended it is the one screen the back
// office opens (getBranchAccess sends every other page here, and the menu lists nothing else), so
// it asks to handle the lock itself rather than be sent to itself.
export default async function PlanPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const query = await searchParams;
  const { supabase, branch, can, subscription } = await getBranchAccess(
    branchId,
    `/b/${branchId}/settings/plan`,
    { whileLocked: 'allow' },
  );
  // The menu around this page may have been rendered before the deadline passed, or before a
  // renewal: a click inside the branch does not render the layout again.
  const lockSync = <SidebarLockSync locked={subscription.locked} />;

  // Whoever holds billing.manage in public.role_capabilities — today the owner alone. It is
  // the same question request_package_change, validate_billing_discount and
  // get_billing_overview ask (private.user_can_manage_billing), and the one the sidebar asks
  // before it shows this page (except while suspended, when it is the menu's only entry). An
  // admin used to be let through here as well, on the theory that the RPC accepted them; it no
  // longer does, so the builder would only have produced a submit the server refuses. Everyone
  // else with the back office still lands on this page whenever the store is suspended and
  // reads PlanNotYours instead.
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

  // The till, the dashboard and sign-in send everyone with the back office here while locked, the
  // owner included, so while orders placed before the end are still being finished the screens
  // that stay open for them are offered on this page too. In an owner-only restaurant the owner's
  // account is the till and the kitchen tablet, and an installed app has no address bar to type
  // /kitchen into.
  const kitchen = can('kitchen.access');
  const recent = can('counter.access');
  const ordersOpen =
    subscription.locked && (kitchen || recent) ? await branchHasOrdersInProgress(branchId) : false;
  const stillOpen = ordersOpen ? { branchId, kitchen, recent } : null;

  if (!canManageBilling) {
    // A failed read is not "inactive" (D8): the card then says who manages the package instead.
    return (
      <>
        <PlanNotYours inactive={subscription.ended} branchName={branch.name} stillOpen={stillOpen} />
        {lockSync}
      </>
    );
  }

  // get_latest_billing_decision is not in the generated types yet — thin typed escape.
  const rpcAny = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  // Read on its own as well as inside the overview (it came with the subscription gate, once per
  // request): this RPC predates get_billing_overview and answers even when that one cannot, and
  // whether the store is suspended is what decides the whole page. Everything this page reads from
  // it (seats, branches used, the deadline) is restaurant-wide in both payloads.
  const { entitlements } = subscription;
  const [overview, catalog, pendingRequest, decidedRes] = await Promise.all([
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
  // Suspended only on a real answer, and the same answer the menu was locked by. A failed read
  // used to put "Your account is not active" in front of an owner who may well be paid up; the
  // layout says "couldn't check" instead (D8).
  const suspended = subscription.known
    ? subscription.ended
    : overviewOk && !overview.entitlements.entitled;

  return (
    <>
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
        suspended={suspended}
        noTrial={query.no_trial === '1'}
        renew={query.renew === '1'}
        // How the restaurant pays. The denied overview carries MANUAL_RAIL (card billing off), so
        // a failed read keeps today's manual page rather than guessing that a card is on file.
        billing={overview.billing}
        checkoutReturn={readCheckoutReturn(query.checkout, query.session_id)}
        portalReturn={readPortalReturn(query.portal)}
        stillOpen={stillOpen}
      />
      {lockSync}
    </>
  );
}

/**
 * What a manager, cashier or anyone else without billing rights sees. The suspension
 * redirect sends every back-office role here, and an AccessDenied card with a Sign out button reads
 * as "your account is broken" to a cashier whose only real problem is an unpaid package.
 * While inactive it can ask again: the owner renews elsewhere, and nothing tells this screen.
 */
async function PlanNotYours({
  inactive,
  branchName,
  stillOpen,
}: {
  inactive: boolean;
  branchName: string;
  /** The screens still open for orders placed before the end, or null. */
  stillOpen: { branchId: string; kitchen: boolean; recent: boolean } | null;
}) {
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
          {inactive && stillOpen && <StillOpenLinks {...stillOpen} className="mt-3" />}
          {inactive && <CheckAgainButton size="sm" className="mt-3" />}
        </div>
      </Card>
      {/* Nothing on this card can be typed into, so it asks again by itself: the owner's renewal
          unlocks the menu, and a booking released onto the board brings up its link. */}
      {inactive && <LockedAutoRefresh />}
    </div>
  );
}
