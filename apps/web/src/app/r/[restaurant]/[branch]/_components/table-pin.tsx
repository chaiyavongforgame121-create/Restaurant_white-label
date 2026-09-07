'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, Receipt, Utensils } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import {
  getTableSessionBill,
  joinTableSession,
  setTableSessionStatus,
  type TableSessionBill,
} from '@favornoms/database/queries';
import { useRealtime } from '@favornoms/database/realtime';
import { Badge, Button, Sheet, cn } from '@favornoms/ui';
import { useAuth } from '@/components/auth/use-auth';
import { useCart } from '@/store/cart';

export interface PinnedTable {
  id: string;
  /** `tables.table_number` — what the floor calls it, sent to place-order as a fallback. */
  number: string;
  /** What the diner is shown: the table's own name, else "Table <number>". */
  label: string;
  /**
   * The open sitting this phone has joined.
   *
   * This is the whole difference from what came before. A pin used to be a private note a
   * phone kept to itself; it is now a claim on a row every phone at the table shares, which
   * is why a friend's second scan lands on the same bill and why settling that bill ends
   * ordering for everyone at once.
   */
  sessionId: string;
}

interface TablePinValue {
  /** The table this device is sitting at, at THIS branch, or null. */
  table: PinnedTable | null;
  /** False until the stored pin has been checked against the server. */
  ready: boolean;
  /** The sitting's running bill — every round, from every phone at the table. */
  bill: TableSessionBill | null;
  /** Re-read the bill now (after placing a round, say). */
  refreshBill: () => void;
  /** Called by TableScanPin once join_table_session has proved the sitting. */
  pin: (table: PinnedTable, token: string) => void;
  /** The diner saying they have left: drops the pin and re-asks the order type. */
  clear: () => void;
}

/**
 * One key for every storefront on this origin, the same as the cart. A pin therefore
 * carries its branch and is only honoured at that branch — scanning table 7 at one
 * restaurant must not seat the diner at table 7 of the next one.
 */
const STORAGE_KEY = 'favornoms-table-v1';

/**
 * How long the CACHE is believed without asking.
 *
 * The sitting itself now lives in the database and the server decides when it ends — this
 * is only the point past which the local copy is not worth a round trip, because any
 * sitting behind it has long since expired or been settled. A meal that outruns it just
 * needs the tent scanned again.
 */
const PIN_TTL_MS = 4 * 60 * 60 * 1000;

interface StoredPin {
  id: string;
  number: string;
  label: string;
  branchId: string;
  sessionId: string;
  /** The token that opened this sitting, so the pin can be re-joined without a re-scan. */
  token: string;
  /** Epoch ms of the scan. Absent on pins written before sessions existed. */
  scannedAt: number;
}

function readStored(branchId: string): StoredPin | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPin> | null;
    // A pin with no sessionId was written by the localStorage-only version of this file.
    // It refers to no row anywhere, so it is not a sitting and cannot be revived.
    if (!parsed?.id || !parsed.number || !parsed.sessionId) return null;
    if (parsed.branchId !== branchId) return null;
    const scannedAt = typeof parsed.scannedAt === 'number' ? parsed.scannedAt : 0;
    if (scannedAt + PIN_TTL_MS <= Date.now()) return null;
    return {
      id: parsed.id,
      number: parsed.number,
      label: parsed.label || `Table ${parsed.number}`,
      branchId,
      sessionId: parsed.sessionId,
      token: parsed.token ?? '',
      scannedAt,
    };
  } catch {
    // Unreadable or unparseable storage is the same as never having scanned.
    return null;
  }
}

function writeStored(branchId: string, table: PinnedTable, token: string): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: table.id,
        number: table.number,
        label: table.label,
        branchId,
        sessionId: table.sessionId,
        token,
        scannedAt: Date.now(),
      } satisfies StoredPin),
    );
  } catch {
    // Private mode / quota — the pin still holds for this page view.
  }
}

