import type { BranchRider, LiveDelivery } from '@favornoms/database/queries';

// Everything the Live deliveries board decides without touching React or the network:
// what a card says, whether a row is stale, which rider positions are real, which
// actions apply. Kept pure so the rules can be tested against the shapes that
// actually broke the screen (a "ETA 37104 min" card, a scooter with no rider).

export type BadgeVariant = 'muted' | 'warning' | 'info' | 'default' | 'success' | 'danger';

/** A pending/dispatching row older than this has been forgotten, not delayed. */
export const OVERDUE_AFTER_MS = 30 * 60_000;
/**
 * Older than this and the row is a leftover — an abandoned test order, a kitchen that
 * never bumped the ticket. Live data at one branch carried 13 of them from June to
 * September, all "Finding driver". They are parked in their own section and kept off the
 * map so the real work is what the eye lands on, but every one stays actionable.
 */
export const STALE_AFTER_MS = 12 * 60 * 60_000;
/** An ETA is only believed while the fix it was computed from is this fresh. */
export const ETA_FRESH_MS = 10 * 60_000;
/** Longer than this is not an ETA anyone will wait for; it is arithmetic on a dead fix. */
export const ETA_MAX_MIN = 180;
/** arriving_at means "the rider is at the door" only for a little while afterwards. */
export const ARRIVING_WINDOW_MS = 30 * 60_000;

/**
 * One rider's turn at a delivery (public.delivery_assignments). The delivery row is reused by
 * every re-dispatch, so this is the only place a rider's own cancellation reason survives —
 * requeue_failed_delivery nulls deliveries.failed_reason, and a pre-pickup rider cancel never
 * wrote it at all.
 */
export interface DeliveryAssignmentRef {
  id: string;
  delivery_id: string;
  seq: number;
  driver_id: string;
  status: string;
  end_kind: string | null;
  end_reason: string | null;
  offered_at: string;
  ended_at: string | null;
}

/** The most recently ended turn that somebody actually explained. Null when nobody did. */
export function lastEndedWithReason(
  assignments: readonly DeliveryAssignmentRef[],
): DeliveryAssignmentRef | null {
  let best: DeliveryAssignmentRef | null = null;
  for (const a of assignments) {
    if (!a.ended_at || !a.end_reason) continue;
    if (!best || a.seq > best.seq) best = a;
  }
  return best;
}

export interface DeliveryDescription {
  label: string;
  variant: BadgeVariant;
  /** Second line under the badge. Empty when there is nothing worth saying. */
  detail: string;
  overdue: boolean;
}

function msSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return nowMs - t;
}

/** '<1 min', '3 min', '2 h 10 min', '3 d'. Never negative. */
export function ageLabel(iso: string | null | undefined, nowMs: number): string {
  const ms = msSince(iso, nowMs);
  if (ms == null) return '—';
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) {
    const rem = min % 60;
    return rem ? `${h} h ${rem} min` : `${h} h`;
  }
  return `${Math.floor(h / 24)} d`;
}

