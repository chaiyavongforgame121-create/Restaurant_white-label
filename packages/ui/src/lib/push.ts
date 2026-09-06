// Web Push subscription helper. Browser-side only.
//
// Usage:
//   await ensurePushSubscription(supabase, {
//     vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
//     recipientType: 'customer',
//     recipientId: customer.id,
//   });
//
// Calls the public.register_push_subscription RPC (SECURITY DEFINER).

type SupabaseLike = {
  rpc: (fn: string, args: Record<string, unknown>) => unknown;
};

export interface EnsurePushOptions {
  vapidPublicKey: string;
  recipientType: 'customer' | 'driver' | 'staff';
  recipientId: string;
  serviceWorkerUrl?: string;
  /**
   * Only ask for permission while a user gesture is still live, and report 'needs_gesture'
   * otherwise. Safari — and an iOS 16.4+ home-screen web app is the only place iOS supports
   * Web Push at all — requires transient user activation for `requestPermission()`, so a call
   * from a mount effect rejects and the caller never learns push is off. Off by default so
   * existing callers keep their behaviour; pass true from anything that runs on mount.
   */
  requireGesture?: boolean;
}

export type EnsurePushStatus = 'subscribed' | 'denied' | 'unsupported' | 'needs_gesture' | 'error';

/**
 * Wait briefly for the service worker registration owned by
 * apps/<app>/src/components/service-worker.tsx. This helper used to call `register()` itself,
 * which quietly defeated that component's `NODE_ENV === 'production'` gate: the moment a VAPID
 * key was present, `pnpm dev` served un-hashed dev chunks cache-first and the dev server looked
 * broken in a way unrelated to whatever was being edited. Registration happens on `load`, so
 * arriving a few milliseconds early is normal — poll rather than register a second worker.
 */
async function findRegistration(swUrl: string): Promise<ServiceWorkerRegistration | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const reg =
      (await navigator.serviceWorker.getRegistration(swUrl)) ??
      (await navigator.serviceWorker.getRegistration());
    if (reg) return reg;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

export async function ensurePushSubscription(
  supabase: SupabaseLike,
  opts: EnsurePushOptions,
): Promise<{ status: EnsurePushStatus; error?: string }> {
  if (typeof window === 'undefined') return { status: 'unsupported' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { status: 'unsupported' };
  }
  if (typeof Notification === 'undefined') return { status: 'unsupported' };

  try {
    const swUrl = opts.serviceWorkerUrl ?? '/sw.js';

    // Permission first, while any gesture that got us here is still transient.
    let perm = Notification.permission;
    if (perm === 'default') {
      const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
        .userActivation;
      if (opts.requireGesture && activation && !activation.isActive) {
        return { status: 'needs_gesture' };
      }
      perm = await Notification.requestPermission();
    }
    if (perm !== 'granted') return { status: 'denied' };

    const reg = await findRegistration(swUrl);
    if (!reg) return { status: 'error', error: 'no_service_worker' };
    if (!reg.active) await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = urlBase64ToUint8Array(opts.vapidPublicKey);
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key.buffer.slice(
          key.byteOffset,
          key.byteOffset + key.byteLength,
        ) as ArrayBuffer,
      });
    }

    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { status: 'error', error: 'subscription_incomplete' };
    }

    const result = (await supabase.rpc('register_push_subscription', {
      p_recipient_type: opts.recipientType,
      p_recipient_id: opts.recipientId,
      p_endpoint: json.endpoint,
      p_p256dh: json.keys.p256dh,
      p_auth: json.keys.auth,
      p_user_agent: navigator.userAgent,
    })) as { error?: { message?: string } | null };
    if (result.error) {
      return { status: 'error', error: result.error.message ?? 'rpc_error' };
    }

    return { status: 'subscribed' };
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}

export async function unsubscribePush(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return false;
  return sub.unsubscribe();
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
