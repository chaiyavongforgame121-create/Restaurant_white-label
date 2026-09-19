'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleX,
  Copy,
  Link2,
  Mail,
  MessageCircle,
  PauseCircle,
  PlayCircle,
  Plus,
  Share2,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { Badge, Button, Card, EmptyState, useConfirm } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import {
  cancelStaffInvite,
  inviteStaff,
  isStaffAlreadyActiveError,
  isStaffAlreadySuspendedError,
  setStaffBranchScope,
  setStaffRole,
  setStaffStatus,
  staffInviteUrl,
  type StaffRole,
} from '@favornoms/database/queries';
import {
  assignableRoles,
  roleChangeErrorKey,
  roleChangeViewer,
  type RoleChangeViewer,
} from './role-rules';

interface StaffListItem {
  id: string;
  role: StaffRole;
  status: 'pending' | 'active' | 'suspended' | 'removed';
  invited_email: string | null;
  branch_id: string | null;
  created_at: string;
  accepted_at: string | null;
  user_id: string | null;
}

interface BranchOption {
  id: string;
  name: string;
  is_active: boolean;
}

interface Props {
  branchId: string;
  restaurantId: string;
  branchName: string;
  initialStaff: StaffListItem[];
  /** Every branch of the restaurant, hidden ones included so a member's current branch
   *  can still be named. */
  branches: BranchOption[];
  viewerIsOwner: boolean;
  /** Owner or admin of every branch: may invite someone to all branches, not only this one. */
  viewerRestaurantWide: boolean;
  /** A platform admin working as support: the owner as far as set_staff_role is concerned. */
  viewerIsPlatformAdmin: boolean;
  /** The signed-in person, whose own row offers no suspend or remove. */
  viewerUserId: string;
  /** Branches whose Staff page the viewer can open (staff.manage there). */
  staffBranchIds: string[];
}

/** Assignable roles, in descending order of access. `owner` is absent on purpose —
 *  it is created by restaurant onboarding and cannot be handed out here. The
 *  description (staff.roles.<role>.description) is what a non-technical merchant needs to
 *  pick correctly, so it names the boundary rather than listing screens. */
export type AssignableRole =
  | 'admin'
  | 'manager'
  | 'cashier'
  | 'server'
  | 'kitchen'
  | 'driver'
  | 'staff';

const roleOptions: AssignableRole[] = [
  'admin',
  'manager',
  'cashier',
  'server',
  'kitchen',
  'driver',
  'staff',
];

/** Roles with a label in staff.roleNames; anything else is shown as stored. */
const KNOWN_ROLES = new Set<string>([
  'owner',
  'admin',
  'manager',
  'cashier',
  'server',
  'kitchen',
  'driver',
  'staff',
]);

const KNOWN_STATUSES = new Set<string>(['pending', 'active', 'suspended', 'removed']);

/** Roles with a label and a one-line hint under staff.roles / staff.roleChange.hints. */
const ROLES_WITH_HINTS = new Set<string>([
  'admin',
  'manager',
  'cashier',
  'server',
  'kitchen',
  'driver',
  'staff',
]);

/** How long "Copied" stays up before the button reads "Copy" again. */
const COPIED_MS = 2000;

