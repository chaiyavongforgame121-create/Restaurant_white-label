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
}

export async function ensurePushSubscription(
  supabase: SupabaseLike,
  opts: EnsurePushOptions,
): Promise<{ status: 'subscribed' | 'denied' | 'unsupported' | 'error'; error?: string }> {
  if (typeof window === 'undefined') return { status: 'unsupported' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { status: 'unsupported' };
  }

  try {
    const swUrl = opts.serviceWorkerUrl ?? '/sw.js';
    const reg = await navigator.serviceWorker.register(swUrl);
    await navigator.serviceWorker.ready;

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { status: 'denied' };

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
