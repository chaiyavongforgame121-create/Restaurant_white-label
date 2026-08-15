'use client';

import * as React from 'react';

// Guard against a reload loop: controllerchange also fires the first time a worker
// takes control of a page that had none, and once more after our own reload.
let reloaded = false;

export function ServiceWorkerRegistrar() {
  React.useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;

    const handler = () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          // Force an update check on every load. Browsers do check sw.js on navigation,
          // but a stuck worker that is serving a cached HTML shell can keep a device on
          // an old build for a long time — which is exactly what happened when the v2
          // worker was caching Supabase reads. Asking explicitly makes recovery prompt.
          reg.update().catch(() => undefined);
        })
        .catch(() => undefined);
    };

    // When a NEW worker takes control (ours calls skipWaiting + clients.claim), the page
    // is still running assets fetched by the old one. Reload once so the fresh worker
    // serves everything — without this, a device stuck on a bad worker only recovers
    // after the user manually clears data.
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    window.addEventListener('load', handler);
    return () => {
      window.removeEventListener('load', handler);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);
  return null;
}
