import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { featureLabel, formatCurrency } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';
import { PlatformAccessDenied, PlatformNav } from '../_components/platform-nav';

interface Summary {
  mrr: number;
  arr: number;
  /** What today's trials would add per month if every one converted at Base. */
  trial_pipeline_mrr: number;
  active_subs: number;
  trialing_subs: number;
  past_due_subs: number;
  cancelled_subs: number;
  expired_subs: number;
  total_restaurants: number;
  paying_restaurants: number;
  entitled_restaurants: number;
  branch_seats_sold: number;
  branches_used: number;
  pending_requests: number;
  by_plan: { plan_code: string; count: number; mrr: number }[];
  by_addon: { code: string; name: string; count: number; mrr: number }[];
  driver_payouts_accrued: number;
  driver_payouts_paid: number;
  orders_last_30d: number;
  gmv_last_30d: number;
  restaurants: {
    restaurant_id: string;
    name: string;
    slug: string;
    plan: string;
    status: string;
    mrr: number;
    addons: string[];
    branch_seats: number;
    branches_used: number;
    entitled: boolean;
    trial_ends_at: string | null;
    created_at: string;
  }[];
}

function statusVariant(status: string) {
  if (status === 'active') return 'success' as const;
  if (status === 'trialing') return 'warning' as const;
  if (status === 'past_due') return 'danger' as const;
  return 'muted' as const;
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
  const seatsSold = Number(s.branch_seats_sold ?? 0);
  const pending = Number(s.pending_requests ?? 0);

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-2">
        <h1 className="font-display text-3xl font-bold">Financial reports</h1>
        <p className="mt-1 text-muted-foreground">
          Subscription revenue (your platform income) and platform-wide activity.
        </p>
      </header>
      <PlatformNav />

      {/* Revenue headline. ARR comes from the RPC rather than mrr × 12 so the
          two never disagree if the definition of run-rate changes. */}
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="MRR" value={formatCurrency(mrr)} accent />
        <Stat label="ARR (run-rate)" value={formatCurrency(Number(s.arr ?? 0))} />
        <Stat label="Paying restaurants" value={`${s.paying_restaurants ?? 0} / ${s.total_restaurants ?? 0}`} />
        <Stat label="ARPA" value={formatCurrency(s.paying_restaurants ? mrr / s.paying_restaurants : 0)} />
      </div>

      {/* Trial pipeline is the number that matters most pre-revenue: it is the
          MRR sitting in 14-day trials that has not converted yet. */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Trial pipeline" value={formatCurrency(Number(s.trial_pipeline_mrr ?? 0))} />
        <Stat label="Serving customers" value={`${s.entitled_restaurants ?? 0} / ${s.total_restaurants ?? 0}`} />
        <Stat label="Branch seats" value={`${s.branches_used ?? 0} used / ${seatsSold} sold`} />
        <Stat
          label="Pending requests"
          value={String(pending)}
          warn={pending > 0}
          href={pending > 0 ? '/platform/requests' : undefined}
        />
      </div>

      {/* Subscription status */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Active" value={String(s.active_subs ?? 0)} />
        <Stat label="Trialing" value={String(s.trialing_subs ?? 0)} />
        <Stat label="Past due" value={String(s.past_due_subs ?? 0)} warn={Number(s.past_due_subs) > 0} />
        <Stat label="Expired" value={String(s.expired_subs ?? 0)} warn={Number(s.expired_subs) > 0} />
        <Stat label="Cancelled" value={String(s.cancelled_subs ?? 0)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* MRR by plan */}
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">MRR by plan</h2>
          <div className="mt-3 space-y-2">
            {(s.by_plan ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No subscriptions yet.</p>
            )}
            {(s.by_plan ?? []).map((p) => (
              <MrrBar
                key={p.plan_code}
                label={p.plan_code === 'base' ? 'Base' : p.plan_code}
                count={p.count}
                value={Number(p.mrr)}
                total={mrr}
              />
            ))}
          </div>
        </Card>

        {/* MRR by add-on — how much of the take is Delivery / AI Suite / seats,
            which is what decides where the next build effort goes. */}
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">MRR by add-on</h2>
          <div className="mt-3 space-y-2">
            {(s.by_addon ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No add-ons sold yet.</p>
            )}
            {(s.by_addon ?? []).map((a) => (
              <MrrBar key={a.code} label={a.name} count={a.count} value={Number(a.mrr)} total={mrr} />
            ))}
          </div>
        </Card>
      </div>

      {/* Platform activity */}
      <Card className="mt-6 p-5">
        <h2 className="font-display text-lg font-semibold">Platform activity (30 days)</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2 sm:gap-x-8">
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

      {/* Per-restaurant */}
      <Card className="mt-6 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-5 py-3">Restaurant</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Add-ons</th>
                <th className="px-5 py-3">Branches</th>
                <th className="px-5 py-3 text-right">MRR</th>
              </tr>
            </thead>
            <tbody>
              {(s.restaurants ?? []).map((r) => {
                const overSeats = r.branches_used > r.branch_seats;
                return (
                  <tr key={r.slug} className="border-t border-border/40">
                    <td className="px-5 py-3">
                      <span className="font-semibold">{r.name}</span>
                      {/* `entitled` is the only field that says whether this
                          restaurant can actually trade right now — status alone
                          does not (a cancelled sub stays entitled until the
                          paid period runs out). */}
                      {!r.entitled && (
                        <Badge variant="danger" className="ml-2 px-2 py-0.5 text-[10px]">
                          suspended
                        </Badge>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                      {r.status === 'trialing' && r.trial_ends_at && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          ends {new Date(r.trial_ends_at).toLocaleDateString('en-US')}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {(r.addons ?? []).length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {(r.addons ?? []).map((a) => (
                            <Badge key={a} variant="accent" className="px-2 py-0.5 text-[10px]">
                              {featureLabel(a)}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className={`px-5 py-3 ${overSeats ? 'font-semibold text-danger' : ''}`}>
                      {r.branches_used} / {r.branch_seats}
                    </td>
                    <td className="px-5 py-3 text-right font-medium">{formatCurrency(Number(r.mrr))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function MrrBar({
  label,
  count,
  value,
  total,
}: {
  label: string;
  count: number;
  value: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium capitalize">{label}</span>
        <span className="text-muted-foreground">
          {count} · {formatCurrency(value)}/mo
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  warn,
  href,
}: {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
  href?: string;
}) {
  const card = (
    <Card
      className={`p-4 ${accent ? 'border-primary shadow-warm' : ''} ${href ? 'transition hover:border-primary' : ''}`}
    >
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 font-display text-2xl font-bold ${warn ? 'text-danger' : accent ? 'text-primary' : ''}`}>
        {value}
      </p>
    </Card>
  );
  return href ? <Link href={href}>{card}</Link> : card;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