export function StaffView({
  branchId,
  restaurantId,
  branchName,
  initialStaff,
  branches,
  viewerIsOwner,
  viewerRestaurantWide,
  viewerIsPlatformAdmin,
  viewerUserId,
  staffBranchIds,
}: Props) {
  const t = useTranslations('staff');
  const router = useRouter();
  const [staff, setStaff] = React.useState(initialStaff);
  // router.refresh() hands down a fresh initialStaff, but useState keeps its first value, so a
  // new invitation never appeared in the list until a full reload. Take the server's list
  // whenever it changes. That list replaces local edits wholesale, so a refresh queued before a
  // later edit (an invite, then a branch access change) would put the old value back: every
  // write that changes the roster therefore refreshes too, and the last refresh to land carries
  // the last write.
  const [listFrom, setListFrom] = React.useState(initialStaff);
  if (listFrom !== initialStaff) {
    setListFrom(initialStaff);
    setStaff(initialStaff);
  }
  const [modalOpen, setModalOpen] = React.useState(false);
  // Said at page level, not on the row: the outcomes worth announcing (cancelled, already
  // joined) remove the row or turn it active, which would take a row-level message with it.
  const [notice, setNotice] = React.useState<string | null>(null);
  const noticeRef = React.useRef<HTMLParagraphElement>(null);
  // Bumped once per settled invitation. Focus moves in an effect rather than in settleInvite so
  // it lands after the row is gone and the notice already holds the new sentence to read out.
  const [settledCount, setSettledCount] = React.useState(0);
  React.useEffect(() => {
    if (settledCount > 0) noticeRef.current?.focus();
  }, [settledCount]);

  const settleInvite = (message: string, removedId?: string) => {
    setNotice(message);
    if (removedId) setStaff((prev) => prev.filter((m) => m.id !== removedId));
    // The Cancel button that had focus is removed with its row (or with the pending actions once
    // the refresh shows the member active), which drops keyboard and screen reader users back at
    // the top of the document. The notice stays put and says what happened.
    setSettledCount((n) => n + 1);
    router.refresh();
  };

  // Every branch is its own team. The roster is split three ways: this branch's people, those
  // who work at every branch (owners, whose row names the branch they signed up at, and rows
  // with no branch), and, collapsed and read-only, the teams of other branches the viewer also
  // manages (the page leaves out every other branch), each managed from its own Staff page.
  const worksEverywhere = (s: StaffListItem) => s.role === 'owner' || s.branch_id === null;
  const here = staff.filter((s) => !worksEverywhere(s) && s.branch_id === branchId);
  const everywhere = staff.filter(worksEverywhere);
  const elsewhere = staff.filter((s) => !worksEverywhere(s) && s.branch_id !== branchId);
  // The people who can work here now or once they accept; removed rows are history.
  const teamCount = [...here, ...everywhere].filter((s) => s.status !== 'removed').length;
  const branchNameOf = (id: string | null) =>
    (id && branches.find((b) => b.id === id)?.name) || t('branchAccess.oneBranch');

  const statusChanged = (member: StaffListItem, next: StaffListItem['status']) => {
    setStaff((prev) => prev.map((m) => (m.id === member.id ? { ...m, status: next } : m)));
    setNotice(
      t(`statusActions.done.${next === 'active' ? 'reactivated' : next}`, {
        email: member.invited_email ?? t('unnamed'),
      }),
    );
    router.refresh();
  };

  const roleChanged = (member: StaffListItem, next: StaffRole, changed: boolean) => {
    setStaff((prev) => prev.map((m) => (m.id === member.id ? { ...m, role: next } : m)));
    const email = member.invited_email ?? t('unnamed');
    const role = KNOWN_ROLES.has(next) ? t(`roleNames.${next}`) : next;
    setNotice(
      !changed
        ? t('roleChange.unchanged', { email, role })
        : member.user_id
          ? t('roleChange.done', { email, role })
          : t('roleChange.donePending', { email, role }),
    );
    // The list, the counts and every lock on the row are rendered from the database, so the
    // server's view is what the page should show now, not only this row's local copy.
    router.refresh();
  };

  const viewer = roleChangeViewer({
    isOwner: viewerIsOwner,
    restaurantWide: viewerRestaurantWide,
    platformAdmin: viewerIsPlatformAdmin,
    userId: viewerUserId,
  });

  const renderMember = (s: StaffListItem, readOnly: boolean) => (
    <li key={s.id}>
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
            <Mail className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate font-semibold">{s.invited_email ?? t('unnamed')}</p>
            <p className="text-xs text-muted-foreground">
              {KNOWN_ROLES.has(s.role) ? t(`roleNames.${s.role}`) : s.role}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {readOnly ? (
            // A link only where the viewer can open that branch's Staff page; anyone else
            // would land on Access denied.
            s.branch_id && staffBranchIds.includes(s.branch_id) ? (
              <Link
                href={`/b/${s.branch_id}/staff`}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                {branchNameOf(s.branch_id)}
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <span className="text-xs text-muted-foreground">{branchNameOf(s.branch_id)}</span>
            )
          ) : (
            <BranchAccess
              member={s}
              branches={branches}
              viewerIsOwner={viewerIsOwner}
              viewerRestaurantWide={viewerRestaurantWide}
              staffBranchIds={staffBranchIds}
              onChanged={(next) => {
                setStaff((prev) =>
                  prev.map((m) => (m.id === s.id ? { ...m, branch_id: next } : m)),
                );
                // Without this, a refresh still out from an earlier invite or cancel
                // would land afterwards and put the old branch back in the select.
                router.refresh();
              }}
            />
          )}
          <Badge variant={statusVariant(s.status)}>
            {KNOWN_STATUSES.has(s.status) ? t(`statuses.${s.status}`) : s.status}
          </Badge>
        </div>
        {/* Nothing here for anyone the viewer may not change (owners, their own row, admins for
            a non-owner, removed rows): the role stays plain text under the email. */}
        {!readOnly && (
          <RoleChange
            member={s}
            viewer={viewer}
            onChanged={(next, changed) => roleChanged(s, next, changed)}
          />
        )}
        {!readOnly && s.status === 'pending' && !s.user_id && (
          <PendingInviteActions
            member={s}
            viewerIsOwner={viewerIsOwner}
            viewerRestaurantWide={viewerRestaurantWide}
            onSettled={settleInvite}
          />
        )}
        {!readOnly && s.status !== 'pending' && (
          <StatusActions
            member={s}
            viewerIsOwner={viewerIsOwner}
            viewerRestaurantWide={viewerRestaurantWide}
            viewerUserId={viewerUserId}
            onChanged={(next) => statusChanged(s, next)}
          />
        )}
      </Card>
    </li>
  );

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-muted-foreground">
            {t('summary', { count: teamCount, branch: branchName })}
          </p>
        </div>
        <Button variant="gradient" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setModalOpen(true)}>
          {t('inviteStaff')}
        </Button>
      </header>

      <p
        ref={noticeRef}
        role="status"
        aria-live="polite"
        // Focusable from script only, as the landing spot after a pending row disappears.
        tabIndex={-1}
        className={
          notice ? 'mb-4 px-2 text-sm text-muted-foreground outline-none lg:px-0' : 'sr-only'
        }
      >
        {notice}
      </p>

      {here.length + everywhere.length === 0 ? (
        <EmptyState
          icon={<UserPlus className="h-7 w-7" />}
          title={t('empty.title')}
          description={t('empty.description')}
          action={
            <Button variant="gradient" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setModalOpen(true)}>
              {t('empty.action')}
            </Button>
          }
        />
      ) : (
        <div className="space-y-6 px-2 lg:px-0">
          {here.length > 0 && (
            <section>
              <h2 className="font-display text-lg font-semibold">
                {t('sections.thisBranch', { branch: branchName })}
              </h2>
              <ul className="mt-2 space-y-2">{here.map((s) => renderMember(s, false))}</ul>
            </section>
          )}
          {everywhere.length > 0 && (
            <section>
              <h2 className="font-display text-lg font-semibold">{t('sections.allBranches')}</h2>
              <p className="text-sm text-muted-foreground">{t('sections.allBranchesHint')}</p>
              <ul className="mt-2 space-y-2">{everywhere.map((s) => renderMember(s, false))}</ul>
            </section>
          )}
        </div>
      )}

      {elsewhere.length > 0 && (
        <details className="group mt-6 px-2 lg:px-0">
          <summary className="focus-ring flex cursor-pointer list-none items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground">
            <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
            {t('sections.otherBranches', { count: elsewhere.length })}
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">{t('sections.otherBranchesHint')}</p>
          <ul className="mt-2 space-y-2">{elsewhere.map((s) => renderMember(s, true))}</ul>
        </details>
      )}

      <AnimatePresence>
        {modalOpen && (
          <InviteModal
            restaurantId={restaurantId}
            branchId={branchId}
            branchName={branchName}
            canInviteEverywhere={viewerRestaurantWide}
            onClose={() => setModalOpen(false)}
            // Refresh only — the modal stays up to report which outcome happened and to hold
            // the link, because "share this link", "we emailed them" and "they already have an
            // account, so no email went out" each ask something different of the owner.
            onInvited={() => router.refresh()}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Which branches one team member can work at. Each staff row holds a single branch_id, and
 * re-inviting an active member is refused, so without this a branch-only cashier could never
 * be given the second branch. The locks and choices mirror set_staff_branch_scope: the owner
 * row is fixed, only the owner may move an admin, the viewer needs staff.manage at both the
 * branch the person leaves and the one they move to, and "All branches" (given or taken away)
 * needs restaurant-wide authority. Anything else would only end in an error.
 */
function BranchAccess({
  member,
  branches,
  viewerIsOwner,
  viewerRestaurantWide,
  staffBranchIds,
  onChanged,
}: {
  member: StaffListItem;
  branches: BranchOption[];
  viewerIsOwner: boolean;
  viewerRestaurantWide: boolean;
  /** Branches where the viewer holds staff.manage. */
  staffBranchIds: string[];
  onChanged: (branchId: string | null) => void;
}) {
  const t = useTranslations('staff');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const current = member.branch_id ? branches.find((b) => b.id === member.branch_id) : undefined;
  // Where this viewer may move the person: an open branch they manage, plus where they are now.
  const choices = branches.filter(
    (b) => b.id === member.branch_id || (b.is_active && staffBranchIds.includes(b.id)),
  );

  const lockedReason =
    member.role === 'owner'
      ? t('branchAccess.ownerLocked')
      : member.role === 'admin' && !viewerIsOwner
        ? t('branchAccess.adminLocked')
        : member.branch_id === null && !viewerRestaurantWide
          ? t('branchAccess.everyBranchLocked')
          : null;

  // Locked, or nothing to choose between: a branch admin looking at their own branch's cashier.
  if (lockedReason || (!viewerRestaurantWide && choices.length <= 1)) {
    // An owner row carries the first branch's id, but the owner reaches every branch through
    // the restaurant itself; naming that one branch here would be wrong.
    const label =
      member.role === 'owner' || !member.branch_id
        ? t('branchAccess.allBranches')
        : (current?.name ?? t('branchAccess.oneBranch'));
    return (
      <span className="text-xs text-muted-foreground" title={lockedReason ?? undefined}>
        {label}
      </span>
    );
  }

  const change = async (value: string) => {
    const next = value === '' ? null : value;
    if (next === member.branch_id) return;
    setSaving(true);
    setError(null);
    try {
      await setStaffBranchScope(getBrowserClient(), member.id, next);
      onChanged(next);
    } catch (err) {
      // set_staff_branch_scope raises plain codes; anything else is raw database text that
      // belongs in the console, not in front of the merchant.
      const message = (err as Error).message;
      if (message.includes('not_authorized')) {
        setError(t('branchAccess.errors.notAuthorized'));
      } else if (message.includes('owner_scope_fixed')) {
        setError(t('branchAccess.ownerLocked'));
      } else if (message.includes('invalid_branch')) {
        setError(t('branchAccess.errors.invalidBranch'));
      } else if (message.includes('staff_not_found')) {
        setError(t('branchAccess.errors.notFound'));
      } else if (message.includes('auth_required')) {
        setError(t('errors.signedOut'));
      } else {
        console.error('set_staff_branch_scope failed', message);
        setError(t('branchAccess.errors.generic'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        {t('branchAccess.label')}
        <select
          value={member.branch_id ?? ''}
          disabled={saving}
          onChange={(e) => void change(e.target.value)}
          className="focus-ring rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-60"
        >
          {viewerRestaurantWide && <option value="">{t('branchAccess.allBranches')}</option>}
          {choices.map((b) => (
            <option key={b.id} value={b.id}>
              {b.is_active ? b.name : t('branchAccess.hiddenBranch', { name: b.name })}
            </option>
          ))}
          {member.branch_id && !current && (
            <option value={member.branch_id}>{t('branchAccess.oneBranch')}</option>
          )}
        </select>
      </label>
      {error && (
        <p role="alert" className="max-w-xs text-right text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * What one team member can do. A role was fixed at the invitation, so turning a cashier into a
 * kitchen hand meant removing them and inviting them again. The choice is staged: nothing is
 * written until Apply, so a wrong pick in the list costs nothing. The choices are the ones
 * set_staff_role would accept from this viewer (assignableRoles), and the hint under the list
 * says what the chosen role opens. After Apply the page is refreshed from the database, and the
 * person's own open screens reload themselves (StaffAccessWatcher).
 */
function RoleChange({
  member,
  viewer,
  onChanged,
}: {
  member: StaffListItem;
  viewer: RoleChangeViewer;
  onChanged: (next: StaffRole, changed: boolean) => void;
}) {
  const t = useTranslations('staff');
  const choices = assignableRoles(member, viewer);
  const hintId = React.useId();
  const [chosen, setChosen] = React.useState<StaffRole>(member.role);
  // The refresh after Apply, or another admin's change, hands down the stored role. The staged
  // choice follows it rather than offering to apply a change that has already happened.
  const [roleFrom, setRoleFrom] = React.useState(member.role);
  if (roleFrom !== member.role) {
    setRoleFrom(member.role);
    setChosen(member.role);
  }
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Set on success and cleared by the next pick, so "Changed" never outlives what it describes.
  const [applied, setApplied] = React.useState(false);
  if (!choices) return null;
  const email = member.invited_email ?? t('unnamed');
  // A driver stays listed as a driver until someone changes it; driver is never offered otherwise.
  const options: StaffRole[] = (choices as StaffRole[]).includes(member.role)
    ? choices
    : [member.role, ...choices];
  const dirty = chosen !== member.role;

  const apply = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { changed } = await setStaffRole(getBrowserClient(), member.id, chosen);
      setApplied(true);
      onChanged(chosen, changed);
    } catch (err) {
      const message = (err as Error).message;
      const key = roleChangeErrorKey(message);
      if (key === 'generic') console.error('set_staff_role failed', message);
      setError(key === 'signedOut' ? t('errors.signedOut') : t(`roleChange.errors.${key}`));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('roleChange.label')}
          <select
            value={chosen}
            disabled={saving}
            // Every row has this list; the name says whose role it is. It starts with the
            // visible word, so voice control still finds it.
            aria-label={t('roleChange.selectFor', { email })}
            aria-describedby={hintId}
            onChange={(e) => {
              setChosen(e.target.value as StaffRole);
              setError(null);
              setApplied(false);
            }}
            className="focus-ring rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-60"
          >
            {options.map((r) => (
              <option key={r} value={r}>
                {ROLES_WITH_HINTS.has(r) ? t(`roles.${r}.label`) : r}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="soft"
          size="sm"
          aria-label={t('roleChange.applyFor', { email })}
          disabled={!dirty}
          loading={saving}
          onClick={() => void apply()}
        >
          {t('roleChange.apply')}
        </Button>
        {applied && !dirty && (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <Check className="h-3.5 w-3.5" aria-hidden />
            {t('roleChange.applied')}
          </span>
        )}
      </div>
      {ROLES_WITH_HINTS.has(chosen) && (
        <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">
          {t(`roleChange.hints.${chosen}`)}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Copy or take back an invitation nobody has claimed yet. Invitations are shared as links now
 * (LINE, chat) rather than mailed, so the owner needs the link again later, and a way to withdraw
 * one sent to the wrong address. cancel_staff_invite enforces who may cancel (staff.manage at
 * the invitation's branch, restaurant-wide authority for one to every branch, the owner for an
 * admin's); Cancel is only offered where it would succeed.
 */
function PendingInviteActions({
  member,
  viewerIsOwner,
  viewerRestaurantWide,
  onSettled,
}: {
  member: StaffListItem;
  viewerIsOwner: boolean;
  /** Owner or admin of every branch: the only people who may withdraw an invitation to every branch. */
  viewerRestaurantWide: boolean;
  /** The invitation is gone or already used: say so, drop the row when gone, refresh. */
  onSettled: (message: string, removedId?: string) => void;
}) {
  const t = useTranslations('staff');
  const confirm = useConfirm();
  const [copied, flagCopied] = useCopiedFlag();
  // Shown only when both copy routes failed, so the link can still be copied by hand.
  const [manualUrl, setManualUrl] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const email = member.invited_email ?? t('unnamed');
  const canCancel =
    (member.role !== 'admin' || viewerIsOwner) && (member.branch_id !== null || viewerRestaurantWide);
  const fieldId = React.useId();

  const copy = async () => {
    setError(null);
    const url = staffInviteUrl(window.location.origin, member.id);
    if (await copyText(url)) {
      setManualUrl(null);
      flagCopied();
    } else {
      setManualUrl(url);
    }
  };

  const cancel = async () => {
    setError(null);
    const ok = await confirm({
      title: t('pendingInvite.cancelDialog.title', { email }),
      body: t('pendingInvite.cancelDialog.body'),
      confirmLabel: t('pendingInvite.cancelDialog.confirm'),
      cancelLabel: t('pendingInvite.cancelDialog.keep'),
      destructive: true,
    });
    if (!ok) return;
    setCancelling(true);
    try {
      await cancelStaffInvite(getBrowserClient(), member.id);
      onSettled(t('pendingInvite.cancelled', { email }), member.id);
    } catch (err) {
      // cancel_staff_invite raises plain codes; anything else is raw database text for the console.
      const message = (err as Error).message;
      if (message.includes('invite_not_found')) {
        // Cancelled from another tab, or by another admin: what the owner wanted has happened.
        onSettled(t('pendingInvite.alreadyCancelled', { email }), member.id);
      } else if (message.includes('invite_not_pending')) {
        // They opened the link in the meantime; the refresh shows them as active.
        onSettled(t('pendingInvite.alreadyJoined', { email }));
      } else if (message.includes('not_authorized')) {
        setError(t('pendingInvite.errors.notAuthorized'));
      } else if (message.includes('sign_in_required')) {
        setError(t('errors.signedOut'));
      } else {
        console.error('cancel_staff_invite failed', message);
        setError(t('pendingInvite.errors.generic'));
      }
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="w-full border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Every pending row has the same two buttons, so a screen reader's list of buttons
            would read "Copy invite link" over and over; the name says whose invitation it is.
            It keeps the visible words at the start so voice control still matches them, and
            stays put while "Link copied" shows, since the status line below announces that. */}
        <Button
          type="button"
          variant="soft"
          size="sm"
          aria-label={t('pendingInvite.copyLinkFor', { email })}
          leftIcon={copied ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
          onClick={() => void copy()}
        >
          {copied ? t('pendingInvite.copied') : t('pendingInvite.copyLink')}
        </Button>
        {canCancel && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('pendingInvite.cancelFor', { email })}
            leftIcon={<CircleX className="h-4 w-4" />}
            loading={cancelling}
            onClick={() => void cancel()}
          >
            {t('pendingInvite.cancel')}
          </Button>
        )}
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? t('pendingInvite.copied') : ''}
        </span>
      </div>
      {manualUrl && (
        <div className="mt-2">
          <label htmlFor={fieldId} className="mb-1 block text-xs text-muted-foreground">
            {t('pendingInvite.copyFailed')}
          </label>
          <input
            id={fieldId}
            readOnly
            autoFocus
            value={manualUrl}
            dir="ltr"
            onFocus={(e) => e.currentTarget.select()}
            className="focus-ring w-full rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs"
          />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Suspend, reactivate or remove a team member. There was no way to take access away from the
 * back office at all. set_staff_status decides who may (staff.manage where the row works); the
 * buttons only hide what it would refuse: the owner row, an admin row for a non-owner, a row for
 * every branch unless the viewer's own authority is restaurant-wide, and your own row. Suspended
 * keeps the row and can be undone; removed is final, and the person is invited again to come back.
 */
function StatusActions({
  member,
  viewerIsOwner,
  viewerRestaurantWide,
  viewerUserId,
  onChanged,
}: {
  member: StaffListItem;
  viewerIsOwner: boolean;
  /** Owner or admin of every branch: the only people set_staff_status lets change a row with no branch. */
  viewerRestaurantWide: boolean;
  viewerUserId: string;
  onChanged: (next: StaffListItem['status']) => void;
}) {
  const t = useTranslations('staff');
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState<StaffListItem['status'] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const email = member.invited_email ?? t('unnamed');

  if (member.status === 'removed') {
    return <p className="w-full text-xs text-muted-foreground">{t('statusActions.removedHint')}</p>;
  }
  const locked =
    member.role === 'owner' ||
    (member.role === 'admin' && !viewerIsOwner) ||
    (member.branch_id === null && !viewerRestaurantWide) ||
    (member.user_id !== null && member.user_id === viewerUserId);
  if (locked) return null;

  const run = async (next: 'active' | 'suspended' | 'removed') => {
    setError(null);
    if (next !== 'active') {
      const ok = await confirm({
        title: t(`statusActions.${next === 'removed' ? 'removeDialog' : 'suspendDialog'}.title`, { email }),
        body: t(`statusActions.${next === 'removed' ? 'removeDialog' : 'suspendDialog'}.body`),
        confirmLabel: t(`statusActions.${next === 'removed' ? 'remove' : 'suspend'}`),
        cancelLabel: t('statusActions.keep'),
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(next);
    try {
      await setStaffStatus(getBrowserClient(), member.id, next);
      onChanged(next);
    } catch (err) {
      // set_staff_status raises plain codes; anything else is raw database text for the console.
      const message = (err as Error).message;
      if (message.includes('last_owner')) {
        setError(t('statusActions.errors.lastOwner'));
      } else if (message.includes('cannot_change_self')) {
        setError(t('statusActions.errors.self'));
      } else if (message.includes('not_authorized')) {
        setError(t('statusActions.errors.notAuthorized'));
      } else if (message.includes('staff_removed')) {
        setError(t('statusActions.removedHint'));
      } else if (message.includes('staff_not_found')) {
        setError(t('branchAccess.errors.notFound'));
      } else if (message.includes('sign_in_required')) {
        setError(t('errors.signedOut'));
      } else {
        console.error('set_staff_status failed', message);
        setError(t('statusActions.errors.generic'));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="w-full border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {member.status === 'suspended' ? (
          <Button
            type="button"
            variant="soft"
            size="sm"
            aria-label={t('statusActions.reactivateFor', { email })}
            leftIcon={<PlayCircle className="h-4 w-4" />}
            loading={busy === 'active'}
            disabled={busy !== null}
            onClick={() => void run('active')}
          >
            {t('statusActions.reactivate')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('statusActions.suspendFor', { email })}
            leftIcon={<PauseCircle className="h-4 w-4" />}
            loading={busy === 'suspended'}
            disabled={busy !== null}
            onClick={() => void run('suspended')}
          >
            {t('statusActions.suspend')}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('statusActions.removeFor', { email })}
          leftIcon={<UserMinus className="h-4 w-4" />}
          loading={busy === 'removed'}
          disabled={busy !== null}
          onClick={() => void run('removed')}
        >
          {t('statusActions.remove')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function statusVariant(s: string): 'success' | 'warning' | 'muted' | 'danger' {
  if (s === 'active') return 'success';
  if (s === 'pending') return 'warning';
  if (s === 'removed' || s === 'suspended') return 'danger';
  return 'muted';
}

/** A "Copied" flag that turns itself off, and does not fire after the button is gone. */
function useCopiedFlag(): [boolean, () => void] {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flag = React.useCallback(() => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, []);
  return [copied, flag];
}

/**
 * Puts text on the clipboard. navigator.clipboard is missing on plain http (a LAN address
 * during setup) and in some in-app browsers, and can refuse without a recent gesture, so fall
 * back to selecting the text and execCommand('copy'). `field` is the visible input holding the
 * text, which stays selected if both fail; without one a hidden textarea stands in. Resolves
 * false when nothing worked, so the caller can leave the link where it can be copied by hand.
 */
async function copyText(text: string, field?: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection route */
  }
  const previous = document.activeElement as HTMLElement | null;
  let stand: HTMLTextAreaElement | null = null;
  try {
    let target: HTMLInputElement | HTMLTextAreaElement | null = field ?? null;
    if (!target) {
      stand = document.createElement('textarea');
      stand.value = text;
      stand.setAttribute('readonly', '');
      stand.style.position = 'fixed';
      stand.style.top = '0';
      stand.style.opacity = '0';
      document.body.appendChild(stand);
      target = stand;
    }
    target.focus();
    target.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (stand) {
      stand.remove();
      // The stand-in took focus from the button; hand it back so keyboard users stay in place.
      previous?.focus();
    }
  }
}

/** 'existingAccount': an email invitation to an address that already has an account. No email
 *  goes out and the member stays pending until they open the link and join, so the owner needs
 *  the link just as much as after 'link'. */
type InviteResult = { kind: 'link' | 'sent' | 'existingAccount'; email: string; url: string };

function InviteModal({
  restaurantId,
  branchId,
  branchName,
  canInviteEverywhere,
  onClose,
  onInvited,
}: {
  restaurantId: string;
  branchId: string;
  branchName: string;
  /** invite-staff refuses an all-branches invitation from an admin of one branch. */
  canInviteEverywhere: boolean;
  onClose: () => void;
  onInvited: () => void;
}) {
  const t = useTranslations('staff');
  const titleId = React.useId();
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<AssignableRole>('cashier');
  const [scope, setScope] = React.useState<'branch' | 'restaurant'>('branch');
  // Links are the default: Supabase's built-in mailer sends about two emails an hour and only
  // to the project's own team, so an emailed invitation fails for real staff until the
  // platform connects its own mail service. There is no per-restaurant email setting, which is
  // why the hint under the checkbox points at the link rather than at a setup step.
  const [sendEmail, setSendEmail] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<InviteResult | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    // Held for the result view: the field could be edited while the request is out.
    const invitedEmail = email.trim();
    try {
      const supabase = getBrowserClient();
      const res = await inviteStaff(supabase, {
        email: invitedEmail,
        role,
        restaurant_id: restaurantId,
        branch_id: scope === 'branch' || !canInviteEverywhere ? branchId : null,
        delivery: sendEmail ? 'email' : 'link',
      });
      // Built here rather than taken from accept_url, exactly as the pending row's "Copy invite
      // link" builds it. accept_url comes from the function's PUBLIC_ADMIN_URL secret, which can
      // name a different host than the back office the owner is using (a preview, a LAN
      // address), and two different links for one invitation make people wonder which is real.
      const url = staffInviteUrl(window.location.origin, res.staff_id);
      setSubmitting(false);
      setResult({
        kind: res.delivery === 'link' ? 'link' : res.emailed ? 'sent' : 'existingAccount',
        email: invitedEmail,
        url,
      });
      onInvited();
    } catch (err) {
      // invite-staff keeps one row per restaurant and email, so inviting someone already on
      // the team (usually to give them a second branch) came back as a raw
      // "invite_staff_failed:409:..." with no way forward shown. The edge function answers
      // with error codes; anything unrecognised is logged and shown as a generic failure.
      const message = (err as Error).message;
      const emailRefused = message.includes('rate_limited') || message.includes('email_failed');
      if (isStaffAlreadyActiveError(err)) {
        setError(t('invite.errors.alreadyActive', { email: invitedEmail, branch: branchName }));
      } else if (isStaffAlreadySuspendedError(err)) {
        setError(t('invite.errors.alreadySuspended', { email: invitedEmail, branch: branchName }));
      } else if (message.includes('branch_not_in_restaurant')) {
        setError(t('invite.errors.branchNotInRestaurant'));
      } else if (message.includes('branch_scoped_inviter')) {
        setError(t('invite.errors.ownBranchOnly', { branch: branchName }));
      } else if (emailRefused && sendEmail) {
        // The pending row was saved before the send was tried, so the invitation exists; only
        // the email did not go. A link reaches them without any mailer, so point there.
        console.error('invite-staff email failed', message);
        setError(t('invite.errors.emailNotSent', { email: invitedEmail }));
        onInvited();
      } else if (message.includes('rate_limited')) {
        setError(t('invite.errors.rateLimited'));
      } else if (message.includes('only the owner')) {
        setError(t('invite.errors.onlyOwnerAdmin'));
      } else if (message.includes('"forbidden"')) {
        setError(t('invite.errors.notAllowed'));
      } else if (message.includes('not_authenticated') || message.includes('"unauthorized"')) {
        setError(t('errors.signedOut'));
      } else if (message.includes('email_failed')) {
        console.error('invite-staff failed', message);
        setError(t('invite.errors.emailFailed'));
      } else {
        console.error('invite-staff failed', message);
        setError(t('invite.errors.generic'));
      }
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[120] grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 10, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-6 shadow-2xl"
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="font-display text-xl font-bold">
            {t('invite.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('invite.close')}
            className="focus-ring rounded-full p-1.5 hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* The result sits outside the <form>, so none of its buttons (Copy, Share, Done) can
            submit the invitation a second time. */}
        {result ? (
          <div className="py-2 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
            {result.kind === 'link' ? (
              <>
                <p className="mt-3 font-display text-lg font-semibold">{t('invite.linkReadyTitle')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t.rich('invite.linkReadyBody', {
                    email: result.email,
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
              </>
            ) : result.kind === 'sent' ? (
              <>
                <p className="mt-3 font-display text-lg font-semibold">{t('invite.sentTitle')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t.rich('invite.sentBody', {
                    email: result.email,
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
              </>
            ) : (
              <>
                <p className="mt-3 font-display text-lg font-semibold">
                  {t('invite.existingAccountTitle')}
                </p>
                {/* The owner asked for an email and none went out. invite-staff no longer puts
                    an existing account on the team without their say, so nothing happens until
                    this person opens the link: saying "added" or "invitation sent" here would
                    leave the owner waiting for a join that needs them to pass the link on. */}
                <p className="mt-1 text-sm text-muted-foreground">
                  {t.rich('invite.existingAccountBody', {
                    email: result.email,
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
              </>
            )}
            <InviteLinkPanel
              url={result.url}
              email={result.email}
              hint={result.kind === 'sent' ? t('invite.link.emailFallback') : undefined}
            />
            <Button type="button" variant="ghost" className="mt-5" fullWidth onClick={onClose}>
              {t('invite.done')}
            </Button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">{t('invite.email')}</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  placeholder="cashier@example.com"
                  className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium">{t('invite.role')}</span>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as typeof role)}
                  className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
                >
                  {roleOptions.map((value) => (
                    <option key={value} value={value}>
                      {t(`roles.${value}.label`)}
                    </option>
                  ))}
                </select>
                {/* Naming what the role can and cannot do at the point of choosing is the
                    difference between a considered decision and everyone being made a
                    manager. */}
                <span className="mt-1.5 block text-xs text-muted-foreground">
                  {t(`roles.${role}.description`)}
                </span>
              </label>

              <fieldset className="space-y-2">
                <legend className="mb-1 block text-sm font-medium">{t('invite.scope')}</legend>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
                  <input
                    type="radio"
                    name="scope"
                    value="branch"
                    checked={scope === 'branch'}
                    onChange={() => setScope('branch')}
                    className="mt-1"
                  />
                  <div>
                    <p className="text-sm font-semibold">{t('invite.thisBranch')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('invite.thisBranchHint', { branch: branchName })}
                    </p>
                  </div>
                </label>
                {/* An admin of one branch can invite into that branch only (invite-staff). */}
                {canInviteEverywhere && (
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
                    <input
                      type="radio"
                      name="scope"
                      value="restaurant"
                      checked={scope === 'restaurant'}
                      onChange={() => setScope('restaurant')}
                      className="mt-1"
                    />
                    <div>
                      <p className="text-sm font-semibold">{t('invite.allBranches')}</p>
                      <p className="text-xs text-muted-foreground">{t('invite.allBranchesHint')}</p>
                    </div>
                  </label>
                )}
              </fieldset>

              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
                <input
                  type="checkbox"
                  checked={sendEmail}
                  onChange={(e) => setSendEmail(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <p className="text-sm font-semibold">{t('invite.alsoEmail')}</p>
                  <p className="text-xs text-muted-foreground">{t('invite.alsoEmailHint')}</p>
                </div>
              </label>

              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
            </div>

            <footer className="mt-5 flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose} fullWidth>
                {t('invite.cancel')}
              </Button>
              <Button type="submit" variant="gradient" fullWidth loading={submitting}>
                {sendEmail ? t('invite.send') : t('invite.createLink')}
              </Button>
            </footer>
          </form>
        )}
      </motion.div>
    </motion.div>
  );
}

/**
 * The invitation link, ready to hand over. Most staff are reached over LINE rather than email,
 * so sharing there is one tap; the link itself carries no access (the accept page checks the
 * signed-in, confirmed email against the invited address), which is what makes chat safe.
 */
function InviteLinkPanel({ url, email, hint }: { url: string; email: string; hint?: string }) {
  const t = useTranslations('staff');
  const fieldId = React.useId();
  const fieldRef = React.useRef<HTMLInputElement>(null);
  const [copied, flagCopied] = useCopiedFlag();
  const [copyFailed, setCopyFailed] = React.useState(false);
  // navigator.share exists on phones and a few desktop browsers; read after mount so the
  // button never appears where it would do nothing.
  const [canShare, setCanShare] = React.useState(false);
  React.useEffect(() => {
    setCanShare(typeof navigator.share === 'function');
  }, []);

  const shareText = t('invite.link.shareText', { email });

  const copy = async () => {
    const ok = await copyText(url, fieldRef.current);
    setCopyFailed(!ok);
    if (ok) flagCopied();
  };

  const share = async () => {
    try {
      await navigator.share({ text: shareText, url });
    } catch {
      /* closing the share sheet rejects with AbortError; nothing to report */
    }
  };

  return (
    <div className="mt-5 text-left">
      <label htmlFor={fieldId} className="mb-1 block text-sm font-medium">
        {t('invite.link.label')}
      </label>
      {hint && <p className="mb-2 text-xs text-muted-foreground">{hint}</p>}
      <div className="flex gap-2">
        <input
          id={fieldId}
          ref={fieldRef}
          readOnly
          value={url}
          dir="ltr"
          onFocus={(e) => e.currentTarget.select()}
          className="focus-ring min-w-0 flex-1 rounded-xl border border-border bg-muted/40 px-3 py-2 font-mono text-xs"
        />
        <Button
          type="button"
          variant="soft"
          autoFocus
          leftIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          onClick={() => void copy()}
        >
          {copied ? t('invite.link.copied') : t('invite.link.copy')}
        </Button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t('invite.link.copied') : ''}
      </span>
      {copyFailed && <p className="mt-1 text-xs text-danger">{t('invite.link.copyFailed')}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {/* LINE's own green (#06C755) under white text is about 2.3:1, well short of the 4.5:1
            AA asks for. #047A36 still reads as LINE green at 5.5:1, and hover goes darker
            (#03662D, 7.1:1) rather than brighter, so it never dips below that. */}
        <a
          href={`https://line.me/R/share?text=${encodeURIComponent(`${shareText}\n${url}`)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring inline-flex h-11 min-h-touch flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] bg-[#047A36] px-4 text-sm font-medium text-white transition-colors hover:bg-[#03662D]"
        >
          <MessageCircle className="h-4 w-4" aria-hidden />
          {t('invite.link.shareLine')}
        </a>
        {canShare && (
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            leftIcon={<Share2 className="h-4 w-4" />}
            onClick={() => void share()}
          >
            {t('invite.link.share')}
          </Button>
        )}
      </div>
    </div>
  );
}
