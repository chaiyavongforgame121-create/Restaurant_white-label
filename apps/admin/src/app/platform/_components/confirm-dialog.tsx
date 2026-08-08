'use client';

// The app's own confirmation primitive, so /platform never falls back to
// window.confirm. Both callers here are irreversible-ish platform writes:
// set_restaurant_suspended fans out to EVERY branch of the restaurant, and
// billing_set_package moves money. window.confirm could carry neither the blast
// radius named branch by branch, nor a loading state, nor the failed-RPC
// message — which was discarded, making a denied write look like a successful one.

import * as React from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { Button, Card, IconButton } from '@favornoms/ui';
import { fmtDate, money, type BranchLite, type TenantRow } from './tenant-health';

export interface ConfirmCopy {
  titleText: string;
  body: React.ReactNode;
  warning?: React.ReactNode;
  confirmLabel: string;
  confirmVariant: 'danger' | 'primary';
}

export function ConfirmDialog({
  copy,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  copy: ConfirmCopy;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const titleId = React.useId();
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);

  // Focus lands on Cancel, and returns to whatever opened the dialog on close.
  // Without the restore, dismissing a confirmation dropped the keyboard user
  // back at the top of the document — a long scroll from the row they were on.
  React.useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Escape closes; Tab is trapped. A dialog that gates a money write must not
  // let Tab wander onto the page behind it, where the operator can keep
  // clicking the very rows this is asking them to confirm.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !cardRef.current) return;
      const focusable = cardRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !cardRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div
      role="presentation"
      onClick={() => !busy && onClose()}
      className="animate-fade-in fixed inset-0 z-[120] grid place-items-center bg-black/55 p-4 backdrop-blur-sm"
    >
      <Card
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="animate-slide-up w-full max-w-md space-y-3 p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="font-display text-lg font-semibold">
            {copy.titleText}
          </h2>
          <IconButton label="Close" size="sm" onClick={onClose} disabled={busy}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="text-sm text-muted-foreground">{copy.body}</div>

        {copy.warning && (
          <div className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">{copy.warning}</div>
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={copy.confirmVariant} onClick={onConfirm} loading={busy}>
            {copy.confirmLabel}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function suspendCopy(row: TenantRow, branches: BranchLite[], entitled: boolean): ConfirmCopy {
  const total = branches.length;
  const active = branches.filter((b) => b.is_active).length;
  const suspending = active > 0;

  return {
    titleText: suspending ? `Suspend ${row.name}?` : `Restore ${row.name}?`,
    confirmLabel: suspending ? 'Suspend' : 'Restore',
    confirmVariant: suspending ? 'danger' : 'primary',
    body: (
      <>
        {suspending ? 'This takes ' : 'This brings back '}
        {total === 1 ? 'the only branch' : `all ${total} branches`} of {row.name}
        {total > 0 && <> — {branches.map((b) => b.name).join(', ')}</>}.{' '}
        {suspending
          ? 'The storefront will return 404 — not the suspended screen. Staff keep their back-office access and no data is deleted. This does not change their subscription.'
          : 'Customers will be able to find the storefront again.'}
      </>
    ),
    warning: !suspending && !entitled ? (
      <>
        {row.name}&apos;s subscription is {row.ent.status}, so the storefront will still show the
        suspended screen after restoring. Fix the subscription to bring them back online.{' '}
        <Link
          href={`/platform/subscriptions?q=${encodeURIComponent(row.slug)}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          Manage subscription
        </Link>
      </>
    ) : !suspending && active > 0 && active < total ? (
      <>
        {active} of {total} branches are already active. Restoring turns ALL {total} on, including any
        branch that was disabled deliberately.
      </>
    ) : undefined,
  };
}

export function reactivateCopy(
  row: TenantRow,
  branches: BranchLite[],
  kind: 'extend' | 'convert',
  planLabel: string,
  monthly: number | null,
  seats: number,
  nowMs: number,
): ConfirmCopy {
  // Postgres `+ interval '1 month'` clamps to the end of the target month; JS
  // setUTCMonth overflows (Jan 31 -> Mar 3). Left alone, the one sentence this
  // dialog exists to make true would name a paid-through date the RPC will not
  // write — on 7 calendar days a year, for a money write.
  const periodEnd = new Date(nowMs);
  const startDay = periodEnd.getUTCDate();
  periodEnd.setUTCDate(1);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1, 0),
  ).getUTCDate();
  periodEnd.setUTCDate(Math.min(startDay, lastDay));
  const stillSuspended = branches.filter((b) => !b.is_active).length;

  return {
    titleText: kind === 'extend' ? `Extend ${row.name} by 1 month?` : `Put ${row.name} on ${planLabel}?`,
    confirmLabel: kind === 'extend' ? 'Extend' : `Charge ${planLabel}`,
    confirmVariant: 'primary',
    body: (
      <>
        {kind === 'extend'
          ? `Re-bills the ${row.ent.planCode} package the tenant already has`
          : `Moves ${row.name} off ${row.ent.planCode} and onto ${planLabel}`}
        {monthly === null ? '' : ` at ${money(monthly)}/mo`} for {seats} branch{seats === 1 ? '' : 'es'},
        paid through {fmtDate(periodEnd.toISOString())}. The storefront comes back on the diner&apos;s
        next request.
      </>
    ),
    warning:
      stillSuspended > 0 ? (
        <>
          {stillSuspended} of {branches.length} branches are also platform-suspended and will keep
          returning 404 after this. Restore them separately.
        </>
      ) : undefined,
  };
}
