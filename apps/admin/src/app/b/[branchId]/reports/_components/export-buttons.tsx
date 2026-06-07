'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { getSupabaseEnv } from '@favornoms/database/env';
import { Button } from '@favornoms/ui';

export function ExportButtons({ branchId }: { branchId: string }) {
  const [busy, setBusy] = React.useState<string | null>(null);

  const download = async (kind: 'orders' | 'customers' | 'loyalty' | 'revenue') => {
    setBusy(kind);
    try {
      const supabase = getBrowserClient();
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) return;
      const { url } = getSupabaseEnv();
      const res = await fetch(
        `${url}/functions/v1/export-csv?branch_id=${branchId}&kind=${kind}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        alert(`Export failed: ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {(['orders', 'customers', 'loyalty', 'revenue'] as const).map((k) => (
        <Button
          key={k}
          variant="soft"
          size="md"
          onClick={() => download(k)}
          loading={busy === k}
          leftIcon={<Download className="h-4 w-4" />}
        >
          {k.replace(/^./, (c) => c.toUpperCase())}
        </Button>
      ))}
    </div>
  );
}
