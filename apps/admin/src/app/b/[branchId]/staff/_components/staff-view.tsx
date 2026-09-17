'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Check,
  CheckCircle2,
  CircleX,
  Copy,
  Link2,
  Mail,
  MessageCircle,
  Plus,
  Share2,
  UserPlus,
  X,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, useConfirm } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import {
  cancelStaffInvite,
  inviteStaff,
  isStaffAlreadyActiveError,
  setStaffBranchScope,
  staffInviteUrl,
  type StaffRole,
} from '@favornoms/database/queries';

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

/** How long "Copied" stays up before the button reads "Copy" again. */
const COPIED_MS = 2000;

export function StaffView({
  branchId,
  restaurantId,
  branchName,
  initialStaff,
  branches,
  viewerIsOwner,
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

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-muted-foreground">
            {t('summary', { count: staff.length, branch: branchName })}
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

      {staff.length === 0 ? (
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
        <ul className="space-y-2 px-2 lg:px-0">
          {staff.map((s) => (
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
                  <BranchAccess
                    member={s}
                    branches={branches}
                    viewerIsOwner={viewerIsOwner}
                    onChanged={(next) => {
                      setStaff((prev) =>
                        prev.map((m) => (m.id === s.id ? { ...m, branch_id: next } : m)),
                      );
                      // Without this, a refresh still out from an earlier invite or cancel
                      // would land afterwards and put the old branch back in the select.
                      router.refresh();
                    }}
                  />
                  <Badge variant={statusVariant(s.status)}>
                    {KNOWN_STATUSES.has(s.status) ? t(`statuses.${s.status}`) : s.status}
                  </Badge>
                </div>
                {s.status === 'pending' && !s.user_id && (
                  <PendingInviteActions
                    member={s}
                    viewerIsOwner={viewerIsOwner}
                    onSettled={settleInvite}
                  />
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <AnimatePresence>
        {modalOpen && (
          <InviteModal
            restaurantId={restaurantId}
            branchId={branchId}
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
 * be given the second branch. The locks mirror set_staff_branch_scope: the owner row is
 * fixed, and only the owner may move an admin.
 */
function BranchAccess({
  member,
  branches,
  viewerIsOwner,
  onChanged,
}: {
  member: StaffListItem;
  branches: BranchOption[];
  viewerIsOwner: boolean;
  onChanged: (branchId: string | null) => void;
}) {
  const t = useTranslations('staff');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const current = member.branch_id ? branches.find((b) => b.id === member.branch_id) : undefined;

  const lockedReason =
    member.role === 'owner'
      ? t('branchAccess.ownerLocked')
      : member.role === 'admin' && !viewerIsOwner
        ? t('branchAccess.adminLocked')
        : null;

  if (lockedReason) {
    // An owner row carries the first branch's id, but the owner reaches every branch through
    // the restaurant itself; naming that one branch here would be wrong.
    const label =
      member.role === 'owner' || !member.branch_id
        ? t('branchAccess.allBranches')
        : (current?.name ?? t('branchAccess.oneBranch'));
    return (
      <span className="text-xs text-muted-foreground" title={lockedReason}>
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
          <option value="">{t('branchAccess.allBranches')}</option>
          {branches
            .filter((b) => b.is_active || b.id === member.branch_id)
            .map((b) => (
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
 * Copy or take back an invitation nobody has claimed yet. Invitations are shared as links now
 * (LINE, chat) rather than mailed, so the owner needs the link again later, and a way to withdraw
 * one sent to the wrong address. cancel_staff_invite enforces who may cancel; an admin's
 * invitation is not offered to a non-owner for the same reason BranchAccess locks the row.
 */
function PendingInviteActions({
  member,
  viewerIsOwner,
  onSettled,
}: {
  member: StaffListItem;
  viewerIsOwner: boolean;
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
  const canCancel = member.role !== 'admin' || viewerIsOwner;
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
  onClose,
  onInvited,
}: {
  restaurantId: string;
  branchId: string;
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
        branch_id: scope === 'branch' ? branchId : null,
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
        setError(t('invite.errors.alreadyActive', { email: invitedEmail }));
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
                    <p className="text-xs text-muted-foreground">{t('invite.thisBranchHint')}</p>
                  </div>
                </label>
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
