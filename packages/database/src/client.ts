'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './types';
import type { FavornomsClient } from './client-type';
import { getSupabaseEnv } from './env';

/** Singleton Supabase client for browser components ("use client"). */
let _client: FavornomsClient | undefined;

export function getBrowserClient(): FavornomsClient {
  if (!_client) {
    const { url, publishableKey } = getSupabaseEnv();
    _client = createBrowserClient<Database>(url, publishableKey) as FavornomsClient;
  }
  return _client;
}
