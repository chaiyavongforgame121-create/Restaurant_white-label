'use client';

import * as React from 'react';
import { ensurePushSubscription } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { useCart } from '@/store/cart';
import { useAuth } from './auth/use-auth';

/**
 * After a customer signs in, opportunistically subscribe their browser to Web Push.
 * The subscription belongs to the LOGIN (push_subscriptions.user_id is the caller) and to this
 * ORIGIN (the service worker that made it). It is recorded against the diner's customers row at
 * THIS branch, because notify-worker reads that row's branch to know which host the subscription
 * lives on: a diner's update from any branch on the same host reaches it, and an update from a
 * restaurant on another domain never lands in this storefront's app.
 *
 * No row here yet means nothing to be told about here yet: signing in at a branch (customer-auth,
 * the OAuth callback) makes its row, and the checkout makes one for a diner arriving from another
 * branch. A page load after that registers the device.
 * Skipped if VAPID public key isn't configured or push permission was denied.
 */
export function PushSubscriber() {
  const { user } = useAuth();
  // The branch layout's cart store is per branch, so this is the branch being shown.
  const branchId = useCart((s) => s.branchId);
  const triedRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!user || !branchId) return;
    const key = `${user.id}:${branchId}`;
    if (triedRef.current === key) return;
    triedRef.current = key;

    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapidKey) return;
    if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;

    void (async () => {
      const supabase = getBrowserClient();
      // Read-only on purpose: a page visit must not mint a customer record at a branch the diner
      // has never ordered from. (branch_id, user_id) is unique, so this is at most one row.
      const { data: customerRows } = await supabase
        .from('customers')
        .select('id')
        .eq('user_id', user.id)
        .eq('branch_id', branchId)
        .limit(1);
      const customer = customerRows?.[0];
      if (!customer?.id) return;
      await ensurePushSubscription(supabase, {
        vapidPublicKey: vapidKey,
        recipientType: 'customer',
        recipientId: customer.id,
      });
    })();
  }, [user, branchId]);

  return null;
}
