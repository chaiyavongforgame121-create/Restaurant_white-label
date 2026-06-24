'use client';

import * as React from 'react';
import { Award, Gift, History } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import {
  getMyLoyalty,
  listMyLoyaltyTransactions,
  type LoyaltyTxRow,
} from '@favornoms/database/queries';
import { Badge, Card } from '@favornoms/ui';
import { useAuth } from '@/components/auth/use-auth';
import { AccountHeader, SignInGate } from '../../_components/account-ui';

type Loyalty = NonNullable<Awaited<ReturnType<typeof getMyLoyalty>>>;

export function LoyaltyView({
  base,
  brandName,
  branchId,
}: {
  base: string;
  brandName: string;
  branchId: string;
}) {
  const { user, loading } = useAuth();
  const [loyalty, setLoyalty] = React.useState<Loyalty | null>(null);
  const [txns, setTxns] = React.useState<LoyaltyTxRow[]>([]);
  const [busy, setBusy] = React.useState(true);

  React.useEffect(() => {
    if (!user) {
      setBusy(false);
      return;
    }
    const supabase = getBrowserClient();
    setBusy(true);
    void Promise.all([
      getMyLoyalty(supabase, branchId),
      listMyLoyaltyTransactions(supabase, branchId, 30),
    ]).then(([l, t]) => {
      setLoyalty(l);
      setTxns(t);
      setBusy(false);
    });
  }, [user, branchId]);

  const balance = loyalty?.points_balance ?? 0;

  return (
    <div className="container max-w-2xl pb-24 pt-4">
      <AccountHeader base={base} title="Loyalty & rewards" />
      {loading ? null : !user ? (
        <SignInGate base={base} message={`Sign in to see your ${brandName} points and rewards.`} />
      ) : (
        <div className="space-y-5">
          <Card className="overflow-hidden p-0">
            <div className="bg-gradient-warm p-6 text-white">
              <p className="text-sm text-white/80">Your points</p>
              <p className="font-display text-5xl font-bold leading-tight">{balance.toLocaleString()}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant="solid" className="bg-white/25 capitalize text-white">
                  <Award className="h-3 w-3" /> {loyalty?.tier ?? 'bronze'} member
                </Badge>
                <span className="text-xs text-white/80">
                  worth {formatCurrency(balance / 100)} off your next order
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 divide-x divide-border text-center">
              <Stat label="Lifetime earned" value={(loyalty?.lifetime_earned ?? 0).toLocaleString()} />
              <Stat label="Lifetime redeemed" value={(loyalty?.lifetime_spent ?? 0).toLocaleString()} />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <Gift className="h-5 w-5 text-primary" /> How points work
            </h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>Earn points on every order you place.</li>
              <li>
                Redeem at checkout —{' '}
                <strong className="text-foreground">100 points = {formatCurrency(1)} off</strong> (up to
                50% of your subtotal).
              </li>
              <li>Keep ordering to climb tiers and unlock more perks.</li>
            </ul>
          </Card>

          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <History className="h-5 w-5 text-primary" /> Recent activity
            </h2>
            {busy ? (
              <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
            ) : txns.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No points activity yet — your first order will start earning.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {txns.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium capitalize">
                        {t.description ?? t.type.replace(/_/g, ' ')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(t.created_at).toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 font-display text-base font-bold tabular-nums ${
                        t.points >= 0 ? 'text-success' : 'text-muted-foreground'
                      }`}
                    >
                      {t.points >= 0 ? '+' : ''}
                      {t.points.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-4">
      <p className="font-display text-xl font-bold text-primary">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
