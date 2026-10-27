import 'server-only';
import { cache } from 'react';
import { getEntitlementsForBranch, isPlatformAdmin } from '@favornoms/database/queries';
import { getServerClient } from '@favornoms/database/server';
import type { Entitlements } from '@favornoms/shared';

/**
 * What a restaurant whose subscription has ended still opens, and where everyone else is sent.
 *
 * The owner's rule: when the subscription ends, the back office shows Plan & billing and nothing
 * else. It used to be one redirect in the branch layout, which Next does not run again when a
 * merchant clicks between two pages of the same branch, so any sidebar link opened its screen as
 * normal (D1), and the kitchen board and the till's Recent and Tables screens never asked at all
 * (D3, D4). The rule now lives in getBranchAccess, which every /b, /counter and /kitchen page and
 * layout already calls, so a page cannot be reached around it.
 *
 * These gates are what people see; the database still refuses new orders on its own
 * (orders_billing_gate), whatever any screen does.
 */

export interface SubscriptionGate {
  entitlements: Entitlements;
  platformAdmin: boolean;
  /**
   * The entitlements read answered. A real payload always names its restaurant; the fail-closed
   * fallback getEntitlementsForBranch returns on any error names none. A failed read must not lock
   * a paying merchant out during a database blip (D8): it shows "couldn't check" instead.
   */
  known: boolean;
  /** The subscription has really ended (a real answer, not a failed read), whoever is looking. */
  ended: boolean;
  /** Ended, for someone it applies to. Platform admins keep full access to support the merchant. */
  locked: boolean;
}

/** Read once per request: the branch layout and its page both ask, and so do the counter's. */
export const getSubscriptionGate = cache(async (branchId: string): Promise<SubscriptionGate> => {
  const supabase = await getServerClient();
  const [entitlements, platformAdmin] = await Promise.all([
    getEntitlementsForBranch(supabase, branchId),
    isPlatformAdmin(supabase),
  ]);
  return subscriptionGateFrom(entitlements, platformAdmin);
});

export function subscriptionGateFrom(
  entitlements: Entitlements,
  platformAdmin: boolean,
): SubscriptionGate {
  const known = entitlements.restaurantId !== '';
  const ended = known && !entitlements.entitled;
  return { entitlements, platformAdmin, known, ended, locked: ended && !platformAdmin };
}

/** The order statuses the kitchen board shows: placed and not yet finished. */
export const ORDERS_IN_PROGRESS = ['pending', 'confirmed', 'preparing', 'ready'] as const;

/**
 * Recent's own window (counter/[branchId]/recent): an order placed, or booked for, within the last
 * day. Past it, an order nobody finished is not "in progress" but forgotten.
 */
const IN_PROGRESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Orders placed at this branch before the end that the screens left open can still finish: the
 * kitchen board's tickets, its booked ones, and the till sales Recent settles.
 *
 * - Within Recent's window only. Without it a forgotten ticket from last month kept the board and
 *   Recent open for as long as the subscription stayed ended, so "then it locks" never came, and
 *   so did a ready delivery no rider will take. The database refuses new orders on a locked branch
 *   (orders_billing_gate), so the window closes a day after the last order placed, or slot booked,
 *   before the end.
 * - A held booking counts. The board shows it in its Scheduled drawer and the release brings it
 *   onto the board, chime and all; a paid booking for tomorrow is exactly an order to finish.
 * - With lines, as the board shows a ticket (isOnBoard).
 * - A storefront order still waiting for its transfer slip does not count: the slip is decided on
 *   the Orders page, which is locked, and no open screen can move it on. A till sale waiting for
 *   its payment does: Recent's "Payment received" settles it.
 *
 * An unreadable answer counts as yes. This only ever keeps the kitchen board and Recent open a
 * little longer for a restaurant whose subscription has ended; reading it as no would strand a
 * kitchen mid-service over a failed query.
 */
export const branchHasOrdersInProgress = cache(async (branchId: string): Promise<boolean> => {
  const supabase = await getServerClient();
  const since = new Date(Date.now() - IN_PROGRESS_WINDOW_MS).toISOString();
  // Each .or() is its own `or` parameter, and PostgREST ANDs them.
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_items!inner(id)')
    .eq('branch_id', branchId)
    .in('status', [...ORDERS_IN_PROGRESS])
    .or(`created_at.gte.${since},scheduled_for.gte.${since}`)
    .or('awaiting_payment.eq.false,source.in.(counter,pos)')
    .limit(1);
  if (error) return true;
  return (data?.length ?? 0) > 0;
});

/**
 * What a screen does while the restaurant's subscription has ended:
 * - left out: send the person away (every back-office page, the till, the counter's Tables);
 * - 'allow': the caller decides for itself (the branch layout, Plan & billing, /suspended);
 * - 'ordersInProgress': stay open while the branch still has orders to finish, with a banner
 *   (the kitchen board and the till's Recent list, owner decision 2026-10-27), then lock.
 */
export type WhileLocked = 'allow' | 'ordersInProgress';

export const planPath = (branchId: string) => `/b/${branchId}/settings/plan`;
export const suspendedPath = (branchId: string) => `/suspended/${branchId}`;

export interface SubscriptionRedirectInput {
  branchId: string;
  locked: boolean;
  /** What the person may do at this branch (my_capabilities). */
  capabilities: ReadonlySet<string>;
  whileLocked?: WhileLocked;
  /** branchHasOrdersInProgress, asked only for 'ordersInProgress'. */
  ordersInProgress?: boolean;
}

/**
 * Where getBranchAccess sends someone away to, or null to let the screen render.
 *
 * - Someone with the back office (owner, admin, manager, cashier) goes to Plan & billing: the
 *   owner renews there, and everyone else reads "ask the owner" with the menu around them.
 * - Someone without it (server, staff, kitchen) goes to /suspended/<branch>, which says the
 *   subscription is the cause and to ask the owner. Sending them to Plan & billing ended on
 *   "No admin access", whose "Back to my screen" led to the locked till again (D5).
 * - A stranger is left to the screen's own access-denied card: whether a restaurant has paid is
 *   no business of someone who does not work there.
 */
export function subscriptionRedirect(input: SubscriptionRedirectInput): string | null {
  if (!input.locked) return null;
  if (input.capabilities.size === 0) return null;
  if (input.whileLocked === 'allow') return null;
  if (input.whileLocked === 'ordersInProgress' && input.ordersInProgress === true) return null;
  return input.capabilities.has('backoffice.access')
    ? planPath(input.branchId)
    : suspendedPath(input.branchId);
}

export interface BranchLayoutRedirectInput {
  branchId: string;
  /** The address asked for (PATHNAME_HEADER); '' when the header is missing. */
  pathname: string;
  locked: boolean;
  capabilities: ReadonlySet<string>;
}

/**
 * The branch layout's own answer: the same rule, decided from the address on a full load, so a
 * locked back office goes to Plan & billing before any page under it starts reading. Pages still
 * enforce it themselves for clicks inside the app, which do not run this layout again.
 *
 * Plan & billing itself is never redirected for someone with the back office: it is where the
 * owner renews, and sending it to itself would loop. Nor is an address this layout cannot see
 * (no header): the page under it decides then, which cannot loop either.
 */
export function branchLayoutRedirect(input: BranchLayoutRedirectInput): string | null {
  if (!input.locked || input.capabilities.size === 0) return null;
  if (!input.capabilities.has('backoffice.access')) return suspendedPath(input.branchId);
  if (!input.pathname) return null;
  const plan = planPath(input.branchId);
  if (input.pathname === plan || input.pathname.startsWith(`${plan}/`)) return null;
  return plan;
}
