'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';

interface Props {
  branchId: string;
  driverId: string;
  periodStart: string;
  amount: number;
}

export function MarkPaidButton({ branchId, driverId, periodStart, amount }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const markPaid = async () => {
    if (!window.confirm(`Mark $${amount.toFixed(2)} as paid for this driver's week?`)) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('mark_driver_payout_paid', {
      p_branch_id: branchId,
      p_driver_id: driverId,
      p_period_start: periodStart,
    });
    setBusy(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    router.refresh();
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="gradient" loading={busy} onClick={markPaid}>
        Mark ${amount.toFixed(2)} paid
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
