'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Mail, Plus, UserPlus, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import {
  inviteStaff,
  isStaffAlreadyActiveError,
  setStaffBranchScope,
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
  const [modalOpen, setModalOpen] = React.useState(false);

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
                    onChanged={(next) =>
                      setStaff((prev) =>
                        prev.map((m) => (m.id === s.id ? { ...m, branch_id: next } : m)),
                      )
                    }
                  />
                  <Badge variant={statusVariant(s.status)}>
                    {KNOWN_STATUSES.has(s.status) ? t(`statuses.${s.status}`) : s.status}
                  </Badge>
                </div>
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
            // Refresh only — the modal stays up to report which of the two outcomes
            // happened, because "we emailed them" and "they can sign in right now" need
            // different things from the owner.
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
      {error && <p className="max-w-xs text-right text-xs text-danger">{error}</p>}
    </div>
  );
}

function statusVariant(s: string): 'success' | 'warning' | 'muted' | 'danger' {
  if (s === 'active') return 'success';
  if (s === 'pending') return 'warning';
  if (s === 'removed' || s === 'suspended') return 'danger';
  return 'muted';
}

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
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<AssignableRole>('cashier');
  const [scope, setScope] = React.useState<'branch' | 'restaurant'>('branch');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ emailed: boolean } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const supabase = getBrowserClient();
      const res = await inviteStaff(supabase, {
        email: email.trim(),
        role,
        restaurant_id: restaurantId,
        branch_id: scope === 'branch' ? branchId : null,
      });
      setSubmitting(false);
      setResult({ emailed: res.emailed });
      onInvited();
    } catch (err) {
      // invite-staff keeps one row per restaurant and email, so inviting someone already on
      // the team (usually to give them a second branch) came back as a raw
      // "invite_staff_failed:409:..." with no way forward shown. The edge function answers
      // with error codes; anything unrecognised is logged and shown as a generic failure.
      const message = (err as Error).message;
      if (isStaffAlreadyActiveError(err)) {
        setError(t('invite.errors.alreadyActive', { email: email.trim() }));
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
      className="fixed inset-0 z-[120] grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.form
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 10, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl"
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-bold">{t('invite.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('invite.close')}
            className="focus-ring rounded-full p-1.5 hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {result ? (
          <div className="py-2 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
            {result.emailed ? (
              <>
                <p className="mt-3 font-display text-lg font-semibold">{t('invite.sentTitle')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t.rich('invite.sentBody', {
                    email,
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
              </>
            ) : (
              <>
                <p className="mt-3 font-display text-lg font-semibold">{t('invite.addedTitle')}</p>
                {/* The old code reported plain success here and sent no email at all, so an
                    owner inviting an existing account waited forever for a message that was
                    never going to arrive. Say what actually happened instead. */}
                <p className="mt-1 text-sm text-muted-foreground">
                  {t.rich('invite.addedBody', {
                    email,
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
              </>
            )}
            <Button variant="gradient" className="mt-5" fullWidth onClick={onClose}>
              {t('invite.done')}
            </Button>
          </div>
        ) : (
          <>
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

          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        <footer className="mt-5 flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose} fullWidth>
            {t('invite.cancel')}
          </Button>
          <Button type="submit" variant="gradient" fullWidth loading={submitting}>
            {t('invite.send')}
          </Button>
        </footer>
          </>
        )}
      </motion.form>
    </motion.div>
  );
}
