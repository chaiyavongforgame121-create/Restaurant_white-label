import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

/**
 * Common SupabaseClient type accepted by query helpers — compatible with
 * both browser (`createBrowserClient`) and server (`createServerClient`)
 * clients from `@supabase/ssr`.
 *
 * Note: we use `any` for the schema-related generics because their shape
 * differs between supabase-js versions. The `Database` generic still gives
 * full table/column intellisense on `.from('...').select('...')`.
 */
export type FavornomsClient = SupabaseClient<Database, any, any>;
