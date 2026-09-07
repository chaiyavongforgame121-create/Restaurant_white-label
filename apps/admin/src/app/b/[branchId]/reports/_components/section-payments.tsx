'use client';

import * as React from 'react';
import Link from 'next/link';
import { Banknote, CreditCard, QrCode, Undo2, Wallet } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { formatCurrency } from '@favornoms/shared';
import { Kpi } from './kpi';
import { Caption, EmptyNote, SectionFrame } from './section-frame';
import type { PaymentsReport, SectionResult } from './report-queries';

// "QR transfer" is the merchant's own word for the bank-transfer-with-a-slip flow that
// decide_payment_proof settles. `transfer` is only ever the column name.
const METHOD_LABELS: Record<string, string> = {
  card: 'Card',
  cash: 'Cash',
  transfer: 'QR transfer',
};

const STATUS_LABELS: Record<string, string> = {
  completed: 'Success',
  pending: 'Pending',
  failed: 'Failed',
  refunded: 'Refunded',
  voided: 'Voided',
};

// Reading order for the grid. Anything payment_status gains later falls in at the end
// rather than being dropped, which is why the columns come from the rows and not a literal.
const STATUS_ORDER = ['completed', 'pending', 'failed', 'refunded', 'voided'];

export function SectionPayments({
  result,
  currency,
  branchId,
}: {
  result: SectionResult<PaymentsReport>;
  currency: string;
  branchId: string;
}) {
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);

  const statuses = React.useMemo(() => {
    const seen = Array.from(new Set((data?.by_method_status ?? []).map((c) => c.status)));
    return seen.sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a);
      const bi = STATUS_ORDER.indexOf(b);
      return (ai === -1 ? STATUS_ORDER.length : ai) - (bi === -1 ? STATUS_ORDER.length : bi);
    });
  }, [data]);

  const methods = React.useMemo(
    () => Array.from(new Set((data?.by_method_status ?? []).map((c) => c.method))),
    [data],
  );

  const cell = (method: string, status: string) =>
    data?.by_method_status.find((c) => c.method === method && c.status === status);

  return (
    <SectionFrame
      id="payments"
      title="Payments & refunds"
      icon={<Wallet className="h-5 w-5" />}
      caption="Every payment attached to an order taken in this range, by method and state."
      error={result.error ?? (data ? null : 'No payments payload was returned.')}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              icon={<Wallet className="h-5 w-5" />}
              label="Settled"
              value={money(data.totals.settled)}
              hint={`${data.totals.payments} payments`}
              tone="success"
            />
            <Kpi
              icon={<CreditCard className="h-5 w-5" />}
              label="Pending"
              value={money(data.totals.pending)}
              hint="Not charged yet, not lost"
              tone="warning"
            />
            <Kpi
              icon={<Banknote className="h-5 w-5" />}
              label="Failed"
              value={money(data.totals.failed)}
              tone={data.totals.failed > 0 ? 'danger' : 'neutral'}
            />
            <Kpi
              icon={<Undo2 className="h-5 w-5" />}
              label="Refunded"
              value={money(data.totals.refunds)}
              hint={`${data.totals.refund_count} refunds`}
              tone="danger"
            />
          </div>

          <Card className="mt-4 p-5">
            <h3 className="font-display text-lg font-semibold">By method and state</h3>
            {methods.length === 0 ? (
              <EmptyNote>No payment was taken in this range.</EmptyNote>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="pb-2 font-normal">Method</th>
                      {statuses.map((s) => (
                        <th key={s} className="pb-2 text-right font-normal">
                          {STATUS_LABELS[s] ?? s}
                        </th>
                      ))}
                      <th className="pb-2 text-right font-normal">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {methods.map((m) => {
                      const summary = data.by_method.find((x) => x.method === m);
                      return (
                        <tr key={m} className="border-t border-border">
                          <td className="py-2 pr-2 font-semibold">
                            <span className="inline-flex items-center gap-2">
                              {m === 'transfer' ? (
                                <QrCode className="h-4 w-4 text-muted-foreground" />
                              ) : m === 'cash' ? (
                                <Banknote className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <CreditCard className="h-4 w-4 text-muted-foreground" />
                              )}
                              {METHOD_LABELS[m] ?? m}
                            </span>
                          </td>
                          {statuses.map((s) => {
                            const c = cell(m, s);
                            const count = c?.count ?? 0;
                            return (
                              <td key={s} className="py-2 pr-2 text-right">
                                <span
                                  className={`block font-semibold tabular-nums ${
                                    count === 0 ? 'text-muted-foreground' : ''
                                  }`}
                                >
                                  {money(c?.amount ?? 0)}
                                </span>
                                <span className="block text-[11px] text-muted-foreground">
                                  {count} payment{count === 1 ? '' : 's'}
                                </span>
                              </td>
                            );
                          })}
                          <td className="py-2 text-right font-display font-bold tabular-nums">
                            {money(summary?.amount ?? 0)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <Caption>
              A card payment sitting in Pending has not been charged — no card gateway key is
              configured yet, so those rows are waiting rather than failing.
            </Caption>
          </Card>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">Refunds</h3>
              <dl className="mt-3 space-y-1.5 text-sm">
                <PayRow label="Refunded to diners" value={money(data.totals.refunds)} />
                <PayRow label="Refund events" value={data.totals.refund_count.toString()} />
                <PayRow
                  label="Marked refunded on the payment"
                  value={money(data.totals.refunded_on_payments)}
                />
                <PayRow label="Voided payments" value={money(data.totals.voided_on_payments)} />
              </dl>
              <Caption>
                A refund is recorded against the order, not against the payment, so the
                Refunded column in the grid above reads zero by design. The figure to trust is
                the first line here.
              </Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">Awaiting settlement</h3>
              <p className="mt-3 font-display text-3xl font-bold tabular-nums">
                {money(data.totals.unsettled_on_completed_orders)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Orders already handed to the diner whose payment is still pending.
              </p>
              <p className="mt-3 text-sm">
                <Link
                  href={`/counter/${branchId}/recent`}
                  className="focus-ring font-semibold underline"
                >
                  Settle these at the counter
                </Link>
              </p>
              <dl className="mt-4 space-y-1.5 text-sm">
                <PayRow
                  label="Service fees collected"
                  value={money(data.totals.service_fee_collected)}
                />
                <PayRow
                  label="Settled by the historical backfill"
                  value={data.totals.backfilled_settlements.toString()}
                />
              </dl>
            </Card>
          </div>
        </>
      ) : null}
    </SectionFrame>
  );
}

function PayRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
