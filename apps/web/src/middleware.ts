import { updateSession, PATHNAME_HEADER } from '@favornoms/database/middleware';
import { getSupabaseEnv } from '@favornoms/database/env';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Hosts we already know are the platform's, kept only to skip the lookup below on them. It is
 * a fast path and never an authority: a host missing from this list costs one cached RPC and
 * then behaves identically, because resolveDomain() has to find a live branch before anything
 * is rewritten.
 *
 * That distinction is not academic. The per-tenant manifest route used to carry a copy of this
 * list and treat "absent" as "this is a merchant's own domain", which is how the production
 * storefront host — absent from the list to this day — published the platform root as every
 * restaurant's PWA start_url and scope. It now asks the database through hostTenant() in
 * src/lib/tenant.ts instead. Do not reintroduce a second copy of this list anywhere that
 * decides what a page or a manifest says; only a lookup may decide that.
 *
 * Edge middleware cannot import that helper — src/lib/tenant.ts reaches next/headers through
 * the server Supabase client — so this file keeps its own lookup, and the two agree because
 * they call the same RPC and both treat "no live branch" as "not a merchant domain".
 */
const APEX_HOSTS = new Set(
  (process.env.NEXT_PUBLIC_APEX_HOSTS ?? 'localhost,127.0.0.1,favornoms.com,app.favornoms.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// Minimal in-memory cache for custom-domain lookups. Edge runtime warm
// instances retain this map; cold starts re-fetch. 10-minute TTL for a hit;
// a miss is cached far more briefly so a domain added today starts working today.
type DomainTenant = { restaurant: string; branch: string | null };
const DOMAIN_CACHE = new Map<string, { value: DomainTenant | null; expires: number }>();
const TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 60_000;

export async function middleware(request: NextRequest) {
  const host = ((request.headers.get('host') ?? '').split(':')[0] ?? '').toLowerCase();
  const path = request.nextUrl.pathname;

  // Apex/dev hosts pass through to the regular /r/[restaurant]/[branch] routing.
  // Static and Next internals are excluded by the matcher below. /auth/ is exempt too:
  // the OAuth callback is a fixed, tenant-less path on every host.
  const isTenantHost =
    !!host && !APEX_HOSTS.has(host)
    && !path.startsWith('/r/') && !path.startsWith('/api/') && !path.startsWith('/auth/');

  // The session refresh has to happen on a merchant's own domain too. Returning the rewrite
  // on its own skipped updateSession entirely there, so an access token that expired mid-visit
  // was never renewed: getServerClient() cannot write cookies from a server component, and a
  // refresh token re-spent on every render eventually trips GoTrue's reuse detection and
  // revokes the session outright. A diner on order.myrestaurant.com then saw "no orders" for
  // orders they had just placed, while the same page on the apex host worked.
  //
  // The two hops do not depend on each other, so they run together rather than in series —
  // a custom domain must not pay for the domain lookup and the token refresh one after the
  // other on every request.
  const [sessionResponse, resolved] = await Promise.all([
    updateSession(request),
    isTenantHost ? resolveDomain(host) : Promise.resolve(null),
  ]);

  if (resolved && resolved.branch) {
    const url = request.nextUrl.clone();
    url.pathname = `/r/${resolved.restaurant}/${resolved.branch}${path === '/' ? '' : path}`;
    // updateSession writes any refreshed token back onto request.cookies, so rebuilding the
    // request headers here hands the fresh access token to this render; carrying its
    // Set-Cookie headers across is what stores that token in the browser.
    const headers = new Headers(request.headers);
    headers.set(PATHNAME_HEADER, path);
    const rewrite = NextResponse.rewrite(url, { request: { headers } });
    for (const cookie of sessionResponse.cookies.getAll()) rewrite.cookies.set(cookie);
    return rewrite;
  }

  return sessionResponse;
}

async function resolveDomain(host: string): Promise<DomainTenant | null> {
  const cached = DOMAIN_CACHE.get(host);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.value;

  try {
    const { url, publishableKey } = getSupabaseEnv();
    const res = await fetch(`${url}/rest/v1/rpc/resolve_custom_domain`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
      },
      body: JSON.stringify({ p_domain: host }),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ restaurant_slug: string; branch_slug: string | null }>;
    const first = rows?.[0];
    if (!first) {
      DOMAIN_CACHE.set(host, { value: null, expires: now + MISS_TTL_MS });
      return null;
    }
    const value = { restaurant: first.restaurant_slug, branch: first.branch_slug };
    DOMAIN_CACHE.set(host, { value, expires: now + TTL_MS });
    return value;
  } catch {
    // Deliberately not cached: a transient outage must not pin a merchant's domain to the
    // marketing site for a minute. No rewrite happens either way, which is the safe half.
    return null;
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
