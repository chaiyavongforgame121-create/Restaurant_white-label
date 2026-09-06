'use client';

import * as React from 'react';
import { Utensils } from 'lucide-react';
import { cn } from '@favornoms/ui';
import { useCart } from '@/store/cart';

export interface PinnedTable {
  id: string;
  /** `tables.table_number` — what the floor calls it, sent to place-order as a fallback. */
  number: string;
  /** What the diner is shown: the table's own name, else "Table <number>". */
  label: string;
}

interface TablePinValue {
  /** The table this device scanned into at THIS branch, or null. */
  table: PinnedTable | null;
  /** False until the stored pin and the cart have both been read. */
  ready: boolean;
  pin: (table: PinnedTable) => void;
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
 * How long a scan is believed for.
 *
 * A table tent is scanned once and the pin then answers the order-type question for
 * every later visit from that phone — so without a lifetime, one lunch seats the diner
 * at that table for ever: the gate never asks again, the channel switcher stays locked
 * to dine-in, and a takeaway order two weeks later is sent to a table someone else is
 * sitting at. Four hours outlasts any meal and expires well before the next one.
 */
const PIN_TTL_MS = 4 * 60 * 60 * 1000;

interface StoredPin extends PinnedTable {
  branchId: string;
  /** Epoch ms of the scan. Absent on pins written before this had a lifetime. */
  scannedAt: number;
}

interface LivePin {
  table: PinnedTable;
  /** Epoch ms at which this pin stops being believed. */
  expiresAt: number;
}

function readStored(branchId: string): LivePin | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPin> | null;
    if (!parsed?.id || !parsed.number || parsed.branchId !== branchId) return null;
    // A pin with no timestamp was written before pins expired. Treating it as stale is
    // the point of this: those are exactly the ones that have been sitting on a phone
    // since whenever, with no way for the diner to have removed them.
    const expiresAt = typeof parsed.scannedAt === 'number' ? parsed.scannedAt + PIN_TTL_MS : 0;
    if (expiresAt <= Date.now()) {
      // Drop it here rather than leaving a dead key to be re-read on every page load.
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return {
      table: {
        id: parsed.id,
        number: parsed.number,
        label: parsed.label || `Table ${parsed.number}`,
      },
      expiresAt,
    };
  } catch {
    // Unreadable or unparseable storage is the same as never having scanned.
    return null;
  }
}

function writeStored(branchId: string, table: PinnedTable): number {
  const scannedAt = Date.now();
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...table, branchId, scannedAt } satisfies StoredPin),
    );
  } catch {
    // Private mode / quota — the pin still holds for this page view.
  }
  return scannedAt + PIN_TTL_MS;
}

// `ready: true` outside the provider is not a lie: there is no pin to wait for, so a
// consumer that gates on it behaves exactly as it did before tables existed.
const TablePinContext = React.createContext<TablePinValue>({
  table: null,
  ready: true,
  pin: () => {},
  clear: () => {},
});

/** What table this device is sitting at, if any. */
export const useTablePin = () => React.useContext(TablePinContext);

/**
 * Holds the scanned table for the whole branch storefront.
 *
 * Lives here rather than in the cart store because it has a different lifetime: the cart
 * is emptied on every order, while the diner stays at the same table for the next round.
 */
