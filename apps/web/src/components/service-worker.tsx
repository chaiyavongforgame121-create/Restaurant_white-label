'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { RefreshCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@favornoms/ui';

/** Ask the server what build it is serving at most this often. */
const CHECK_EVERY_MS = 30 * 60 * 1000;
/** Floor between checks, so a diner flicking between apps does not poll on every switch. */
const CHECK_MIN_GAP_MS = 60 * 1000;

/**
 * Registers the service worker, and tells the diner — once, quietly — when the app they have
 * open is no longer the app we are shipping.
 *
 * Two questions, answered separately, because conflating them is what made the old version
 * user-hostile:
 *
 *  1. Is a NEWER BUILD deployed than the one this page is running? Asked of /api/version on
 *     load, whenever the tab becomes visible, and every half hour. A phone keeps an installed
 *     PWA alive for days, so "reload to get the fix" otherwise never happens. Yes -> the
 *     banner. A plain reload is enough: navigations are network-first, so the fresh HTML pulls
 *     the new build with it.
 *
 *  2. Is a worker waiting behind the one controlling this page? Adopt it silently. The page is
 *     already running whatever assets it loaded; a newly activated worker only changes what
 *     FUTURE requests do, so there is nothing to reload for. The old code paired an
 *     unconditional skipWaiting() in sw.js with a reload on `controllerchange`, which meant any
 *     change to the worker restarted the app a few seconds after opening it — mid-cart,
 *     mid-address-form, with no warning and no way to decline.
 */
export function ServiceWorkerRegistrar() {
  const t = useTranslations('common');
  const [updateReady, setUpdateReady] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;

    let disposed = false;
    let lastCheck = 0;
    // The build this page was served by. Learned from the first answer rather than baked in at
    // compile time, because the build id is not exposed to the client bundle.
    let ownBuild: string | null = null;
    let registration: ServiceWorkerRegistration | null = null;

    /** Activating a waiting worker is invisible to the page, so it needs no permission. */
    const adopt = (worker: ServiceWorker | null) => {
      if (worker) worker.postMessage({ type: 'SKIP_WAITING' });
    };

    const checkBuild = async () => {
      if (disposed || Date.now() - lastCheck < CHECK_MIN_GAP_MS) return;
      lastCheck = Date.now();
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const { build } = (await res.json()) as { build?: string };
        if (disposed || !build) return;
        if (ownBuild === null) {
          ownBuild = build;
          return;
        }
        if (build !== ownBuild) {
          setUpdateReady(true);
          // The worker itself may have changed in the same deploy; fetch it now so the new one
          // is installed and waiting by the time the diner taps Reload.
          registration?.update().catch(() => undefined);
        }
      } catch {
        // Offline, or the route is not deployed. Nothing to announce either way.
      }
    };

    const register = () => {
      navigator.serviceWorker
        // The URL stays exactly '/sw.js'. packages/ui's ensurePushSubscription registers the
        // same path on its own, and two registrations with different script URLs at the same
        // scope replace each other — a version query here would make them fight on every
        // sign-in.
        .register('/sw.js')
        .then((reg) => {
          if (disposed) return;
          registration = reg;
          if (reg.waiting && navigator.serviceWorker.controller) adopt(reg.waiting);
          reg.addEventListener('updatefound', () => {
            const incoming = reg.installing;
            if (!incoming) return;
            incoming.addEventListener('statechange', () => {
              if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
                adopt(incoming);
              }
            });
          });
          // Browsers do check sw.js on navigation, but a stuck worker serving a cached shell
          // can keep a device on an old build for a long time — which is exactly what happened
          // with the v2 worker. Asking explicitly makes recovery prompt.
          reg.update().catch(() => undefined);
        })
        .catch(() => undefined);
      void checkBuild();
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') void checkBuild();
    };

    const interval = window.setInterval(() => void checkBuild(), CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', onVisible);

    // On a production build hydration finishes after `load`, so a listener added here
    // waits for an event that has already fired and the worker never registers (seen
    // on the driver app: readyState 'complete', zero registrations). Register at once
    // if the page has already loaded, otherwise wait for it.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener('load', register);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return (
    <AnimatePresence>
      {updateReady && (
        <motion.div
          initial={{ y: 60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 60, opacity: 0 }}
          role="status"
          // Clear of the bottom tab bar on mobile, out of the way entirely on desktop.
          className="fixed inset-x-3 bottom-20 z-[150] flex items-center justify-between gap-3 rounded-2xl border border-border bg-card/95 p-3 pl-4 shadow-warm backdrop-blur-xl lg:bottom-4 lg:left-auto lg:right-4 lg:max-w-sm"
        >
          <p className="text-sm font-medium">{t('update.ready')}</p>
          <Button
            size="sm"
            variant="gradient"
            leftIcon={<RefreshCcw className="h-4 w-4" />}
            onClick={() => window.location.reload()}
          >
            {t('update.reload')}
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
