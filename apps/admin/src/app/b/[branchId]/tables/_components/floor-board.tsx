'use client';

import * as React from 'react';
import Link from 'next/link';
import { Ban, Banknote, Lock, QrCode, Receipt, RefreshCw, Unlock, Users } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import {
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
import { Badge, Button, Card, EmptyState, Sheet } from '@favornoms/ui';
import { buildFloor, floorCounts, groupByZone, type FloorTableState } from './floor-model';

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

/** RPC failures, in words a server with a customer waiting can act on. */
function readableError(message: string): string {
  if (message.includes('unpaid_needs_manager'))
    return 'This bill still has money on it. Ask a manager to write it off.';
  if (message.includes('forbidden')) return 'Your account cannot do that at this branch.';
  if (message.includes('session_already_closed')) return 'That table has already been closed.';
  if (message.includes('table_not_found')) return 'That table is no longer set up here.';
  return message;
}

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
  const [tables, setTables] = React.useState(initialTables);
  const [sessions, setSessions] = React.useState(initialSessions);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [openTableId, setOpenTableId] = React.useState<string | null>(null);
  const [bill, setBill] = React.useState<TableSessionBill | null>(null);
  const [billLoading, setBillLoading] = React.useState(false);
  const [settleNote, setSettleNote] = React.useState<string | null>(null);

  // Re-rendered on a timer so "Seated · 42m" keeps counting without a refetch. A minute is
  // the resolution the label has, so anything faster is only work.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

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
      setError(readableError((err as Error).message));
    } finally {
      setBusyId(null);
    }
  };

  const loadBill = React.useCallback(async (sessionId: string) => {
    setBillLoading(true);
    setBill(null);
    try {
      setBill(await getTableSessionBill(getBrowserClient(), sessionId));
    } catch (err) {
      setError(readableError((err as Error).message));
    } finally {
      setBillLoading(false);
    }
  }, []);

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
      setSettleNote(
        result.skipped.length > 0
          ? `Closed, but ${result.skipped
              .map((s) => `order ${s.order_number} could not be settled here (${s.reason})`)
              .join('; ')}. Approve it in Payments.`
          : `${state.label} settled — ${result.orders_settled} ${
              result.orders_settled === 1 ? 'round' : 'rounds'
            }, ${formatCurrency(Number(result.total))}.`,
      );
      setOpenTableId(null);
    });
  };

  const voidBill = (state: FloorTableState) => {
    const session = state.session;
    if (!session) return;
    const note = window.prompt(
      `Close ${state.label} WITHOUT taking payment?\n\nThe rounds stay on the books as unpaid. Say why:`,
      'Walk-out',
    );
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
          <h1 className="font-display text-3xl font-bold">Tables</h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            Who is sitting where at {branchName}, and what each table owes. A table stays open
            for round after round until you take the money — settling the bill is what stops
            its QR code ordering again.
          </p>
        </div>
        {canSetup && (
          <Link href={`/b/${branchId}/qr/tables`}>
            <Button variant="outline" leftIcon={<QrCode className="h-4 w-4" />}>
              Table QR codes
            </Button>
          </Link>
        )}
      </header>

      {!healthy && (
        <p role="status" className="mb-4 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">
          Reconnecting — the board may be a moment behind.
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
          title="No tables set up yet"
          description="Add your tables and print their QR codes, and this board fills in as guests scan them."
          action={
            canSetup ? (
              <Link href={`/b/${branchId}/qr/tables`}>
                <Button variant="gradient">Set up tables</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-2 text-sm">
            <Badge variant="success">{counts.seated} seated</Badge>
            <Badge variant="muted">{counts.free} free</Badge>
            {counts.billRequested > 0 && (
              <Badge variant="warning">{counts.billRequested} waiting for the bill</Badge>
            )}
            <Badge variant="neutral">On the floor {formatCurrency(counts.outstanding)}</Badge>
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
                        <p className="font-display text-lg font-semibold">{state.label}</p>
                        {state.detail && (
                          <p className="text-xs text-muted-foreground">{state.detail}</p>
                        )}
                      </div>
                      <Badge variant={state.badge.variant}>{state.badge.text}</Badge>
                    </div>

                    {state.session ? (
                      <p className="text-sm">
                        <span className="font-semibold tabular-nums">
                          {formatCurrency(state.total)}
                        </span>{' '}
                        <span className="text-muted-foreground">
                          · {state.rounds} {state.rounds === 1 ? 'round' : 'rounds'} · code{' '}
                          {state.session.session_code}
                        </span>
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {state.table.status === 'dirty'
                          ? 'Settled — clear it for the next party.'
                          : 'Nobody sitting here.'}
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
                            Bill
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
                              {state.session.status === 'locked' ? 'Reopen' : 'Ask for bill'}
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
                              Seat
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
                              Clear
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
        title={selected?.label ?? 'Table'}
      >
        {selected?.session && (
          <div className="space-y-4 p-1">
            <p className="text-sm text-muted-foreground">
              Open {selected.badge.text.replace('Seated · ', '')} · code{' '}
              <span className="font-semibold">{selected.session.session_code}</span> — read it out
              when a second phone is asked to join this table.
            </p>

            {billLoading && <p className="text-sm text-muted-foreground">Reading the bill…</p>}

            {bill?.orders.map((order) => (
              <div key={order.order_id} className="rounded-2xl border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    Round {order.round ?? 1} · {order.order_number}
                    {order.paid && (
                      <Badge variant="success" className="ml-2">
                        Paid
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
                  <span className="font-display text-lg font-semibold">Table total</span>
                  <span className="font-display text-lg font-bold tabular-nums">
                    {formatCurrency(Number(bill.running_total))}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>Still to collect</span>
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
                  Take payment
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
                  Close without payment
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Taking payment records every round as received, closes the table and stops its QR
              code ordering until the next party is seated.
            </p>
          </div>
        )}
      </Sheet>
    </div>
  );
}
