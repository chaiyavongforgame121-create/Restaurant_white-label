import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from './types';
import { getSupabaseEnv } from './env';

/** Request header carrying the current pathname into server components. */
export const PATHNAME_HEADER = 'x-favornoms-pathname';

/**
 * Request header carrying the current query string ('' or '?…') into server components. The
 * storefront's moved-address fallback needs it: a redirect built from the pathname alone dropped
 * a table code's ?t= and a Stripe return's ?payment_intent=…
 */
export const SEARCH_HEADER = 'x-favornoms-search';

/**
 * Request header carrying a storefront's public base (/r/<web-address>, or the long form) into
 * server components, set by the web middleware when it serves a short address from its long form
 * (docs/SHORT-STOREFRONT-URLS-2026-10-26.md §3). Whatever a client sends under this name is
 * dropped: only the middleware's value reaches the app. PATHNAME_HEADER stays the address the
 * browser asked for.
 */
export const PUBLIC_BASE_HEADER = 'x-favornoms-public-base';

export interface UpdateSessionOptions {
  /**
   * Serve this same-origin path (or URL) instead of the one asked for: NextResponse.rewrite, so
   * the browser keeps its URL. The refreshed session rides on the rewrite exactly as on next().
   */
  rewrite?: string | URL;
  /** Request headers to add for the server components rendering this request. */
  headers?: Record<string, string>;
}

/**
 * Per @supabase/ssr Next.js middleware pattern.
 * Call this from each app's middleware.ts to refresh the session cookie on
 * every request.
 *
 * The response is rebuilt inside setAll rather than mutated: a refreshed
 * access token has to reach the server components rendering *this* request,
 * and that only happens if the outgoing request headers are rebuilt after the
 * cookie jar changes. Snapshotting the headers once up front would silently
 * cost a render at every token refresh.
 *
 * We also forward the pathname and the query string, which layouts otherwise
 * cannot see. The admin branch layout needs the pathname to exempt
 * /settings/plan from the suspension redirect — without the exemption that
 * redirect loops forever.
 *
 * `options` lets the storefront serve a short address from its long form
 * (`rewrite`) and hand the app its public base (`headers`, PUBLIC_BASE_HEADER).
 */
export async function updateSession(request: NextRequest, options: UpdateSessionOptions = {}) {
  const { url, publishableKey } = getSupabaseEnv();

  const buildHeaders = () => {
    const h = new Headers(request.headers);
    h.set(PATHNAME_HEADER, request.nextUrl.pathname);
    h.set(SEARCH_HEADER, request.nextUrl.search);
    h.delete(PUBLIC_BASE_HEADER);
    for (const [name, value] of Object.entries(options.headers ?? {})) h.set(name, value);
    return h;
  };
  const respond = () =>
    options.rewrite
      ? NextResponse.rewrite(new URL(options.rewrite, request.url), { request: { headers: buildHeaders() } })
      : NextResponse.next({ request: { headers: buildHeaders() } });

  let response = respond();

  // Skip the /auth/v1/user round-trip for anonymous visitors. getUser() exists here only to
  // refresh an access token, and an anonymous visitor has no token to refresh — yet this call
  // (~1.4s from Thailand, seconds on a cold instance) was on the critical path of EVERY menu
  // page load, which is the bulk of the "everything spins" report. A signed-in visitor always
  // carries an `sb-<ref>-auth-token` cookie; only then is there anything to do.
  const hasAuthCookie = request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'));
  if (!hasAuthCookie) return response;

  const supabase = createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = respond();
        for (const { name, value, options: cookieOptions } of cookiesToSet) {
          response.cookies.set(name, value, cookieOptions as never);
        }
      },
    },
  });

  // Refreshes the access token if expired.
  await supabase.auth.getUser();

  return response;
}
