// How old is the rider's last GPS fix, and is that old enough to stop trusting the pin?
//
// The rider's heartbeat never goes quieter than 45 s while a job is live, so silence past
// roughly twice that is not a parked rider — it is a phone that has stopped reporting
// (backgrounded app, denied permission, dead spot). Both the customer's map and the rider's
// own screens answer that question, so the arithmetic lives in one place.

/** Seconds since a GPS fix timestamp, or null when there has never been one. */
export function fixAgeSeconds(updatedAt: string | null | undefined, nowMs: number): number | null {
  if (!updatedAt) return null;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return null;
  // Clocks disagree by a second or two; a "-3s ago" reads as a bug.
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/** Past this many seconds of silence the position on screen is not where the rider is. */
export const GPS_STALE_AFTER_SEC = 90;

/** Dispatch drops riders whose fix is older than this (dispatch_max_gps_age_min = 5 min). */
export const GPS_DISPATCH_MAX_AGE_SEC = 300;

export function isFixStale(ageSec: number | null, thresholdSec = GPS_STALE_AFTER_SEC): boolean {
  return ageSec == null || ageSec > thresholdSec;
}

/** "45s ago" / "2 min ago" / "3 hr ago" — short enough for a map chip. */
export function formatFixAge(ageSec: number): string {
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)} min ago`;
  if (ageSec < 86_400) return `${Math.floor(ageSec / 3600)} hr ago`;
  return `${Math.floor(ageSec / 86_400)} d ago`;
}
