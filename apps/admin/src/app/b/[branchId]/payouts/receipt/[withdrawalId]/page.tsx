import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { formatCurrency } from '@favornoms/shared';
import { Card } from '@favornoms/ui';
import { PrintButton } from '../../_components/print-button';

interface Props {
  params: Promise<{ branchId: string; withdrawalId: string }>;
}

export default async function WithdrawalReceiptPage({ params }: Props) {
  const { branchId, withdrawalId } = await params;
  const supabase = await getServerClient();

  const { data: withdrawal } = await supabase
    .from('driver_withdrawals')
    .select('id, amount, bank_name, account_number, account_name, paid_at, receipt_number, drivers(full_name)')
    .eq('id', withdrawalId)
    .eq('branch_id', branchId)
    .eq('status', 'paid')
    .maybeSingle();
  if (!withdrawal) notFound();
  // PostgREST returns the to-one `drivers` embed as an object at runtime; normalize
  // against the array fallback typing (same idiom as kitchen/live-ops views).
  const embed = withdrawal.drivers as { full_name: string } | { full_name: string }[] | null;
  const driverName = (Array.isArray(embed) ? embed[0]?.full_name : embed?.full_name) ?? 'Driver';

  const [{ data: branch }, { data: items }] = await Promise.all([
    supabase.from('branches').select('name, address').eq('id', branchId).maybeSingle(),
    supabase
      .from('driver_earnings_ledger')
      .select('id, delivered_at, base_pay, distance_pay, tip_net, total')
      .eq('withdrawal_id', withdrawalId)
      .order('delivered_at', { ascending: true }),
  ]);
  const lines = items ?? [];

  return (
    <div className="container max-w-2xl py-8">
      {/* Print only the receipt itself, not the sidebar/app chrome around it. */}
      <style>{`@media print {
        body * { visibility: hidden; }
        #withdrawal-receipt, #withdrawal-receipt * { visibility: visible; }
        #withdrawal-receipt { position: absolute; left: 0; top: 0; width: 100%; margin: 0; border: none; box-shadow: none; }
        #withdrawal-receipt .print-hide { display: none; }
      }`}</style>

      <div className="mb-4 flex items-center justify-between px-2 pl-16 lg:px-0">
        <Link
          href={`/b/${branchId}/payouts`}
          className="focus-ring text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          ← Back to payouts
        </Link>
        <PrintButton />
      </div>

      <Card id="withdrawal-receipt" className="mx-2 bg-card p-6 lg:mx-0 lg:p-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold">Payout receipt</h1>
            <p className="mt-1 text-sm text-muted-foreground">Receipt {withdrawal.receipt_number ?? '—'}</p>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <p>Paid {withdrawal.paid_at ? new Date(withdrawal.paid_at).toLocaleString() : '—'}</p>
          </div>
        </header>

        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Paid by</p>
            <p className="mt-1 font-medium">{branch?.name ?? 'Branch'}</p>
            {branch?.address && <p className="text-sm text-muted-foreground">{branch.address}</p>}
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Paid to</p>
            <p className="mt-1 font-medium">{driverName}</p>
            <p className="text-sm text-muted-foreground">
              {withdrawal.bank_name} ··{withdrawal.account_number.slice(-4)} · {withdrawal.account_name}
            </p>
          </div>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="py-2 pr-2 font-semibold">Delivered</th>
              <th className="py-2 pr-2 text-right font-semibold">Base</th>
              <th className="py-2 pr-2 text-right font-semibold">Distance</th>
              <th className="py-2 pr-2 text-right font-semibold">Tip</th>
              <th className="py-2 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-border/50">
                <td className="py-2 pr-2">{new Date(l.delivered_at).toLocaleString()}</td>
                <td className="py-2 pr-2 text-right">{formatCurrency(Number(l.base_pay))}</td>
                <td className="py-2 pr-2 text-right">{formatCurrency(Number(l.distance_pay))}</td>
                <td className="py-2 pr-2 text-right">{formatCurrency(Number(l.tip_net))}</td>
                <td className="py-2 text-right font-medium">
                  {formatCurrency(Number(l.total ?? Number(l.base_pay) + Number(l.distance_pay) + Number(l.tip_net)))}
                </td>
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-muted-foreground">
                  No line items recorded.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} className="py-3 pr-2 text-right font-display text-base font-semibold">
                Grand total
              </td>
              <td className="py-3 text-right font-display text-base font-bold">
                {formatCurrency(Number(withdrawal.amount))}
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </div>
  );
}
