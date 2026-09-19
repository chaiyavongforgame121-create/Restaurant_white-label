'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useRealtime } from '@favornoms/database/realtime';
import { catchUpWorthIt, changeMatters, fallbackDue, refreshDelay } from './live-model';

type RefreshKind = 'change' | 'catchUp';

/**
 * Keeps the dashboard current: live when something happens on the branch, and once a minute
 * regardless.
 *
 * The page is server-rendered and stays that way — moving eleven reads into the browser to patch
 * rows in place would be a second copy of every bucket's rules. Instead a change to this branch's
 * orders or deliveries asks for router.refresh(), which renders the page again on the server and
 * hands the new rows to the client components already on screen (which is how Action Required
 * tells a new row from an old one). Unlike the kitchen and delivery boards, this page holds no
 * local work a refetch could erase, which is what made refreshing unsafe there.
 *
 * Realtime is the fast path, not the only one. The minute's refresh stays as the fallback: half of
 * this page is clock-driven (a ticket turning late, a booking coming due) and no row changes when
 * that happens, and a socket can be down without anybody noticing. It keeps running, at half the
 * pace, while the tab is hidden (HIDDEN_FALLBACK_FACTOR): an owner on another tab is exactly who
 * the tab-title count and the chime are for.
 */
export function AutoRefresh({
  branchId,
  intervalMs = 60_000,
}: {
  branchId: string;
  intervalMs?: number;
}) {
  const router = useRouter();
  // Mounting counts as a refresh: the server rendered this page a moment ago.
  const lastRefreshAt = React.useRef(Date.now());
  const memory = React.useRef(new Map<string, string>());
  const requestRef = React.useRef<(kind: RefreshKind) => void>(() => {});

  React.useEffect(() => {
    let pending: number | null = null;
    let fallback: number | null = null;
    let disposed = false;

    const arm = () => {
      if (fallback != null) window.clearTimeout(fallback);
      fallback = window.setTimeout(onFallback, intervalMs);
    };
    function onFallback() {
      fallback = null;
      // The timer fires one interval after the last render; a hidden tab lets every other one
      // pass. Coming back into view, useRealtime asks for a catch-up at once.
      const visible = document.visibilityState === 'visible';
      if (fallbackDue(Date.now(), lastRefreshAt.current, intervalMs, visible)) request('change');
      else arm();
    }
    const refreshNow = () => {
      pending = null;
      if (disposed) return;
      lastRefreshAt.current = Date.now();
      router.refresh();
      arm();
    };
    // Every reason to refresh goes through here, so none of them can stack a second render on
    // top of one already on its way.
    function request(kind: RefreshKind) {
      if (disposed) return;
      const now = Date.now();
      if (kind === 'catchUp' && !catchUpWorthIt(now, lastRefreshAt.current)) return;
      if (pending != null) return;
      pending = window.setTimeout(refreshNow, refreshDelay(now, lastRefreshAt.current));
    }

    requestRef.current = request;
    arm();
    return () => {
      disposed = true;
      if (pending != null) window.clearTimeout(pending);
      if (fallback != null) window.clearTimeout(fallback);
      requestRef.current = () => {};
    };
  }, [router, intervalMs]);

  useRealtime({
    channel: `dashboard:${branchId}`,
    tables: [
      { table: 'orders', filter: `branch_id=eq.${branchId}` },
      { table: 'deliveries', filter: `branch_id=eq.${branchId}` },
    ],
    onChange: (payload, table) => {
      const row = (payload.eventType === 'DELETE' ? payload.old : payload.new) as
        | Record<string, unknown>
        | null;
      if (changeMatters(table, payload.eventType, row, memory.current)) {
        requestRef.current('change');
      }
    },
    // First connect, every reconnect, the tab waking and the network coming back.
    refetch: () => requestRef.current('catchUp'),
  });

  return null;
}
