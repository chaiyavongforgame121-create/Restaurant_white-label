import { PUBLIC_BASE_HEADER, updateSession } from '@favornoms/database/middleware';
import { getSupabaseEnv } from '@favornoms/database/env';
import {
  movedStorefrontPath,
  parseStorefrontPathResolution,
  shortStorefrontRewrite,
  storefrontPathHead,
  type StorefrontPathResolution,
} from '@favornoms/database/storefront-path';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refreshes the session cookie (updateSession), and puts a storefront address where the
 * storefront lives (docs/SHORT-STOREFRONT-URLS-2026-10-26.md §2–§3).
 *
 * Merchant custom domains are gone (2026-10-26, phase 1): there is no host lookup any more. Every
 * storefront is under /r/ on the platform's own hosts, in one of two forms: the long form
 * /r/<restaurant>/<branch>/…, the only route the app has, and the short form /r/<web-address>/…
 * of a branch that has a web address (branches.public_slug).
 *
 * public.resolve_storefront_path answers for the first one or two segments after /r/:
 *  - `short`: a live web address. The request is REWRITTEN onto the branch's long form, so the
 *    browser keeps the short URL, and the app is told the public base in PUBLIC_BASE_HEADER (it
 *    still has the browser's own pathname and query string in PATHNAME_HEADER / SEARCH_HEADER).
 *  - `redirect`: the long form of a branch that has a web address, or an address a restaurant,
 *    branch or web address gave up (storefront_path_aliases; a live address always wins over an
 *    old one). The answer is a real 308 sent here, before anything streams, with the rest of the
 *    path and the whole query string kept: a printed table code (?t=) and a Stripe return
 *    (?payment_intent=…) that land on an old address arrive with their parameters. It is never
 *    cached, by this map or by the browser: a stale redirect can loop.
 *  - `live` passes through (with its base in the header); `none` is the route's own 404.
 * The branch layout's fallback covers a `live` or `short` answer this cache still holds after a
 * rename: it asks again, fresh, and redirects (after streaming has started, so as a meta refresh).
 *
 * The lookup runs before the session refresh rather than beside it, because a rewrite has to
 * carry the refreshed session. It is a map hit on almost every request; a 308 skips the refresh
 * altogether (no token is spent, so no Set-Cookie has to ride on it), and the page it lands on
 * refreshes.
 */

/**
 * Per-instance cache of the answers. Edge warm instances keep this map; a cold start asks again.
 * Live and short answers are cached, otherwise every menu request would pay an RPC to learn that
 * nothing moved; five minutes bounds how long a rename takes to become a 308 here (the layout's
 * fallback covers the gap). A web address is one entry whatever page follows it; a long-form pair
 * is one entry per pair. An unknown address is kept for a minute only, so a storefront created a
 * moment ago is not held behind a stale "none". A redirect is never cached: a stale one can point
 * at an address that now redirects back (a slug renamed and renamed back, or a restaurant slug a
 * branch gave up and took back) and loop, and old addresses are rare traffic.
 */
const PATH_CACHE = new Map<string, { value: StorefrontPathResolution; expires: number }>();
const PATH_TTL_MS = 5 * 60 * 1000;
const PATH_NONE_TTL_MS = 60_000;
/** Random /r/a/b probes must not grow one instance's memory without bound. */
const PATH_CACHE_MAX = 2000;
/**
 * When the RPC is not there (a 404 / PGRST202: the web app deployed before
 * 20261026110000_storefront_path_aliases), stop asking for a minute instead of paying a failed
 * round trip on every storefront request. Only then: without an answer a web address is not
 * rewritten at all (there is no /r/<web-address> route, so it 404s, a printed table code and a
 * Stripe return included), so one transient error (a 5xx, a 429, a statement timeout) must not
 * switch the short form off for a minute. Any failure, and the minute itself, answers with the
 * last thing this instance knew about the address, expired or not (lastKnown below).
 */
const PATH_RPC_RETRY_MS = 60_000;
let pathRpcUnavailableUntil = 0;

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const head = storefrontPathHead(pathname);
  const resolution = head ? await resolveStorefrontPath(head.first, head.second) : null;

  const moved = movedStorefrontPath(`${pathname}${search}`, resolution);
  if (moved) {
    const redirect = NextResponse.redirect(new URL(moved, request.url), 308);
    // A 308 is cacheable by default, and a browser that kept one could loop once the address
    // moves again (or is taken back).
    redirect.headers.set('Cache-Control', 'no-store');
    return redirect;
  }

  const rewrite = shortStorefrontRewrite(`${pathname}${search}`, resolution);
  const base = resolution?.status === 'short' || resolution?.status === 'live' ? resolution.publicBase : null;
  return updateSession(request, {
    ...(rewrite ? { rewrite } : {}),
    ...(base ? { headers: { [PUBLIC_BASE_HEADER]: base } } : {}),
  });
}

