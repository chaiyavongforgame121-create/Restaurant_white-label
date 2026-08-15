// Minimal service worker — production should use Workbox per responsive-mobile-first.md §13.3
//
// v3 — CRITICAL FIX. v2's fetch handler fell through to a CACHE-FIRST branch for every GET
// that was not /api/, a .webmanifest or a navigation. Cross-origin requests were never
// excluded, so every Supabase REST read (https://<ref>.supabase.co/rest/v1/...) was cached
// permanently on first response and served from cache forever after.
//
// The effect was that the app looked completely broken end to end: a diner saved a delivery
// address (POST, not intercepted, so it really did persist), but the address LIST kept
// replaying the first empty response and showed "No saved addresses" — the network was never
// touched again, so the server logs showed exactly one GET. The same staleness hit orders,
// rewards and every other client-side read. Bumping the version purges the poisoned caches
// via the activate handler below.
//
// Rules now: never intercept cross-origin (Supabase, Mapbox, fonts) — those must always go to
// the network. Only same-origin, content-addressed static assets are cache-first.
const CACHE_VERSION = 'favornoms-web-v3';
const CACHE_FILES = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

// Same-origin paths that are safe to serve cache-first: build output is content-addressed
// (a new build gets a new URL) and icons are versioned by CACHE_VERSION.
const STATIC_PREFIXES = ['/_next/static/', '/icon', '/apple-touch-icon'];
const STATIC_EXTENSIONS = /\.(?:css|js|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico)$/i;

function isStaticAsset(url) {
  return (
    STATIC_PREFIXES.some((p) => url.pathname.startsWith(p)) ||
    STATIC_EXTENSIONS.test(url.pathname)
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(CACHE_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// Web Push: render notifications from notify-worker payloads.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Favornoms', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Favornoms';
  const options = {
    body: data.body || '',
    // PNG, not SVG — Android notification icons do not render SVG.
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Cross-origin (Supabase REST/Auth/Functions, Mapbox, Google) — DO NOT intercept at all.
  // This is the v2 bug: caching these froze every client-side read at its first response.
  // Returning without respondWith lets the browser perform the request normally.
  if (url.origin !== self.location.origin) return;

  // Same-origin API and auth routes are live data — never serve them from cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  // Network-first for HTML navigation and the per-tenant manifest, with a cache fallback so
  // the app still opens offline. Manifests carry live branding, so they must not go stale.
  if (req.mode === 'navigate' || url.pathname.endsWith('.webmanifest')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((m) => m ?? caches.match('/'))),
    );
    return;
  }

  // Cache-first ONLY for content-addressed static assets. Anything else same-origin falls
  // through to the network untouched.
  if (!isStaticAsset(url)) return;

  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        }),
    ),
  );
});
