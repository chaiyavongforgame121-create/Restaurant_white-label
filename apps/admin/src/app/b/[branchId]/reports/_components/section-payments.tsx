'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Banknote, CreditCard, QrCode, Undo2, Wallet } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { formatCurrency } from '@favornoms/shared';
import { Kpi } from './kpi';
import { Caption, EmptyNote, SectionFrame } from './section-frame';
import type { PaymentsReport, SectionResult } from './report-queries';

// "QR transfer" is the merchant's own word for the bank-transfer-with-a-slip flow that
// decide_payment_proof settles. `transfer` is only ever the column name. Method and status
// names live in reports.payments.method / .status; a code with no entry shows as-is.

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
  const t = useTranslations('reports.payments');
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);
  const methodName = (method: string) => (t.has(`method.${method}`) ? t(`method.${method}`) : method);
  const statusName = (status: string) => (t.has(`status.${status}`) ? t(`status.${status}`) : status);

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
      title={t('title')}
      icon={<Wallet className="h-5 w-5" />}
      caption={t('caption')}
      error={result.error ?? (data ? null : { code: 'emptyResponse', ref: null })}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              icon={<Wallet className="h-5 w-5" />}
              label={t('settled')}
              value={money(data.totals.settled)}
              hint={t('paymentCount', { count: data.totals.payments })}
              tone="success"
            />
            <Kpi
              icon={<CreditCard className="h-5 w-5" />}
              label={t('pending')}
              value={money(data.totals.pending)}
              hint={t('pendingHint')}
              tone="warning"
            />
            <Kpi
              icon={<Banknote className="h-5 w-5" />}
              label={t('failed')}
              value={money(data.totals.failed)}
              tone={data.totals.failed > 0 ? 'danger' : 'neutral'}
            />
            <Kpi
              icon={<Undo2 className="h-5 w-5" />}
              label={t('refunded')}
              value={money(data.totals.refunds)}
              hint={t('refundCount', { count: data.totals.refund_count })}
              tone="danger"
            />
          </div>

          <Card className="mt-4 p-5">
            <h3 className="font-display text-lg font-semibold">{t('grid')}</h3>
            {methods.length === 0 ? (
              <EmptyNote>{t('gridEmpty')}</EmptyNote>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="pb-2 font-normal">{t('col.method')}</th>
                      {statuses.map((s) => (
                        <th key={s} className="pb-2 text-right font-normal">
                          {statusName(s)}
                        </th>
                      ))}
                      <th className="pb-2 text-right font-normal">{t('col.total')}</th>
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
                              {methodName(m)}
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
                                  {t('paymentCount', { count })}
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
            <Caption>{t('gridCaption')}</Caption>
          </Card>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('refunds')}</h3>
              <dl className="mt-3 space-y-1.5 text-sm">
                <PayRow label={t('refundedToDiners')} value={money(data.totals.refunds)} />
                <PayRow label={t('refundEvents')} value={data.totals.refund_count.toString()} />
                <PayRow
                  label={t('markedRefunded')}
                  value={money(data.totals.refunded_on_payments)}
                />
                <PayRow label={t('voided')} value={money(data.totals.voided_on_payments)} />
              </dl>
              <Caption>{t('refundsCaption')}</Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('awaiting')}</h3>
              <p className="mt-3 font-display text-3xl font-bold tabular-nums">
                {money(data.totals.unsettled_on_completed_orders)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{t('awaitingBody')}</p>
              <p className="mt-3 text-sm">
                <Link
                  href={`/counter/${branchId}/recent`}
                  className="focus-ring font-semibold underline"
                >
                  {t('settleLink')}
                </Link>
              </p>
              <dl className="mt-4 space-y-1.5 text-sm">
                <PayRow
                  label={t('serviceFees')}
                  value={money(data.totals.service_fee_collected)}
                />
                <PayRow
                  label={t('backfilled')}
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