function removeStored(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to remove
  }
}

// `ready: true` outside the provider is not a lie: there is no pin to wait for, so a
// consumer that gates on it behaves exactly as it did before tables existed.
const TablePinContext = React.createContext<TablePinValue>({
  table: null,
  ready: true,
  bill: null,
  refreshBill: () => {},
  pin: () => {},
  clear: () => {},
});

/** What table this device is sitting at, and what the table owes. */
export const useTablePin = () => React.useContext(TablePinContext);

/**
 * Holds the sitting for the whole branch storefront.
 *
 * Lives here rather than in the cart store because it has a different lifetime: the cart is
 * emptied on every order, while the party stays at the same table for the next round.
 *
 * localStorage was the truth here and is now only a cache. Every mount checks the sitting
 * against the server, because the thing that ends a meal is the restaurant taking payment,
 * not a clock on the diner's phone — and the phone has no way of knowing that happened.
 */
export function TablePinProvider({
  branchId,
  children,
}: {
  branchId: string;
  children: React.ReactNode;
}) {
  const [table, setTable] = React.useState<PinnedTable | null>(null);
  const [bill, setBill] = React.useState<TableSessionBill | null>(null);
  const [ready, setReady] = React.useState(false);
  /** Which sitting the bill below was first read for, so a join is not read twice. */
  const firstReadRef = React.useRef<string | null>(null);

  // The cart persists with skipHydration, so anything written into it before rehydration
  // finishes is overwritten a tick later by the stored values — the same wait AppShell and
  // OrderTypeGate make before they trust the store.
  const [cartHydrated, setCartHydrated] = React.useState(false);
  React.useEffect(() => {
    const persist = useCart.persist;
    if (!persist || persist.hasHydrated()) {
      setCartHydrated(true);
      return;
    }
    const unsub = persist.onFinishHydration(() => setCartHydrated(true));
    void persist.rehydrate();
    return unsub;
  }, []);

  /**
   * Forget the sitting on THIS device.
   *
   * Dropping the pin alone would leave the cart pinned to dine-in with no table: the channel
   * was set by the scan, not by the diner, and the switcher and the gate both read it as an
   * answered question. Nulling it is what hands the choice back.
   */
  const forget = React.useCallback(() => {
    removeStored();
    setTable(null);
    setBill(null);
    useCart.setState({ channel: null, channelBranchId: null });
  }, []);

  // localStorage is read in an effect, never during render: the server has no idea what this
  // device scanned, and reading it on the first paint is a hydration mismatch.
  React.useEffect(() => {
    if (!cartHydrated) return;
    const stored = readStored(branchId);
    if (!stored) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await getTableSessionBill(getBrowserClient(), stored.sessionId);
        if (cancelled) return;
        // Settled, voided or abandoned. The bill this phone was adding to is finished, so
        // the pin goes with it — this is what makes "the QR cannot order again until a new
        // sitting starts" true on the diner's screen and not only in the database.
        if (fresh.status === 'closed') {
          removeStored();
          setTable(null);
          useCart.setState({ channel: null, channelBranchId: null });
          return;
        }
        setTable({
          id: stored.id,
          number: stored.number,
          label: fresh.table_label || stored.label,
          sessionId: stored.sessionId,
        });
        setBill(fresh);
        firstReadRef.current = stored.sessionId;
      } catch {
        // Signed out, no longer a participant, or the sitting is gone. All three mean this
        // device is not at that table any more.
        if (!cancelled) removeStored();
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cartHydrated, branchId]);

  const sessionId = table?.sessionId ?? null;

  const refreshBill = React.useCallback(() => {
    if (!sessionId) return;
    void (async () => {
      try {
        const fresh = await getTableSessionBill(getBrowserClient(), sessionId);
        if (fresh.status === 'closed') {
          forget();
          return;
        }
        setBill(fresh);
      } catch {
        forget();
      }
    })();
  }, [sessionId, forget]);

  // The first read for a sitting this device has only just joined. The subscription below
  // is created after the join, so the last_activity_at bump the join itself caused has
  // already gone past — without this the checkout would show no round number until someone
  // else at the table ordered.
  React.useEffect(() => {
    if (!sessionId || firstReadRef.current === sessionId) return;
    firstReadRef.current = sessionId;
    refreshBill();
  }, [sessionId, refreshBill]);

  // A settled bill has to reach the diner's phone without a reload — otherwise they keep
  // adding to a table the restaurant has already closed and only find out at checkout.
  // The `orders` subscription is what shows a table-mate's round arriving; the session's own
  // last_activity_at bump covers the rounds RLS will not hand this diner directly.
  useRealtime({
    channel: `table-session:${sessionId ?? 'none'}`,
    tables: [
      { table: 'table_sessions', event: 'UPDATE', filter: `id=eq.${sessionId ?? ''}` },
      { table: 'orders', filter: `session_id=eq.${sessionId ?? ''}` },
    ],
    refetch: refreshBill,
    enabled: !!sessionId,
  });

  // Scanning a table IS choosing dine-in at this branch, so the pin answers the order-type
  // question instead of sitting beside it and letting the gate ask again.
  React.useEffect(() => {
    if (!ready || !table) return;
    const { channel, channelBranchId, setChannel } = useCart.getState();
    if (channel !== 'dine_in' || channelBranchId !== branchId) setChannel('dine_in', branchId);
  }, [ready, table, branchId]);

  const pin = React.useCallback(
    (next: PinnedTable, token: string) => {
      const cart = useCart.getState();
      // Items chosen at another branch cannot be served at this table — place-order would
      // reject their menu ids anyway, but not before the diner had carried them to a
      // checkout that could never succeed.
      if (cart.branchId && cart.branchId !== branchId && cart.lines.length > 0) cart.clear();
      writeStored(branchId, next, token);
      setTable(next);
      setBill(null);
    },
    [branchId],
  );

  const value = React.useMemo<TablePinValue>(
    () => ({ table, ready, bill, refreshBill, pin, clear: forget }),
    [table, ready, bill, refreshBill, pin, forget],
  );

  return <TablePinContext.Provider value={value}>{children}</TablePinContext.Provider>;
}

