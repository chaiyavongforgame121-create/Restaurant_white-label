'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Ban, Banknote, Lock, QrCode, Receipt, RefreshCw, Unlock, Users } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import {
  TABLE_TYPES,
  closeTableSession,
  getTableSessionBill,
  listTableStates,
  openTableSession,
  setTableSessionStatus,
  settleTableSession,
  type FloorSession,
  type FloorTable,
  type TableSessionBill,
} from '@favornoms/database/queries';
import { useRealtime } from '@favornoms/database/realtime';
import { Badge, Button, Card, EmptyState, Sheet, usePrompt } from '@favornoms/ui';
import {
  buildFloor,
  elapsedTime,
  floorCounts,
  groupByZone,
  type Elapsed,
  type FloorDetailPart,
  type FloorTableState,
  type TableLabel,
} from './floor-model';

interface Props {
  branchId: string;
  branchName: string;
  initialTables: FloorTable[];
  initialSessions: FloorSession[];
  /** counter.access — seat a table, take the money, clear it down. */
  canSettle: boolean;
  /** payments.decide — walk away from a bill that has not been paid. */
  canVoid: boolean;
  /** branch.settings — the table setup screen, where the codes are printed. */
  canSetup: boolean;
}

type FloorErrorCode =
  | 'unpaidNeedsManager'
  | 'forbidden'
  | 'sessionAlreadyClosed'
  | 'tableNotFound'
  | 'generic';

/** RPC failures, as codes for words a server with a customer waiting can act on. */
function readableError(message: string): FloorErrorCode {
  if (message.includes('unpaid_needs_manager')) return 'unpaidNeedsManager';
  if (message.includes('forbidden')) return 'forbidden';
  if (message.includes('session_already_closed')) return 'sessionAlreadyClosed';
  if (message.includes('table_not_found')) return 'tableNotFound';
  // Anything else is raw database text: keep it for the logs, not for the floor.
  console.error(message);
  return 'generic';
}

const KNOWN_TABLE_TYPES: readonly string[] = TABLE_TYPES;

/**
 * Who is sitting where, and what each table owes.
 *
 * There was no table view of any kind before this: `tables.status` existed and nothing ever
 * wrote it, the kitchen printed "Table 7" on a ticket, and the only way to know what a table
 * had run up was to read the orders list and add it up by hand. The board is also the only
 * place a sitting can be ENDED — settling the bill is what makes that table's QR stop
 * ordering, so this screen is what closes the loop the diner's phone opens.
 */
