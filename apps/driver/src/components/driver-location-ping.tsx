'use client';

import * as React from 'react';
import { getBrowserClient } from '@favornoms/database/client';
import { updateDriverLocation } from '@favornoms/database/queries';
import { useDriverSession } from './driver-session';
import { useDriver } from '@/store/driver';

const MIN_INTERVAL_MS = 5_000;
const MAX_AGE_MS = 30_000;
const HEARTBEAT_MS = 60_000;

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
  const enabled = status === 'online' || status === 'on_delivery';
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

    // watchPosition only fires on movement — a parked driver goes stale and
    // dispatch (>5 min staleness cutoff) stops offering them jobs. Heartbeat a
    // fix every 60s through the same throttled push to keep them dispatchable.
    const heartbeatId = window.setInterval(() => {
      navigator.geolocation.getCurrentPosition(push, () => {}, {
        enableHighAccuracy: true,
        maximumAge: MAX_AGE_MS,
        timeout: 15_000,
      });
    }, HEARTBEAT_MS);

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
  }, [enabled, driver.id]);

  return null;
}
