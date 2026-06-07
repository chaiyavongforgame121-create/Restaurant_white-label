'use client';

import * as React from 'react';
import { ensurePushSubscription } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { useDriverSession } from './driver-session';

/**
 * After driver auth, opportunistically subscribe the browser to Web Push.
 * Skipped if VAPID public key isn't configured or the browser doesn't support push.
 * Permission is requested at most once per session (never re-asked after denial).
 */
export function PushSubscriber() {
  const { driver } = useDriverSession();
  const triedRef = React.useRef(false);

  React.useEffect(() => {
    if (triedRef.current) return;
    triedRef.current = true;
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapidKey) return;
    if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
    void ensurePushSubscription(getBrowserClient(), {
      vapidPublicKey: vapidKey,
      recipientType: 'driver',
      recipientId: driver.id,
    });
  }, [driver.id]);

  return null;
}
