import type { DeliveryDispatchState } from '@favornoms/database/queries';

// What the kitchen board and Live deliveries say about finding a rider. Both boards used to
// guess: the kitchen spun "Searching for a rider…" for 120 seconds after "ready" with nothing
// running on the server, then printed "No rider found — tap to retry", and the retry wiped the
// round so the rider who had just declined was asked again (and struck again, which is how two
// riders ended up on a cooldown). The server now runs the round (docs/DISPATCH-FIXES-2026-10-05.md
// D1/D2) and writes where it stands on the delivery row; everything here reads that row, and the
// answer dispatch-driver gave this screen, and nothing else. No clock on this side ever decides
// that nobody was found.
//
// Pure: no React, no network. The view words every result in the reader's language.

/** Why a round found nobody (or is waiting), as a key the views word. The five of D7, plus every
 *  rider busy on another job (the commonest reason at a busy branch) and a setup gap (no map pin,
 *  nobody approved or verified, nobody in range) that no amount of waiting fixes. */
export type NoRiderReason =
  | 'everyoneAsked'
  | 'cooldown'
  | 'nobodyOnline'
  | 'noFreshGps'
  | 'allBusy'
  | 'notSetUp'
  | 'windowOver';

/** The delivery-row fields the dispatch line is read from. Both boards' row types fit it. */
export interface DispatchRowFields {
  status: string;
  driver_id: string | null;
  accepted_at?: string | null;
  offer_expires_at?: string | null;
  /**
   * `undefined` means the row was read without the column (an older select, or a database the
   * migration has not reached); `null` means the server has no round running for it.
   */
  dispatch_state?: DeliveryDispatchState | string | null;
  dispatch_round_started_at?: string | null;
  dispatch_history?: unknown;
  batch_id?: string | null;
}

/**
 * The gate counts dispatch_candidate_diagnostics returns. Each count is independent of the
 * others (not a funnel), and any of them may be missing from an older server.
 */
export interface DispatchDiagnostics {
  branch_has_pin?: boolean;
  max_gps_age_min?: number;
  radius_km?: number;
  approved?: number;
  online?: number;
  kyc_verified?: number;
  not_cooling_down?: number;
  /** Riders the round skipped because they are on a cooldown. */
  cooling_down?: number;
  has_location?: number;
  gps_fresh?: number;
  in_radius?: number;
  not_busy?: number;
  /** Riders already asked in this round, who are not asked again until a new one. */
  already_asked?: number;
  /**
   * private.dispatch_funnel's verdict: the first gate, in find_dispatch_candidates' order, that
   * left nobody ('no_branch_pin', 'none_approved', 'nobody_online', 'kyc_not_verified',
   * 'cooling_down', 'no_fresh_gps', 'out_of_radius', 'riders_busy', 'everyone_asked'). The counts
   * above are independent of each other and cannot say that; the server's funnel can.
   */
  reason?: string;
}

export interface DispatchFailure {
  error?: string;
  diagnostics?: DispatchDiagnostics | null;
}

export type DispatchFailureKey =
  | 'maxAttempts'
  | 'notEntitled'
  | 'notDispatchable'
  | 'alreadyAccepted'
  | 'authRequired'
  | 'notAuthorized'
  | 'failed'
  | 'noneAvailable'
  | 'noPin'
  | 'noneApproved'
  | 'noneOnline'
  | 'noneVerified'
  | 'allCoolingDown'
  | 'noLocation'
  | 'gpsStale'
  | 'allBusy'
  | 'outOfRangeMiles'
  | 'outOfRange'
  | 'alreadyAsked'
  | 'someCoolingDown';

/** A sentence to show, as a key under `<namespace>.dispatch` plus its values. */
export interface DispatchFailureText {
  key: DispatchFailureKey;
  values?: Record<string, number>;
  /** The server's own code when this screen does not know it — for the log, never the screen. */
  code?: string;
}

