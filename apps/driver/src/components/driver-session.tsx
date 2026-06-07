'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@favornoms/database/client';
import { getMyDriver, type DriverWithApproval } from '@favornoms/database/queries';

interface DriverSessionContextValue {
  driver: DriverWithApproval;
  loading: boolean;
  refresh: () => Promise<void>;
}

const DriverSessionContext = React.createContext<DriverSessionContextValue | null>(null);

/**
 * Provides the signed-in driver record + auth gate. If no session, redirects to /login.
 * Children only mount when a valid driver is loaded.
 */
export function DriverSessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [driver, setDriver] = React.useState<DriverWithApproval | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      router.replace('/login');
      return;
    }
    const d = await getMyDriver(supabase);
    setDriver(d);
    setLoading(false);
  }, [router]);

  React.useEffect(() => {
    void load();
    const supabase = getBrowserClient();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        setDriver(null);
        router.replace('/login');
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        void load();
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [load, router]);

  if (loading) {
    return (
      <div className="grid min-h-dynamic-screen place-items-center bg-background">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!driver) {
    // Edge case: signed in but no drivers row. handle_new_user trigger should
    // have created one; if not, sign out and force re-onboarding.
    void getBrowserClient().auth.signOut();
    return null;
  }

  return (
    <DriverSessionContext.Provider value={{ driver, loading, refresh: load }}>
      {children}
    </DriverSessionContext.Provider>
  );
}

export function useDriverSession() {
  const ctx = React.useContext(DriverSessionContext);
  if (!ctx) throw new Error('useDriverSession must be used inside <DriverSessionProvider>');
  return ctx;
}
