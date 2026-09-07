'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { getSupabaseEnv } from '@favornoms/database/env';
import { Button } from '@favornoms/ui';
import type { ReportRange } from './report-range';

const KINDS = [
  { kind: 'orders', label: 'Orders', ranged: true },
  { kind: 'revenue', label: 'Revenue', ranged: true },
  { kind: 'menu', label: 'Menu', ranged: true },
  { kind: 'payments', label: 'Payments', ranged: true },
  { kind: 'refunds', label: 'Refunds', ranged: true },
  // Customers is a standing list ordered by lifetime spend, so a date window would only
  // narrow it to who signed up in the range — not what anyone means by "export customers".
  { kind: 'customers', label: 'Customers', ranged: false },
  { kind: 'loyalty', label: 'Loyalty', ranged: true },
] as const;

type ExportKind = (typeof KINDS)[number]['kind'];

export function ExportButtons({ branchId, range }: { branchId: string; range: ReportRange }) {
  const [busy, setBusy] = React.useState<ExportKind | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);

  const download = async (kind: ExportKind, ranged: boolean) => {
    setBusy(kind);
    setFailure(null);
    try {
      const supabase = getBrowserClient();
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) {
        setFailure('Your session expired. Reload the page and sign in again.');
        return;
      }
      const { url } = getSupabaseEnv();
      const params = new URLSearchParams({ branch_id: branchId, kind });
      // The merchant exports what the screen shows. Without this the CSV was the last
      // 10 000 rows of all time, which never matched the report they were looking at.
      if (ranged) {
        params.set('from', range.from);
        params.set('to', range.to);
      }
      const res = await fetch(`${url}/functions/v1/export-csv?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setFailure(`${kind} export failed (${res.status}). Try again, or contact support.`);
        return;
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = ranged ? `${kind}-${range.from}_${range.to}.csv` : `${kind}-${range.to}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <Button
            key={k.kind}
            variant="soft"
            size="md"
            onClick={() => download(k.kind, k.ranged)}
            loading={busy === k.kind}
            leftIcon={<Download className="h-4 w-4" />}
          >
            {k.label}
          </Button>
        ))}
      </div>
      {failure ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