const isZero = (n: number | undefined): boolean => n != null && n <= 0;

/** Turn dispatch-driver's gate counts into the one sentence that tells the merchant where to
 *  look. Ordered from "nothing is set up" to "everyone free was already asked", so the first
 *  failing gate is the one reported. A count the server did not send is skipped, never read as
 *  zero. `status` is the HTTP status of the response the body came from. */
export function describeDispatchFailure(body: DispatchFailure | null, status?: number): DispatchFailureText {
  // Every answer dispatch-driver writes itself carries `error`, and its no-rider answer also
  // carries `diagnostics`. A body with neither never reached the function: the platform
  // gateway rejected the JWT itself (401 {"code":401,"message":"Invalid JWT"}, e.g. a stale
  // token after a key rotation) or failed (5xx). Reading that as "no rider available" sent
  // the merchant after riders, and nothing was logged.
  if (!body?.error && !body?.diagnostics) {
    if (status === 401) return { key: 'authRequired' };
    if (status === 403) return { key: 'notAuthorized' };
    return status != null ? { key: 'failed', code: `http_${status}` } : { key: 'failed' };
  }
  if (body?.error && body.error !== 'no_drivers_available' && body.error !== 'no_rider_found') {
    // A server before the 2026-10-05 rounds stopped after driver_max_attempts offers.
    if (body.error === 'max_attempts_reached') return { key: 'maxAttempts' };
    // Only a dispatch-driver older than v2.5 sends this; kept so a stale deployment reads right.
    if (body.error === 'feature_not_entitled') return { key: 'notEntitled' };
    // Past dispatching (picked up, cancelled), or gone altogether: either way nothing to search for.
    if (
      body.error === 'delivery_not_dispatchable' ||
      body.error === 'not_dispatchable' ||
      body.error === 'delivery_not_found'
    ) {
      return { key: 'notDispatchable' };
    }
    // D6: a new round is refused once a rider has accepted — the job is no longer looking.
    if (body.error === 'already_accepted') return { key: 'alreadyAccepted' };
    // The two refusals, both before anything is written: the session has expired, or the
    // caller lacks delivery.manage / kitchen.access at the delivery's branch.
    if (body.error === 'auth_required') return { key: 'authRequired' };
    if (body.error === 'not_authorized' || body.error === 'forbidden') return { key: 'notAuthorized' };
    // Any other code is server vocabulary, not a sentence for the merchant.
    return { key: 'failed', code: body.error };
  }
  const d = body?.diagnostics;
  if (!d) return { key: 'noneAvailable' };
  const funnel = gateFromFunnel(d);
  if (funnel) return funnel;
  if (d.branch_has_pin === false) return { key: 'noPin' };
  if (isZero(d.approved)) return { key: 'noneApproved' };
  if (isZero(d.online)) return { key: 'noneOnline', values: { approved: d.approved ?? 0 } };
  const online = d.online ?? 0;
  if (isZero(d.kyc_verified)) return { key: 'noneVerified', values: { online } };
  // The reason the owner never saw: riders online, but every one of them on the strike
  // cooldown. Named, so the merchant knows the cooldown can be lifted on Drivers.
  if (isZero(d.not_cooling_down) || (d.cooling_down != null && d.online != null && d.cooling_down >= d.online)) {
    return { key: 'allCoolingDown', values: { online } };
  }
  if (isZero(d.has_location)) return { key: 'noLocation', values: { online } };
  if (isZero(d.gps_fresh)) return { key: 'gpsStale', values: { online, minutes: d.max_gps_age_min ?? 5 } };
  if (isZero(d.not_busy)) return { key: 'allBusy', values: { online } };
  if (isZero(d.in_radius)) {
    const mi = d.radius_km != null ? Math.round(d.radius_km / 1.609344) : null;
    return mi != null
      ? { key: 'outOfRangeMiles', values: { online, miles: mi } }
      : { key: 'outOfRange', values: { online } };
  }
  const cooling = Math.max(0, d.cooling_down ?? 0);
  if ((d.already_asked ?? 0) > 0) {
    return { key: 'alreadyAsked', values: { asked: d.already_asked ?? 0, cooling } };
  }
  if (cooling > 0) return { key: 'someCoolingDown', values: { online, cooling } };
  return { key: 'noneAvailable' };
}

