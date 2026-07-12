'use client';

import * as React from 'react';
import Link from 'next/link';
import { Receipt, Send, Store, TrendingUp } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card, Sheet } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';

interface Withdrawal {
  id: string;
  branch_id: string;
  amount: number;
  status: string;
  bank_name: string;
  account_number: string;
  account_name: string;
  rejection_reason: string | null;
  receipt_number: string | null;
  created_at: string;
  branch: { name: string } | null;
}

interface BranchBalance {
  branch_id: string;
  name: string;
  accrued: number;
  deliveries: number;
}

// RPC raises these as bare exception messages; anything else falls through raw.
const RPC_ERROR_COPY: Record<string, string> = {
  bank_details_required: 'Please fill in all bank details.',
  withdrawal_already_pending: 'You already have a pending request for this restaurant.',
  nothing_to_withdraw: 'Nothing to withdraw for this restaurant yet.',
};

export default function EarningsPage() {
  const { driver } = useDriverSession();
  const [withdrawals, setWithdrawals] = React.useState<Withdrawal[]>([]);
  const [balances, setBalances] = React.useState<BranchBalance[]>([]);
  const [estimatedEarnings, setEstimatedEarnings] = React.useState(0);
  const [totals, setTotals] = React.useState({ accrued: 0, paid: 0, base: 0, distance: 0, tip: 0 });
  const [requesting, setRequesting] = React.useState<BranchBalance | null>(null);
  const [bankName, setBankName] = React.useState('');
  const [accountNumber, setAccountNumber] = React.useState('');
  const [accountName, setAccountName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const { data: w } = await supabase
      .from('driver_withdrawals')
      .select('id, branch_id, amount, status, bank_name, account_number, account_name, rejection_reason, receipt_number, created_at, branch:branches(name)')
      .eq('driver_id', driver.id)
      .order('created_at', { ascending: false })
      .limit(20);
    setWithdrawals((w ?? []) as unknown as Withdrawal[]);

    // The settlement ledger is the source of truth for what the driver is owed / was paid.
    const { data: ledger } = await supabase
      .from('driver_earnings_ledger')
      .select('branch_id, base_pay, distance_pay, tip_net, total, status, branch:branches(name)')
      .eq('driver_id', driver.id);
    const perBranch = new Map<string, BranchBalance>();
    const t = (ledger ?? []).reduce(
      (a, r) => {
        const total = Number(r.total ?? 0);
        if (r.status === 'paid') a.paid += total;
        else {
          a.accrued += total;
          const b = perBranch.get(r.branch_id) ?? {
            branch_id: r.branch_id,
            name: (r.branch as unknown as { name: string } | null)?.name ?? 'Restaurant',
            accrued: 0,
            deliveries: 0,
          };
          b.accrued += total;
          b.deliveries += 1;
          perBranch.set(r.branch_id, b);
        }
        a.base += Number(r.base_pay ?? 0);
        a.distance += Number(r.distance_pay ?? 0);
        a.tip += Number(r.tip_net ?? 0);
        return a;
      },
      { accrued: 0, paid: 0, base: 0, distance: 0, tip: 0 },
    );
    setTotals(t);
    setEstimatedEarnings(t.accrued + t.paid);
    setBalances([...perBranch.values()].sort((a, b) => b.accrued - a.accrued));
  }, [driver.id]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const pendingBranchIds = new Set(withdrawals.filter((w) => w.status === 'pending').map((w) => w.branch_id));

  const openRequest = (b: BranchBalance) => {
    // Prefill bank details from the driver's most recent request, any branch.
    const last = withdrawals[0];
    setBankName(last?.bank_name ?? '');
    setAccountNumber(last?.account_number ?? '');
    setAccountName(last?.account_name ?? '');
    setError(null);
    setRequesting(b);
  };

  const submit = async () => {
    if (!requesting) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('request_driver_withdrawal', {
      p_branch_id: requesting.branch_id,
      p_bank_name: bankName.trim(),
      p_account_number: accountNumber.trim(),
      p_account_name: accountName.trim(),
    });
    setBusy(false);
    if (rpcErr) {
      const key = Object.keys(RPC_ERROR_COPY).find((k) => rpcErr.message.includes(k));
      setError((key && RPC_ERROR_COPY[key]) || rpcErr.message);
      return;
    }
    setRequesting(null);
    void refresh();
  };

  return (
    <div className="container max-w-xl py-6">
      <header className="mb-5 px-1">
        <h1 className="font-display text-2xl font-bold">Earnings</h1>
      </header>

      <Card className="mb-5 bg-gradient-warm p-5 text-white">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-6 w-6" />
          <div>
            <p className="text-xs uppercase tracking-wider text-white/80">Lifetime earnings</p>
            <p className="font-display text-3xl font-bold">${estimatedEarnings.toFixed(2)}</p>
          </div>
        </div>
      </Card>

      <div className="mb-5 grid grid-cols-2 gap-3">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Unpaid</p>
          <p className="font-display text-2xl font-bold">${totals.accrued.toFixed(2)}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">request a payout per restaurant</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Paid</p>
          <p className="font-display text-2xl font-bold">${totals.paid.toFixed(2)}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">settled by restaurants</p>
        </Card>
      </div>
      <Card className="mb-5 grid grid-cols-3 divide-x divide-border p-4 text-center">
        <div><p className="text-[11px] uppercase text-muted-foreground">Base</p><p className="font-semibold">${totals.base.toFixed(2)}</p></div>
        <div><p className="text-[11px] uppercase text-muted-foreground">Distance</p><p className="font-semibold">${totals.distance.toFixed(2)}</p></div>
        <div><p className="text-[11px] uppercase text-muted-foreground">Tips</p><p className="font-semibold">${totals.tip.toFixed(2)}</p></div>
      </Card>

      <h2 className="mb-2 font-display text-lg font-semibold">Balance by restaurant</h2>
      {balances.length === 0 ? (
        <p className="mb-5 rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          Nothing unpaid right now — new deliveries show up here.
        </p>
      ) : (
        <ul className="mb-5 space-y-2">
          {balances.map((b) => {
            const pending = pendingBranchIds.has(b.branch_id);
            return (
              <li key={b.branch_id}>
                <Card className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
                      <Store className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{b.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {b.deliveries} {b.deliveries === 1 ? 'delivery' : 'deliveries'}
                      </p>
                    </div>
                    <p className="font-display text-xl font-bold text-primary">${b.accrued.toFixed(2)}</p>
                  </div>
                  <Button
                    variant="gradient"
                    fullWidth
                    className="mt-3"
                    disabled={pending}
                    onClick={() => openRequest(b)}
                    leftIcon={<Send className="h-4 w-4" />}
                  >
                    Request withdrawal
                  </Button>
                  {pending && (
                    <p className="mt-2 text-center text-xs text-muted-foreground">
                      Requested — waiting for the restaurant
                    </p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mb-2 font-display text-lg font-semibold">History</h2>
      {withdrawals.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No withdrawal requests yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {withdrawals.map((w) => (
            <li key={w.id}>
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-display text-lg font-bold">${Number(w.amount).toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">
                      {w.branch?.name ?? 'Restaurant'} · {w.bank_name} · ··{w.account_number.slice(-4)} · {new Date(w.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge variant={w.status === 'paid' ? 'success' : w.status === 'rejected' ? 'danger' : 'warning'}>
                    {w.status}
                  </Badge>
                </div>
                {w.status === 'rejected' && w.rejection_reason && (
                  <p className="mt-2 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">{w.rejection_reason}</p>
                )}
                {w.status === 'paid' && (
                  <Link
                    href={`/app/earnings/receipt/${w.id}`}
                    className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
                  >
                    <Receipt className="h-4 w-4" /> View receipt
                  </Link>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Sheet open={requesting !== null} onClose={() => setRequesting(null)} title="Request withdrawal">
        {requesting && (
          <div className="space-y-3 px-5 pb-8 pt-1">
            <Card className="flex items-center justify-between bg-muted/40 p-4">
              <div>
                <p className="font-semibold">{requesting.name}</p>
                <p className="text-xs text-muted-foreground">
                  {requesting.deliveries} {requesting.deliveries === 1 ? 'delivery' : 'deliveries'} · final amount confirmed by the restaurant
                </p>
              </div>
              <p className="font-display text-2xl font-bold text-primary">${requesting.accrued.toFixed(2)}</p>
            </Card>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Bank</span>
              <input value={bankName} onChange={(e) => setBankName(e.target.value)} className="input" placeholder="Chase / Bank of America / etc." maxLength={80} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Account number</span>
              <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} className="input" maxLength={34} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Account holder name</span>
              <input value={accountName} onChange={(e) => setAccountName(e.target.value)} className="input" maxLength={80} />
            </label>
            {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <Button
              variant="gradient"
              fullWidth
              onClick={submit}
              loading={busy}
              disabled={!bankName.trim() || !accountNumber.trim() || !accountName.trim()}
            >
              Submit request
            </Button>
          </div>
        )}
      </Sheet>

      <style jsx>{`
        .input { width: 100%; height: 48px; padding: 0 1rem; font-size: 16px; border-radius: 0.875rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
        .input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
      `}</style>
    </div>
  );
}
