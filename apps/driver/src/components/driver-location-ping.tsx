'use client';

import * as React from 'react';
import { getBrowserClient } from '@favornoms/database/client';
import { updateDriverLocation } from '@favornoms/database/queries';
import { useDriverSession } from './driver-session';
import { useDelivery } from './delivery-provider';
import { useDriver } from '@/store/driver';

const MIN_INTERVAL_MS = 3_000;
const MAX_AGE_MS = 30_000;
// Two cadences, because the two jobs this ping does are not the same job.
//
// Merely online, the only reader is dispatch, which asks one question: is this fix younger
// than dispatch_max_gps_age_min (5 min)? A minute is ample, and a parked rider's phone
// should not be woken every few seconds to answer it.
//
// On a delivery, a customer is watching the pin move on a map. That needs the fix rate the
// map is expected to redraw at, and it lasts only as long as the trip.
const HEARTBEAT_IDLE_MS = 60_000;
const HEARTBEAT_ACTIVE_MS = 3_000;
// Below this a "new" fix is GPS noise, not the rider moving. Writing it anyway made the
// customer's pin twitch in place and, because set_driver_location stamps the rider's own
// delivery row, woke every screen subscribed to that row for nothing.
const MIN_MOVE_M = 12;
// However still the rider stands, never go quieter than this: dispatch drops riders whose
// fix has gone stale, and the customer needs to see the pin is still being reported.
const MAX_SILENCE_MS = 45_000;

/** Flat-earth metres — fine at the tens-of-metres scale this is asked about. */
function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLng = (b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

interface WakeLockSentinel {
  release: () => Promise<void>;
}

/**
 * Watches GPS while driver is online or on a delivery and pushes coords
 * to drivers.current_location via the set_driver_location RPC.
 * Throttled to MIN_INTERVAL_MS so we don't hammer the DB.
 *
 * Whether a job is in flight comes from DeliveryProvider — the server's answer — not from
 * the persisted store. The store's 'on_delivery' is only ever set while the Home screen is
 * mounted, so a rider who opened /app/active straight from a chat push (notify-worker sends
 * exactly that deep link), or who cleared site data, carried food for a whole trip at the
 * idle cadence — or, from 'offline', sent nothing at all while the customer watched a pin
 * that never moved.
 *
 * No UI — mount once near the app root, inside DeliveryProvider.
 */
export function DriverLocationPing() {
  const { driver } = useDriverSession();
  const { active } = useDelivery();
  const status = useDriver((s) => s.status);
  const setGps = useDriver((s) => s.setGps);
  const markFixSent = useDriver((s) => s.markFixSent);
  const onDelivery = !!active;
  // The store is still consulted, but only as one of several ways to be "on shift". Its
  // own reconcile against drivers.is_online happens on Home, hence the server flag too.
  const enabled =
    onDelivery || status === 'online' || status === 'on_delivery' || !!driver.is_online;
  const lastSentAt = React.useRef(0);
  const lastSentFix = React.useRef<{ lat: number; lng: number } | null>(null);

  React.useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGps('unavailable');
      return;
    }
    // Geolocation is silently refused outside a secure context, which is exactly what a
    // rider gets when they open the app over plain http on the shop's LAN address.
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setGps('insecure');
      return;
    }

    const supabase = getBrowserClient();

    const send = (lat: number, lng: number, battery?: number) => {
      void updateDriverLocation(supabase, driver.id, { lat, lng, battery }).then(({ error }) => {
        // A write that failed is not a fix the world knows about: leave lastFixAt where it
        // was so every screen keeps counting up and says so.
        if (!error) markFixSent();
      });
    };

    const push = (pos: GeolocationPosition) => {
      const now = Date.now();
      if (now - lastSentAt.current < MIN_INTERVAL_MS) return;

      // A rider waiting at the counter still produces a fix every three seconds, and every
      // write of one lands on rows other screens are subscribed to. Publish movement, not
      // jitter — but never let the silence outlast MAX_SILENCE_MS.
      const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const previous = lastSentFix.current;
      if (
        previous &&
        metresBetween(previous, fix) < MIN_MOVE_M &&
        now - lastSentAt.current < MAX_SILENCE_MS
      ) {
        return;
      }
      lastSentAt.current = now;
      lastSentFix.current = fix;

      const navAny = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
      if (typeof navAny.getBattery === 'function') {
        navAny
          .getBattery()
          .then((b) => send(fix.lat, fix.lng, Math.round(b.level * 100)))
          .catch(() => send(fix.lat, fix.lng));
      } else {
        send(fix.lat, fix.lng);
      }
    };

    // Every error used to land in an empty arrow function, so a rider whose permission was
    // blocked — the state the live rider account is in — saw nothing anywhere in the app.
    const onGeoError = (err: GeolocationPositionError) => {
      setGps(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
    };

    const watchId = navigator.geolocation.watchPosition(push, onGeoError, {
      enableHighAccuracy: true,
      maximumAge: MAX_AGE_MS,
      timeout: 15_000,
    });

    // watchPosition only fires on movement — a parked driver goes stale and dispatch (>5 min
    // staleness cutoff) stops offering them jobs. It is also not a clock: a rider crawling in
    // traffic can go a long time between callbacks, and the customer's map sits still. The
    // heartbeat forces a fix on a known cadence through the same throttled push.
    //
    // maximumAge must be BELOW the interval while on a delivery, or the browser is free to
    // hand back the same cached fix every time and the pin never moves.
    const heartbeatId = window.setInterval(
      () => {
        navigator.geolocation.getCurrentPosition(push, onGeoError, {
          enableHighAccuracy: true,
          maximumAge: onDelivery ? 2_000 : MAX_AGE_MS,
          timeout: 15_000,
        });
      },
      onDelivery ? HEARTBEAT_ACTIVE_MS : HEARTBEAT_IDLE_MS,
    );

    // Back to the foreground: timers/watch may have been throttled for minutes,
    // so reset the throttle and push a fresh fix immediately.
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      lastSentAt.current = 0;
      navigator.geolocation.getCurrentPosition(push, onGeoError, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15_000,
      });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      navigator.geolocation.clearWatch(watchId);
      window.clearInterval(heartbeatId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // onDelivery is a dependency: picking up a job has to re-arm the interval at the faster
    // cadence, and finishing it has to drop back to the slow one.
  }, [enabled, onDelivery, driver.id, setGps, markFixSent]);

  // A web page cannot report GPS from the background: iOS suspends it within seconds and
  // Android throttles the timers to a crawl. The app's own Navigate button sends the rider
  // to Google Maps for the drive, so the one thing worth defending is the case where they
  // leave OUR screen in front — keep it awake for the length of the job rather than letting
  // the phone lock 30 seconds in and freeze the customer's pin. The browser drops the lock
  // whenever the page is hidden, so it is re-taken on every return to the foreground.
  React.useEffect(() => {
    if (!onDelivery) return;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> };
    };
    if (!nav.wakeLock) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        lock = await nav.wakeLock!.request('screen');
      } catch {
        // Refused (low battery, no user gesture yet, unsupported) — nothing to do but let
        // the phone behave normally.
      }
    };
    void acquire();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void lock?.release().catch(() => {});
    };
  }, [onDelivery]);

  return null;
}