/** The sentence for the server's own funnel verdict, with the counts it has; null when the
 *  diagnostics carry no verdict this screen knows (an older server), so the counts decide. */
function gateFromFunnel(d: DispatchDiagnostics): DispatchFailureText | null {
  const online = Math.max(0, d.online ?? 0);
  switch (d.reason) {
    case 'no_branch_pin':
      return { key: 'noPin' };
    case 'none_approved':
      return { key: 'noneApproved' };
    case 'nobody_online':
      return { key: 'noneOnline', values: { approved: Math.max(0, d.approved ?? 0) } };
    case 'kyc_not_verified':
      return { key: 'noneVerified', values: { online } };
    case 'cooling_down':
      return { key: 'allCoolingDown', values: { online } };
    case 'no_fresh_gps':
      return isZero(d.has_location)
        ? { key: 'noLocation', values: { online } }
        : { key: 'gpsStale', values: { online, minutes: d.max_gps_age_min ?? 5 } };
    case 'out_of_radius': {
      const mi = d.radius_km != null ? Math.round(d.radius_km / 1.609344) : null;
      return mi != null
        ? { key: 'outOfRangeMiles', values: { online, miles: mi } }
        : { key: 'outOfRange', values: { online } };
    }
    case 'riders_busy':
      return { key: 'allBusy', values: { online } };
    case 'everyone_asked':
      return { key: 'alreadyAsked', values: { asked: Math.max(0, d.already_asked ?? 0), cooling: Math.max(0, d.cooling_down ?? 0) } };
    default:
      return null;
  }
}

/** The gate sentence a reason line stands for, read down to the reasons the boards word. */
function reasonFromFailure(key: DispatchFailureKey): NoRiderReason | null {
  switch (key) {
    case 'noneOnline':
      return 'nobodyOnline';
    case 'noPin':
    case 'noneApproved':
    case 'noneVerified':
    case 'outOfRange':
    case 'outOfRangeMiles':
      return 'notSetUp';
    case 'allCoolingDown':
    case 'someCoolingDown':
      return 'cooldown';
    case 'noLocation':
    case 'gpsStale':
      return 'noFreshGps';
    case 'allBusy':
      return 'allBusy';
    case 'alreadyAsked':
    case 'maxAttempts':
      return 'everyoneAsked';
    default:
      return null;
  }
}

/** private.dispatch_funnel's reason codes (and 'round_over', a staff "find" on a round that
 *  already ended), as the reasons the boards word. */
const REASON_CODES: Record<string, NoRiderReason> = {
  everyone_asked: 'everyoneAsked',
  cooling_down: 'cooldown',
  nobody_online: 'nobodyOnline',
  no_fresh_gps: 'noFreshGps',
  riders_busy: 'allBusy',
  none_approved: 'notSetUp',
  kyc_not_verified: 'notSetUp',
  no_branch_pin: 'notSetUp',
  out_of_radius: 'notSetUp',
  round_over: 'windowOver',
};

/**
 * The server's reason code (or, failing that, its gate counts) as one of the reasons the boards
 * word. Known codes are read exactly; anything else is matched loosely, because a reason this
 * screen cannot read must still fall back to something true rather than to nothing. Null when
 * neither the code nor the counts say anything.
 */
