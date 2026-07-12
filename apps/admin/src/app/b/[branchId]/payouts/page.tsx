import Link from 'next/link';
import { getServerClient } from '@favornoms/database/server';
import { formatCurrency } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';
import { WithdrawalActions } from './_components/withdrawal-actions';

interface Props {
  params: Promise<{ branchId: string }>;
}

interface SummaryRow {
  driver_id: string;
  driver_name: string;
  payout_period_start: string;
  payout_period_end: string;
  delivery_count: number;
  base_total: number;
  distance_total: number;
  tip_total: number;
  accrued_total: number;
  paid_total: number;
  grand_total: number;
}

export default async function PayoutsPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  const WITHDRAWAL_COLS =
    'id, amount, status, bank_name, account_number, account_name, created_at, paid_at, receipt_number, rejection_reason, drivers(full_name)';
  // Pending rows get their own unbounded query — they linger while newer requests
  // get settled, so a shared recency window would eventually hide them from the
  // queue while the driver stays blocked from re-requesting.
  const [{ data: pendingData }, { data: settledData }, { data: summaryData }] = await Promise.all([
    supabase
      .from('driver_withdrawals')
      .select(WITHDRAWAL_COLS)
      .eq('branch_id', branchId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
    supabase
      .from('driver_withdrawals')
      .select(WITHDRAWAL_COLS)
      .eq('branch_id', branchId)
      .neq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(10),
    supabase.rpc('get_branch_payout_summary', { p_branch_id: branchId, p_weeks: 8 }),
  ]);

  // PostgREST returns the to-one `drivers` embed as an object at runtime; normalize
  // against the array fallback typing (same idiom as kitchen/live-ops views).
  const normalize = (rows: NonNullable<typeof pendingData>) =>
    rows.map((w) => {
      const d = w.drivers as { full_name: string } | { full_name: string }[] | null;
      return { ...w, driver_name: (Array.isArray(d) ? d[0]?.full_name : d?.full_name) ?? 'Driver' };
    });
  const pending = normalize(pendingData ?? []);
  const settled = normalize(settledData ?? []);
  const rows = (summaryData ?? []) as SummaryRow[];

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Driver payouts</h1>
        <p className="mt-1 text-muted-foreground">
          Drivers request withdrawals of their accrued earnings; settle them here.
        </p>
      </header>

      <section className="mb-8 px-2 lg:px-0">
        <h2 className="mb-3 font-display text-xl font-semibold">Withdrawal requests</h2>
        {pending.length === 0 && settled.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">No withdrawal requests yet.</Card>
        ) : (
          <ul className="space-y-3">
            {pending.map((w) => (
              <li key={w.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-display text-lg font-semibold">{w.driver_name}</p>
                        <Badge variant="warning">Pending</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Requested {new Date(w.created_at).toLocaleString()}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {w.bank_name} ··{w.account_number.slice(-4)} · {w.account_name}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span className="font-display text-xl font-bold">{formatCurrency(Number(w.amount))}</span>
                      <WithdrawalActions
                        withdrawalId={w.id}
                        amount={Number(w.amount)}
                        driverName={w.driver_name}
                      />
                    </div>
                  </div>
                </Card>
              </li>
            ))}
            {settled.map((w) => (
              <li key={w.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-display text-base font-semibold">{w.driver_name}</p>
                      <p className="text-sm text-muted-foreground">
                        Requested {new Date(w.created_at).toLocaleDateString()} · {w.bank_name} ··
                        {w.account_number.slice(-4)}
                      </p>
                      {w.status === 'rejected' && w.rejection_reason && (
                        <p className="mt-1 text-xs text-muted-foreground">Reason: {w.rejection_reason}</p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="font-display text-lg font-bold">{formatCurrency(Number(w.amount))}</span>
                      {w.status === 'paid' ? (
                        <>
                          <Badge variant="success">Paid</Badge>
                          {w.receipt_number && (
                            <Link
                              href={`/b/${branchId}/payouts/receipt/${w.id}`}
                              className="focus-ring text-sm font-medium text-primary underline-offset-2 hover:underline"
                            >
                              Receipt {w.receipt_number}
                            </Link>
                          )}
                        </>
                      ) : (
                        <Badge variant="danger">Rejected</Badge>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="px-2 lg:px-0">
        <h2 className="mb-1 font-display text-xl font-semibold">Weekly summary</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Info only — drivers now request withdrawals themselves; settle them from the queue above.
        </p>
        {rows.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">No driver earnings yet.</Card>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={`${r.driver_id}-${r.payout_period_start}`}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-display text-lg font-semibold">{r.driver_name}</p>
                      <p className="text-sm text-muted-foreground">
                        Week of {new Date(r.payout_period_start).toLocaleDateString()} · {r.delivery_count} deliveries
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Base {formatCurrency(Number(r.base_total))} · Distance {formatCurrency(Number(r.distance_total))} · Tips {formatCurrency(Number(r.tip_total))}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span className="font-display text-xl font-bold">{formatCurrency(Number(r.grand_total))}</span>
                      {Number(r.accrued_total) > 0 ? (
                        <Badge variant="warning">{formatCurrency(Number(r.accrued_total))} unpaid</Badge>
                      ) : (
                        <Badge variant="success">Paid</Badge>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
