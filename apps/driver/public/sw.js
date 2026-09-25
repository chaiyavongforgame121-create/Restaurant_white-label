// Minimal driver-app service worker. Production should use Workbox for
// background sync of location updates per responsive-mobile-first.md §13.2
//
// v2 — CRITICAL FIX. v1's fetch handler was cache-first for EVERY GET with no origin check,
// so every Supabase REST read (dispatch offers, active delivery, earnings) was frozen at its
// first response and served from cache forever — a rider would never see a new offer or a
// status change. Same class of bug as the customer app's sw.js v2. Bumping the version purges
// the poisoned caches via the activate handler.
//
// v3 — what an INSTALLED rider app does with the rest of it. Standalone means no address bar
// and no back button, so every one of these was a dead end you could only leave by
// force-quitting:
//
//  1. '/' was precached and was the offline fallback, but '/' is a 307 to /app/home
//     (src/app/page.tsx). cache.addAll follows the redirect and stores a response with its
//     `redirected` flag set, and the spec makes a navigation answered with one a network
//     error — so the single universal fallback was guaranteed to fail. It is gone; /login and
//     /app/home are precached instead (a rider whose session check fails offline is sent to
//     /login, which was never in the list), and the last resort is the page synthesised below,
//     which cannot be missing.
//  2. Any response was cached, ok or not. fetch() only rejects on a transport failure, so a
//     502, a chunk 404'd mid-deploy, or — the nasty one — a café captive-portal page returned
//     with HTTP 200 became the offline shell until the next version bump. Under the cache-first
//     branch a 404'd chunk is permanent: cache-first never re-fetches.
//  3. Notification icons were SVG. Chrome on Android does not decode SVG for `icon`/`badge`,
//     so every dispatch alert wore a generic Chrome glyph. apps/web/public/sw.js has carried
//     the PNG fix and this comment since its v3; this worker never got it.
//  4. Every offer shared one tag with `renotify` unset. Showing a notification whose tag
//     matches one already on the shade REPLACES it in silence — no sound, no vibration, no
//     banner. While offer #1 was still showing, offer #2 arrived invisibly and the rider lost
//     the work. notify-worker now sends a per-delivery tag; `renotify` makes each one alert.
//  5. No pushsubscriptionchange handler. Browsers rotate push endpoints; notify-worker deletes
//     the stale row on the next 410 and nothing re-subscribed, so the installed app went
//     permanently silent. Re-subscribe here and hand the result to the page, which owns the RPC.
//
// v4 — the app is FavorGO now, with a car where the bicycle was. The icons kept their URLs, and
// v3 served every /icon*, /apple-touch-icon* and *.png|svg cache-first — which, for a file whose
// name carries no hash, means for good: an installed rider would have kept the bicycle until
// some later version bump. This bump purges v3's cache, and public/ files are now network-first
// (the cache only as the offline fallback), like the manifest, so the next icon change needs no
// bump. Only /_next/static/, whose file names carry a build hash, is still cache-first. The
// notification badge is also a car silhouette of its own now; see the push handler.
const CACHE_VERSION = 'favornoms-driver-v4';

// The offline path, and only the offline path: the shell a signed-in rider lands on, the
// screen an expired session lands on, and the icons their tab and the manifest point at.
const CACHE_FILES = [
  '/app/home',
  '/login',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon.svg',
  '/icon-192.png',
];

// Content-addressed: every file under here has a build hash in its name, so a cached copy can
// never be the wrong one.
const IMMUTABLE_PREFIX = '/_next/static/';
// Files from public/, which keep their URL when their content changes. The prefixes catch any
// extensionless icon route; everything in public/ today has one of the extensions.
const PUBLIC_PREFIXES = ['/icon', '/apple-touch-icon', '/favicon', '/badge'];
const STATIC_EXTENSIONS = /\.(?:css|js|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico)$/i;

