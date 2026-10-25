import { updateSession } from '@favornoms/database/middleware';
import { getSupabaseEnv } from '@favornoms/database/env';
import {
  movedStorefrontPath,
  parseStorefrontPathResolution,
  storefrontPathSlugs,
  type StorefrontPathResolution,
} from '@favornoms/database/storefront-path';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Two jobs, run together rather than in series: refresh the session cookie (updateSession), and
 * send an old storefront address to where that storefront lives now.
 *
 * Merchant custom domains are gone (2026-10-26, phase 1): there is no host lookup and no rewrite
 * any more. Every storefront is /r/<restaurant>/<branch> on the platform's own hosts.
 *
 * Old addresses come from public.resolve_storefront_path, which reads the slugs a restaurant or
 * branch gave up (storefront_path_aliases, written by a trigger on every rename) and always lets
 * a live slug win over an old one. The answer is a real 308 sent here, before anything streams,
 * with the rest of the path and the whole query string kept: a printed table code (?t=) and a
 * Stripe return (?payment_intent=…) that land on an old address arrive with their parameters.
 * The branch layout used to redirect instead, after app/r/loading.tsx had started streaming, so
 * the answer was a 200 with a meta refresh and the query string was lost; it is now only the
 * fallback for a pair this cache still calls live.
 */

/**
 * Per-instance cache of the answer for each slug pair. Edge warm instances keep this map; a cold
 * start asks again. Live pairs are cached, otherwise every menu request would pay an RPC to learn
 * that nothing moved; five minutes bounds how long a rename takes to become a 308 here (the
 * layout's fallback covers the gap). An unknown pair is kept for a minute only, so a storefront
 * created a moment ago is not held behind a stale "none". A redirect is never cached: a stale one
 * can point at an address that now redirects back (a slug renamed and renamed back, or a freed
 * slug taken by another storefront) and loop, and old addresses are rare traffic.
 */
const PATH_CACHE = new Map<string, { value: StorefrontPathResolution; expires: number }>();
const PATH_TTL_MS = 5 * 60 * 1000;
const PATH_NONE_TTL_MS = 60_000;
/** Random /r/a/b probes must not grow one instance's memory without bound. */
const PATH_CACHE_MAX = 2000;
/**
 * When the RPC is not there (the web app deployed before 20261026110000_storefront_path_aliases)
 * or keeps failing, stop asking for a minute instead of paying a failed round trip on every
 * storefront request. Nothing is redirected meanwhile, which is how it behaved before.
 */
const PATH_RPC_RETRY_MS = 60_000;
let pathRpcUnavailableUntil = 0;

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const slugs = storefrontPathSlugs(pathname);

  const [sessionResponse, resolution] = await Promise.all([
    updateSession(request),
    slugs ? resolveStorefrontPath(slugs.first, slugs.second) : Promise.resolve(null),
  ]);

  const moved = movedStorefrontPath(`${pathname}${search}`, resolution);
  if (moved) {
    const redirect = NextResponse.redirect(new URL(moved, request.url), 308);
    // updateSession may have refreshed the access token, spending the old refresh token. Its
    // Set-Cookie headers have to ride on the redirect, or the browser keeps the spent one and the
    // next refresh trips GoTrue's reuse detection.
    for (const cookie of sessionResponse.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  return sessionResponse;
}

async function resolveStorefrontPath(first: string, second: string): Promise<StorefrontPathResolution | null> {
  const key = `${first}/${second}`;
  const now = Date.now();
  const cached = PATH_CACHE.get(key);
  if (cached && cached.expires > now) return cached.value;
  if (now < pathRpcUnavailableUntil) return null;

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
      pathRpcUnavailableUntil = now + PATH_RPC_RETRY_MS;
      return null;
    }
    const value = parseStorefrontPathResolution(await res.json());
    if (!value) return null;
    if (value.status === 'redirect') return value;
    if (!PATH_CACHE.has(key) && PATH_CACHE.size >= PATH_CACHE_MAX) {
      // Oldest first: a Map iterates in insertion order.
      const oldest = PATH_CACHE.keys().next().value;
      if (oldest !== undefined) PATH_CACHE.delete(oldest);
    }
    PATH_CACHE.set(key, { value, expires: now + (value.status === 'none' ? PATH_NONE_TTL_MS : PATH_TTL_MS) });
    return value;
  } catch {
    // Deliberately not cached: a transient outage must not pin an answer. No redirect happens,
    // which is the safe half — the page renders or 404s exactly as it would have.
    return null;
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
