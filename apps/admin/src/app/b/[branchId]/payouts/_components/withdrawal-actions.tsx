'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';

interface Props {
  withdrawalId: string;
  amount: number;
  driverName: string;
}

const RPC_ERRORS: Record<string, string> = {
  not_pending: 'This request was already settled.',
  not_authorized: "You don't have permission to settle this request.",
};

export function WithdrawalActions({ withdrawalId, amount, driverName }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [paidReceipt, setPaidReceipt] = React.useState<string | null>(null);
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState('');

  const markPaid = async () => {
    if (!window.confirm(`Pay $${amount.toFixed(2)} to ${driverName}? Confirm only after the transfer is sent.`)) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { data, error: rpcErr } = await supabase.rpc('pay_driver_withdrawal', {
      p_withdrawal_id: withdrawalId,
    });
    setBusy(false);
    if (rpcErr) {
      setError(RPC_ERRORS[rpcErr.message] ?? rpcErr.message);
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
      setError(RPC_ERRORS[rpcErr.message] ?? rpcErr.message);
      return;
    }
    router.refresh();
  };

  if (paidReceipt) {
    return <span className="text-sm font-medium text-success">Paid · Receipt {paidReceipt}</span>;
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {rejecting ? (
        <div className="flex flex-col items-end gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder="Reason (optional)"
            className="focus-ring h-9 w-56 rounded-md border border-border bg-background px-3 text-sm"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" loading={busy} onClick={reject}>
              Confirm reject
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
            Reject
          </Button>
          <Button size="sm" variant="gradient" loading={busy} onClick={markPaid}>
            Mark as paid
          </Button>
        </div>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
