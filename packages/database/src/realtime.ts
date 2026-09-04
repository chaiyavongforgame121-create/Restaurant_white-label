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

/**
 * A rider's phone pushes GPS every 3 seconds, and each push is a `deliveries` UPDATE, so
 * a screen that refetches per payload was doing ~20 full reads a minute — every one of
 * them replacing the order object and repainting the tracking subtree. Collapse a burst
 * into a single read instead; a fifth of a second is far below what anyone perceives as
 * lag on a map pin, and well above the cadence of a chatty table.
 */
const CHANGE_COALESCE_MS = 250;

/**
 * How long a channel must stay SUBSCRIBED before its retry counter is forgiven. Resetting
 * on SUBSCRIBED alone meant a channel that connected and dropped again immediately never
 * climbed past the first 1000 ms step, so a misconfigured publication reconnected at a
 * fixed ~1 Hz forever — repainting the "Reconnecting…" strip and refetching each time.
 */
const STABLE_CONNECTION_MS = 10_000;

/**
 * Most drops are recovered inside a second. Waiting before admitting to being unhealthy
 * keeps the banner out of the DOM for the blips nobody needs to know about, and still
 * shows it for the outages they do.
 */
const UNHEALTHY_AFTER_MS = 3_000;

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

  // Two mounts of the same component (React StrictMode does this on every dev mount) ask
  // for the same channel name, and `removeChannel` is async: the second mount joins the
  // topic before the first one's phx_leave has landed, and Realtime answers the duplicate
  // join with CHANNEL_ERROR. Suffixing the topic per hook instance keeps a leaving channel
  // and a joining one from ever colliding.
  const instanceId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');

  // The table list is rebuilt on every render by most callers; serialising it keeps the
  // effect from resubscribing in a loop.
  const tablesKey = JSON.stringify(tables);

  React.useEffect(() => {
    if (!enabled) return;

    const spec: RealtimeTable[] = JSON.parse(tablesKey);
    const supabase = getBrowserClient();
    const topic = `${channel}-${instanceId}`;

    let current: RealtimeChannel | null = null;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    let unhealthyTimer: ReturnType<typeof setTimeout> | null = null;
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let queued = false;
    let disposed = false;

    function runRefetch() {
      const fn = refetchRef.current;
      if (!fn || disposed) return;
      // One read at a time. Without this, a burst that outruns the query stacks parallel
      // reads whose responses land out of order, and the screen settles on whichever
      // stale one finished last.
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      void (async () => {
        try {
          await fn();
        } catch {
          /* the caller owns how its own failure is surfaced */
        } finally {
          inFlight = false;
          if (queued && !disposed) {
            queued = false;
            scheduleRefetch();
          }
        }
      })();
    }

    function scheduleRefetch(delay: number = CHANGE_COALESCE_MS) {
      if (disposed) return;
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        runRefetch();
      }, delay);
    }

    const connect = () => {
      if (disposed) return;

      let ch = supabase.channel(topic);
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
            else scheduleRefetch();
          }) as never,
        );
      }

      current = ch.subscribe((status) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') {
          if (unhealthyTimer) {
            clearTimeout(unhealthyTimer);
            unhealthyTimer = null;
          }
          setHealthy(true);
          // Forgive the backoff only once this connection has proven it will hold.
          if (stableTimer) clearTimeout(stableTimer);
          stableTimer = setTimeout(() => {
            retries = 0;
          }, STABLE_CONNECTION_MS);
          // Catch up on anything that changed while we were not listening. Routed through
          // the same coalescer so a flapping channel cannot turn reconnects into a
          // refetch loop.
          scheduleRefetch(0);
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (stableTimer) {
            clearTimeout(stableTimer);
            stableTimer = null;
          }
          if (!unhealthyTimer) {
            unhealthyTimer = setTimeout(() => {
              unhealthyTimer = null;
              setHealthy(false);
            }, UNHEALTHY_AFTER_MS);
          }
          if (retryTimer) clearTimeout(retryTimer);
          const delay = Math.min(1000 * 2 ** retries, MAX_BACKOFF_MS);
          retries += 1;
          retryTimer = setTimeout(() => {
            void (async () => {
              if (disposed) return;
              // Wait for the leave to land before rejoining, or the new channel races the
              // old one off the socket.
              if (current) await supabase.removeChannel(current);
              current = null;
              connect();
            })();
          }, delay);
        }
      });
    };

    connect();

    // A backgrounded tab's socket is usually dead by the time it comes back, and the
    // browser does not always tell us. Re-reading on focus is cheap and covers it.
    const wake = () => {
      if (document.visibilityState === 'visible') scheduleRefetch(0);
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (stableTimer) clearTimeout(stableTimer);
      if (unhealthyTimer) clearTimeout(unhealthyTimer);
      if (coalesceTimer) clearTimeout(coalesceTimer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      if (current) void supabase.removeChannel(current);
    };
  }, [channel, tablesKey, enabled, instanceId]);

  return { healthy };
}
