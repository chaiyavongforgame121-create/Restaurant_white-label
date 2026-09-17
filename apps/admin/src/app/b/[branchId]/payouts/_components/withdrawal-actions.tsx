'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, useConfirm } from '@favornoms/ui';

interface Props {
  withdrawalId: string;
  amount: number;
  driverName: string;
  slipAttached: boolean;
}

/** pay_/reject_driver_withdrawal error codes → payouts.actions.errors.<key>. */
const RPC_ERRORS: Record<string, string> = {
  not_pending: 'notPending',
  not_authorized: 'notAuthorized',
  not_found: 'notFound',
  auth_required: 'signedOut',
};

export function WithdrawalActions({ withdrawalId, amount, driverName, slipAttached }: Props) {
  const t = useTranslations('payouts.actions');
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [paidReceipt, setPaidReceipt] = React.useState<string | null>(null);
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState('');

  const rpcError = (message: string) => {
    const key = RPC_ERRORS[message];
    if (!key) console.error('driver withdrawal RPC failed', message);
    return t(`errors.${key ?? 'generic'}`);
  };

  const markPaid = async () => {
    // Not a hard block: merchants transfer first and screenshot second, and the slip can be
    // filed against a paid payout afterwards.
    const confirmed = await confirm({
      title: t('payTitle', { amount: `$${amount.toFixed(2)}`, name: driverName }),
      body: slipAttached ? t('payBody') : t('payBodyNoSlip'),
      confirmLabel: t('markPaid'),
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { data, error: rpcErr } = await supabase.rpc('pay_driver_withdrawal', {
      p_withdrawal_id: withdrawalId,
    });
    setBusy(false);
    if (rpcErr) {
      setError(rpcError(rpcErr.message));
      return;
    }
    setPaidReceipt((data as { receipt_number?: string } | null)?.receipt_number ?? '—');
    router.refresh();
  };

  const reject = async () => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const trimmed = reason.trim();
    const { error: rpcErr } = await supabase.rpc(
      'reject_driver_withdrawal',
      trimmed ? { p_withdrawal_id: withdrawalId, p_reason: trimmed } : { p_withdrawal_id: withdrawalId },
    );
    setBusy(false);
    if (rpcErr) {
      setError(rpcError(rpcErr.message));
      return;
    }
    router.refresh();
  };

  if (paidReceipt) {
    return (
      <span className="text-sm font-medium text-success">
        {t('paidReceipt', { number: paidReceipt })}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {rejecting ? (
        <div className="flex flex-col items-end gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder={t('reasonPlaceholder')}
            className="focus-ring h-9 w-56 rounded-md border border-border bg-background px-3 text-sm"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
              {t('cancel')}
            </Button>
            <Button size="sm" variant="danger" loading={busy} onClick={reject}>
              {t('confirmReject')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
            {t('reject')}
          </Button>
          <Button size="sm" variant="gradient" loading={busy} onClick={markPaid}>
            {t('markPaid')}
          </Button>
        </div>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
