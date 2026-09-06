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
          // Explicit update check on every load. The v1 worker cached every GET,
          // including dispatch reads, so a rider could sit on a frozen build; asking
          // for an update directly is what gets such a device back on a good worker.
          reg.update().catch(() => undefined);
        })
        .catch(() => undefined);
    };

    // Reload once when a new worker takes control so the page stops running assets
    // fetched by the old one.
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    // Hydration finishes after `load` on a production build, so a listener added here
    // would wait for an event that has already fired and the worker would never register
    // — which is exactly what a production probe showed: readyState 'complete', zero
    // registrations. Register now if the page has already loaded, otherwise wait for it.
    if (document.readyState === 'complete') handler();
    else window.addEventListener('load', handler);
    return () => {
      window.removeEventListener('load', handler);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);
  return null;
}
