import type { DriverApproval, DriverApprovalStatus } from '@favornoms/database/queries';
import { intlLocaleFor, type UiLocale } from '@favornoms/shared';

// The rider-facing vocabulary for a driver_approvals row. Two surfaces on this screen have
// to agree on it — the applications list at the top and the restaurant cards below it — so
// it lives in one place rather than being re-typed per branch of a ternary. The words
// themselves are in the `onboarding` catalogue, keyed by status
// (`apply.status.{status}` for the badge, `apply.explanation.{status}` for the line under it).

/**
 * @favornoms/ui Badge variant per status. `pending` is `info`, not `warning`: waiting for
 * a decision and being paused by the restaurant are opposite outcomes, and they used to
 * render as the same amber pill. The admin side already separates them.
 */
export const APPLICATION_BADGE_VARIANT: Record<
  DriverApprovalStatus,
  'success' | 'warning' | 'danger' | 'info'
> = {
  pending: 'info',
  approved: 'success',
  rejected: 'danger',
  suspended: 'warning',
};

export type ApplicationAction = 'withdraw' | 'reapply' | 'none';

/** What the rider may do next. `approved` and `suspended` are the merchant's to change. */
export function applicationAction(status: DriverApprovalStatus): ApplicationAction {
  if (status === 'pending') return 'withdraw';
  if (status === 'rejected') return 'reapply';
  return 'none';
}

/**
 * Days a rejected rider waits before applying again. The merchant's queue orders by
 * applied_at desc, so an uncapped re-apply lets a rejected rider sit at the top of it as
 * often as they like. Mirrors the `interval '7 days'` guard in driver_reapply_to_branch —
 * change one and you must change the other.
 */
export const REAPPLY_COOLDOWN_DAYS = 7;

const DAY_MS = 86_400_000;

/** When the rejected application becomes re-appliable, or null if it already is. */
export function reapplyAvailableAt(a: DriverApproval, now = Date.now()): Date | null {
  if (a.status !== 'rejected' || !a.reviewed_at) return null;
  const until = new Date(a.reviewed_at).getTime() + REAPPLY_COOLDOWN_DAYS * DAY_MS;
  return until > now ? new Date(until) : null;
}

/** Anything the rider must act on first; settled approvals last. */
const SORT_RANK: Record<DriverApprovalStatus, number> = {
  rejected: 0,
  pending: 1,
  suspended: 2,
  approved: 3,
};

export function compareApplications(a: DriverApproval, b: DriverApproval): number {
  const rank = SORT_RANK[a.status] - SORT_RANK[b.status];
  if (rank !== 0) return rank;
  return new Date(b.applied_at).getTime() - new Date(a.applied_at).getTime();
}

/** Short, absolute date — riders compare "applied" against "decided", so no relative fuzz. */
export function formatApplicationDate(when: string | Date, locale: UiLocale): string {
  const d = typeof when === 'string' ? new Date(when) : when;
  return d.toLocaleDateString(intlLocaleFor(locale), { day: 'numeric', month: 'short' });
}
