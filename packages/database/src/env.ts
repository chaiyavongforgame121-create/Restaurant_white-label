/**
 * Reads + validates Supabase env vars. Throws a clear message if missing.
 * Call from both server and client entrypoints.
 */
export interface SupabaseEnv {
  url: string;
  publishableKey: string;
}

export function getSupabaseEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      [
        '[@favornoms/database] Missing Supabase env vars.',
        'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in your .env.local',
        'See README.md for the values.',
      ].join('\n'),
    );
  }
  return { url, publishableKey };
}
