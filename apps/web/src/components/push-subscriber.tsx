'use client';

import * as React from 'react';
import { ensurePushSubscription } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { useAuth } from './auth/use-auth';

/**
 * After a customer signs in, opportunistically subscribe their browser to Web Push.
 * Looks up the customers row by auth uid, then registers the subscription.
 * Skipped if VAPID public key isn't configured or push permission was denied.
 */
export function PushSubscriber() {
  const { user } = useAuth();
  const triedRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!user) return;
    if (triedRef.current === user.id) return;
    triedRef.current = user.id;

    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapidKey) return;
    if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;

    void (async () => {
      const supabase = getBrowserClient();
      const { data: customer } = await supabase
        .from('customers')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!customer?.id) return;
      await ensurePushSubscription(supabase, {
        vapidPublicKey: vapidKey,
        recipientType: 'customer',
        recipientId: customer.id,
      });
    })();
  }, [user]);

  return null;
}
