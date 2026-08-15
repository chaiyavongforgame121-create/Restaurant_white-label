import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from './types';
import { getSupabaseEnv } from './env';

/** Request header carrying the current pathname into server components. */
export const PATHNAME_HEADER = 'x-favornoms-pathname';

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
 * We also forward the pathname, which layouts otherwise cannot see. The admin
 * branch layout needs it to exempt /settings/plan from the suspension
 * redirect — without the exemption that redirect loops forever.
 */
export async function updateSession(request: NextRequest) {
  const { url, publishableKey } = getSupabaseEnv();

  const buildHeaders = () => {
    const h = new Headers(request.headers);
    h.set(PATHNAME_HEADER, request.nextUrl.pathname);
    return h;
  };

  let response = NextResponse.next({ request: { headers: buildHeaders() } });

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
        response = NextResponse.next({ request: { headers: buildHeaders() } });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options as never);
        }
      },
    },
  });

  // Refreshes the access token if expired.
  await supabase.auth.getUser();

  return response;
}
