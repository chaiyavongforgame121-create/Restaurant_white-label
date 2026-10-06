'use client';

import type { OfferSighting } from './alerts';

/**
 * Tell the service worker which offers are still this rider's, so it can take every other offer
 * notification off the shade (public/sw.js, 'offers-live'). An offer notification stays up until
 * it is touched (requireInteraction), and nothing used to remove one once the offer had expired
 * or gone to another rider: tapping it opened an empty home screen.
 *
 * `over` names the offers this phone saw end since the last report (lib/alerts offersOver). The
 * worker keeps those for a while, because the push for an offer can land after the rider already
 * answered it in the app; that push is then closed the moment it arrives instead of buzzing.
 *
 * Only ever called with the result of a read the server answered. An empty list before that read
 * would clear the notification of an offer that is still live.
 */
export function reportLiveOffers(deliveryIds: readonly string[], over: readonly OfferSighting[] = []): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const message = {
    type: 'offers-live',
    deliveryIds: [...deliveryIds],
    over: over.map((o) => ({ deliveryId: o.deliveryId, expiresAt: o.expiresAtMs })),
  };
  // getRegistration, not .ready: in development no worker is registered and .ready never settles.
  navigator.serviceWorker
    .getRegistration()
    .then((registration) => {
      const worker = navigator.serviceWorker.controller ?? registration?.active ?? null;
      worker?.postMessage(message);
    })
    .catch(() => undefined);
}
