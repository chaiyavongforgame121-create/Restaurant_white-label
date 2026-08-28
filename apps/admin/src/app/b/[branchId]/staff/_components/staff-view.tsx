'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Mail, Plus, UserPlus, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { inviteStaff, type StaffRole } from '@favornoms/database/queries';

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

interface Props {
  branchId: string;
  restaurantId: string;
  branchName: string;
  initialStaff: StaffListItem[];
}

/** Assignable roles, in descending order of access. `owner` is absent on purpose —
 *  it is created by restaurant onboarding and cannot be handed out here. The
 *  description is what a non-technical merchant needs to pick correctly, so it names
 *  the boundary rather than listing screens. */
export type AssignableRole =
  | 'admin'
  | 'manager'
  | 'cashier'
  | 'server'
  | 'kitchen'
  | 'driver'
  | 'staff';

const roleOptions: { value: AssignableRole; label: string; description: string }[] = [
  {
    value: 'admin',
    label: 'Admin',
    description:
      'Everything you can do, except billing and adding another admin. For a business partner or general manager.',
  },
  {
    value: 'manager',
    label: 'Manager',
    description:
      'Runs the day to day: orders, refunds, menu, stock, promos, drivers, reports and staff hours. No billing, branding or staff invites.',
  },
  {
    value: 'cashier',
    label: 'Cashier',
    description:
      'Counter and payments. Takes orders and money, applies discounts, reprints receipts, cancels before payment. Refunds need a manager.',
  },
  {
    value: 'server',
    label: 'Server',
    description:
      'Dine-in only. Builds a table order, sends it to the kitchen and watches its progress. Sees only their own orders — no takings, no reports.',
  },
  {
    value: 'kitchen',
    label: 'Kitchen',
    description:
      'The kitchen display only. Accept, cooking, ready, plus marking items low or sold out. No customer or payment details.',
  },
  {
    value: 'driver',
    label: 'Driver',
    description:
      'Appears in your staff list but has no back-office access at all — riders work in the Driver app, where they see only their own jobs and earnings.',
  },
  {
    value: 'staff',
    label: 'Staff (general)',
    description: 'Counter access only. The original catch-all role, kept for existing team members.',
  },
];

export function StaffView({ branchId, restaurantId, branchName, initialStaff }: Props) {
  const router = useRouter();
  const [staff] = React.useState(initialStaff);
  const [modalOpen, setModalOpen] = React.useState(false);

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">Staff</h1>
          <p className="mt-1 text-muted-foreground">
            {staff.length} {staff.length === 1 ? 'member' : 'members'} at {branchName}
          </p>
        </div>
        <Button variant="gradient" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setModalOpen(true)}>
          Invite staff
        </Button>
      </header>

      {staff.length === 0 ? (
        <EmptyState
          icon={<UserPlus className="h-7 w-7" />}
          title="No staff yet"
          description="Invite cashiers, kitchen staff and managers to share access to the dashboard, POS and KDS."
          action={
            <Button variant="gradient" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setModalOpen(true)}>
              Invite first member
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2 px-2 lg:px-0">
          {staff.map((s) => (
            <li key={s.id}>
              <Card className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
                    <Mail className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold">{s.invited_email ?? 'Unnamed'}</p>
                    <p className="text-xs capitalize text-muted-foreground">
                      {s.role} {s.branch_id ? '· Branch' : '· All branches'}
                    </p>
                  </div>
                </div>
                <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
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
      setError((err as Error).message);
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
          <h2 className="font-display text-xl font-bold">Invite staff member</h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1.5 hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </header>

        {result ? (
          <div className="py-2 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
            {result.emailed ? (
              <>
                <p className="mt-3 font-display text-lg font-semibold">Invitation sent</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  We emailed <strong>{email}</strong> a link. Opening it adds them to the
                  team and asks them to choose a password.
                </p>
              </>
            ) : (
              <>
                <p className="mt-3 font-display text-lg font-semibold">Added to the team</p>
                {/* The old code reported plain success here and sent no email at all, so an
                    owner inviting an existing account waited forever for a message that was
                    never going to arrive. Say what actually happened instead. */}
                <p className="mt-1 text-sm text-muted-foreground">
                  <strong>{email}</strong> already had an account, so no email was needed —
                  they can sign in here right now with the password they already use.
                </p>
              </>
            )}
            <Button variant="gradient" className="mt-5" fullWidth onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <>
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Email</span>
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
            <span className="mb-1 block text-sm font-medium">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
              className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
            >
              {roleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {/* Naming what the role can and cannot do at the point of choosing is the
                difference between a considered decision and everyone being made a
                manager. */}
            <span className="mt-1.5 block text-xs text-muted-foreground">
              {roleOptions.find((o) => o.value === role)?.description}
            </span>
          </label>

          <fieldset className="space-y-2">
            <legend className="mb-1 block text-sm font-medium">Scope</legend>
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
                <p className="text-sm font-semibold">This branch only</p>
                <p className="text-xs text-muted-foreground">Access limited to this location</p>
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
                <p className="text-sm font-semibold">All branches</p>
                <p className="text-xs text-muted-foreground">Full restaurant access (managers)</p>
              </div>
            </label>
          </fieldset>

          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        <footer className="mt-5 flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose} fullWidth>
            Cancel
          </Button>
          <Button type="submit" variant="gradient" fullWidth loading={submitting}>
            Send invite
          </Button>
        </footer>
          </>
        )}
      </motion.form>
    </motion.div>
  );
}