/** 'm:ss' for a countdown; clamps at 0:00. */
export function formatCountdown(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * Where the rider on this job is — or null. A position is only real when the row still
 * has a rider AND the rider is actually moving for it. reject_dispatch, offer expiry and
 * cancellation clear driver_id but leave driver_lat/lng behind, and a pending row cannot
 * have a rider position by definition; drawing those put a scooter on the map that
 * nobody was riding.
 */
export function riderPosition(d: Pick<LiveDelivery, 'driver_id' | 'driver_lat' | 'driver_lng' | 'status'>): { lat: number; lng: number } | null {
  if (!d.driver_id) return null;
  if (d.status !== 'assigned' && d.status !== 'picked_up' && d.status !== 'in_transit') return null;
  const { driver_lat: lat, driver_lng: lng } = d;
  if (lat == null || lng == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export function dropoffPosition(d: Pick<LiveDelivery, 'dropoff_lat' | 'dropoff_lng'>): { lat: number; lng: number } | null {
  const { dropoff_lat: lat, dropoff_lng: lng } = d;
  if (lat == null || lng == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * An ETA worth printing, or null. set_driver_location recomputes current_eta_min on every
 * ping, so a value that is enormous, or that rode in on a fix from last week, is not an
 * estimate — it is the last thing a dead rider session wrote.
 */
export function saneEta(
  etaMin: number | null | undefined,
  locationUpdatedAt: string | null | undefined,
  nowMs: number,
): number | null {
  if (etaMin == null || !Number.isFinite(etaMin)) return null;
  if (etaMin < 0 || etaMin > ETA_MAX_MIN) return null;
  const age = msSince(locationUpdatedAt, nowMs);
  if (age == null || age > ETA_FRESH_MS) return null;
  return Math.round(etaMin);
}

/** True while an offer is still open for the rider to answer. */
export function offerOpen(d: Pick<LiveDelivery, 'status' | 'driver_id' | 'accepted_at' | 'offer_expires_at'>, nowMs: number): boolean {
  if (d.status !== 'assigned' || !d.driver_id || d.accepted_at) return false;
  const exp = d.offer_expires_at ? new Date(d.offer_expires_at).getTime() : NaN;
  return Number.isFinite(exp) && exp > nowMs;
}

export function describeDelivery(
  d: LiveDelivery,
  nowMs: number,
  selfDelivery: boolean,
  assignments: readonly DeliveryAssignmentRef[] = [],
): DeliveryDescription {
  const age = msSince(d.created_at, nowMs) ?? 0;
  const kitchen = d.order?.status;

  switch (d.status) {
    case 'pending': {
      const detail =
        kitchen === 'ready'
          ? 'Kitchen says ready — no rider has been asked yet'
          : kitchen
            ? `Kitchen: ${kitchen.replace(/_/g, ' ')}`
            : '';
      return { label: 'Waiting for the kitchen', variant: 'muted', detail, overdue: age > OVERDUE_AFTER_MS };
    }
    case 'dispatching': {
      const n = d.dispatch_attempts;
      // A row back in the pool because a rider walked away is not the same as a row nobody has
      // answered yet, and "Asked 3 riders so far" said nothing about which one it was. The
      // rider's own words win over the attempt count whenever there are any.
      const walked = lastEndedWithReason(assignments);
      const detail =
        walked && walked.end_kind?.startsWith('driver_cancelled')
          ? `Rider cancelled: ${walked.end_reason}`
          : n > 0
            ? `Asked ${n} rider${n === 1 ? '' : 's'} so far`
            : 'Looking for a rider';
      return { label: 'Finding a rider', variant: 'warning', detail, overdue: age > OVERDUE_AFTER_MS };
    }
    case 'assigned': {
      if (!d.driver_id) {
        return selfDelivery
          ? { label: 'Ready to go out', variant: 'info', detail: 'Your own staff deliver this one', overdue: age > OVERDUE_AFTER_MS }
          : { label: 'Finding a rider', variant: 'warning', detail: 'No rider holds this yet', overdue: age > OVERDUE_AFTER_MS };
      }
      if (d.accepted_at) {
        return { label: 'Rider accepted · heading to shop', variant: 'info', detail: `Accepted ${ageLabel(d.accepted_at, nowMs)} ago`, overdue: false };
      }
      const exp = d.offer_expires_at ? new Date(d.offer_expires_at).getTime() : NaN;
      if (Number.isFinite(exp) && exp > nowMs) {
        return { label: 'Offered to rider', variant: 'warning', detail: `Expires in ${formatCountdown(exp - nowMs)}`, overdue: false };
      }
      return { label: 'Offered to rider', variant: 'warning', detail: 'Offer expired — returning to the pool', overdue: true };
    }
    case 'picked_up': {
      const eta = saneEta(d.current_eta_min, d.driver_location_updated_at, nowMs);
      return { label: 'Picked up', variant: 'default', detail: eta != null ? `ETA ${eta} min` : `Picked up ${ageLabel(d.picked_up_at ?? d.created_at, nowMs)} ago`, overdue: false };
    }
    case 'in_transit': {
      const arriving = msSince(d.arriving_at, nowMs);
      if (arriving != null && arriving >= 0 && arriving < ARRIVING_WINDOW_MS) {
        return { label: 'Arriving now', variant: 'success', detail: 'Rider is at the door', overdue: false };
      }
      const eta = saneEta(d.current_eta_min, d.driver_location_updated_at, nowMs);
      return { label: 'On the way', variant: 'default', detail: eta != null ? `ETA ${eta} min` : 'ETA unknown — waiting for the rider’s GPS', overdue: false };
    }
    case 'failed': {
      // failed_reason is cleared by requeue_failed_delivery; the turn keeps what was said.
      const ended = lastEndedWithReason(assignments);
      return {
        label: 'Failed — needs you',
        variant: 'danger',
        detail: d.failed_reason ?? ended?.end_reason ?? 'No reason recorded',
        overdue: true,
      };
    }
    default:
      return { label: String(d.status), variant: 'muted', detail: '', overdue: false };
  }
}

/**
 * A row nobody has touched for STALE_AFTER_MS that is still waiting on a rider or the
 * kitchen. Rows a rider actually holds are never stale here — the food is moving.
 */
export function isStale(d: LiveDelivery, nowMs: number): boolean {
  const age = msSince(d.created_at, nowMs);
  if (age == null || age < STALE_AFTER_MS) return false;
  if (d.status === 'picked_up' || d.status === 'in_transit') return false;
  if (d.status === 'assigned' && d.accepted_at) return false;
  return true;
}

/** Manual offer to a specific rider. staff_assign_driver refuses once the rider accepted. */
export function canAssign(d: LiveDelivery, selfDelivery: boolean): boolean {
  if (selfDelivery) return false;
  if (d.status !== 'pending' && d.status !== 'dispatching' && d.status !== 'assigned') return false;
  return !d.accepted_at;
}

/**
 * Auto-dispatch only makes sense once there is food to collect: dispatch-driver offers
 * the job the moment it is called, and a rider sent to a kitchen that has not started is
 * a rider who leaves.
 */
export function canFindRider(d: LiveDelivery, selfDelivery: boolean): boolean {
  if (selfDelivery) return false;
  if (d.status !== 'pending' && d.status !== 'dispatching') return false;
  return d.order?.status === 'ready';
}

/** Cancelling from here is only offered while the food is still in the shop. */
export function canCancelDelivery(d: LiveDelivery): boolean {
  return d.status === 'pending' || d.status === 'dispatching' || d.status === 'assigned' || d.status === 'failed';
}

export type RiderPinState = 'busy' | 'available' | 'stale' | 'offline';

/**
 * How a rider shows on the map and in the list. `busy` wins: a rider on a job is drawn by
 * the job, not as an idle puck. `online` is sticky (riders forget to toggle off), so an
 * online rider whose last fix is older than the dispatch window is `stale`, which is also
 * exactly the rider find_dispatch_candidates will skip.
 */
export function riderPinState(r: BranchRider, nowMs: number, maxGpsAgeMin: number): RiderPinState {
  if (r.active_delivery_id) return 'busy';
  if (!r.online) return 'offline';
  const age = msSince(r.location_updated_at, nowMs);
  if (age != null && age <= Math.max(1, maxGpsAgeMin) * 60_000) return 'available';
  return 'stale';
}

export function riderMapPosition(r: BranchRider): { lat: number; lng: number } | null {
  if (r.lat == null || r.lng == null) return null;
  if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return null;
  if (Math.abs(r.lat) > 90 || Math.abs(r.lng) > 180) return null;
  return { lat: r.lat, lng: r.lng };
}

export interface BoardCounts {
  waitingKitchen: number;
  findingRider: number;
  offered: number;
  accepted: number;
  onTheWay: number;
  failed: number;
}

export function boardCounts(ds: readonly LiveDelivery[]): BoardCounts {
  const c: BoardCounts = { waitingKitchen: 0, findingRider: 0, offered: 0, accepted: 0, onTheWay: 0, failed: 0 };
  for (const d of ds) {
    switch (d.status) {
      case 'pending':
        c.waitingKitchen += 1;
        break;
      case 'dispatching':
        c.findingRider += 1;
        break;
      case 'assigned':
        if (!d.driver_id) c.findingRider += 1;
        else if (d.accepted_at) c.accepted += 1;
        else c.offered += 1;
        break;
      case 'picked_up':
      case 'in_transit':
        c.onTheWay += 1;
        break;
      case 'failed':
        c.failed += 1;
        break;
    }
  }
  return c;
}

/**
 * What a refetch does to the board. A read that FAILED keeps what is on screen — the
 * flicker this board used to have came from failed reads arriving as empty arrays. A read
 * that SUCCEEDED is the truth even when it is empty: the last delivery finishing while the
 * tab was hidden must clear the board when it wakes, not leave a ghost card until reload.
 */
export function mergeRefetch<T>(prev: T[], next: T[], hadError: boolean): T[] {
  return hadError ? prev : next;
}

/** Split the board into rows worth watching and rows that have been forgotten. */
export function partitionStale(ds: readonly LiveDelivery[], nowMs: number): { live: LiveDelivery[]; stale: LiveDelivery[] } {
  const live: LiveDelivery[] = [];
  const stale: LiveDelivery[] = [];
  for (const d of ds) (isStale(d, nowMs) ? stale : live).push(d);
  return { live, stale };
}

export interface DispatchFailure {
  error?: string;
  diagnostics?: {
    branch_has_pin?: boolean;
    max_gps_age_min?: number;
    radius_km?: number;
    approved?: number;
    online?: number;
    has_location?: number;
    gps_fresh?: number;
    in_radius?: number;
    not_busy?: number;
  } | null;
}

/** Turn dispatch-driver's gate counts into the one sentence that tells the merchant where
 *  to look. Ordered from "nothing is set up" to "everyone is busy", so the first failing
 *  gate is the one reported. Mirrors the kitchen display's reading of the same payload. */
export function describeDispatchFailure(body: DispatchFailure): string {
  if (body?.error && body.error !== 'no_drivers_available') {
    if (body.error === 'max_attempts_reached') return 'Tried every rider — raise "Max dispatch attempts" or assign one by hand.';
    if (body.error === 'delivery_not_dispatchable') return 'This delivery is no longer waiting for a rider.';
    return body.error.replace(/_/g, ' ');
  }
  const d = body?.diagnostics;
  if (!d) return 'No rider available right now.';
  if (d.branch_has_pin === false) return 'This branch has no map pin yet — set it in Branch settings.';
  if (!d.approved) return 'No rider is approved for this branch yet.';
  if (!d.online) return `No rider is online right now (${d.approved} approved).`;
  if (!d.has_location) {
    return `${d.online} online, but none have shared a location — the rider app must be open with location permission granted.`;
  }
  if (!d.gps_fresh) {
    return `${d.online} online, but no location newer than ${d.max_gps_age_min ?? 5} min. The rider app only sends GPS while it is open in the foreground.`;
  }
  if (!d.not_busy) return `${d.online} online, all already on a delivery.`;
  if (!d.in_radius) {
    const mi = d.radius_km != null ? Math.round(d.radius_km / 1.609344) : null;
    return `${d.online} online, but none within${mi != null ? ` ${mi} mi` : ' the search radius'} — raise "Driver search radius".`;
  }
  return 'No rider available right now.';
}

/** The RPCs raise bare exception names; left alone they read as crashes, not rules. */
export const ASSIGN_ERRORS: Record<string, string> = {
  driver_busy: 'That rider is already on a delivery.',
  driver_not_eligible: 'That rider is not approved here or their documents are not verified.',
  already_accepted: 'The rider has already accepted — they must hand it back from their app before you can reassign.',
  not_assignable: 'This delivery can no longer be assigned by hand.',
  not_found: 'That delivery no longer exists.',
  forbidden: 'Your account cannot manage deliveries at this branch.',
  auth_required: 'Your session has expired — sign in again.',
  not_failed: 'Only a failed delivery can be re-dispatched.',
  not_self_delivery: 'This branch uses platform riders; the rider moves the delivery from their app.',
  bad_transition: 'That step is not available for this delivery any more.',
};

/** A Postgres error message may carry the bare code or wrap it; match the code anywhere. */
export function readableRpcError(message: string): string {
  const code = Object.keys(ASSIGN_ERRORS).find((k) => new RegExp(`\\b${k}\\b`).test(message));
  return code ? ASSIGN_ERRORS[code]! : message;
}
