import { getServerClient } from '@favornoms/database/server';
import { formatCurrency } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';
import { MarkPaidButton } from './_components/mark-paid-button';

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
  const { data } = await supabase.rpc('get_branch_payout_summary', {
    p_branch_id: branchId,
    p_weeks: 8,
  });
  const rows = (data ?? []) as SummaryRow[];

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Driver payouts</h1>
        <p className="mt-1 text-muted-foreground">
          Weekly settlement owed to drivers for completed deliveries.
        </p>
      </header>

      {rows.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">No driver earnings yet.</Card>
      ) : (
        <ul className="space-y-3 px-2 lg:px-0">
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
                      <>
                        <Badge variant="warning">{formatCurrency(Number(r.accrued_total))} unpaid</Badge>
                        <MarkPaidButton
                          branchId={branchId}
                          driverId={r.driver_id}
                          periodStart={r.payout_period_start}
                          amount={Number(r.accrued_total)}
                        />
                      </>
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
    </div>
  );
}
