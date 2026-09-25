// What the Card payments card says about a branch's Stripe account, in plain words. Pure, so the
// wording rules are tested without a browser; the card itself only renders what these return.

/** The columns of branch_payment_accounts the card reads. */
export interface CardAccountState {
  stripe_account_id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements_due: string[];
  disabled_reason: string | null;
}

/**
 * not_connected: no account.
 * onboarding:    Stripe's form was not finished ("Finish setting up").
 * under_review:  everything was sent and Stripe is checking; nothing for the owner to do.
 * ready:         diners can pay by card.
 * action_needed: Stripe wants something, or has stopped the account.
 */
export type CardPaymentsStatus = 'not_connected' | 'onboarding' | 'under_review' | 'ready' | 'action_needed';

/** Reasons Stripe gives while it is still looking at the account, with nothing for the owner to do. */
const REVIEW_REASONS = new Set(['requirements.pending_verification', 'under_review', 'listed']);

export function cardPaymentsStatus(account: CardAccountState | null | undefined): CardPaymentsStatus {
  if (!account) return 'not_connected';
  const due = account.requirements_due ?? [];
  if (!account.details_submitted) return 'onboarding';
  if (account.charges_enabled) return due.length > 0 ? 'action_needed' : 'ready';
  if (due.length > 0) return 'action_needed';
  if (account.disabled_reason && !REVIEW_REASONS.has(account.disabled_reason)) return 'action_needed';
  return 'under_review';
}

export type DisabledReason = 'rejected' | 'review' | 'pastDue' | 'paused' | 'other';

/** Stripe's requirements.disabled_reason, grouped into what the owner can be told. */
export function disabledReasonKey(reason: string | null | undefined): DisabledReason | null {
  if (!reason) return null;
  if (reason.startsWith('rejected')) return 'rejected';
  if (REVIEW_REASONS.has(reason)) return 'review';
  if (reason === 'requirements.past_due') return 'pastDue';
  if (reason === 'platform_paused') return 'paused';
  return 'other';
}

/**
 * The red "Stripe has paused card payments" box, or null when there is none to show.
 *
 * Not while the owner is still in Stripe's form ('onboarding'). An account that has not finished
 * the form normally carries disabled_reason requirements.past_due, which is simply Stripe's way of
 * saying the details it needs for card payments are missing; nothing was ever switched on or is
 * overdue, and "Finish setting up" already says what to do (the requirement list is hidden then
 * for the same reason). The other reasons tell the owner to open the Stripe Dashboard, whose button
 * is hidden while onboarding too. A rejection is final whatever state the account is in, so it is
 * always shown. Never on a ready account, and never for a review, which is not a problem.
 */
export function disabledNotice(account: CardAccountState | null | undefined): DisabledReason | null {
  const reason = disabledReasonKey(account?.disabled_reason);
  if (!reason || reason === 'review') return null;
  if (reason === 'rejected') return reason;
  const status = cardPaymentsStatus(account);
  return status === 'onboarding' || status === 'ready' ? null : reason;
}

export type RequirementGroup = 'bank' | 'people' | 'business' | 'profile' | 'terms' | 'other';

const GROUP_ORDER: RequirementGroup[] = ['bank', 'people', 'business', 'profile', 'terms', 'other'];

/**
 * Stripe names requirements by field path (external_account, individual.verification.document,
 * company.tax_id, ...). An owner needs to know which part of Stripe's form to open, not the path,
 * so they are grouped into a handful of plain-word lines, each once, in the order Stripe's form
 * asks for them.
 */
export function requirementGroups(requirements: readonly string[] | null | undefined): RequirementGroup[] {
  const found = new Set<RequirementGroup>();
  for (const raw of requirements ?? []) {
    const r = raw.trim();
    if (!r) continue;
    if (r === 'external_account' || r.startsWith('external_account.')) found.add('bank');
    else if (/^(individual|representative|owners|directors|executives|relationship|person_)/.test(r)) found.add('people');
    else if (r.startsWith('company.')) found.add('business');
    else if (r.startsWith('business_profile.') || r === 'business_type') found.add('profile');
    else if (r.startsWith('tos_acceptance.')) found.add('terms');
    else found.add('other');
  }
  return GROUP_ORDER.filter((g) => found.has(g));
}

export interface ShareOption {
  accountId: string;
  /** The first branch paid into it; the button posts this one. */
  sourceBranchId: string;
  branchNames: string[];
}

/**
 * The accounts another branch of this restaurant is already paid into, one choice per account
 * (two branches sharing one account are one choice, named after both). Only ready or in-review
 * accounts are offered: copying an unfinished account would only copy its unfinished setup, and
 * copying one Stripe rejected or wants more from would point this branch's diners at an account
 * that cannot take their cards.
 */
export function shareOptions(
  accounts: ReadonlyArray<CardAccountState & { branch_id: string; branch_name: string }>,
  currentBranchId: string,
): ShareOption[] {
  const byAccount = new Map<string, ShareOption>();
  for (const a of accounts) {
    if (a.branch_id === currentBranchId) continue;
    const status = cardPaymentsStatus(a);
    if (status !== 'ready' && status !== 'under_review') continue;
    if (disabledReasonKey(a.disabled_reason) === 'rejected') continue;
    const existing = byAccount.get(a.stripe_account_id);
    if (existing) existing.branchNames.push(a.branch_name);
    else byAccount.set(a.stripe_account_id, { accountId: a.stripe_account_id, sourceBranchId: a.branch_id, branchNames: [a.branch_name] });
  }
  return [...byAccount.values()];
}

/** The other branches paid into this branch's account, for "this account also pays ...". */
export function sharedWith(
  accounts: ReadonlyArray<{ branch_id: string; branch_name: string; stripe_account_id: string }>,
  current: { branch_id: string; stripe_account_id: string } | null,
): string[] {
  if (!current) return [];
  return accounts
    .filter((a) => a.branch_id !== current.branch_id && a.stripe_account_id === current.stripe_account_id)
    .map((a) => a.branch_name);
}

/** The ?stripe= value Stripe's onboarding sends the owner back with. */
export function stripeReturnParam(search: string): 'return' | 'refresh' | null {
  const v = new URLSearchParams(search).get('stripe');
  return v === 'return' || v === 'refresh' ? v : null;
}

/** The same URL without ?stripe=, so a reload does not repeat the return handling. */
export function withoutStripeParam(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete('stripe');
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

/** An edge-function error code, as a key under branchOps.cardPayments.errors. */
export function connectErrorKey(code: string | null | undefined): string {
  switch (code) {
    case 'forbidden':
      return 'errors.forbidden';
    case 'already_connected':
      return 'errors.alreadyConnected';
    case 'source_not_connected':
      return 'errors.sourceNotConnected';
    case 'other_restaurant':
      return 'errors.otherRestaurant';
    case 'not_connected':
      return 'errors.notConnected';
    case 'admin_url_not_configured':
      return 'errors.adminUrl';
    // Stripe itself answered no (the account or its onboarding link was refused). It is not
    // "nothing changed": the function stores a new account before it asks for the link, so a
    // refused link can leave an account behind. Nor is it always worth retrying at once (a platform
    // not yet set up for Accounts v2 refuses every time), so the words point to support too.
    case 'stripe_error':
      return 'errors.stripeRefused';
    default:
      return 'errors.generic';
  }
}
