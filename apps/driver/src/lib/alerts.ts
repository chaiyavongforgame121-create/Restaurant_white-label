/**
 * When FavorGO makes a noise, and when it stops. Pure, so the rules can be tested without a
 * phone: the component that plays the sound (components/driver-alerts.tsx) only asks these.
 *
 * Why the app rings at all: an offer lives for about a minute (branch offer_ttl_seconds, 75 s at
 * Food Thai Thai) and lapsing costs the rider a strike. Until now the only alert was one
 * navigator.vibrate on arrival, which Chrome blocks before the page has had a tap and which an
 * iPhone does not have, so most offers arrived in silence and expired unseen.
 */

/** How often an unanswered offer rings again: about as often as a phone rings. */
export const OFFER_RING_EVERY_MS = 3_000;
/** A timer a little early still counts as due, so the cadence does not slip to six seconds. */
const RING_DUE_SLACK_MS = 250;
/** An offer with no server deadline (rows from before dispatch v2) counts down this long on the
 *  sheet, so it rings this long too. */
export const OFFER_FALLBACK_MS = 45_000;
/** The sheet never counts down less than this, however late the offer reached the phone (or
 *  however far the phone's clock runs ahead of the server's): an offer that shows up at 0 s is
 *  an offer the rider can only lose. */
export const OFFER_MIN_SHOWN_MS = 5_000;

/** Per ring: long-short-long, so it reads as "answer me" in a pocket. Android only. */
export const OFFER_VIBRATE_PATTERN: readonly number[] = [400, 120, 400, 120, 400];
/** A job handed over outright buzzes once, like the chime. */
export const JOB_VIBRATE_PATTERN: readonly number[] = [200, 100, 200];

/** A parsed timestamp, or null when it is missing or unreadable (never NaN). */
export function parseTimeMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When this phone treats the offer as over. The server's offer_expires_at, but never sooner than
 * OFFER_MIN_SHOWN_MS after the offer first appeared here, and OFFER_FALLBACK_MS after that when
 * the offer carries no deadline. The countdown on the sheet and the ring both end here, so the
 * phone never rings for an offer its own countdown says is over.
 */
export function offerDeadlineMs(expiresAtMs: number | null, shownAtMs: number): number {
  if (expiresAtMs == null) return shownAtMs + OFFER_FALLBACK_MS;
  return Math.max(expiresAtMs, shownAtMs + OFFER_MIN_SHOWN_MS);
}

/** Whole seconds left on the countdown, never negative. */
export function secondsLeft(deadlineMs: number, now: number): number {
  return Math.max(0, Math.ceil((deadlineMs - now) / 1000));
}

export interface OfferRingInput {
  /** The offer on screen, or null. */
  offerId: string | null;
  /** offerDeadlineMs() for it. */
  deadlineMs: number | null;
  /** An accept or a decline for it is on its way to the server. */
  responding: boolean;
  now: number;
}

/**
 * Whether an offer should still be ringing: there is one, the rider has not answered it, and
 * its deadline has not passed. Accepted or declined offers leave the screen (offerId null),
 * which is how those two stop it; `responding` stops it the moment the rider taps rather than a
 * round trip later. A refused answer puts responding back to false, and the offer, still the
 * rider's, rings again.
 */
export function offerShouldRing(input: OfferRingInput): boolean {
  if (!input.offerId || input.responding || input.deadlineMs == null) return false;
  return input.now < input.deadlineMs;
}

/**
 * Whether the next ring is due. `lastRingAt` is the last ring that was actually heard or felt;
 * a ring that made no sound (audio still locked, no vibration on an iPhone) does not count, so
 * the first tap that unlocks audio rings straight away instead of up to three seconds later.
 */
export function offerRingDue(lastRingAt: number | null, now: number, every = OFFER_RING_EVERY_MS): boolean {
  if (lastRingAt == null) return true;
  return now - lastRingAt >= every - RING_DUE_SLACK_MS;
}

/** The delivery ids a job stands for on this phone: itself and, for a stack, its other stop. */
export function jobIds(job: { id: string; batchMate: { id: string } | null } | null | undefined): string[] {
  if (!job) return [];
  return job.batchMate ? [job.id, job.batchMate.id] : [job.id];
}

/**
 * Whether a job just arrived on this phone without an offer: a staff hand-over, or a second stop
 * added to the job in hand. `previous` holds every id on screen at the last confirmed read
 * (offers and jobs alike), or null before the first one. The first read only sets that baseline:
 * a job the rider already had when they opened the app is not news. An offer that turns into a
 * job (the rider accepted it) was already on screen, so it does not ring a second time.
 */
export function sightJobs(
  previous: readonly string[] | null,
  offerIds: readonly string[],
  activeIds: readonly string[],
): { seen: string[]; ringJob: boolean } {
  const seen = [...new Set([...offerIds, ...activeIds])];
  if (previous == null) return { seen, ringJob: false };
  return { seen, ringJob: activeIds.some((id) => !previous.includes(id)) };
}

/**
 * Whether to hold the screen awake. A waiting rider's phone that locks drops the realtime socket
 * and the in-app ring with it, and push may not be set up, so being online is reason enough,
 * unless the rider turned that off. During a job the screen stays on regardless: the customer's
 * map follows this phone's GPS, which a locked web page stops sending.
 */
export function wantsWakeLock(input: { online: boolean; onDelivery: boolean; keepAwake: boolean }): boolean {
  return input.onDelivery || (input.online && input.keepAwake);
}

/** A stored on/off switch: anything but the two words FavorGO writes falls back to the default. */
export function readOnOff(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return fallback;
}

/** What the rider is told when the server did not take their answer to an offer. */
export type DispatchNotice = 'offerGone' | 'offerExpired' | 'noSignal' | 'declineFailed' | 'acceptFailed';

/**
 * accept_dispatch and reject_dispatch raise plain words: 'forbidden' when the offer is no longer
 * this rider's (it expired and moved on, or staff gave it to someone else), 'offer_expired' when
 * an accept came too late. 'no_answer' is the query layer's word for a request that never got a
 * reply. Anything else (an expired session, a server fault) is a generic failure, and the offer
 * stays on screen for the server to settle.
 */
export function dispatchNotice(reason: string, action: 'accept' | 'decline'): DispatchNotice {
  const word = reason.trim().toLowerCase();
  if (word === 'no_answer') return 'noSignal';
  if (word === 'offer_expired') return 'offerExpired';
  if (word === 'forbidden' || word === 'not_offered' || word === 'offer_gone') return 'offerGone';
  return action === 'accept' ? 'acceptFailed' : 'declineFailed';
}

/** A message from our service worker, as the page understands it. */
export type WorkerMessage =
  | { type: 'push'; deliveryId: string | null; offer: boolean }
  | { type: 'push-subscription-changed' };

/** Narrow an untrusted postMessage payload to one of ours; null for anything else. */
export function parseWorkerMessage(data: unknown): WorkerMessage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type === 'push-subscription-changed') return { type: 'push-subscription-changed' };
  if (d.type !== 'push') return null;
  return {
    type: 'push',
    deliveryId: typeof d.deliveryId === 'string' && d.deliveryId ? d.deliveryId : null,
    offer: d.offer === true,
  };
}
