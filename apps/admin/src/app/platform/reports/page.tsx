import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { formatCurrency } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';
import { PlatformAccessDenied, PlatformNav } from '../_components/platform-nav';

interface Summary {
  mrr: number;
  active_subs: number;
  trialing_subs: number;
  past_due_subs: number;
  cancelled_subs: number;
  total_restaurants: number;
  paying_restaurants: number;
  by_plan: { plan_code: string; count: number; mrr: number }[];
  driver_payouts_accrued: number;
  driver_payouts_paid: number;
  orders_last_30d: number;
  gmv_last_30d: number;
  restaurants: { name: string; slug: string; plan: string; status: string; mrr: number; created_at: string }[];
}

export default async function PlatformReportsPage() {
  const supabase = await getServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/platform/reports');

  const { data, error } = await supabase.rpc('platform_financial_summary');
  if (error) return <PlatformAccessDenied />;
  const s = (data ?? {}) as unknown as Summary;
  const mrr = Number(s.mrr ?? 0);

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-2">
        <h1 className="font-display text-3xl font-bold">Financial reports</h1>
        <p className="mt-1 text-muted-foreground">
          Subscription revenue (your platform income) and platform-wide activity.
        </p>
      </header>
      <PlatformNav />

      {/* Revenue headline */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="MRR" value={formatCurrency(mrr)} accent />
        <Stat label="ARR (run-rate)" value={formatCurrency(mrr * 12)} />
        <Stat label="Paying restaurants" value={`${s.paying_restaurants ?? 0} / ${s.total_restaurants ?? 0}`} />
        <Stat
          label="ARPA"
          value={formatCurrency(s.paying_restaurants ? mrr / s.paying_restaurants : 0)}
        />
      </div>

      {/* Subscription status */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active" value={String(s.active_subs ?? 0)} />
        <Stat label="Trialing" value={String(s.trialing_subs ?? 0)} />
        <Stat label="Past due" value={String(s.past_due_subs ?? 0)} warn={Number(s.past_due_subs) > 0} />
        <Stat label="Cancelled" value={String(s.cancelled_subs ?? 0)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* MRR by plan */}
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">MRR by plan</h2>
          <div className="mt-3 space-y-2">
            {(s.by_plan ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No paid subscriptions yet.</p>
            )}
            {(s.by_plan ?? []).map((p) => {
              const pct = mrr > 0 ? Math.round((Number(p.mrr) / mrr) * 100) : 0;
              return (
                <div key={p.plan_code}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium capitalize">{p.plan_code}</span>
                    <span className="text-muted-foreground">
                      {p.count} · {formatCurrency(Number(p.mrr))}/mo
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Platform activity */}
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">Platform activity (30 days)</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Orders" value={String(s.orders_last_30d ?? 0)} />
            <Row label="GMV (completed)" value={formatCurrency(Number(s.gmv_last_30d ?? 0))} />
            <Row label="Driver payouts — unpaid" value={formatCurrency(Number(s.driver_payouts_accrued ?? 0))} />
            <Row label="Driver payouts — paid" value={formatCurrency(Number(s.driver_payouts_paid ?? 0))} />
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            GMV flows to restaurants (they take payment); driver payouts are settled by restaurants. Your
            revenue is the subscription MRR above.
          </p>
        </Card>
      </div>

      {/* Per-restaurant */}
      <Card className="mt-6 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-5 py-3">Restaurant</th>
                <th className="px-5 py-3">Plan</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right">MRR</th>
              </tr>
            </thead>
            <tbody>
              {(s.restaurants ?? []).map((r) => (
                <tr key={r.slug} className="border-t border-border/40">
                  <td className="px-5 py-3 font-semibold">{r.name}</td>
                  <td className="px-5 py-3 capitalize">{r.plan}</td>
                  <td className="px-5 py-3">
                    <Badge variant={r.status === 'active' ? 'success' : r.status === 'trialing' ? 'warning' : 'muted'}>
                      {r.status}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-right font-medium">{formatCurrency(Number(r.mrr))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value, accent, warn }: { label: string; value: string; accent?: boolean; warn?: boolean }) {
  return (
    <Card className={`p-4 ${accent ? 'border-primary shadow-warm' : ''}`}>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 font-display text-2xl font-bold ${warn ? 'text-danger' : accent ? 'text-primary' : ''}`}>
        {value}
      </p>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
