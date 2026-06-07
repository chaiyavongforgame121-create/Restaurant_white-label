'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Mail, Plus, UserPlus, X } from 'lucide-react';
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

const roleOptions: { value: 'manager' | 'cashier' | 'kitchen' | 'staff'; label: string }[] = [
  { value: 'manager', label: 'Manager' },
  { value: 'cashier', label: 'Cashier (POS)' },
  { value: 'kitchen', label: 'Kitchen (KDS)' },
  { value: 'staff', label: 'Staff' },
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
            onInvited={() => {
              setModalOpen(false);
              router.refresh();
            }}
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
  const [role, setRole] = React.useState<'manager' | 'cashier' | 'kitchen' | 'staff'>('cashier');
  const [scope, setScope] = React.useState<'branch' | 'restaurant'>('branch');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const supabase = getBrowserClient();
      await inviteStaff(supabase, {
        email: email.trim(),
        role,
        restaurant_id: restaurantId,
        branch_id: scope === 'branch' ? branchId : null,
      });
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
      </motion.form>
    </motion.div>
  );
}
