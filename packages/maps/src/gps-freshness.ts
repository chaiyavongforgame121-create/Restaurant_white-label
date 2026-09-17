// How old is the rider's last GPS fix, and is that old enough to stop trusting the pin?
//
// The rider's heartbeat never goes quieter than 45 s while a job is live, so silence past
// roughly twice that is not a parked rider — it is a phone that has stopped reporting
// (backgrounded app, denied permission, dead spot). Both the customer's map and the rider's
// own screens answer that question, so the arithmetic lives in one place.

import { resolveMapsLocale, type MapsLocale } from './locale';

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

const FIX_AGE_COPY: Record<
  MapsLocale,
  { s: (n: number) => string; min: (n: number) => string; hr: (n: number) => string; d: (n: number) => string }
> = {
  en: { s: (n) => `${n}s ago`, min: (n) => `${n} min ago`, hr: (n) => `${n} hr ago`, d: (n) => `${n} d ago` },
  es: { s: (n) => `hace ${n} s`, min: (n) => `hace ${n} min`, hr: (n) => `hace ${n} h`, d: (n) => `hace ${n} d` },
  vi: {
    s: (n) => `${n} giây trước`,
    min: (n) => `${n} phút trước`,
    hr: (n) => `${n} giờ trước`,
    d: (n) => `${n} ngày trước`,
  },
  th: {
    s: (n) => `${n} วินาทีที่แล้ว`,
    min: (n) => `${n} นาทีที่แล้ว`,
    hr: (n) => `${n} ชั่วโมงที่แล้ว`,
    d: (n) => `${n} วันที่แล้ว`,
  },
};

/** "45s ago" / "2 min ago" / "3 hr ago" — short enough for a map chip. In `locale` (English when omitted). */
export function formatFixAge(ageSec: number, locale: MapsLocale = 'en'): string {
  const copy = FIX_AGE_COPY[resolveMapsLocale(locale)];
  if (ageSec < 60) return copy.s(ageSec);
  if (ageSec < 3600) return copy.min(Math.floor(ageSec / 60));
  if (ageSec < 86_400) return copy.hr(Math.floor(ageSec / 3600));
  return copy.d(Math.floor(ageSec / 86_400));
}
