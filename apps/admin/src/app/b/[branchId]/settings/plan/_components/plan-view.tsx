'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Sparkles } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

interface PlanRow {
  code: string;
  name: string;
  monthly_price: number | string;
  limits: { max_items?: number; max_branches?: number; max_orders_per_month?: number };
}

interface PlanStatus {
  plan: string;
  branches: { allowed: boolean; limit: number; current: number | null };
  items: { allowed: boolean; limit: number; current: number | null };
  orders_per_month: { allowed: boolean; limit: number; current: number | null };
}

interface Props {
  branchId: string;
  restaurantId: string;
  plans: PlanRow[];
  status: PlanStatus | null;
}

export function PlanView({ branchId, restaurantId, plans, status }: Props) {
  const router = useRouter();
  const [busyCode, setBusyCode] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const upgrade = async (code: string) => {
    if (status?.plan === code) return;
    if (!window.confirm(`Upgrade to ${code}? (Stripe billing not yet wired — this only switches the in-app plan record.)`)) return;
    setBusyCode(code);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const { error: rpcErr } = await supabase.rpc('upgrade_plan', {
        p_restaurant_id: restaurantId,
        p_plan_code: code,
      });
      if (rpcErr) {
        setError(rpcErr.message);
        return;
      }
      router.refresh();
    } finally {
      setBusyCode(null);
    }
  };

  const fmtLimit = (n?: number) => (n === -1 ? 'Unlimited' : n?.toLocaleString() ?? '—');

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Plan & billing</h1>
        <p className="mt-1 text-muted-foreground">Manage your subscription and feature limits.</p>
      </header>

      {status && (
        <Card className="mb-6 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Current plan</p>
              <p className="mt-1 font-display text-2xl font-bold capitalize">{status.plan}</p>
            </div>
            <div className="grid grid-cols-3 gap-4 text-center">
              <Usage label="Branches" current={status.branches.current} limit={status.branches.limit} />
              <Usage label="Active items" current={status.items.current} limit={status.items.limit} />
              <Usage label="Orders / mo" current={status.orders_per_month.current} limit={status.orders_per_month.limit} />
            </div>
          </div>
        </Card>
      )}

      {error && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => {
          const isCurrent = status?.plan === plan.code;
          return (
            <Card
              key={plan.code}
              className={`flex flex-col p-5 ${isCurrent ? 'border-primary shadow-warm' : ''}`}
            >
              <div className="flex items-baseline justify-between">
                <h3 className="font-display text-xl font-bold">{plan.name}</h3>
                {isCurrent && <Badge variant="solid">Current</Badge>}
              </div>
              <p className="mt-2 font-display text-3xl font-bold">
                ${Number(plan.monthly_price).toFixed(0)}
                <span className="ml-1 text-sm font-normal text-muted-foreground">/ month</span>
              </p>
              <ul className="mt-4 space-y-2 text-sm">
                <Feature>{fmtLimit(plan.limits.max_branches)} branches</Feature>
                <Feature>{fmtLimit(plan.limits.max_items)} active menu items</Feature>
                <Feature>{fmtLimit(plan.limits.max_orders_per_month)} orders / month</Feature>
                {plan.code !== 'free' && <Feature>Email + SMS notifications</Feature>}
                {(plan.code === 'pro' || plan.code === 'enterprise') && <Feature>Web push notifications</Feature>}
                {(plan.code === 'pro' || plan.code === 'enterprise') && <Feature>AI menu import</Feature>}
                {plan.code === 'enterprise' && <Feature>Priority support + SLA</Feature>}
              </ul>
              <Button
                variant={isCurrent ? 'outline' : 'gradient'}
                fullWidth
                className="mt-5"
                disabled={isCurrent}
                loading={busyCode === plan.code}
                onClick={() => upgrade(plan.code)}
                leftIcon={!isCurrent ? <Sparkles className="h-4 w-4" /> : undefined}
              >
                {isCurrent ? 'Active' : plan.code === 'free' ? 'Downgrade' : 'Upgrade'}
              </Button>
            </Card>
          );
        })}
      </div>

      <p className="mt-8 text-xs text-muted-foreground">
        Stripe billing integration is on the roadmap. For now, upgrades take effect immediately in
        the app; you&apos;ll need to handle the customer-side charge separately until Stripe Billing
        is wired up.
      </p>
    </div>
  );
}

function Usage({ label, current, limit }: { label: string; current: number | null; limit: number }) {
  const pct = limit > 0 && current != null ? Math.min(100, Math.round((current / limit) * 100)) : 0;
  return (
    <div className="min-w-[7rem]">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-display text-base font-bold">
        {current ?? '—'} / {limit === -1 ? '∞' : limit}
      </p>
      {limit > 0 && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      <span>{children}</span>
    </li>
  );
}
