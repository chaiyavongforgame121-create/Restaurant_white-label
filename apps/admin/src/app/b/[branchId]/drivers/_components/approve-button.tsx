'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, Pause, Play, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';

type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'suspended';

/**
 * The decisions offered depend on where the application already is. Previously only
 * `pending` rows rendered any control at all, so the moment a branch approved its one
 * applicant the screen became read-only for ever — the merchant could not suspend a rider
 * who stopped showing up, could not reinstate one they had rejected by mistake, and read
 * the absence of buttons as "approve is broken".
 */
const ACTIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  pending: ['approved', 'rejected'],
  approved: ['suspended', 'rejected'],
  rejected: ['approved'],
  suspended: ['approved', 'rejected'],
};

/** The button for moving TO a status, as a key under drivers.approve.actions. */
const LABEL_KEY: Record<ApprovalStatus, string> = {
  approved: 'approve',
  rejected: 'reject',
  suspended: 'suspend',
  pending: 'reopen',
};

const ICON: Record<ApprovalStatus, React.ReactNode> = {
  approved: <Check className="h-4 w-4" />,
  rejected: <X className="h-4 w-4" />,
  suspended: <Pause className="h-4 w-4" />,
  pending: <Play className="h-4 w-4" />,
};

/** Reinstating a previously-rejected rider reads better as "Reinstate" than "Approve". */
function labelKeyFor(from: ApprovalStatus, to: ApprovalStatus): string {
  if (to === 'approved' && (from === 'rejected' || from === 'suspended')) return 'reinstate';
  return LABEL_KEY[to];
}

/** Postgres insufficient_privilege, as PostgREST reports it. */
const PERMISSION_DENIED = '42501';

export function ApproveButton({
  approvalId,
  currentStatus,
  reviewerId,
}: {
  approvalId: string;
  currentStatus: ApprovalStatus;
  /** auth.users id of the reviewer. `driver_approvals.reviewed_by` references auth.users(id)
   *  — NOT staff_members(id), despite what the generated types.ts claims. Verified against
   *  the live constraint `driver_approvals_reviewed_by_fkey`. */
  reviewerId: string | null;
}) {
  const t = useTranslations('drivers');
  const router = useRouter();
  const [busy, setBusy] = React.useState<ApprovalStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [noteFor, setNoteFor] = React.useState<ApprovalStatus | null>(null);
  const [note, setNote] = React.useState('');

  const commit = async (status: ApprovalStatus, reason: string | null) => {
    setBusy(status);
    setError(null);
    const supabase = getBrowserClient();

    // `.select()` so the write reports what it actually changed: a bare update returns
    // success even when RLS matched zero rows, which is how a manager without permission
    // used to click Approve, see the row redraw unchanged, and have no idea it failed.
    const { data, error: updErr } = await supabase
      .from('driver_approvals')
      .update({
        status,
        reviewed_at: new Date().toISOString(),
        reviewed_by: reviewerId,
        // Only overwrite the note when one was actually typed, so approving does not wipe
        // the reason recorded by an earlier rejection.
        ...(reason ? { notes: reason } : {}),
      })
      .eq('id', approvalId)
      .select('id');

    setBusy(null);
    if (updErr) {
      // The database's own words go to the log; the merchant gets a sentence.
      console.error('driver_approvals update failed:', updErr.message);
      setError(updErr.code === PERMISSION_DENIED ? t('approve.notSaved') : t('approve.saveFailed'));
      return;
    }
    if (!data || data.length === 0) {
      setError(t('approve.notSaved'));
      return;
    }
    setNoteFor(null);
    setNote('');
    router.refresh();
  };

  // Rejecting without a reason leaves the rider staring at a status change they cannot act
  // on, so rejection asks for one. Every other transition is immediate.
  const onPick = (status: ApprovalStatus) => {
    if (status === 'rejected') {
      setNoteFor('rejected');
      return;
    }
    void commit(status, null);
  };

  const options = ACTIONS[currentStatus] ?? [];

  return (
    <div className="flex flex-col items-end gap-1.5">
      {noteFor === 'rejected' ? (
        <div className="w-64 rounded-xl border border-border bg-muted/30 p-2.5">
          <label htmlFor={`reject-note-${approvalId}`} className="text-xs font-semibold">
            {t('approve.rejectReasonLabel')}
          </label>
          <textarea
            id={`reject-note-${approvalId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={280}
            placeholder={t('approve.rejectReasonPlaceholder')}
            className="focus-ring mt-1 w-full resize-none rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
          />
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setNoteFor(null);
                setNote('');
              }}
            >
              {t('approve.cancel')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={busy === 'rejected'}
              disabled={note.trim().length === 0}
              onClick={() => void commit('rejected', note.trim())}
            >
              {t('approve.confirmReject')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          {options.map((status) => (
            <Button
              key={status}
              size="sm"
              variant={status === 'approved' ? 'primary' : status === 'rejected' ? 'outline' : 'ghost'}
              disabled={busy !== null}
              loading={busy === status}
              onClick={() => onPick(status)}
              leftIcon={ICON[status]}
            >
              {t(`approve.actions.${labelKeyFor(currentStatus, status)}`)}
            </Button>
          ))}
        </div>
      )}
      {error && <p className="max-w-64 text-right text-xs text-danger">{error}</p>}
    </div>
  );
}
