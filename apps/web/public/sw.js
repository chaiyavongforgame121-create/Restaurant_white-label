// Minimal service worker — production should use Workbox per responsive-mobile-first.md §13.3
//
// v3 fixed the disaster: v2's fetch handler fell through to a CACHE-FIRST branch for every GET
// that was not /api/, a .webmanifest or a navigation, cross-origin included, so every Supabase
// REST read was cached permanently on first response and replayed forever. Saved addresses,
// orders and rewards all froze at their first (empty) answer. The rule that came out of it —
// never intercept cross-origin, cache-first only content-addressed same-origin assets — still
// holds and is enforced below.
//
// v4 fixes what an INSTALLED storefront does with the rest of it:
//
//  1. It no longer calls skipWaiting() on its own. Paired with the old
//     controllerchange -> location.reload() in service-worker.tsx, any change to this file
//     restarted the app a few seconds after the diner opened it — mid-cart, mid-form, with no
//     warning. The page now decides when to switch (SKIP_WAITING below), and the "a new
//     version is ready" banner is a tap, not an ambush.
//  2. '/' and '/manifest.webmanifest' are no longer precached, and '/' is no longer the offline
//     fallback. Those are the PLATFORM's landing page and manifest. A diner who installed
//     "Somtam Zab" and opened it on the underground got the Favornoms marketing page — their
//     restaurant, as far as they could tell, had been replaced by an advert. Offline now falls
//     back to that storefront's own root, and only then to '/'.
//  3. Personal and transactional pages are never stored. /orders, /account, /checkout and
//     /sign-in HTML sat in Cache Storage on whatever phone last opened them, replayable offline
//     by whoever holds the phone next.
//  4. The asset cache is bounded. It only ever grew: every deploy adds a fresh set of
//     content-hashed chunks under new URLs and nothing removed the old ones, so the cache grew
//     by a build's worth of JavaScript per deploy until the browser evicted the origin's
//     storage wholesale.
//
// v5 keeps branches apart. Two storefronts of one restaurant (/r/coastal-grill/brooklyn and
// /r/coastal-grill/food-thai-thai) share this origin, so they share this worker and its one
// push subscription:
//
//  1. Tapping a notification navigated the FIRST open window, whatever it was showing. An order
//     update from one branch took over a window the diner had open on the other branch's menu,
//     mid-cart. A tap now goes to a window of the storefront the notification is about, or opens
//     a new one; another branch's window is never touched.
//  2. Every notification wore the platform's icon and, when the payload had none, its name.
//     notify-worker now sends the branch's own title and icon, and they are used when present.
const CACHE_VERSION = 'favornoms-web-v5';

// Icons only. Deliberately no HTML: see (2) above.
const CACHE_FILES = [
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

// Same-origin paths that are safe to serve cache-first: build output is content-addressed
// (a new build gets a new URL) and icons are versioned by CACHE_VERSION.
const STATIC_PREFIXES = ['/_next/static/', '/icon', '/apple-touch-icon'];
const STATIC_EXTENSIONS = /\.(?:css|js|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico)$/i;

// Pages that belong to one person and one moment. Served from the network like everything
// else; simply never written down. Anchored to the site root or to a /r/<restaurant>/<branch>
// prefix so a restaurant whose slug happens to be "orders" is not caught by it.
const NO_STORE_NAV =
  /^(?:\/r\/[^/]+\/[^/]+)?\/(?:orders|account|checkout|sign-in|sign-up|auth)(?:\/|$)/;

// Roughly one build's worth of chunks plus a handful of pages. Cache.keys() returns insertion
// order, so trimming from the front drops the oldest entries — in practice the previous
// deploy's chunks, which nothing will ask for again.
const MAX_ENTRIES = 250;

function isStaticAsset(url) {
  return (
    STATIC_PREFIXES.some((p) => url.pathname.startsWith(p)) ||
    STATIC_EXTENSIONS.test(url.pathname)
  );
}

/** The storefront a path belongs to: /r/<restaurant>/<branch>. Null off a storefront. */
function tenantRoot(url) {
  const m = url.pathname.match(/^\/r\/[^/]+\/[^/]+/);
  return m ? m[0] : null;
}

async function putTrimmed(request, response) {
  const cache = await caches.open(CACHE_VERSION);
  await cache.put(request, response);
  const keys = await cache.keys();
  if (keys.length > MAX_ENTRIES) {
    await Promise.all(keys.slice(0, keys.length - MAX_ENTRIES).map((k) => cache.delete(k)));
  }
}

self.addEventListener('install', (event) => {
  // No skipWaiting(): a waiting worker is adopted by the page (see service-worker.tsx), which
  // knows whether the diner is in the middle of something.
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(CACHE_FILES)));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        // Everything from an older CACHE_VERSION goes, which is how a device on v3 sheds the
        // precached platform landing page and the unbounded v3 asset cache in one step.
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// PNG, not SVG — Android notification icons do not render SVG.
const PLATFORM_NOTIFICATION_ICON = '/icon-192.png';

/**
 * An icon URL from a push payload, or null. https anywhere (the branch's upload lives on the
 * Supabase storage host), or a path on this origin. Anything else — javascript:, data:, a
 * non-string — is ignored so the platform icon is used instead.
 */
function payloadIcon(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value, self.location.origin);
    if (u.protocol === 'https:' || u.origin === self.location.origin) return u.href;
  } catch {
    // Not a URL.
  }
  return null;
}

