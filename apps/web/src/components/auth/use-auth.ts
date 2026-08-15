'use client';

import * as React from 'react';
import type { User } from '@supabase/supabase-js';
import { getBrowserClient } from '@favornoms/database/client';

/** Subscribes to auth state changes and returns the current user. */
export function useAuth() {
  const [user, setUser] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const supabase = getBrowserClient();
    // getSession(), NOT getUser(): getUser() hits /auth/v1/user over the network on
    // EVERY mount, and menu/checkout/account/orders each mount this hook — that
    // is 7-9 cross-Pacific round-trips per interaction, each gating a "Loading…" spinner,
    // which is the bulk of the "everything spins forever" report. getSession() reads the
    // session from local storage synchronously-ish (no network), and onAuthStateChange
    // still corrects it the instant a token is refreshed or a sign-in/out happens.
    // The catch stays load-bearing: a rejection must resolve loading, not hang the page.
    supabase.auth
      .getSession()
      .then(({ data }) => setUser(data.session?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { user, loading };
}
