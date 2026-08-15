import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from './types';
import type { FavornomsClient } from './client-type';
import { getSupabaseEnv } from './env';

/**
 * Supabase client for Server Components, Route Handlers, and Server Actions.
 * Uses Next.js cookies() so RLS sees the authenticated user.
 *
 * Per @supabase/ssr docs: do NOT cache or memoize across requests.
 */
export async function getServerClient(): Promise<FavornomsClient> {
  const { url, publishableKey } = getSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options as never);
          }
        } catch {
          // Server Components cannot set cookies — middleware handles refresh.
        }
      },
    },
  }) as FavornomsClient;
}

/**
 * Cookie-LESS anon client for public, non-user-specific reads (tenant, menu, prices).
 *
 * It never calls next/headers `cookies()`, so — unlike getServerClient — it does NOT opt
 * the route into dynamic rendering and IS safe to call inside `unstable_cache`. Use it only
 * for data that is identical for every visitor (the storefront is publicly viewable, so the
 * anon role can read it); anything user-scoped must still go through getServerClient so RLS
 * sees the session.
 */
export function getAnonServerClient(): FavornomsClient {
  const { url, publishableKey } = getSupabaseEnv();
  return createServerClient<Database>(url, publishableKey, {
    cookies: { getAll: () => [], setAll: () => {} },
  }) as FavornomsClient;
}
