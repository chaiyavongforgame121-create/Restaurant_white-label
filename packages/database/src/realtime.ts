'use client';

import * as React from 'react';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { getBrowserClient } from './client';

/**
 * A Supabase realtime subscription that notices when it has stopped working.
 *
 * Every realtime surface in this codebase used to call a bare `.subscribe()` with no
 * status callback. Supabase does not throw when a channel drops — it reports
 * CHANNEL_ERROR / TIMED_OUT / CLOSED to a callback nobody passed. The result was that a
 * kitchen tablet on café wifi silently stopped receiving tickets, the diner's tracking
 * bar silently froze, and nobody found out until someone reloaded. For a kitchen screen
 * that is the difference between a busy service and a lost order.
 *
 * What this adds over `.subscribe()`:
 *   - reconnects with backoff when the channel drops
 *   - refetches on every (re)connect, so anything missed while disconnected is picked up
 *   - refetches when the tab becomes visible or the network returns — a backgrounded
 *     tablet is the common case, and the socket is usually dead by the time it wakes
 *   - reports `healthy` so the screen can say so instead of quietly lying
 *
 * `onChange` and `refetch` are held in refs, so callers do not have to memoise them for
 * the subscription to stay stable.
 */
export interface RealtimeTable {
  table: string;
  /** PostgREST filter, e.g. `branch_id=eq.${id}`. */
  filter?: string;
  event?: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
}

export interface UseRealtimeOptions {
  /** Channel name. Must be unique per subscription within the app. */
  channel: string;
  tables: RealtimeTable[];
  /** Called for each change. Omit to simply refetch on any change. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange?: (payload: RealtimePostgresChangesPayload<any>, table: string) => void;
  /** Called on first connect, on every reconnect, on tab focus and on network return. */
  refetch?: () => void | Promise<void>;
  /** Set false to tear the subscription down (e.g. while a branch id is unknown). */
  enabled?: boolean;
}

const MAX_BACKOFF_MS = 30_000;

export function useRealtime({
  channel,
  tables,
  onChange,
  refetch,
  enabled = true,
}: UseRealtimeOptions): { healthy: boolean } {
  const [healthy, setHealthy] = React.useState(true);

  const onChangeRef = React.useRef(onChange);
  const refetchRef = React.useRef(refetch);
  onChangeRef.current = onChange;
  refetchRef.current = refetch;

  // The table list is rebuilt on every render by most callers; serialising it keeps the
  // effect from resubscribing in a loop.
  const tablesKey = JSON.stringify(tables);

  React.useEffect(() => {
    if (!enabled) return;

    const spec: RealtimeTable[] = JSON.parse(tablesKey);
    const supabase = getBrowserClient();

    let current: RealtimeChannel | null = null;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;

      let ch = supabase.channel(channel);
      for (const t of spec) {
        ch = ch.on(
          // The overload for this signature is not exported; the shape is checked by the
          // options object below.
          'postgres_changes' as never,
          {
            event: t.event ?? '*',
            schema: 'public',
            table: t.table,
            ...(t.filter ? { filter: t.filter } : {}),
          } as never,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((payload: RealtimePostgresChangesPayload<any>) => {
            if (onChangeRef.current) onChangeRef.current(payload, t.table);
            else void refetchRef.current?.();
          }) as never,
        );
      }

      current = ch.subscribe((status) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') {
          retries = 0;
          setHealthy(true);
          // Catch up on anything that changed while we were not listening.
          void refetchRef.current?.();
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setHealthy(false);
          if (retryTimer) clearTimeout(retryTimer);
          const delay = Math.min(1000 * 2 ** retries, MAX_BACKOFF_MS);
          retries += 1;
          retryTimer = setTimeout(() => {
            if (disposed) return;
            if (current) void supabase.removeChannel(current);
            current = null;
            connect();
          }, delay);
        }
      });
    };

    connect();

    // A backgrounded tab's socket is usually dead by the time it comes back, and the
    // browser does not always tell us. Re-reading on focus is cheap and covers it.
    const wake = () => {
      if (document.visibilityState === 'visible') void refetchRef.current?.();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      if (current) void supabase.removeChannel(current);
    };
  }, [channel, tablesKey, enabled]);

  return { healthy };
}
