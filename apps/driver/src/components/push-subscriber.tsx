'use client';

import * as React from 'react';
import { Bell } from 'lucide-react';
import { ensurePushSubscription } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { useDriverSession } from './driver-session';

/**
 * Web Push for dispatch alerts. This is the only channel that reaches a rider whose phone is in
 * their pocket, which is the whole point of installing the app, so a silent failure here is the
 * app not working.
 *
 * Two things used to fail silently. Permission was requested straight from this effect, with no
 * user gesture: Safari (and an iOS home-screen app is the only place iOS does Web Push at all)
 * rejects that outright, and Chrome's quiet UI frequently auto-suppresses a prompt that arrives
 * a second after opening the app — either way the rejection was swallowed and nobody learned
 * push was off. And when a browser rotated the push endpoint, notify-worker deleted the stale
 * row on the next 410 and nothing re-subscribed, so the installed app went quiet for good.
 */
export function PushSubscriber() {
  const { driver } = useDriverSession();
  const [needsTap, setNeedsTap] = React.useState(false);
  const triedRef = React.useRef(false);

  const subscribe = React.useCallback(
    async (fromGesture: boolean) => {
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidKey) return;
      const res = await ensurePushSubscription(getBrowserClient(), {
        vapidPublicKey: vapidKey,
        recipientType: 'driver',
        recipientId: driver.id,
        requireGesture: !fromGesture,
      });
      setNeedsTap(res.status === 'needs_gesture');
    },
    [driver.id],
  );

  React.useEffect(() => {
    if (triedRef.current) return;
    triedRef.current = true;
    if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
    void subscribe(false);
  }, [subscribe]);

  // The worker re-subscribes on pushsubscriptionchange and posts here, because only the page
  // holds the session that the register_push_subscription RPC runs under.
  React.useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (data?.type !== 'push-subscription-changed') return;
      void subscribe(true);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [subscribe]);

  if (!needsTap) return null;

  return (
    <div className="border-border bg-card/95 shadow-warm fixed inset-x-3 bottom-24 z-50 flex items-center gap-3 rounded-2xl border p-3 backdrop-blur-xl">
      <span className="bg-primary/10 text-primary grid h-9 w-9 shrink-0 place-items-center rounded-xl">
        <Bell className="h-4 w-4" />
      </span>
      <p className="flex-1 text-xs">Turn on alerts so you hear new delivery offers.</p>
      {/* min-h-0 opts out of the app-wide 48px button floor — this strip has to fit above the
          tab bar without swallowing the screen. */}
      <button
        onClick={() => void subscribe(true)}
        className="focus-ring bg-primary text-primary-foreground h-9 min-h-0 shrink-0 rounded-xl px-3 text-xs font-semibold"
      >
        Turn on
      </button>
    </div>
  );
}