export function FloorBoard({
  branchId,
  branchName,
  initialTables,
  initialSessions,
  canSettle,
  canVoid,
  canSetup,
}: Props) {
  const t = useTranslations('tables');
  const [tables, setTables] = React.useState(initialTables);
  const [sessions, setSessions] = React.useState(initialSessions);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [openTableId, setOpenTableId] = React.useState<string | null>(null);
  const [bill, setBill] = React.useState<TableSessionBill | null>(null);
  const [billLoading, setBillLoading] = React.useState(false);
  const [settleNote, setSettleNote] = React.useState<string | null>(null);
  const prompt = usePrompt();

  // Re-rendered on a timer so "Seated · 42m" keeps counting without a refetch. A minute is
  // the resolution the label has, so anything faster is only work.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const labelText = (label: TableLabel) =>
    label.kind === 'name' ? label.name : t('label.number', { number: label.number });

  const elapsedText = (elapsed: Elapsed | null | undefined) =>
    !elapsed
      ? t('elapsed.unknown')
      : elapsed.hours === 0
        ? t('elapsed.minutes', { minutes: elapsed.minutes })
        : t('elapsed.hoursMinutes', {
            hours: elapsed.hours,
            minutes: String(elapsed.minutes).padStart(2, '0'),
          });

  const badgeText = (state: FloorTableState) =>
    state.badge.code === 'seated'
      ? t('badge.seated', { elapsed: elapsedText(state.badge.elapsed) })
      : t(`badge.${state.badge.code}`);

  const typeText = (tableType: string) =>
    KNOWN_TABLE_TYPES.includes(tableType) ? t(`types.${tableType}`) : tableType.replace(/_/g, ' ');

  const detailText = (parts: FloorDetailPart[]) =>
    parts
      .map((part) =>
        part.kind === 'type'
          ? typeText(part.tableType)
          : part.kind === 'seats'
            ? t('detail.seats', { count: part.count })
            : t('detail.party', { size: part.size }),
      )
      .join(' · ');

  const reload = React.useCallback(async () => {
    const next = await listTableStates(getBrowserClient(), branchId);
    setTables(next.tables);
    setSessions(next.sessions);
  }, [branchId]);

  // A diner's scan, a round from their phone and a settled bill all have to land here
  // without anyone reloading — a server watching the board is not going to press refresh.
  const { healthy } = useRealtime({
    channel: `floor:${branchId}`,
    tables: [
      { table: 'table_sessions', filter: `branch_id=eq.${branchId}` },
      { table: 'orders', filter: `branch_id=eq.${branchId}` },
    ],
    refetch: reload,
  });

  const states = React.useMemo(
    () => buildFloor(tables, sessions, nowMs),
    [tables, sessions, nowMs],
  );
  const zones = React.useMemo(() => groupByZone(states), [states]);
  const counts = React.useMemo(() => floorCounts(states), [states]);
  const selected = states.find((s) => s.table.id === openTableId) ?? null;

  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await reload();
    } catch (err) {
      setError(t(`errors.${readableError((err as Error).message)}`));
    } finally {
      setBusyId(null);
    }
  };

  const loadBill = React.useCallback(
    async (sessionId: string) => {
      setBillLoading(true);
      setBill(null);
      try {
        setBill(await getTableSessionBill(getBrowserClient(), sessionId));
      } catch (err) {
        setError(t(`errors.${readableError((err as Error).message)}`));
      } finally {
        setBillLoading(false);
      }
    },
    [t],
  );

  const openBill = (state: FloorTableState) => {
    setSettleNote(null);
    setOpenTableId(state.table.id);
    if (state.session) void loadBill(state.session.id);
  };

  const seat = (state: FloorTableState) =>
    run(state.table.id, async () => {
      await openTableSession(getBrowserClient(), state.table.id);
    });

  const clearTable = (state: FloorTableState) =>
    run(state.table.id, async () => {
      // Nothing privileged here — the table is empty and this is the one table column the
      // floor owns. tables_staff_update already gates it on branch.settings.
      const { error: updErr } = await getBrowserClient()
        .from('tables')
        .update({ status: 'open' })
        .eq('id', state.table.id);
      if (updErr) throw new Error(updErr.message);
    });

  const toggleLock = (state: FloorTableState) => {
    const session = state.session;
    if (!session) return;
    return run(state.table.id, async () => {
      await setTableSessionStatus(
        getBrowserClient(),
        session.id,
        session.status === 'locked' ? 'open' : 'locked',
      );
    });
  };

  const takePayment = (state: FloorTableState) => {
    const session = state.session;
    if (!session) return;
    return run(state.table.id, async () => {
      const result = await settleTableSession(getBrowserClient(), session.id);
      // A QR transfer settles against a photographed slip, so record_counter_payment
      // refuses it. Saying "paid" over the top of that would be a lie the cash-up finds.
      if (result.skipped.length > 0) {
        // The reasons are the database's own words; the floor only needs the order numbers.
        console.error('settle_table_session skipped rounds', result.skipped);
        setSettleNote(
          t('settle.skipped', {
            count: result.skipped.length,
            orders: result.skipped.map((s) => s.order_number).join(', '),
          }),
        );
      } else {
        setSettleNote(
          t('settle.done', {
            table: labelText(state.label),
            rounds: result.orders_settled,
            total: formatCurrency(Number(result.total)),
          }),
        );
      }
      setOpenTableId(null);
    });
  };

  const voidBill = async (state: FloorTableState) => {
    const session = state.session;
    if (!session) return;
    const note = await prompt({
      title: t('void.title', { table: labelText(state.label) }),
      body: t('void.body'),
      // Saved as the sitting's close note, so it stays in the words the records are kept in.
      defaultValue: 'Walk-out',
      placeholder: t('void.placeholder'),
      confirmLabel: t('void.confirm'),
    });
    if (note === null) return;
    return run(state.table.id, async () => {
      await closeTableSession(getBrowserClient(), session.id, 'voided', note || undefined);
      setOpenTableId(null);
    });
  };

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('header.title')}</h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            {t('header.intro', { branch: branchName })}
          </p>
        </div>
        {canSetup && (
          <Link href={`/b/${branchId}/qr/tables`}>
            <Button variant="outline" leftIcon={<QrCode className="h-4 w-4" />}>
              {t('header.qrCodes')}
            </Button>
          </Link>
        )}
      </header>

      {!healthy && (
        <p role="status" className="mb-4 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">
          {t('reconnecting')}
        </p>
      )}

      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {settleNote && (
        <p role="status" className="mb-4 rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
          {settleNote}
        </p>
      )}

      {states.length === 0 ? (
        <EmptyState
          icon={<Users className="h-7 w-7" />}
          title={t('empty.title')}
          description={t('empty.description')}
          action={
            canSetup ? (
              <Link href={`/b/${branchId}/qr/tables`}>
                <Button variant="gradient">{t('empty.action')}</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-2 text-sm">
            <Badge variant="success">{t('counts.seated', { count: counts.seated })}</Badge>
            <Badge variant="muted">{t('counts.free', { count: counts.free })}</Badge>
            {counts.billRequested > 0 && (
              <Badge variant="warning">
                {t('counts.billRequested', { count: counts.billRequested })}
              </Badge>
            )}
            <Badge variant="neutral">
              {t('counts.outstanding', { amount: formatCurrency(counts.outstanding) })}
            </Badge>
          </div>

          {zones.map((zone) => (
            <section key={zone.zone ?? '__none'} className="mb-7">
              {zone.zone && (
                <h2 className="mb-2 font-display text-lg font-semibold">{zone.zone}</h2>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {zone.tables.map((state) => (
                  <Card key={state.table.id} className="flex flex-col gap-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-display text-lg font-semibold">
                          {labelText(state.label)}
                        </p>
                        {state.detail.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {detailText(state.detail)}
                          </p>
                        )}
                      </div>
                      <Badge variant={state.badge.variant}>{badgeText(state)}</Badge>
                    </div>

                    {state.session ? (
                      <p className="text-sm">
                        <span className="font-semibold tabular-nums">
                          {formatCurrency(state.total)}
                        </span>{' '}
                        <span className="text-muted-foreground">
                          {t('card.sessionSummary', {
                            rounds: state.rounds,
                            code: state.session.session_code,
                          })}
                        </span>
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {state.table.status === 'dirty'
                          ? t('card.settledNeedsClearing')
                          : t('card.empty')}
                      </p>
                    )}

                    <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
                      {state.session ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            leftIcon={<Receipt className="h-4 w-4" />}
                            onClick={() => openBill(state)}
                          >
                            {t('card.bill')}
                          </Button>
                          {canSettle && (
                            <Button
                              size="sm"
                              variant="ghost"
                              leftIcon={
                                state.session.status === 'locked' ? (
                                  <Unlock className="h-4 w-4" />
                                ) : (
                                  <Lock className="h-4 w-4" />
                                )
                              }
                              loading={busyId === state.table.id}
                              onClick={() => void toggleLock(state)}
                            >
                              {state.session.status === 'locked'
                                ? t('card.reopen')
                                : t('card.askForBill')}
                            </Button>
                          )}
                        </>
                      ) : (
                        <>
                          {canSettle && (
                            <Button
                              size="sm"
                              variant="gradient"
                              leftIcon={<Users className="h-4 w-4" />}
                              loading={busyId === state.table.id}
                              onClick={() => void seat(state)}
                            >
                              {t('card.seat')}
                            </Button>
                          )}
                          {canSettle && state.table.status === 'dirty' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              leftIcon={<RefreshCw className="h-4 w-4" />}
                              loading={busyId === state.table.id}
                              onClick={() => void clearTable(state)}
                            >
                              {t('card.clear')}
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      <Sheet
        open={!!selected?.session}
        onClose={() => setOpenTableId(null)}
        side="right"
        title={selected ? labelText(selected.label) : t('sheet.titleFallback')}
      >
        {selected?.session && (
          <div className="space-y-4 p-1">
            <p className="text-sm text-muted-foreground">
              {t.rich('sheet.openFor', {
                elapsed: elapsedText(elapsedTime(selected.session.opened_at, nowMs)),
                code: selected.session.session_code,
                strong: (chunks) => <span className="font-semibold">{chunks}</span>,
              })}
            </p>

            {billLoading && <p className="text-sm text-muted-foreground">{t('sheet.readingBill')}</p>}

            {bill?.orders.map((order) => (
              <div key={order.order_id} className="rounded-2xl border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {t('sheet.round', { round: order.round ?? 1, number: order.order_number })}
                    {order.paid && (
                      <Badge variant="success" className="ml-2">
                        {t('sheet.paid')}
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm font-semibold tabular-nums">
                    {formatCurrency(Number(order.total))}
                  </p>
                </div>
                {order.customer_name && (
                  <p className="text-xs text-muted-foreground">{order.customer_name}</p>
                )}
                <ul className="mt-2 space-y-1">
                  {order.items.map((item, i) => (
                    <li
                      key={`${order.order_id}-${i}`}
                      className="flex justify-between gap-3 text-sm text-muted-foreground"
                    >
                      <span>
                        {item.quantity}× {item.name}
                      </span>
                      <span className="tabular-nums">{formatCurrency(Number(item.subtotal))}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {bill && (
              <div className="space-y-1 border-t border-border pt-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-lg font-semibold">{t('sheet.tableTotal')}</span>
                  <span className="font-display text-lg font-bold tabular-nums">
                    {formatCurrency(Number(bill.running_total))}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>{t('sheet.stillToCollect')}</span>
                  <span className="tabular-nums">{formatCurrency(Number(bill.outstanding))}</span>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {canSettle && (
                <Button
                  variant="gradient"
                  leftIcon={<Banknote className="h-4 w-4" />}
                  loading={busyId === selected.table.id}
                  onClick={() => void takePayment(selected)}
                >
                  {t('sheet.takePayment')}
                </Button>
              )}
              {canVoid && (
                <Button
                  variant="ghost"
                  leftIcon={<Ban className="h-4 w-4" />}
                  className="text-danger"
                  loading={busyId === selected.table.id}
                  onClick={() => void voidBill(selected)}
                >
                  {t('sheet.closeWithoutPayment')}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t('sheet.paymentHint')}</p>
          </div>
        )}
      </Sheet>
    </div>
  );
}