export function noRiderReasonOf(reason: unknown, diagnostics?: DispatchDiagnostics | null): NoRiderReason | null {
  if (typeof reason === 'string' && reason.trim() !== '') {
    const r = reason.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(REASON_CODES, r)) return REASON_CODES[r]!;
    if (r.includes('cool')) return 'cooldown';
    if (r.includes('online') || r.includes('offline')) return 'nobodyOnline';
    if (r.includes('gps') || r.includes('location')) return 'noFreshGps';
    if (r.includes('busy')) return 'allBusy';
    if (r.includes('pin') || r.includes('radius') || r.includes('kyc') || r.includes('approved')) return 'notSetUp';
    if (r.includes('ask') || r.includes('declin') || r.includes('reject') || r.includes('exhaust') || r.includes('everyone')) {
      return 'everyoneAsked';
    }
    if (r.includes('window') || r.includes('time')) return 'windowOver';
  }
  if (diagnostics) return reasonFromFailure(describeDispatchFailure({ diagnostics }).key);
  return null;
}

// ---------------------------------------------------------------------------------------
// The per-offer log (deliveries.dispatch_history)

interface LogEntry {
  type: string;
  driverId: string | null;
  atMs: number | null;
  roundMs: number | null;
  reason: unknown;
  diagnostics: DispatchDiagnostics | null;
  /** The round's asked count as the server wrote it on a waiting / no_rider_found entry. */
  asked: number | null;
}

