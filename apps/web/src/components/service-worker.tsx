'use client';

import * as React from 'react';

export function ServiceWorkerRegistrar() {
  React.useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;
    const handler = () => navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    window.addEventListener('load', handler);
    return () => window.removeEventListener('load', handler);
  }, []);
  return null;
}
