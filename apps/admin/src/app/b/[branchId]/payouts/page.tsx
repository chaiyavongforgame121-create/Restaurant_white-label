import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { getServerClient } from '@favornoms/database/server';
import { DEFAULT_UI_LOCALE, formatCurrency, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';
import { PAYOUT_SUMMARY_WEEKS, resolveDeliveryGate } from '@/lib/delivery-gate';
import { DeliveryLocked, DeliveryStoppedNotice } from '@/components/delivery-locked';
import { PayoutAttachments } from './_components/payout-attachments';
import { fetchPayoutMedia } from './_components/payout-media';
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
  const [t, locale] = await Promise.all([getTranslations('payouts'), getLocale()]);
  const intlLocale = intlLocaleFor(isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);

  const WITHDRAWAL_COLS =
    'id, amount, status, bank_name, account_number, account_name, created_at, paid_at, receipt_number, rejection_reason, drivers(full_name)';
  // This screen never asked whether the branch sells delivery — it had no capability check
  // either — so it worked for any branch by URL. Delivery is per branch now, and the
  // question is asked for THIS branch. The name is read alongside it: the locked screen
  // says which branch does not deliver, not "your add-on is gone".
  const [gate, { data: branchRow }] = await Promise.all([
    resolveDeliveryGate(supabase, branchId),
    supabase.from('branches').select('name').eq('id', branchId).maybeSingle(),
  ]);
  const branchName = branchRow?.name ?? '';

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
    supabase.rpc('get_branch_payout_summary', { p_branch_id: branchId, p_weeks: PAYOUT_SUMMARY_WEEKS }),
  ]);

  // PostgREST returns the to-one `drivers` embed as an object at runtime; normalize
  // against the array fallback typing (same idiom as kitchen/live-ops views).
  const normalize = (rows: NonNullable<typeof pendingData>) =>
    rows.map((w) => {
      const d = w.drivers as { full_name: string } | { full_name: string }[] | null;
      return {
        ...w,
        driver_name: (Array.isArray(d) ? d[0]?.full_name : d?.full_name) ?? t('driverFallback'),
      };
    });
  const pending = normalize(pendingData ?? []);
  const settled = normalize(settledData ?? []);
  const rows = (summaryData ?? []) as SummaryRow[];
  // Money already earned is not cancelled by a plan change: a rider who finished runs here
  // is still owed, and a withdrawal they have already asked for still has to be settled.
  // So the screen locks only once there is nothing outstanding — otherwise it stays open
  // with a line saying why. This is hasRidersOwed's rule (lib/delivery-gate.ts) — a pending
  // withdrawal, or accrued earnings in the same PAYOUT_SUMMARY_WEEKS this page lists — read
  // off the rows the page already has, so the sidebar entry the layout shows from that helper
  // always leads to an open screen.
  const owing = pending.length > 0 || rows.some((r) => Number(r.accrued_total) > 0);
  if (!gate.delivers && !owing) {
    return <DeliveryLocked branchId={branchId} branchName={branchName} gate={gate} />;
  }

  // The rider's receiving QR and the transfer slip, fetched once the rows above have settled
  // which withdrawals are actually on screen.
  const media = await fetchPayoutMedia(supabase, [...pending, ...settled].map((w) => w.id));

  return (
    <>
      {!gate.delivers && (
        <DeliveryStoppedNotice
          branchName={branchName}
          planHref={gate.planHref}
          body={t('notOffered.stillOwed')}
        />
      )}
      <div className="container max-w-4xl py-8">
        <header className="mb-6 px-2 pl-16 lg:px-0">
          <h1 className="font-display text-3xl font-bold">{t('page.title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('page.subtitle')}</p>
        </header>

        <section className="mb-8 px-2 lg:px-0">
          <h2 className="mb-3 font-display text-xl font-semibold">{t('page.requestsTitle')}</h2>
          {pending.length === 0 && settled.length === 0 ? (
            <Card className="p-8 text-center text-muted-foreground">{t('page.noRequests')}</Card>
          ) : (
            <ul className="space-y-3">
              {pending.map((w) => (
                <li key={w.id}>
                  <Card className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-display text-lg font-semibold">{w.driver_name}</p>
                          <Badge variant="warning">{t('status.pending')}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {t('page.requested', {
                            date: new Date(w.created_at).toLocaleString(intlLocale),
                          })}
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
                          slipAttached={!!media.get(w.id)?.slipPath}
                        />
                      </div>
                    </div>
                    <PayoutAttachments
                      withdrawalId={w.id}
                      qrPath={media.get(w.id)?.qrPath ?? null}
                      slipPath={media.get(w.id)?.slipPath ?? null}
                      canAttach
                    />
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
                          {t('page.requested', {
                            date: new Date(w.created_at).toLocaleDateString(intlLocale),
                          })}{' '}
                          · {w.bank_name} ··
                          {w.account_number.slice(-4)}
                        </p>
                        {w.status === 'rejected' && w.rejection_reason && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t('page.reason', { reason: w.rejection_reason })}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className="font-display text-lg font-bold">{formatCurrency(Number(w.amount))}</span>
                        {w.status === 'paid' ? (
                          <>
                            <Badge variant="success">{t('status.paid')}</Badge>
                            {w.receipt_number && (
                              <Link
                                href={`/b/${branchId}/payouts/receipt/${w.id}`}
                                className="focus-ring text-sm font-medium text-primary underline-offset-2 hover:underline"
                              >
                                {t('receiptNumber', { number: w.receipt_number })}
                              </Link>
                            )}
                          </>
                        ) : (
                          <Badge variant="danger">{t('status.rejected')}</Badge>
                        )}
                      </div>
                    </div>
                    {w.status === 'paid' && (
                      // A merchant who transferred first and screenshotted second can still file
                      // the slip after the fact; a rejected request has no transfer behind it.
                      <PayoutAttachments
                        withdrawalId={w.id}
                        qrPath={media.get(w.id)?.qrPath ?? null}
                        slipPath={media.get(w.id)?.slipPath ?? null}
                        canAttach
                      />
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="px-2 lg:px-0">
          <h2 className="mb-1 font-display text-xl font-semibold">{t('page.summaryTitle')}</h2>
          <p className="mb-3 text-sm text-muted-foreground">{t('page.summaryHint')}</p>
          {rows.length === 0 ? (
            <Card className="p-8 text-center text-muted-foreground">{t('page.noEarnings')}</Card>
          ) : (
            <ul className="space-y-3">
              {rows.map((r) => (
                <li key={`${r.driver_id}-${r.payout_period_start}`}>
                  <Card className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-display text-lg font-semibold">{r.driver_name}</p>
                        <p className="text-sm text-muted-foreground">
                          {t('page.weekOf', {
                            date: new Date(r.payout_period_start).toLocaleDateString(intlLocale),
                            count: r.delivery_count,
                          })}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t('page.breakdown', {
                            base: formatCurrency(Number(r.base_total)),
                            distance: formatCurrency(Number(r.distance_total)),
                            tips: formatCurrency(Number(r.tip_total)),
                          })}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <span className="font-display text-xl font-bold">{formatCurrency(Number(r.grand_total))}</span>
                        {Number(r.accrued_total) > 0 ? (
                          <Badge variant="warning">
                            {t('page.unpaid', { amount: formatCurrency(Number(r.accrued_total)) })}
                          </Badge>
                        ) : (
                          <Badge variant="success">{t('status.paid')}</Badge>
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
    </>
  );
}
