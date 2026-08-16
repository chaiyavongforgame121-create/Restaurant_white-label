'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';

export function ApproveButton({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const setStatus = async (status: 'approved' | 'rejected') => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();

    // Record WHO decided. Approving a driver is a KYC/compliance decision — "this rider was
    // cleared to carry orders" needs an accountable name behind it, and reviewed_by was
    // being left NULL on every approval, so the audit trail said when but never by whom.
    const { data: auth } = await supabase.auth.getUser();

    // `.select()` so the write reports what it actually changed: a bare update returns
    // success even when RLS matched zero rows, which is how a manager without permission
    // used to click Approve, see the row redraw unchanged, and have no idea it failed.
    const { data, error: updErr } = await supabase
      .from('driver_approvals')
      .update({
        status,
        reviewed_at: new Date().toISOString(),
        reviewed_by: auth.user?.id ?? null,
      })
      .eq('id', approvalId)
      .select('id');

    setBusy(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    if (!data || data.length === 0) {
      setError("That didn't save — you may not have permission to review drivers.");
      return;
    }
    router.refresh();
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => setStatus('rejected')}
          leftIcon={<X className="h-4 w-4" />}
        >
          Reject
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => setStatus('approved')}
          leftIcon={<Check className="h-4 w-4" />}
        >
          Approve
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
