'use client';

import * as React from 'react';
import { Send, TrendingUp } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';

interface Withdrawal {
  id: string;
  amount: number;
  status: string;
  bank_name: string;
  account_number: string;
  created_at: string;
}

export default function EarningsPage() {
  const { driver } = useDriverSession();
  const [withdrawals, setWithdrawals] = React.useState<Withdrawal[]>([]);
  const [estimatedEarnings, setEstimatedEarnings] = React.useState(0);
  const [composing, setComposing] = React.useState(false);
  const [amount, setAmount] = React.useState('');
  const [bankName, setBankName] = React.useState('');
  const [accountNumber, setAccountNumber] = React.useState('');
  const [accountName, setAccountName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const { data: w } = await supabase
      .from('driver_withdrawals')
      .select('*')
      .eq('driver_id', driver.id)
      .order('created_at', { ascending: false })
      .limit(20);
    setWithdrawals((w ?? []) as Withdrawal[]);

    const { data: deliveries } = await supabase
      .from('deliveries')
      .select('driver_earnings')
      .eq('driver_id', driver.id)
      .eq('status', 'delivered');
    const total = (deliveries ?? []).reduce((s, d) => s + Number(d.driver_earnings ?? 0), 0);
    setEstimatedEarnings(total);
  }, [driver.id]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('driver_withdrawals').insert({
      driver_id: driver.id,
      amount: Number(amount),
      bank_name: bankName,
      account_number: accountNumber,
      account_name: accountName,
    });
    setBusy(false);
    if (insErr) { setError(insErr.message); return; }
    setComposing(false);
    setAmount(''); setBankName(''); setAccountNumber(''); setAccountName('');
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
            <p className="font-display text-3xl font-bold">${estimatedEarnings.toLocaleString()}</p>
          </div>
        </div>
      </Card>

      <div className="mb-5">
        <Button
          variant={composing ? 'ghost' : 'gradient'}
          fullWidth
          onClick={() => setComposing((c) => !c)}
          leftIcon={<Send className="h-4 w-4" />}
        >
          {composing ? 'Cancel' : 'Request withdrawal'}
        </Button>
      </div>

      {composing && (
        <Card className="mb-5 space-y-3 p-5">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Amount (USD)</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} className="input" inputMode="decimal" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Bank</span>
            <input value={bankName} onChange={(e) => setBankName(e.target.value)} className="input" placeholder="Chase / Bank of America / etc." />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Account number</span>
            <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} className="input" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Account holder name</span>
            <input value={accountName} onChange={(e) => setAccountName(e.target.value)} className="input" />
          </label>
          {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button
            variant="gradient"
            fullWidth
            onClick={submit}
            loading={busy}
            disabled={!amount || !bankName || !accountNumber || !accountName}
          >
            Submit request
          </Button>
        </Card>
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
              <Card className="flex items-center justify-between p-4">
                <div>
                  <p className="font-display text-lg font-bold">${Number(w.amount).toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">
                    {w.bank_name} · ··{w.account_number.slice(-4)} · {new Date(w.created_at).toLocaleDateString()}
                  </p>
                </div>
                <Badge variant={w.status === 'paid' ? 'success' : w.status === 'rejected' ? 'danger' : 'muted'}>
                  {w.status}
                </Badge>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <style jsx>{`
        .input { width: 100%; height: 48px; padding: 0 1rem; font-size: 16px; border-radius: 0.875rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
        .input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
      `}</style>
    </div>
  );
}
