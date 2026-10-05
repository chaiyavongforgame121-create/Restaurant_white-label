// When a queued notification is still worth sending, and how a push service should carry it
// (docs/DISPATCH-FIXES-2026-10-05.md D10). Used by notify-worker.
//
// Why this exists: the worker never ran on the live project (private.app_settings had no
// notify_worker_url), so notifications_outbox holds months of `pending` rows — delivery offers that
// expired in June, "your rider is arriving" for orders long delivered. Switched on as it was, the
// worker would have sent every one of them, oldest first, 25 a minute: about seven minutes of
// stale pushes before the first live offer got out. And web-push's defaults (TTL four weeks,
// urgency normal) let a push service hold an offer, or Android's Doze delay it, far longer than
// the 75 seconds the offer lives.
//
// The rules:
//   • An offer (new_dispatch) is stale once its offer is over: created_at + expires_in_seconds
//     (120 s when the row does not say), or the offer_expires_at it carries if that is sooner.
//   • Anything else is stale 30 minutes after it fell due (the later of created_at and
//     scheduled_for). No offer outlives that either, so one cutoff retires every old row at once.
//   • A row that cannot be dated is stale: a push nobody can place in time is not sent.
//   • Fresh offers go first, then everything else; newest first within each, so a backlog never
//     sits in front of a live offer.
//   • An offer is sent with urgency high and a TTL of the seconds it has left; anything else with
//     urgency normal and a TTL of the time left before it would be stale.
//
// PURE ON PURPOSE. Nothing here imports, reads Deno.env or touches a database, so the admin app's
// vitest pins every rule (apps/admin/src/lib/notify-staleness-edge.test.ts).
//
// NOTE ON DEPLOYMENT: the Supabase CLI uploads the whole `supabase/functions` tree, so
// `../_shared/notify-staleness.ts` resolves. Through the Management API / MCP, pass this file as
// `_shared/notify-staleness.ts` next to `notify-worker/index.ts`.

/** The rider offer push. */
export const OFFER_TEMPLATE = 'new_dispatch';

/** An offer whose row does not say how long it lives: the default offer TTL (75 s) and some queue. */
export const OFFER_FALLBACK_LIFE_SEC = 120;

/** How long after it fell due anything else is still worth sending. Also the most an offer lives. */
export const STALE_AFTER_SEC = 30 * 60;

/** The outbox columns these rules read. */
export interface OutboxTiming {
  template: string;
  variables: Record<string, unknown> | null | undefined;
  created_at: string | null | undefined;
  scheduled_for: string | null | undefined;
}

export type StaleReason = 'offer_expired' | 'too_old' | 'undated';

export interface PushOptions {
  /** Seconds a push service may hold the message for a device that is offline. */
  TTL: number;
  urgency: 'high' | 'normal';
}

const isOffer = (row: OutboxTiming): boolean => row.template === OFFER_TEMPLATE;

function timeMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A positive number of seconds, from a number or a numeric string; null otherwise. */
function positiveSeconds(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The moment (epoch ms) after which the row is not worth sending, or null when it cannot be dated.
 */
export function staleAtMs(row: OutboxTiming): number | null {
  const created = timeMs(row.created_at);
  if (isOffer(row)) {
    // The offer's clock starts when it was queued, which is when it was made.
    if (created === null) return null;
    const vars = row.variables ?? {};
    const life = Math.min(positiveSeconds(vars.expires_in_seconds) ?? OFFER_FALLBACK_LIFE_SEC, STALE_AFTER_SEC);
    const byLife = created + life * 1000;
    const stated = timeMs(vars.offer_expires_at);
    return stated === null ? byLife : Math.min(byLife, stated);
  }
  const scheduled = timeMs(row.scheduled_for);
  if (created === null && scheduled === null) return null;
  // Due when it was queued, or when it was scheduled for if that is later.
  const due = Math.max(created ?? -Infinity, scheduled ?? -Infinity);
  return due + STALE_AFTER_SEC * 1000;
}

/** Why the row should not be sent at `nowMs`, or null when it should. */
export function staleReason(row: OutboxTiming, nowMs: number): StaleReason | null {
  const until = staleAtMs(row);
  if (until === null) return 'undated';
  if (nowMs < until) return null;
  return isOffer(row) ? 'offer_expired' : 'too_old';
}

/** Whole seconds left before the row is stale; 0 once it is (or when it cannot be dated). */
export function secondsLeft(row: OutboxTiming, nowMs: number): number {
  const until = staleAtMs(row);
  return until === null ? 0 : Math.max(0, Math.floor((until - nowMs) / 1000));
}

/**
 * How the push service should carry this row. An offer is urgent (Android delivers it through
 * Doze) and worthless once over, so it lives exactly as long as the offer. Anything else waits
 * like any notification, and no longer than it is worth sending. Never below 1 second: a TTL of 0
 * asks the service to drop the message unless the device is reachable that instant.
 */
export function pushOptions(row: OutboxTiming, nowMs: number): PushOptions {
  return {
    TTL: Math.max(1, secondsLeft(row, nowMs)),
    urgency: isOffer(row) ? 'high' : 'normal',
  };
}

/**
 * What the push itself carries beyond title, body, url and tag, so the rider app's service worker
 * can tell an open app an offer arrived and close the notification once the offer is gone.
 */
export function pushData(row: OutboxTiming): Record<string, unknown> {
  const out: Record<string, unknown> = { template: row.template };
  if (!isOffer(row)) return out;
  const vars = row.variables ?? {};
  if (typeof vars.delivery_id === 'string') out.delivery_id = vars.delivery_id;
  if (typeof vars.batch_id === 'string') out.batch_id = vars.batch_id;
  const until = staleAtMs(row);
  if (until !== null) out.expires_at = new Date(until).toISOString();
  return out;
}

/**
 * The cutoff for retiring old rows in one statement: a row whose created_at AND scheduled_for are
 * both before it is stale whatever its template (an offer never lives longer than STALE_AFTER_SEC).
 */
export function staleCutoffIso(nowMs: number): string {
  return new Date(nowMs - STALE_AFTER_SEC * 1000).toISOString();
}

/** Sort key: when the row became worth sending (later = newer). Undated rows never get here. */
function dueMs(row: OutboxTiming): number {
  const created = timeMs(row.created_at) ?? -Infinity;
  const scheduled = timeMs(row.scheduled_for) ?? -Infinity;
  return isOffer(row) ? created : Math.max(created, scheduled);
}

export interface SendPlan<T> {
  /** Rows to send this run, in order: offers first, newest first within each group. */
  send: T[];
  /** Rows to mark skipped, each with why. Never limited: retiring is one cheap statement. */
  stale: Array<{ row: T; reason: StaleReason }>;
}

/**
 * Splits the rows a run fetched into what to send now (at most `limit`) and what to retire.
 * Fresh rows beyond `limit` are neither: they wait for the next run.
 */
export function planSend<T extends OutboxTiming>(rows: readonly T[], nowMs: number, limit: number): SendPlan<T> {
  const fresh: T[] = [];
  const stale: Array<{ row: T; reason: StaleReason }> = [];
  for (const row of rows) {
    const reason = staleReason(row, nowMs);
    if (reason) stale.push({ row, reason });
    else fresh.push(row);
  }
  fresh.sort((a, b) => {
    const offerFirst = Number(isOffer(b)) - Number(isOffer(a));
    return offerFirst !== 0 ? offerFirst : dueMs(b) - dueMs(a);
  });
  return { send: fresh.slice(0, Math.max(0, limit)), stale };
}