async function resolveStorefrontPath(first: string, second: string | null): Promise<StorefrontPathResolution | null> {
  // A web address answers for every page under it, so it is looked up on its own first.
  const pairKey = `${first}/${second ?? ''}`;
  const now = Date.now();
  // An expired entry stays in the map until it is replaced or evicted: when the database cannot
  // answer, the last `short` or `live` answer is served rather than nothing. A stale `short` is
  // safe to serve, because the branch layout's fallback asks again and corrects a rename; its
  // expiry is never re-armed, so the next request asks again. A `none` is not kept for this (it is
  // the same as no answer), and a redirect is never cached at all.
  let lastKnown: StorefrontPathResolution | null = null;
  for (const key of [first, pairKey]) {
    const cached = PATH_CACHE.get(key);
    if (!cached) continue;
    if (cached.expires > now) return cached.value;
    if (!lastKnown && (cached.value.status === 'short' || cached.value.status === 'live')) lastKnown = cached.value;
  }
  if (now < pathRpcUnavailableUntil) return lastKnown;

  try {
    const { url, publishableKey } = getSupabaseEnv();
    const res = await fetch(`${url}/rest/v1/rpc/resolve_storefront_path`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
      },
      body: JSON.stringify({ p_first: first, p_second: second }),
    });
    if (!res.ok) {
      if (res.status === 404 || (await rpcErrorCode(res)) === 'PGRST202') {
        pathRpcUnavailableUntil = now + PATH_RPC_RETRY_MS;
      }
      return lastKnown;
    }
    const value = parseStorefrontPathResolution(await res.json());
    if (!value) return lastKnown;
    // Asked, so anything kept for the first segment alone had expired. An answer that is not that
    // web address served (it was cleared, given up or switched off) supersedes it: it must not
    // come back as the last known answer when the next lookup fails.
    if (value.status !== 'short') PATH_CACHE.delete(first);
    if (value.status === 'redirect') return value;
    const key = value.segments === 1 ? first : pairKey;
    if (!PATH_CACHE.has(key) && PATH_CACHE.size >= PATH_CACHE_MAX) {
      // Oldest first: a Map iterates in insertion order.
      const oldest = PATH_CACHE.keys().next().value;
      if (oldest !== undefined) PATH_CACHE.delete(oldest);
    }
    PATH_CACHE.set(key, { value, expires: now + (value.status === 'none' ? PATH_NONE_TTL_MS : PATH_TTL_MS) });
    return value;
  } catch {
    // Deliberately not cached, and no backoff: a transient outage must not pin an answer. Null
    // means no redirect and no rewrite, so a web address this instance never saw 404s for this
    // one request; one it did see is still served from its last answer.
    return lastKnown;
  }
}

/** PostgREST's error code from a failed response's body (PGRST202: no such function), if any. */
async function rpcErrorCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code
      : null;
  } catch {
    return null;
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
