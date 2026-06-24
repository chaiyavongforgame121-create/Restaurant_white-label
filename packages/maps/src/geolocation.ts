// Browser geolocation wrapper. getCurrentPosition() only works in a secure
// context (https, or http on localhost/127.0.0.1); over plain http on any other
// host the browser silently refuses, so we detect that up front and surface a
// typed, human-readable reason instead of a cryptic GeolocationPositionError.

import type { LatLng } from './geo';

export type GeolocationFailure =
  | 'unsupported' // navigator.geolocation missing entirely
  | 'insecure_context' // http on a non-localhost host — the browser blocks it
  | 'denied' // user declined the permission prompt
  | 'unavailable' // position could not be determined
  | 'timeout';

export class GeolocationError extends Error {
  readonly reason: GeolocationFailure;
  constructor(reason: GeolocationFailure, message?: string) {
    super(message ?? reason);
    this.name = 'GeolocationError';
    this.reason = reason;
  }
}

/** True when the browser can actually run geolocation here (API present + secure context). */
export function isGeolocationAvailable(): boolean {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return false;
  // isSecureContext is false on http://<non-localhost> — getCurrentPosition would reject.
  if (typeof window !== 'undefined' && window.isSecureContext === false) return false;
  return true;
}

/** Resolve the device's current coordinates, or reject with a typed GeolocationError. */
export function getCurrentPosition(opts?: PositionOptions): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(new GeolocationError('unsupported'));
      return;
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      reject(new GeolocationError('insecure_context'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        const reason: GeolocationFailure =
          err.code === err.PERMISSION_DENIED
            ? 'denied'
            : err.code === err.TIMEOUT
              ? 'timeout'
              : 'unavailable';
        reject(new GeolocationError(reason, err.message));
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000, ...opts },
    );
  });
}
