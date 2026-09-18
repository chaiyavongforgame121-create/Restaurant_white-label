'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@favornoms/database/client';
import { useRealtime } from '@favornoms/database/realtime';
import { effectivePriceMap, type EffectivePrice, type EffectivePriceRow } from './counter-pricing';

/** Never re-run the server tree more often than this, whatever the kitchen is doing. */
const MIN_REFRESH_GAP_MS = 3_000;
/** A till that comes back after this long re-reads the menu; a quick alt-tab does not. */
const WAKE_MIN_AGE_MS = 60_000;
/** Happy hours start and end on the minute. */
const PRICE_POLL_MS = 60_000;
/** setTimeout's ceiling. An 86 further out than ~24 days is picked up by the next refresh. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Keeps an open till honest about what it can sell and at what price.
 *
 * The till loaded the menu once. A dish restocked on the inventory page stayed "Out of stock"
 * until someone reloaded; one the kitchen 86'd stayed on sale until place-order refused it at
 * Charge; an 86 that expired at midnight stayed grey all morning; and a happy hour that started
 * while the till was open was quoted at the list price. This is the storefront's pattern:
 *
 *   - menu_items and storefront_versions (bumped by combos, categories and hours) for this
 *     branch -> router.refresh(), which re-runs the server page and keeps the cart;
 *   - a timer for the earliest sold_out_until, because nothing is written when an 86 expires;
 *   - get_effective_prices every minute, handed back through onPrices.
 */
export function useLiveCounter({
  branchId,
  soldOutUntil,
  onPrices,
}: {
  branchId: string;
  /** menu item id -> the future time its 86 ends. */
  soldOutUntil: Record<string, string>;
  onPrices: (prices: Record<string, EffectivePrice>) => void;
}) {
  const router = useRouter();
  const lastRefresh = React.useRef(Date.now());
  const timer = React.useRef<number | null>(null);
  const onPricesRef = React.useRef(onPrices);
  onPricesRef.current = onPrices;

  const refresh = React.useCallback(() => {
    if (timer.current !== null) return;
    const wait = Math.max(0, MIN_REFRESH_GAP_MS - (Date.now() - lastRefresh.current));
    timer.current = window.setTimeout(() => {
      timer.current = null;
      lastRefresh.current = Date.now();
      router.refresh();
    }, wait);
  }, [router]);

  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  useRealtime({
    channel: `counter-menu:${branchId}`,
    tables: [
      { table: 'storefront_versions', event: 'UPDATE', filter: `branch_id=eq.${branchId}` },
      { table: 'menu_items', filter: `branch_id=eq.${branchId}` },
    ],
    onChange: refresh,
    // Called on first connect too; only a long sleep is worth re-running the page.
    refetch: () => {
      if (Date.now() - lastRefresh.current > WAKE_MIN_AGE_MS) refresh();
    },
  });

  // The earliest 86 that is still in the future. The page re-reads the list on every refresh,
  // so the next one is scheduled when this one fires.
  const nextExpiry = React.useMemo(() => {
    const now = Date.now();
    let best: number | null = null;
    for (const iso of Object.values(soldOutUntil)) {
      const at = new Date(iso).getTime();
      if (Number.isFinite(at) && at > now && (best === null || at < best)) best = at;
    }
    return best;
  }, [soldOutUntil]);

  React.useEffect(() => {
    if (nextExpiry === null) return undefined;
    // A second late, so the server sees the 86 as over when it re-renders.
    const ms = nextExpiry - Date.now() + 1_000;
    if (ms > MAX_TIMEOUT_MS) return undefined;
    const id = window.setTimeout(refresh, Math.max(0, ms));
    return () => window.clearTimeout(id);
  }, [nextExpiry, refresh]);

  const reloadPrices = React.useCallback(async () => {
    try {
      const supabase = getBrowserClient();
      const { data, error } = await supabase.rpc('get_effective_prices', { p_branch_id: branchId });
      if (error || !data) return;
      onPricesRef.current(effectivePriceMap(data as EffectivePriceRow[]));
    } catch {
      // Keep the prices the till has; the next tick tries again.
    }
  }, [branchId]);

  React.useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void reloadPrices();
    };
    const id = window.setInterval(tick, PRICE_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [reloadPrices]);

  return { refresh, reloadPrices };
}