function parseMs(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** dispatch_history as entries. Every field is read defensively: the log has been written by
 *  three generations of dispatch code (`result: 'no_drivers'`, `attempted_at`, `at`). */
function readLog(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: LogEntry[] = [];
  for (const item of raw) {
    const e = asObject(item);
    if (!e) continue;
    const type = typeof e.type === 'string' ? e.type : typeof e.result === 'string' ? e.result : '';
    out.push({
      type,
      driverId: typeof e.driver_id === 'string' ? e.driver_id : null,
      atMs: parseMs(e.at) ?? parseMs(e.attempted_at) ?? parseMs(e.ts),
      roundMs: parseMs(e.round_started_at) ?? parseMs(e.round_start) ?? parseMs(e.round),
      reason: e.reason,
      diagnostics: asObject(e.diagnostics) as DispatchDiagnostics | null,
      asked: typeof e.asked === 'number' && Number.isFinite(e.asked) ? e.asked : null,
    });
  }
  return out;
}

/** Postgres keeps microseconds that JavaScript drops; a stamp within this is the same stamp. */
const SAME_STAMP_MS = 2;

/** Whether an entry belongs to the round that started at `roundMs`. Entries name their round;
 *  older ones only carry a time, and an entry written at or after the start is in it. */
function inRound(e: LogEntry, roundMs: number | null): boolean {
  if (roundMs == null) return true;
  if (e.roundMs != null) return Math.abs(e.roundMs - roundMs) < SAME_STAMP_MS;
  return e.atMs != null && e.atMs > roundMs - SAME_STAMP_MS;
}

/** A rider's turn at a delivery (delivery_assignments) — another record of who was asked. */
export interface OfferRef {
  driver_id: string;
  offered_at: string;
}

/**
 * How many different riders this round has asked — the same rule as the server's
 * private.dispatch_asked_riders: every rider named by a log entry of the round (offered, then
 * declined, expired, withdrawn, or a rider who handed an accepted job back), and every rider turn
 * offered since the round began. A stack is one unit (D5): a rider asked for either stop counts
 * once. The count the server itself wrote on its latest waiting / no_rider_found entry is a floor,
 * so a log entry it trimmed is not a rider forgotten.
 */
export function askedInRound(rows: readonly DispatchRowFields[], offers: readonly OfferRef[] = []): number {
  const asked = new Set<string>();
  let earliestRound: number | null = null;
  let written = 0;
  for (const row of rows) {
    const roundMs = parseMs(row.dispatch_round_started_at ?? null);
    if (roundMs != null) earliestRound = earliestRound == null ? roundMs : Math.min(earliestRound, roundMs);
    for (const e of readLog(row.dispatch_history)) {
      if (!inRound(e, roundMs)) continue;
      if (e.driverId) asked.add(e.driverId);
      if (e.asked != null) written = Math.max(written, e.asked);
    }
  }
  // An assignment row has no round of its own; it is in the round if it was offered after the
  // round began. Without a round start there is nothing to tie it to, so it is not counted.
  if (earliestRound != null) {
    for (const o of offers) {
      const at = parseMs(o.offered_at);
      if (at != null && at > earliestRound - SAME_STAMP_MS) asked.add(o.driver_id);
    }
  }
  return Math.max(asked.size, written);
}

/** The newest entry of one of `types` in its row's current round, across a stack's rows. */
function latestInRound(rows: readonly DispatchRowFields[], types: readonly string[]): LogEntry | null {
  let best: LogEntry | null = null;
  let bestOrder = -Infinity;
  for (const row of rows) {
    const roundMs = parseMs(row.dispatch_round_started_at ?? null);
    const log = readLog(row.dispatch_history);
    for (let i = 0; i < log.length; i += 1) {
      const e = log[i]!;
      if (!types.includes(e.type) || !inRound(e, roundMs)) continue;
      // Entries without a time keep their order in the log.
      const order = e.atMs ?? i;
      if (order >= bestOrder) {
        best = e;
        bestOrder = order;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------
// dispatch-driver's answer

export type DispatchAnswer =
  | { kind: 'offered'; driverId: string | null; expiresAt: string | null; asked: number | null }
  | { kind: 'searching'; asked: number | null }
  | { kind: 'waiting'; asked: number | null; why: NoRiderReason | null; failure: DispatchFailureText | null }
  | { kind: 'noRiderFound'; asked: number | null; reason: NoRiderReason; failure: DispatchFailureText | null }
  /** D6: a new round was refused because a rider has already accepted. */
  | { kind: 'alreadyAccepted' }
  /** Nothing was dispatched; `failure` says why (signed out, not allowed, not dispatchable…). */
  | { kind: 'refused'; failure: DispatchFailureText };

function numberOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * dispatch-driver's reply as one of the things it can mean. The server's own `result`
 * (public.staff_dispatch_delivery) wins whatever the HTTP status; the older replies — 200
 * `{status:'offered'}`, 503 `no_drivers_available` with gate counts, 409 refusals — are still
 * read, so the boards keep working against a deployment that has not caught up.
 */
export function readDispatchAnswer(status: number | null, body: unknown): DispatchAnswer {
  const b = asObject(body);
  const diagnostics = (asObject(b?.diagnostics) as DispatchDiagnostics | null) ?? null;
  const asked = numberOf(b?.asked_count);
  const result =
    typeof b?.result === 'string' ? b.result : b?.status === 'offered' ? 'offered' : null;
  const gate = diagnostics ? describeDispatchFailure({ diagnostics }) : null;

  switch (result) {
    case 'offered':
    case 'offered_batch':
      return {
        kind: 'offered',
        driverId: typeof b?.driver_id === 'string' ? b.driver_id : null,
        expiresAt: typeof b?.offer_expires_at === 'string' ? b.offer_expires_at : null,
        asked,
      };
    case 'searching':
      return { kind: 'searching', asked };
    case 'waiting':
      return { kind: 'waiting', asked, why: noRiderReasonOf(b?.reason, diagnostics), failure: gate };
    case 'no_rider_found':
      return {
        kind: 'noRiderFound',
        asked,
        reason: noRiderReasonOf(b?.reason, diagnostics) ?? 'windowOver',
        failure: gate,
      };
    case 'already_accepted':
      return { kind: 'alreadyAccepted' };
    case 'not_dispatchable':
      return { kind: 'refused', failure: { key: 'notDispatchable' } };
    default:
      break;
  }

  const error = typeof b?.error === 'string' ? b.error : null;
  if (error === 'already_accepted') return { kind: 'alreadyAccepted' };
  if (status != null && status >= 200 && status < 300 && !error) {
    // The server took the job and said nothing this screen recognises: it is searching.
    return { kind: 'searching', asked };
  }
  return { kind: 'refused', failure: describeDispatchFailure(b as DispatchFailure | null, status ?? undefined) };
}

// ---------------------------------------------------------------------------------------
// The line a card prints

export type DispatchLine =
  /** The rider accepted; they are heading to the shop. */
  | { kind: 'accepted' }
  /** The food has left with the rider. */
  | { kind: 'withRider' }
  /** One rider has the offer on their screen until `expiresAt`. */
  | { kind: 'offered'; driverId: string; expiresAt: string; asked: number }
  /** The offer ran out a moment ago; the expiry sweep (every 30 s) moves it to the next rider. */
  | { kind: 'offerLapsed'; asked: number }
  /** The round is offering it rider by rider. */
  | { kind: 'searching'; asked: number }
  /** Every eligible rider has been asked; the sweep offers it to the next one who becomes free. */
  | { kind: 'waiting'; asked: number; why: NoRiderReason | null }
  /** The search window ran out (D2). Only ever because the server said so. */
  | { kind: 'noRiderFound'; asked: number; reason: NoRiderReason }
  /** Waiting for a rider with no round running: nothing on the server is looking. */
  | { kind: 'notStarted' }
  /** The row was read without dispatch_state: say it is looking, never that nobody was found. */
  | { kind: 'unknown'; asked: number }
  /** A self-delivery branch's order, parked at assigned with nobody on it: its own staff carry it. */
  | { kind: 'selfDelivery' }
  /** Failed, delivered or cancelled — not this line's business. */
  | { kind: 'closed' };

export interface DispatchLineInput {
  nowMs: number;
  /** The other stops of the same stack (same batch_id). Their riders count toward this one. */
  stack?: readonly DispatchRowFields[];
  /** This screen's last dispatch-driver answer for the delivery, if any. */
  answer?: DispatchAnswer | null;
  /** delivery_assignments rows for the delivery (and its stack), where the board loads them. */
  offers?: readonly OfferRef[];
}

/** The delivery-row columns the dispatch line reads that a board's select may not name. */
const DISPATCH_COLUMNS = ['offer_expires_at', 'dispatch_state', 'dispatch_round_started_at', 'dispatch_history'] as const;

/**
 * A delivery row just read, with the dispatch columns the board already holds for it when the
 * read did not name them. A board whose select predates those columns learns them from realtime
 * payloads (which carry the whole row); without this, every refetch — on reconnect, on focus,
 * after a tap — dropped them again and the card fell back to "Searching…". The read still wins
 * for every column it did name, and a column it named as null stays null.
 */
export function withKnownDispatchColumns<T extends { id: string }>(read: T, known: T | null | undefined): T {
  if (!known || known.id !== read.id) return read;
  let out: T | null = null;
  for (const col of DISPATCH_COLUMNS) {
    if (col in read || !(col in known)) continue;
    out ??= { ...read };
    (out as Record<string, unknown>)[col] = (known as Record<string, unknown>)[col];
  }
  return out ?? read;
}

/** The stops of `row`'s stack among `all`, excluding `row` itself. Empty when not stacked. */
export function stackPeers<T extends DispatchRowFields & { id: string }>(row: T, all: readonly T[]): T[] {
  if (!row.batch_id) return [];
  return all.filter((o) => o.id !== row.id && o.batch_id === row.batch_id);
}

/**
 * What the card says about finding a rider. The row is the truth; the answer this screen got
 * from dispatch-driver only fills what the row cannot say yet — a reason the log does not
 * carry, or a whole verdict while the row was read without dispatch_state.
 */
export function dispatchLine(row: DispatchRowFields, input: DispatchLineInput): DispatchLine {
  const { nowMs, stack = [], answer = null, offers = [] } = input;
  const rows = [row, ...stack];
  const computed = askedInRound(rows, offers);
  const fromAnswer = answer && 'asked' in answer ? answer.asked : null;
  const asked = computed > 0 ? computed : Math.max(0, fromAnswer ?? 0);

  switch (row.status) {
    case 'picked_up':
    case 'in_transit':
      return { kind: 'withRider' };
    case 'pending':
    case 'dispatching':
      break;
    case 'assigned': {
      if (row.accepted_at) return { kind: 'accepted' };
      // assigned with nobody on it is how a self-delivery branch parks a ready order for its own
      // staff (the server refuses to dispatch it: 'self_delivery'). No rider is being looked for.
      if (!row.driver_id) return { kind: 'selfDelivery' };
      const exp = parseMs(row.offer_expires_at ?? null);
      if (exp != null && exp > nowMs) return { kind: 'offered', driverId: row.driver_id, expiresAt: row.offer_expires_at!, asked };
      return { kind: 'offerLapsed', asked };
    }
    default:
      return { kind: 'closed' };
  }

  const state = row.dispatch_state;
  if (state === 'no_rider_found') {
    const entry = latestInRound(rows, ['no_rider_found']);
    const reason =
      noRiderReasonOf(entry?.reason, entry?.diagnostics) ??
      (answer?.kind === 'noRiderFound' ? answer.reason : null) ??
      'windowOver';
    return { kind: 'noRiderFound', asked, reason };
  }
  if (state === 'waiting') {
    const entry = latestInRound(rows, ['waiting']);
    const why =
      noRiderReasonOf(entry?.reason, entry?.diagnostics) ??
      (answer?.kind === 'waiting' ? answer.why : null);
    return { kind: 'waiting', asked, why };
  }
  if (state === 'searching') return { kind: 'searching', asked };

  // No state on the row. Either the row was read without the column (undefined), or the server
  // has nothing running (null). The answer this screen just got is newer than both.
  const verdict = lineFromAnswer(answer, asked);
  if (verdict) return verdict;
  return state === null ? { kind: 'notStarted' } : { kind: 'unknown', asked };
}

function lineFromAnswer(answer: DispatchAnswer | null, asked: number): DispatchLine | null {
  switch (answer?.kind) {
    case 'searching':
      return { kind: 'searching', asked };
    case 'waiting':
      return { kind: 'waiting', asked, why: answer.why };
    case 'noRiderFound':
      return { kind: 'noRiderFound', asked, reason: answer.reason };
    // An offer answer is followed by the row turning `assigned`; until it lands, the round is
    // simply under way.
    case 'offered':
      return { kind: 'searching', asked: Math.max(asked, 1) };
    default:
      return null;
  }
}

/** The button a card offers for finding a rider. `start` continues or starts the round;
 *  `restart` is "Find rider again": a new round in which everyone may be asked again. */
export type FindRiderAction = 'start' | 'restart' | null;

export function findRiderAction(line: DispatchLine): FindRiderAction {
  switch (line.kind) {
    case 'notStarted':
    // Read without dispatch_state, a press is what the board did before the server ran rounds,
    // and it is harmless: the server continues whatever round there is.
    case 'unknown':
      return 'start';
    case 'noRiderFound':
      return 'restart';
    default:
      return null;
  }
}

/**
 * Whether "Find rider again" (a new round) may be offered at all: until a rider accepts. The
 * server refuses it after that (409 already_accepted), and the kitchen's menu used to offer
 * "Re-dispatch (start over)" on a ticket whose rider was already on the way to the shop.
 */
export function canRestartDispatch(row: Pick<DispatchRowFields, 'status' | 'accepted_at' | 'driver_id'>): boolean {
  if (row.accepted_at) return false;
  // A self-delivery order parked for the shop's own staff is not looking for a rider at all.
  if (row.status === 'assigned' && !row.driver_id) return false;
  return row.status === 'pending' || row.status === 'dispatching' || row.status === 'assigned';
}
