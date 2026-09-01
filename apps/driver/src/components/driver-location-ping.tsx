'use client';

import * as React from 'react';
import { getBrowserClient } from '@favornoms/database/client';
import { updateDriverLocation } from '@favornoms/database/queries';
import { useDriverSession } from './driver-session';
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

/**
 * Watches GPS while driver is online or on a delivery and pushes coords
 * to drivers.current_location via the set_driver_location RPC.
 * Throttled to MIN_INTERVAL_MS so we don't hammer the DB.
 *
 * No UI — mount once near the app root.
 */
export function DriverLocationPing() {
  const { driver } = useDriverSession();
  const status = useDriver((s) => s.status);
  const onDelivery = status === 'on_delivery';
  const enabled = status === 'online' || onDelivery;
  const lastSentAt = React.useRef(0);

  React.useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;

    const supabase = getBrowserClient();

    const push = (pos: GeolocationPosition) => {
      const now = Date.now();
      if (now - lastSentAt.current < MIN_INTERVAL_MS) return;
      lastSentAt.current = now;

      let battery: number | undefined;
      const navAny = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
      if (typeof navAny.getBattery === 'function') {
        navAny
          .getBattery()
          .then((b) => {
            battery = Math.round(b.level * 100);
            void updateDriverLocation(supabase, driver.id, {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              battery,
            });
          })
          .catch(() => {
            void updateDriverLocation(supabase, driver.id, {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
            });
          });
      } else {
        void updateDriverLocation(supabase, driver.id, {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
      }
    };

    const watchId = navigator.geolocation.watchPosition(
      push,
      // Silent on error — user may have denied permission; keep app working.
      () => {},
      { enableHighAccuracy: true, maximumAge: MAX_AGE_MS, timeout: 15_000 },
    );

    // watchPosition only fires on movement — a parked driver goes stale and dispatch (>5 min
    // staleness cutoff) stops offering them jobs. It is also not a clock: a rider crawling in
    // traffic can go a long time between callbacks, and the customer's map sits still. The
    // heartbeat forces a fix on a known cadence through the same throttled push.
    //
    // maximumAge must be BELOW the interval while on a delivery, or the browser is free to
    // hand back the same cached fix every time and the pin never moves.
    const heartbeatId = window.setInterval(
      () => {
        navigator.geolocation.getCurrentPosition(push, () => {}, {
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
      navigator.geolocation.getCurrentPosition(push, () => {}, {
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
  }, [enabled, onDelivery, driver.id]);

  return null;
}