export function TablePinProvider({
  branchId,
  children,
}: {
  branchId: string;
  children: React.ReactNode;
}) {
  const [table, setTable] = React.useState<PinnedTable | null>(null);
  const [expiresAt, setExpiresAt] = React.useState<number | null>(null);
  const [ready, setReady] = React.useState(false);

  // The cart persists with skipHydration, so anything written into it before rehydration
  // finishes is overwritten a tick later by the stored values — the same wait AppShell
  // and OrderTypeGate make before they trust the store.
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

  // localStorage is read in an effect, never during render: the server has no idea what
  // this device scanned, and reading it on the first paint is a hydration mismatch.
  React.useEffect(() => {
    if (!cartHydrated) return;
    const stored = readStored(branchId);
    setTable(stored?.table ?? null);
    setExpiresAt(stored?.expiresAt ?? null);
    setReady(true);
  }, [cartHydrated, branchId]);

  // Scanning a table IS choosing dine-in at this branch, so the pin answers the
  // order-type question instead of sitting beside it and letting the gate ask again.
  React.useEffect(() => {
    if (!ready || !table) return;
    const { channel, channelBranchId, setChannel } = useCart.getState();
    if (channel !== 'dine_in' || channelBranchId !== branchId) setChannel('dine_in', branchId);
  }, [ready, table, branchId]);

  // Let the pin lapse on its own while the tab is open, and re-check whenever the tab
  // comes back — a phone that slept through the whole afternoon fires no timer, and
  // would otherwise still be seated at the table on the next glance.
  //
  // Deliberately quieter than clear(): the order type is left alone, so a long meal that
  // outruns the clock degrades into "type your table number" at checkout rather than
  // ambushing the diner with the blocking order-type gate mid-order.
  React.useEffect(() => {
    if (!ready || !table) return;
    const recheck = () => {
      if (readStored(branchId)) return;
      setTable(null);
      setExpiresAt(null);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    const timer = window.setTimeout(recheck, Math.max(0, (expiresAt ?? 0) - Date.now()));
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready, table, expiresAt, branchId]);

  const pin = React.useCallback(
    (next: PinnedTable) => {
      const cart = useCart.getState();
      // Items chosen at another branch cannot be served at this table — place-order would
      // reject their menu ids anyway, but not before the diner had carried them to a
      // checkout that could never succeed.
      if (cart.branchId && cart.branchId !== branchId && cart.lines.length > 0) cart.clear();
      setExpiresAt(writeStored(branchId, next));
      setTable(next);
    },
    [branchId],
  );

  const clear = React.useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // nothing to remove
    }
    setTable(null);
    setExpiresAt(null);
    // Dropping the pin alone would leave the cart pinned to dine-in with no table: the
    // channel was set by the scan, not by the diner, and the switcher and the gate both
    // read it as an answered question. Nulling it is what makes "I've left" actually
    // hand the choice back — the order-type gate re-opens on the next ordering surface.
    useCart.setState({ channel: null, channelBranchId: null });
  }, []);

  const value = React.useMemo<TablePinValue>(
    () => ({ table, ready, pin, clear }),
    [table, ready, pin, clear],
  );

  return <TablePinContext.Provider value={value}>{children}</TablePinContext.Provider>;
}

/**
 * Writes a freshly scanned table into the pin, once.
 *
 * Rendered by the menu page only when `?t=` resolved to a table that really belongs to
 * the branch in the URL, so by the time this mounts the table has already been proven.
 */
export function TableScanPin({ table }: { table: PinnedTable }) {
  const { ready, pin } = useTablePin();
  // Scanning the tent again is the diner saying they are still sitting there, so it
  // restarts the pin's clock even when the table has not changed. The ref is what keeps
  // that to once per scan: pin() changes the context, which would otherwise re-run this.
  const pinnedRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!ready) return;
    if (pinnedRef.current !== table.id) {
      pinnedRef.current = table.id;
      pin(table);
    }
    // Drop ?t= so the token stops riding along in shares, browser history and Referer
    // headers. history.replaceState rather than router.replace: the page is already
    // rendered and re-fetching the whole menu to change the address bar is wasteful.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('t')) {
        url.searchParams.delete('t');
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      // Address bar cosmetics only — never worth failing the scan over.
    }
  }, [ready, table, pin]);

  return null;
}

/**
 * "You are ordering at table N", for the surfaces that have nowhere else to say it.
 *
 * The menu says it by replacing the order-type switcher and the checkout says it in the
 * dine-in card; the cart has neither, and a diner who cannot see the pin cannot tell a
 * dine-in order from a takeaway one until it is too late.
 */
export function TablePinNotice() {
  const { table } = useTablePin();
  if (!table) return null;
  return (
    <div className="container mt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-primary/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Utensils className="h-4 w-4 shrink-0" aria-hidden />
          Ordering at {table.label}
        </p>
        <LeaveTableButton className="ml-auto" />
      </div>
    </div>
  );
}

/**
 * The way out of a scanned table.
 *
 * Without it the only exits are clearing site data and waiting for the pin to lapse:
 * a diner who scanned a tent to look at the menu, or one who has paid and left, is
 * otherwise held at dine-in with a table number the restaurant will act on.
 */
export function LeaveTableButton({ className }: { className?: string }) {
  const { table, clear } = useTablePin();
  if (!table) return null;
  return (
    <button
      type="button"
      onClick={clear}
      className={cn(
        'focus-ring rounded-full px-2 py-1 text-xs font-semibold text-primary underline underline-offset-2',
        className,
      )}
    >
      Not at {table.label}?
    </button>
  );
}
