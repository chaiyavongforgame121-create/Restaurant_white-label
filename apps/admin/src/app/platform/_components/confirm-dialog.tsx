'use client';

// The app's own confirmation primitive, so /platform never falls back to
// window.confirm. Both callers here are irreversible-ish platform writes:
// set_restaurant_suspended fans out to EVERY branch of the restaurant, and
// billing_set_package moves money. window.confirm could carry neither the blast
// radius named branch by branch, nor a loading state, nor the failed-RPC
// message — which was discarded, making a denied write look like a successful one.

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button, Card, IconButton } from '@favornoms/ui';
import { money, type BranchLite, type TenantRow } from './tenant-health';
import type { PlatformText } from './platform-text';

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
  const t = useTranslations('platform.confirm');
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
          <IconButton label={t('close')} size="sm" onClick={onClose} disabled={busy}>
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
            {t('cancel')}
          </Button>
          <Button variant={copy.confirmVariant} onClick={onConfirm} loading={busy}>
            {copy.confirmLabel}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function suspendCopy(
  row: TenantRow,
  branches: BranchLite[],
  entitled: boolean,
  p: PlatformText,
): ConfirmCopy {
  const { t } = p;
  const total = branches.length;
  const active = branches.filter((b) => b.is_active).length;
  const suspending = active > 0;
  // Branch names are the merchant's own words; only the list punctuation is localized.
  const names = p.list(branches.map((b) => b.name));

  return {
    titleText: suspending
      ? t('confirm.suspend.title', { name: row.name })
      : t('confirm.restore.title', { name: row.name }),
    confirmLabel: suspending ? t('confirm.suspend.confirm') : t('confirm.restore.confirm'),
    confirmVariant: suspending ? 'danger' : 'primary',
    body: suspending
      ? t('confirm.suspend.body', { total, name: row.name, branches: names })
      : total === 0
        ? t('confirm.restore.bodyNoBranches', { name: row.name })
        : t('confirm.restore.body', { total, name: row.name, branches: names }),
    warning: !suspending && !entitled ? (
      <>
        {t.rich('confirm.restore.warningUnpaid', {
          name: row.name,
          status: p.status(row.ent.status),
          link: (chunks) => (
            <Link
              href={`/platform/subscriptions?q=${encodeURIComponent(row.slug)}`}
              className="text-primary underline-offset-2 hover:underline"
            >
              {chunks}
            </Link>
          ),
        })}
      </>
    ) : !suspending && active > 0 && active < total ? (
      <>{t('confirm.restore.warningPartial', { active, total })}</>
    ) : undefined,
  };
}

export function reactivateCopy(
  row: TenantRow,
  branches: BranchLite[],
  kind: 'extend' | 'convert',
  /** The plan code the write sends; shown through its label. */
  planCode: string,
  monthly: number | null,
  seats: number,
  /** The exact paid-through date the write will produce (see extensionPeriodEnd). */
  periodEnd: Date,
  /** The current deadline when extending a store that has not lapsed yet, else null. */
  extendsFrom: string | null,
  p: PlatformText,
): ConfirmCopy {
  const { t } = p;
  const stillSuspended = branches.filter((b) => !b.is_active).length;
  const plan = p.plan(planCode);
  const current = p.plan(row.ent.planCode);
  const price = {
    hasPrice: monthly === null ? 'no' : 'yes',
    price: monthly === null ? '' : money(monthly),
  };
  const to = p.date(periodEnd.toISOString());

  return {
    titleText:
      kind === 'extend'
        ? t('confirm.reactivate.titleExtend', { name: row.name })
        : t('confirm.reactivate.titleConvert', { name: row.name, plan }),
    confirmLabel:
      kind === 'extend' ? t('confirm.reactivate.confirmExtend') : t('confirm.reactivate.confirmConvert', { plan }),
    confirmVariant: 'primary',
    body: extendsFrom
      ? t('confirm.reactivate.bodyExtendLive', {
          plan: current,
          ...price,
          seats,
          from: p.date(extendsFrom),
          to,
        })
      : kind === 'extend'
        ? t('confirm.reactivate.bodyRebill', { plan: current, ...price, seats, to })
        : t('confirm.reactivate.bodyConvert', { name: row.name, current, plan, ...price, seats, to }),
    warning:
      stillSuspended > 0
        ? t('confirm.reactivate.warningSuspended', { suspended: stillSuspended, total: branches.length })
        : undefined,
  };
}
