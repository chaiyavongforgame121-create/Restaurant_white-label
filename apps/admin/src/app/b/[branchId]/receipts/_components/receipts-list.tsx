'use client';

import * as React from 'react';
import { Download, FileText, Printer } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

interface ReceiptRow {
  id: string;
  invoice_number: string;
  buyer_name: string | null;
  total: number | string;
  status: string;
  issued_at: string | null;
  order_id: string | null;
  orders?: { order_number?: string } | null;
}

interface Props {
  branchId: string;
  receipts: ReceiptRow[];
}

export function ReceiptsList({ branchId, receipts }: Props) {
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const openReceipt = async (id: string) => {
    setBusyId(id);
    try {
      const supabase = getBrowserClient();
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const apikey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      const res = await fetch(`${url}/functions/v1/issue-tax-invoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: apikey ?? '',
          Authorization: `Bearer ${accessToken ?? apikey}`,
        },
        body: JSON.stringify({ tax_invoice_id: id }),
      });
      if (!res.ok) {
        alert(`Failed to render receipt: ${res.status}`);
        return;
      }
      const data = await res.json();
      const w = window.open('', '_blank', 'width=520,height=720');
      if (!w) {
        alert('Pop-up blocked. Allow pop-ups for this site.');
        return;
      }
      w.document.open();
      w.document.write(data.html);
      w.document.close();
      setTimeout(() => w.focus(), 50);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Receipts</h1>
        <p className="mt-1 text-muted-foreground">All sales receipts issued for branch {branchId.slice(0, 8)}…</p>
      </header>

      {receipts.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <FileText className="mx-auto h-10 w-10 opacity-40" />
          <p className="mt-3 text-sm">No receipts issued yet. Receipts are created from the Orders page on completed orders.</p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Receipt #</th>
                <th className="px-4 py-3 text-left font-semibold">Order #</th>
                <th className="px-4 py-3 text-left font-semibold">Customer</th>
                <th className="px-4 py-3 text-right font-semibold">Total</th>
                <th className="px-4 py-3 text-center font-semibold">Status</th>
                <th className="px-4 py-3 text-left font-semibold">Issued</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id} className="border-t border-border/60">
                  <td className="px-4 py-3 font-medium">{r.invoice_number}</td>
                  <td className="px-4 py-3 text-muted-foreground">{r.orders?.order_number ?? '—'}</td>
                  <td className="px-4 py-3">{r.buyer_name ?? 'Walk-in'}</td>
                  <td className="px-4 py-3 text-right font-display font-bold tabular-nums text-primary">
                    {formatCurrency(Number(r.total))}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant={r.status === 'issued' ? 'success' : 'muted'}>{r.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.issued_at ? new Date(r.issued_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openReceipt(r.id)}
                      loading={busyId === r.id}
                      leftIcon={<Printer className="h-4 w-4" />}
                    >
                      View / print
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}
    </div>
  );
}
