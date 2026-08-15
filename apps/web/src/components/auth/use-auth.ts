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
    // The catch is load-bearing: every page that gates a "Loading…" branch on this
    // flag spins forever if getUser() rejects. Treat a failed lookup as signed-out —
    // onAuthStateChange still corrects it if a session turns up.
    supabase.auth
      .getUser()
      .then(({ data }) => setUser(data.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { user, loading };
}
