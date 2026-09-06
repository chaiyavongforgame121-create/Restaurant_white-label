import { updateSession, PATHNAME_HEADER } from '@favornoms/database/middleware';
import { getSupabaseEnv } from '@favornoms/database/env';
import { NextResponse, type NextRequest } from 'next/server';

const APEX_HOSTS = new Set(
  (process.env.NEXT_PUBLIC_APEX_HOSTS ?? 'localhost,127.0.0.1,favornoms.com,app.favornoms.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// Minimal in-memory cache for custom-domain lookups. Edge runtime warm
// instances retain this map; cold starts re-fetch. 10-minute TTL.
const DOMAIN_CACHE = new Map<string, { restaurant: string; branch: string | null; expires: number }>();
const TTL_MS = 10 * 60 * 1000;

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

async function resolveDomain(host: string): Promise<{ restaurant: string; branch: string | null } | null> {
  const cached = DOMAIN_CACHE.get(host);
  const now = Date.now();
  if (cached && cached.expires > now) return cached;

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
      DOMAIN_CACHE.set(host, { restaurant: '', branch: null, expires: now + 60_000 });
      return null;
    }
    const value = { restaurant: first.restaurant_slug, branch: first.branch_slug };
    DOMAIN_CACHE.set(host, { ...value, expires: now + TTL_MS });
    return value;
  } catch {
    return null;
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
