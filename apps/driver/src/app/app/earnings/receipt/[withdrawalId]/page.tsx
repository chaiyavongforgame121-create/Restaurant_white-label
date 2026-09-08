'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Receipt } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { getDriverWithdrawal, type DriverWithdrawalRow } from '@favornoms/database/queries';
import { branchSubtitle, restaurantLabel } from '@favornoms/shared';
import { Card } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';
import { fetchTransferSlipPath } from '../../_components/payout-media';

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
  const [withdrawal, setWithdrawal] = React.useState<DriverWithdrawalRow | null>(null);
  const [lines, setLines] = React.useState<LedgerLine[]>([]);
  const [slipUrl, setSlipUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void (async () => {
      const w = await getDriverWithdrawal(supabase, driver.id, withdrawalId).catch(() => null);
      setWithdrawal(w);
      if (w) {
        const { data: l } = await supabase
          .from('driver_earnings_ledger')
          .select('id, delivered_at, base_pay, distance_pay, tip_net, total')
          .eq('withdrawal_id', withdrawalId)
          .order('delivered_at', { ascending: true });
        setLines((l ?? []) as unknown as LedgerLine[]);

        // The merchant's own proof that the money left their bank. payout-slips is private,
        // and the rider reads it through the owns_withdrawal_folder half of the read policy.
        const slipPath = await fetchTransferSlipPath(supabase, withdrawalId, driver.id);
        if (slipPath) {
          const { data: signed } = await supabase.storage
            .from('payout-slips')
            .createSignedUrl(slipPath, 60 * 10);
          setSlipUrl(signed?.signedUrl ?? null);
        }
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

  const label = restaurantLabel(withdrawal.branch);
  const subtitle = branchSubtitle(label);

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
          {/* Named up here too: a rider who works for several restaurants files these, and a
              receipt that only says "payout" is not evidence of who paid. */}
          <p className="mt-0.5 text-sm text-white/90">Paid by {label.restaurantName}</p>
        </div>

        <div className="space-y-1.5 border-b border-dashed border-border p-5 text-sm">
          <div className="flex justify-between gap-3">
            <span className="shrink-0 text-muted-foreground">Restaurant</span>
            <span className="text-right font-medium">{label.restaurantName}</span>
          </div>
          {subtitle && (
            <div className="flex justify-between gap-3">
              <span className="shrink-0 text-muted-foreground">Branch</span>
              <span className="text-right font-medium">{subtitle}</span>
            </div>
          )}
          <div className="flex justify-between"><span className="text-muted-foreground">Driver</span><span className="font-medium">{driver.full_name}</span></div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Paid</span>
            <span className="font-medium">{withdrawal.paid_at ? new Date(withdrawal.paid_at).toLocaleString() : '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Bank</span>
            <span className="font-medium">{withdrawal.bank_name} ··{withdrawal.account_number.slice(-4)}</span>
          </div>
          {slipUrl && (
            <a href={slipUrl} target="_blank" rel="noopener noreferrer" className="mt-3 block">
              <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                Transfer slip
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={slipUrl}
                alt="Transfer slip from the restaurant"
                className="max-h-64 w-full rounded-lg border border-border bg-muted object-contain"
              />
            </a>
          )}
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
