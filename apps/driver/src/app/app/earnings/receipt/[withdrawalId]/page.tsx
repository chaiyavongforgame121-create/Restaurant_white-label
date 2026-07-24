'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Receipt } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Card } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';

interface Withdrawal {
  id: string;
  amount: number;
  status: string;
  bank_name: string;
  account_number: string;
  account_name: string;
  receipt_number: string | null;
  paid_at: string | null;
  branch: { name: string } | null;
}

interface LedgerLine {
  id: string;
  delivered_at: string;
  base_pay: number;
  distance_pay: number;
  tip_net: number;
  total: number;
}

export default function ReceiptPage() {
  const { driver } = useDriverSession();
  const { withdrawalId } = useParams<{ withdrawalId: string }>();
  const [withdrawal, setWithdrawal] = React.useState<Withdrawal | null>(null);
  const [lines, setLines] = React.useState<LedgerLine[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void (async () => {
      // RLS already scopes to the driver's own rows; the driver_id filter is belt-and-braces.
      const { data: w } = await supabase
        .from('driver_withdrawals')
        .select('id, amount, status, bank_name, account_number, account_name, receipt_number, paid_at, branch:branches(name)')
        .eq('id', withdrawalId)
        .eq('driver_id', driver.id)
        .maybeSingle();
      setWithdrawal((w ?? null) as unknown as Withdrawal | null);
      if (w) {
        const { data: l } = await supabase
          .from('driver_earnings_ledger')
          .select('id, delivered_at, base_pay, distance_pay, tip_net, total')
          .eq('withdrawal_id', withdrawalId)
          .order('delivered_at', { ascending: true });
        setLines((l ?? []) as unknown as LedgerLine[]);
      }
      setLoading(false);
    })();
  }, [withdrawalId, driver.id]);

  if (loading) {
    return (
      <div className="grid min-h-[50dvh] place-items-center">
        <p className="text-sm text-muted-foreground">Loading receipt…</p>
      </div>
    );
  }

  if (!withdrawal) {
    return (
      <div className="container max-w-xl py-6">
        <p className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          We couldn&apos;t find this receipt. It may belong to another account.
        </p>
        <Link href="/app/earnings" className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
          <ArrowLeft className="h-4 w-4" /> Back to earnings
        </Link>
      </div>
    );
  }

  if (withdrawal.status !== 'paid') {
    return (
      <div className="container max-w-xl py-6">
        <p className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          This withdrawal hasn&apos;t been paid yet — the receipt appears here once the restaurant pays it.
        </p>
        <Link href="/app/earnings" className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
          <ArrowLeft className="h-4 w-4" /> Back to earnings
        </Link>
      </div>
    );
  }

  return (
    <div className="container max-w-xl py-6">
      <Link href="/app/earnings" className="mb-4 inline-flex items-center gap-1.5 px-1 text-sm font-semibold text-primary">
        <ArrowLeft className="h-4 w-4" /> Back to earnings
      </Link>

      <Card className="overflow-hidden">
        <div className="bg-gradient-warm p-5 text-center text-white">
          <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full bg-white/20">
            <Receipt className="h-5 w-5" />
          </div>
          <p className="text-xs uppercase tracking-wider text-white/80">Payout receipt</p>
          <p className="font-display text-lg font-bold">{withdrawal.receipt_number}</p>
        </div>

        <div className="space-y-1.5 border-b border-dashed border-border p-5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Restaurant</span><span className="font-medium">{withdrawal.branch?.name ?? 'Restaurant'}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Driver</span><span className="font-medium">{driver.full_name}</span></div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Paid</span>
            <span className="font-medium">{withdrawal.paid_at ? new Date(withdrawal.paid_at).toLocaleString() : '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Bank</span>
            <span className="font-medium">{withdrawal.bank_name} ··{withdrawal.account_number.slice(-4)}</span>
          </div>
        </div>

        <div className="p-5">
          <p className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            {lines.length} {lines.length === 1 ? 'delivery' : 'deliveries'}
          </p>
          <ul className="divide-y divide-border/60">
            {lines.map((l) => (
              <li key={l.id} className="flex items-center justify-between py-2.5 text-sm">
                <div>
                  <p className="font-medium">{new Date(l.delivered_at).toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">
                    Base ${Number(l.base_pay).toFixed(2)} · Distance ${Number(l.distance_pay).toFixed(2)} · Tip ${Number(l.tip_net).toFixed(2)}
                  </p>
                </div>
                <span className="font-semibold">${Number(l.total).toFixed(2)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between border-t border-dashed border-border pt-3">
            <span className="font-display text-lg font-semibold">Total paid</span>
            <span className="font-display text-2xl font-bold text-primary">${Number(withdrawal.amount).toFixed(2)}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}
