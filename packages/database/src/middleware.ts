import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from './types';
import { getSupabaseEnv } from './env';

/**
 * Per @supabase/ssr Next.js middleware pattern.
 * Call this from apps/web/middleware.ts and apps/driver/middleware.ts
 * to refresh the session cookie on every request.
 */
export async function updateSession(request: NextRequest) {
  const response = NextResponse.next({ request });
  const { url, publishableKey } = getSupabaseEnv();

  const supabase = createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
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