// Web Push: render notifications from notify-worker payloads.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Favornoms', body: event.data ? event.data.text() : '' };
  }
  if (!data || typeof data !== 'object') data = {};
  // notify-worker sends the storefront's own name ("Coastal Grill - Hamburger") and the branch's
  // icon for a diner's order updates: two branches on one host share this worker, and the
  // platform's name and icon said nothing about which of them was writing.
  const title = (typeof data.title === 'string' && data.title) || 'Favornoms';
  const options = {
    body: data.body || '',
    icon: payloadIcon(data.icon) || PLATFORM_NOTIFICATION_ICON,
    badge: payloadIcon(data.badge) || PLATFORM_NOTIFICATION_ICON,
    tag: data.tag,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/** A URL without its #fragment, for "is this window already showing that page". */
function withoutHash(href) {
  const i = href.indexOf('#');
  return i === -1 ? href : href.slice(0, i);
}

/**
 * Take the diner to `rawUrl` in a window of the SAME storefront, or a new one.
 *
 * Two branches of one restaurant share this origin and this worker, so "the first open window"
 * could be the other branch's menu with a cart in it. A window only counts when its
 * /r/<restaurant>/<branch> root matches the target's (for a platform URL, when it is not on a
 * storefront either); every other window is left exactly as it is. On a merchant's own domain
 * the storefront is served without the /r/ prefix, so its windows have no root and a /r/ target
 * opens a new window instead: this worker cannot tell which branch such a window is showing, and
 * guessing wrong is exactly the hijack this exists to prevent.
 *
 * Browsers grant ONE window interaction per click — focus() and openWindow() each consume it —
 * so the choice between focusing and opening is made before either is called. A window this
 * worker does not control cannot be navigated at all, so it only wins when it is already on the
 * target page.
 */
async function openStorefrontWindow(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl, self.location.origin);
  } catch {
    target = new URL('/', self.location.origin);
  }
  const href = target.href;

  if (target.origin !== self.location.origin) {
    return self.clients.openWindow ? self.clients.openWindow(href) : undefined;
  }

  const root = tenantRoot(target);
  const [all, controlled] = await Promise.all([
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }),
    self.clients.matchAll({ type: 'window' }),
  ]);
  const controlledIds = new Set(controlled.map((c) => c.id));
  const sameStorefront = all.filter((client) => {
    try {
      const u = new URL(client.url);
      return u.origin === self.location.origin && tenantRoot(u) === root;
    } catch {
      return false;
    }
  });

  // Already on the page: bring it forward, nothing to load.
  const onTarget = sameStorefront.find((c) => withoutHash(c.url) === withoutHash(href));
  if (onTarget) return onTarget.focus();

  // Same storefront, another page: prefer the window the diner was last looking at. Focus
  // first, while the click still grants it; navigating needs no such grant.
  const navigable = sameStorefront.filter((c) => controlledIds.has(c.id));
  const chosen = navigable.find((c) => c.focused) || navigable[0];
  if (chosen) {
    const focused = (await chosen.focus().catch(() => null)) || chosen;
    return focused.navigate(href).catch(() => focused);
  }

  if (self.clients.openWindow) return self.clients.openWindow(href);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(openStorefrontWindow(url).catch(() => {}));
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

  // Network-first for HTML navigation and the per-tenant manifest, so the shell is never stale:
  // prices, sold-out badges and opening hours are rendered on the server, and a cached shell is
  // a cached menu. The cache copy exists only to open offline.
  if (req.mode === 'navigate' || url.pathname.endsWith('.webmanifest')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only successful, complete responses are worth keeping — a cached 404 or a redirect
          // to sign-in is a worse offline experience than the fallback below.
          if (res.ok && res.type === 'basic' && !NO_STORE_NAV.test(url.pathname)) {
            const copy = res.clone();
            event.waitUntil(putTrimmed(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const exact = await caches.match(req, { ignoreSearch: true });
          if (exact) return exact;
          // This diner's restaurant, not the platform's marketing page.
          const root = tenantRoot(url);
          if (root) {
            const rootHit = await caches.match(root);
            if (rootHit) return rootHit;
          }
          const platform = await caches.match('/');
          return platform ?? Response.error();
        }),
    );
    return;
  }

  // Cache-first ONLY for content-addressed static assets. Anything else same-origin falls
  // through to the network untouched — which is where the RSC payloads behind every in-app
  // tab tap (`?_rsc=`, request mode "cors", no file extension) land, and where they belong:
  // they carry the menu, the prices and the opening hours.
  if (!isStaticAsset(url)) return;

  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            event.waitUntil(putTrimmed(req, copy));
          }
          return res;
        }),
    ),
  );
});
