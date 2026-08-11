import type { FavornomsClient } from '../client-type';

// Phone auth is OTP-less across every surface: the `customer-auth` / `driver-auth` edge
// functions mint a session from a phone number alone, so there are no send/verify wrappers
// here any more. See supabase/functions/customer-auth/index.ts.

export async function getCurrentUser(supabase: FavornomsClient) {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user ?? null;
}

export async function signOut(supabase: FavornomsClient) {
  return supabase.auth.signOut();
}
