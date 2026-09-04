'use client';

import * as React from 'react';
import { Utensils } from 'lucide-react';
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
  clear: () => void;
}

/**
 * One key for every storefront on this origin, the same as the cart. A pin therefore
 * carries its branch and is only honoured at that branch — scanning table 7 at one
 * restaurant must not seat the diner at table 7 of the next one.
 */
const STORAGE_KEY = 'favornoms-table-v1';

interface StoredPin extends PinnedTable {
  branchId: string;
}

function readStored(branchId: string): PinnedTable | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPin> | null;
    if (!parsed?.id || !parsed.number || parsed.branchId !== branchId) return null;
    return { id: parsed.id, number: parsed.number, label: parsed.label || `Table ${parsed.number}` };
  } catch {
    // Unreadable or unparseable storage is the same as never having scanned.
    return null;
  }
}

function writeStored(branchId: string, table: PinnedTable) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...table, branchId } satisfies StoredPin));
  } catch {
    // Private mode / quota — the pin still holds for this page view.
  }
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
    setTable(readStored(branchId));
    setReady(true);
  }, [cartHydrated, branchId]);

  // Scanning a table IS choosing dine-in at this branch, so the pin answers the
  // order-type question instead of sitting beside it and letting the gate ask again.
  React.useEffect(() => {
    if (!ready || !table) return;
    const { channel, channelBranchId, setChannel } = useCart.getState();
    if (channel !== 'dine_in' || channelBranchId !== branchId) setChannel('dine_in', branchId);
  }, [ready, table, branchId]);

  const pin = React.useCallback(
    (next: PinnedTable) => {
      const cart = useCart.getState();
      // Items chosen at another branch cannot be served at this table — place-order would
      // reject their menu ids anyway, but not before the diner had carried them to a
      // checkout that could never succeed.
      if (cart.branchId && cart.branchId !== branchId && cart.lines.length > 0) cart.clear();
      writeStored(branchId, next);
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
  const { ready, table: current, pin } = useTablePin();

  React.useEffect(() => {
    if (!ready) return;
    if (current?.id !== table.id) pin(table);
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
  }, [ready, current, table, pin]);

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
      <p className="flex items-center gap-2 rounded-2xl bg-primary/10 px-4 py-3 text-sm font-semibold text-primary">
        <Utensils className="h-4 w-4 shrink-0" aria-hidden />
        Ordering at {table.label}
      </p>
    </div>
  );
}