// Last resort when the network is gone and nothing useful is in the cache. Inline rather than a
// file in public/, because a fallback that can 404 during precache is not a fallback.
const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Offline</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100dvh;display:grid;place-items:center;text-align:center;
padding:max(1.5rem,env(safe-area-inset-top)) 1.5rem max(1.5rem,env(safe-area-inset-bottom));
font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
background:#fffaf5;color:#1a1a1a}
@media(prefers-color-scheme:dark){body{background:#1a0e08;color:#f5efe9}}
h1{font-size:1.35rem;margin:0 0 .5rem}
p{margin:0 0 1.5rem;opacity:.75;max-width:22rem}
button{min-height:48px;padding:0 1.5rem;border:0;border-radius:14px;background:#ff6b35;
color:#fff;font-weight:600;font-size:1rem}
</style></head><body><div>
<h1>You're offline</h1>
<p>Your deliveries are safe. As soon as you have signal again, everything will be here.</p>
<button onclick="location.reload()">Try again</button>
</div></body></html>`;

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function isPublicFile(url) {
  return (
    PUBLIC_PREFIXES.some((p) => url.pathname.startsWith(p)) || STATIC_EXTENSIONS.test(url.pathname)
  );
}

/**
 * Store a response only if we would be happy to serve it back. A redirected response is
 * refused outright: the spec will not let one answer a navigation, so caching it manufactures
 * the very dead end this version exists to remove.
 */
function cacheIfServable(event, req, res) {
  if (!res || !res.ok || res.redirected || res.type !== 'basic') return;
  const copy = res.clone();
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((c) => c.put(req, copy))
      .catch(() => undefined),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // Not addAll: it is all-or-nothing, so one 404 leaves the worker uninstalled and the
      // rider with no offline story at all. Each file stands or falls on its own.
      .then((cache) =>
        Promise.all(
          CACHE_FILES.map((path) =>
            fetch(path, { cache: 'reload' })
              .then((res) => (res.ok && !res.redirected ? cache.put(path, res) : undefined))
              .catch(() => undefined),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        // Everything from an older CACHE_VERSION goes, which is how a device on v2 sheds the
        // precached redirect at '/' and any 502 it swallowed.
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// Web Push: render notifications from notify-worker payloads. For a rider with the phone in
// their pocket this is the only channel there is, so a notification that does not alert is the
// same as no notification.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'FavorGO', body: event.data ? event.data.text() : '' };
  }
  // The app's name, as in src/components/brand-mark.tsx (APP_NAME); a worker cannot import it.
  const title = data.title || 'FavorGO';
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : undefined;
  // notify-worker tags dispatch offers 'new_dispatch:<delivery id>' so each offer is its own
  // notification; order-status updates keep collapsing on one tag, which is what you want there.
  const isDispatch = !!tag && tag.indexOf('new_dispatch') === 0;
  const options = {
    body: data.body || '',
    // PNG, not SVG — Android notification icons do not render SVG.
    icon: '/icon-192.png',
    // Android paints the badge in the status bar from its alpha channel alone. icon-192 is a
    // solid rounded square, so it came out as a blank white tile; this is the car cut out.
    badge: '/badge-96.png',
    tag,
    // renotify without a tag is a TypeError, which rejects showNotification and produces no
    // notification at all — worse than the silent replacement it is here to prevent.
    renotify: !!tag,
    requireInteraction: isDispatch,
    vibrate: isDispatch ? [200, 100, 200, 100, 200] : [100],
    silent: false,
    data: { url: data.url || '/app/home' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // '/app' has no page — the driver app's entry is /app/home. Defaulting to it meant
  // tapping a notification opened a 404.
  const url = (event.notification.data && event.notification.data.url) || '/app/home';
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

// A rotated endpoint used to mean permanent silence. Re-subscribe with the same application
// server key and hand the result to the page — only the page can call the RPC that stores it.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      let sub = event.newSubscription || null;
      if (!sub) {
        const old =
          event.oldSubscription || (await self.registration.pushManager.getSubscription());
        const key = old && old.options ? old.options.applicationServerKey : null;
        if (!key) return;
        sub = await self.registration.pushManager
          .subscribe({ userVisibleOnly: true, applicationServerKey: key })
          .catch(() => null);
      }
      if (!sub) return;
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        client.postMessage({ type: 'push-subscription-changed', subscription: sub.toJSON() });
      }
    })(),
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

  // Cross-origin (Supabase REST/Auth/Realtime, Mapbox) — never intercept. Dispatch offers and
  // delivery state MUST come from the network every time; caching them is what froze the app.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  // Network-first for navigation + manifest, cache only as an offline fallback.
  if (req.mode === 'navigate' || url.pathname.endsWith('.webmanifest')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          cacheIfServable(event, req, res);
          return res;
        })
        .catch(async () => {
          const exact = await caches.match(req, { ignoreSearch: true });
          if (exact) return exact;
          // The shell, then the screen an expired session lands on, then a page that always
          // exists. Never '/': it redirects, and a redirected response cannot answer this.
          const shell = await caches.match('/app/home');
          if (shell) return shell;
          const login = await caches.match('/login');
          if (login) return login;
          return offlineResponse();
        }),
    );
    return;
  }

  // Cache-first ONLY for content-addressed static assets.
  if (url.pathname.startsWith(IMMUTABLE_PREFIX)) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            cacheIfServable(event, req, res);
            return res;
          }),
      ),
    );
    return;
  }

  // public/ files (icons, favicons, the badge): same URL, new content whenever the brand
  // changes, so the network decides and the cache only covers being offline.
  if (isPublicFile(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          cacheIfServable(event, req, res);
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || Response.error())),
    );
    return;
  }

  // Everything else same-origin falls through untouched — which is where the RSC payloads
  // behind every tab tap (`?_rsc=`, request mode "cors", no file extension) land, and where
  // they belong.
});
