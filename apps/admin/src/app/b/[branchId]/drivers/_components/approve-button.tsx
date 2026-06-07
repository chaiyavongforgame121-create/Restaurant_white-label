'use client';

import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';

export function ApproveButton({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const setStatus = async (status: 'approved' | 'rejected') => {
    const supabase = getBrowserClient();
    await supabase
      .from('driver_approvals')
      .update({ status, reviewed_at: new Date().toISOString() })
      .eq('id', approvalId);
    router.refresh();
  };
  return (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" onClick={() => setStatus('rejected')} leftIcon={<X className="h-4 w-4" />}>
        Reject
      </Button>
      <Button size="sm" variant="primary" onClick={() => setStatus('approved')} leftIcon={<Check className="h-4 w-4" />}>
        Approve
      </Button>
    </div>
  );
}
