import type { FavornomsClient } from './client-type';

/**
 * Give the realtime socket the signed-in user's token before a channel joins.
 *
 * Realtime authorises postgres_changes with the JWT a channel JOINS with. On a fresh page the
 * socket joined before the cookie session reached it, so every subscription registered as `anon`
 * (realtime.subscription.claims_role) and RLS-protected tables — orders for the kitchen,
 * staff_members for the access watcher, delivery_messages for chat — delivered nothing to
 * signed-in users: screens only caught up on a reconnect or when the tab came back into view.
 * With no session the anon key stays, which is right for the storefront's public tables.
 */
export async function authorizeRealtime(supabase: FavornomsClient): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) await supabase.realtime.setAuth(token);
  } catch {
    /* joining as anon still serves public tables; callers' refetches cover the rest */
  }
}