/** What join_table_session refused, in words the diner can act on. */
type ScanBlock = 'not_seated' | 'locked' | 'code' | 'error';

interface TableScanPinProps {
  /** `tables.qr_code_token` — the whole of the deep link. */
  token: string;
  table: { id: string; number: string; label: string };
  /** branches.settings.dine_in.session_mode, as the resolver reported it. */
  sessionMode: string;
  requiresJoinCode: boolean;
}

/**
 * Turns a scan into a seat at the table.
 *
 * Rendered by the menu page only when `?t=` resolved to a table that really belongs to the
 * branch in the URL, so by the time this mounts the table has already been proven to be
 * here. What it cannot prove on its own is that the diner may order: that needs a sitting
 * and a signed-in account, and both are decided by the server.
 */
export function TableScanPin({
  token,
  table,
  sessionMode,
  requiresJoinCode,
}: TableScanPinProps) {
  const { ready, pin } = useTablePin();
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [blocked, setBlocked] = React.useState<ScanBlock | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [code, setCode] = React.useState('');
  const [joining, setJoining] = React.useState(false);
  // pin() changes the context, which would otherwise re-run the join. One attempt per token
  // is all a scan is.
  const attemptedRef = React.useRef<string | null>(null);

  const base = React.useMemo(() => {
    const m = pathname?.match(/^(\/r\/[^/]+\/[^/]+)/);
    return m ? m[1] : '';
  }, [pathname]);

  /** Drop `?t=` so the token stops riding along in shares, history and Referer headers. */
  const stripToken = React.useCallback(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('t')) {
        url.searchParams.delete('t');
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      // Address bar cosmetics only — never worth failing the scan over.
    }
  }, []);

  const join = React.useCallback(
    async (withCode?: string) => {
      setJoining(true);
      try {
        const result = await joinTableSession(getBrowserClient(), token, withCode);
        pin(
          {
            id: result.table_id,
            number: result.table_number,
            label: result.table_label,
            sessionId: result.session_id,
          },
          token,
        );
        setBlocked(null);
        setMessage(null);
        stripToken();
      } catch (err) {
        const reason = (err as Error).message ?? '';
        if (reason.includes('not_signed_in')) {
          // The token MUST survive the round trip, or the diner comes back unseated and
          // has to get up and scan the tent again.
          router.push(`${base}/sign-in?next=${encodeURIComponent(`${base}?t=${token}`)}`);
          return;
        }
        if (reason.includes('join_code_required')) setBlocked('code');
        else if (reason.includes('table_session_locked')) setBlocked('locked');
        else if (reason.includes('table_not_seated')) setBlocked('not_seated');
        else {
          setBlocked('error');
          setMessage(reason);
        }
      } finally {
        setJoining(false);
      }
    },
    [token, pin, router, base, stripToken],
  );

  React.useEffect(() => {
    if (!ready || authLoading) return;
    if (attemptedRef.current === token) return;
    attemptedRef.current = token;
    if (!user) {
      router.push(`${base}/sign-in?next=${encodeURIComponent(`${base}?t=${token}`)}`);
      return;
    }
    void join();
  }, [ready, authLoading, user, token, join, router, base]);

  if (!blocked) return null;

  return (
    <div className="container mt-4">
      <div className="rounded-2xl border border-border bg-card p-4">
        <p className="flex items-center gap-2 font-display text-lg font-semibold">
          <Utensils className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          {table.label}
        </p>
        {blocked === 'not_seated' && (
          <p className="mt-1 text-sm text-muted-foreground">
            {sessionMode === 'staff'
              ? 'Ask a member of staff to open your table, then scan again.'
              : 'This table is not open for ordering yet. Ask a member of staff to seat you.'}
          </p>
        )}
        {blocked === 'locked' && (
          <p className="mt-1 text-sm text-muted-foreground">
            This table has asked for the bill. Ask a member of staff to reopen it if you would
            like to order more.
          </p>
        )}
        {blocked === 'error' && (
          <p role="alert" className="mt-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {message ?? 'That table could not be opened.'}
          </p>
        )}
        {blocked === 'code' && (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              {requiresJoinCode
                ? 'Someone is already ordering at this table. Enter the four-digit code your server gave you to join their bill.'
                : 'Enter the four-digit code for this table to join the bill.'}
            </p>
            <div className="mt-3 flex gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Table code"
                placeholder="0000"
                className="focus-ring h-12 w-28 rounded-xl border border-border bg-background px-4 text-center text-lg tracking-[0.4em]"
              />
              <Button
                variant="gradient"
                disabled={code.length !== 4}
                loading={joining}
                onClick={() => void join(code)}
              >
                Join table
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * "You are ordering at table N", plus what the table owes so far.
 *
 * The menu and the cart have nowhere else to say it, and a diner who cannot see the pin
 * cannot tell a dine-in order from a takeaway one until it is too late. The running total
 * is the whole table's, not this phone's: that is the point of a shared sitting, and it is
 * the number the party will be asked to pay.
 */
export function TablePinNotice() {
  const { table, bill } = useTablePin();
  const [open, setOpen] = React.useState(false);
  if (!table) return null;
  const rounds = bill?.order_count ?? 0;
  return (
    <div className="container mt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-primary/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Utensils className="h-4 w-4 shrink-0" aria-hidden />
          Ordering at {table.label}
          {rounds > 0 && (
            <span className="font-normal">
              · {rounds} {rounds === 1 ? 'round' : 'rounds'} ·{' '}
              {formatCurrency(Number(bill?.running_total ?? 0))}
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="focus-ring ml-auto inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold text-primary underline underline-offset-2"
        >
          <Receipt className="h-3.5 w-3.5" aria-hidden />
          Your table
        </button>
      </div>
      <TableBillSheet open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

/**
 * The whole sitting, round by round.
 *
 * Deliberately built from get_table_session_bill rather than from the diner's own orders:
 * a table-mate's round is not readable through orders_customer_own, and widening that
 * policy to make it readable would hand out the phone number on every row. The RPC checks
 * participation and redacts instead.
 */
function TableBillSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { table, bill, refreshBill } = useTablePin();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // A sheet that is opened after a round was placed elsewhere in the app would otherwise
  // show the total as it was when the provider last heard about it.
  React.useEffect(() => {
    if (open) refreshBill();
  }, [open, refreshBill]);

  if (!table) return null;
  const locked = bill?.status === 'locked';

  const askForBill = async () => {
    if (!bill) return;
    setBusy(true);
    setError(null);
    try {
      await setTableSessionStatus(getBrowserClient(), bill.session_id, 'locked');
      refreshBill();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} side="bottom" title={table.label}>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto p-1">
        {!bill ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Reading your table…
          </p>
        ) : bill.orders.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            Nothing ordered at this table yet. Everything you and the rest of your party order
            lands on one bill.
          </p>
        ) : (
          <>
            {bill.orders.map((order) => (
              <div key={order.order_id} className="rounded-2xl border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    Round {order.round ?? 1}
                    {order.mine && (
                      <Badge variant="muted" className="ml-2">
                        Yours
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm font-semibold tabular-nums">
                    {formatCurrency(Number(order.total))}
                  </p>
                </div>
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
                {order.paid && (
                  <p className="mt-2 text-xs font-semibold text-success">Paid</p>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="font-display text-lg font-semibold">Table total</span>
              <span className="font-display text-lg font-bold tabular-nums">
                {formatCurrency(Number(bill.running_total))}
              </span>
            </div>
            {Number(bill.outstanding) !== Number(bill.running_total) && (
              <p className="text-sm text-muted-foreground">
                Still to pay {formatCurrency(Number(bill.outstanding))}
              </p>
            )}
          </>
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        {locked ? (
          <p role="status" className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">
            Your server has been asked for the bill. No more rounds can go to the kitchen until
            they reopen the table.
          </p>
        ) : (
          <Button
            variant="outline"
            fullWidth
            loading={busy}
            disabled={!bill || bill.orders.length === 0}
            onClick={() => void askForBill()}
          >
            We&apos;re ready to pay
          </Button>
        )}
        <p className="text-center text-xs text-muted-foreground">
          You pay at the restaurant. The table closes when your bill is settled.
        </p>
      </div>
    </Sheet>
  );
}

/**
 * The way out of a scanned table, for this device only.
 *
 * Without it the only exits are clearing site data and waiting: a diner who scanned a tent
 * to look at the menu, or one who has paid and left, is otherwise held at dine-in with a
 * table number the restaurant will act on. It does NOT close the sitting — a phone leaving
 * is not the party leaving, and only the restaurant may say a bill is finished.
 */
export function LeaveTableButton({ className }: { className?: string }) {
  const { table, bill, clear } = useTablePin();
  if (!table) return null;
  const owed = Number(bill?.outstanding ?? 0);
  return (
    <button
      type="button"
      onClick={() => {
        if (
          !window.confirm(
            owed > 0
              ? `Stop ordering at ${table.label}?\n\nThe bill stays open — ${formatCurrency(owed)} is still to pay at the restaurant.`
              : `Stop ordering at ${table.label}?\n\nThe bill stays open; you just won't be ordering to this table from this phone.`,
          )
        )
          return;
        clear();
      }}
      className={cn(
        'focus-ring rounded-full px-2 py-1 text-xs font-semibold text-primary underline underline-offset-2',
        className,
      )}
    >
      Not at {table.label}?
    </button>
  );
}
