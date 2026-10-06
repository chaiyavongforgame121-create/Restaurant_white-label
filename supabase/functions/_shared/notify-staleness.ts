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
//   • An offer whose delivery is no longer offered to that rider (accepted, declined, withdrawn,
//     expired, cancelled) is not sent either: it would ring a locked phone for nothing.
//
// And how a run takes rows (CLAIMS, below): a run sends only rows it has claimed, by moving them
// from pending/failed to `sending` in one guarded UPDATE, so two runs (an overlapping tick, a kick
// after an offer, or anyone calling the URL) never send the same row twice. A claim that is never
// finished, because the run died, is released after CLAIM_LEASE_SEC.
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

/** Written to last_error as `stale:<reason>` when a row is skipped. */
export type StaleReason = 'offer_expired' | 'offer_gone' | 'too_old' | 'undated';

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

// ── Claims ───────────────────────────────────────────────────────────────────────────────────────
//
// The worker used to read pending rows, send them, and only then mark them sent. Two runs that
// overlapped (a tick that ran long, a kick after an offer landing beside the minute tick, or anyone
// calling the worker's URL, which is open until NOTIFY_WORKER_SECRET is set) read the same rows
// and sent every one of them twice: the rider's offer rang again, the diner's SMS was billed again.
//
// Now a run claims before it sends:
//   UPDATE notifications_outbox SET status = 'sending', attempts = n + 1, sent_at = <claim time>
//    WHERE id IN (...) AND attempts = n AND status IN ('pending', 'failed')  RETURNING ...
// one statement per `n` the rows were read with (claimGroups), so the counter goes up by exactly
// one per try without an increment PostgREST cannot express. Postgres re-checks the WHERE on the
// newest row version when two such UPDATEs meet, so the second one finds the row `sending` and
// skips it: each row is claimed by one run only, and a run sends only what came back.
//   • attempts is also the claim's token: the run finishes a row (sent or failed) only
//     while it is still `sending` with the attempts it claimed, so a run that outlived its lease
//     cannot overwrite the claim that replaced it.
//   • The table has no claimed_at column, so while a row is `sending`, sent_at holds the claim
//     time (the lease clock). Sent rows get the real send time; failed rows have it cleared.
//   • A row left `sending` for CLAIM_LEASE_SEC (its run died) goes back to `failed` and is retried
//     like any failure. The try it was claimed for still counts, so a row that kills the worker
//     every time stops after MAX_ATTEMPTS instead of looping.

/**
 * How long a claim holds a row before it may be retried. Longer than any run can live: the edge
 * runtime kills a function at its wall-clock limit (150 s free, 400 s paid), so a claim older than
 * this belongs to a run that is gone, not to a slow one still sending.
 */
export const CLAIM_LEASE_SEC = 10 * 60;

/** Claims taken before this moment are abandoned (see CLAIM_LEASE_SEC). */
export function leaseCutoffIso(nowMs: number): string {
  return new Date(nowMs - CLAIM_LEASE_SEC * 1000).toISOString();
}

/** One guarded UPDATE: the rows read with `attempts` tries behind them, claimed as try attempts + 1. */
export interface ClaimGroup {
  attempts: number;
  ids: string[];
}

/**
 * The rows to claim, grouped by the attempts each was read with, fewest first. A row read twice is
 * claimed once; a row with no usable count, or out of tries, is not claimed at all.
 */
export function claimGroups(
  rows: ReadonlyArray<{ id: string; attempts: number }>,
  maxAttempts: number,
): ClaimGroup[] {
  const byAttempts = new Map<number, string[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    if (!Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts >= maxAttempts) continue;
    seen.add(row.id);
    const ids = byAttempts.get(row.attempts) ?? [];
    ids.push(row.id);
    byAttempts.set(row.attempts, ids);
  }
  return [...byAttempts.entries()].sort(([a], [b]) => a - b).map(([attempts, ids]) => ({ attempts, ids }));
}

/**
 * The rows this run won, in the order it planned to send them, as the claim returned them (so
 * `attempts` is the claimed try, the token that finishes the row). Rows another run claimed first
 * are left out: that run sends them.
 */
export function claimedInPlanOrder<T extends { id: string }>(
  planned: ReadonlyArray<{ id: string }>,
  claimed: readonly T[],
): T[] {
  const won = new Map(claimed.map((row) => [row.id, row]));
  const out: T[] = [];
  for (const row of planned) {
    const mine = won.get(row.id);
    if (mine) {
      out.push(mine);
      won.delete(row.id);
    }
  }
  return out;
}

// ── Is the offer still open? ─────────────────────────────────────────────────────────────────────
//
// An offer row is queued in the transaction that makes the offer, but it is sent later (the next
// run, or a retry). If the rider has answered in the app by then, or the offer was withdrawn,
// moved on or expired early, the push is a ghost: it rings a locked phone for an offer that is not
// there. The worker reads the offer's deliveries and skips the row (`stale:offer_gone`) unless one
// of them is still offered to this rider: status 'assigned', driver_id = the recipient, not
// accepted, and offer_expires_at still ahead. A stack's push names its first stop and its batch,
// so any stop of the batch still offered to the rider keeps it open.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The deliveries columns offerIsOpen reads. */
export interface OfferDelivery {
  id: string;
  batch_id: string | null;
  status: string | null;
  driver_id: string | null;
  accepted_at: string | null;
  offer_expires_at: string | null;
}

/** The delivery (and stack) an offer row is about, or null when it names no delivery. */
export function offerTarget(row: OutboxTiming): { deliveryId: string; batchId: string | null } | null {
  if (!isOffer(row)) return null;
  const vars = row.variables ?? {};
  const deliveryId = typeof vars.delivery_id === 'string' && UUID_RE.test(vars.delivery_id) ? vars.delivery_id : null;
  if (!deliveryId) return null;
  const batchId = typeof vars.batch_id === 'string' && UUID_RE.test(vars.batch_id) ? vars.batch_id : null;
  return { deliveryId, batchId };
}

/**
 * Whether the offer this row announces is still open to its rider at `nowMs`. Null when the row
 * names no delivery, so nothing can be said: the staleness rules alone decide then.
 */
export function offerIsOpen(
  row: OutboxTiming & { recipient_id: string },
  deliveries: readonly OfferDelivery[],
  nowMs: number,
): boolean | null {
  const target = offerTarget(row);
  if (!target) return null;
  return deliveries.some((d) => {
    if (d.id !== target.deliveryId && !(target.batchId && d.batch_id === target.batchId)) return false;
    const expires = timeMs(d.offer_expires_at);
    return (
      d.status === 'assigned' &&
      d.driver_id === row.recipient_id &&
      d.accepted_at == null &&
      expires !== null &&
      expires > nowMs
    );
  });
}

// ── What a call asks for ─────────────────────────────────────────────────────────────────────────

/**
 * 'offers': only the rider offers (a kick right after an offer is queued, so the push goes out in
 * seconds rather than at the next minute tick). 'all': offers first, then everything else (the
 * minute tick, a manual call, any body this does not read). Only `{"scope":"offers"}` narrows it.
 */
export type RunScope = 'offers' | 'all';

export function runScope(body: unknown): RunScope {
  return typeof body === 'object' && body !== null && (body as { scope?: unknown }).scope === 'offers'
    ? 'offers'
    : 'all';
}
