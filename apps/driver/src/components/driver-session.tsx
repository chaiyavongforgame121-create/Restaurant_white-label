'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { getBrowserClient } from '@favornoms/database/client';
import { getMyDriver, type DriverWithApproval } from '@favornoms/database/queries';

interface DriverSessionContextValue {
  driver: DriverWithApproval;
  loading: boolean;
  refresh: () => Promise<void>;
}

const DriverSessionContext = React.createContext<DriverSessionContextValue | null>(null);

/**
 * Why the session check could not reach a conclusion. 'no_profile' is a real answer from the
 * server; the other two mean we never got one, which is not the same thing and must never be
 * treated as a sign-out.
 */
type SessionProblem = 'offline' | 'unreachable' | 'no_profile';

/**
 * A round trip that never completed is not a sign-out. supabase-js hands back an
 * AuthRetryableFetchError (HTTP status 0) when the request never reached the server, which is
 * exactly what a tunnel, a basement car park or a dead cell looks like. Only an answered 401
 * means the session is actually gone.
 */
function isRetryableAuthFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; status?: number; message?: string };
  if (e.name === 'AuthRetryableFetchError') return true;
  if (e.status === 0) return true;
  return /fetch|network|timeout|timed out/i.test(e.message ?? '');
}

/**
 * Provides the signed-in driver record + auth gate. If there is genuinely no session, redirects
 * to /login. Children only mount when a valid driver is loaded.
 *
 * The installed app has no address bar and no back button, so this component decides whether a
 * rider can use their phone at all. Two of its old answers were dead ends:
 *
 *  - `getUser()` failing offline returned `{ user: null }`, which sent the rider to /login —
 *    a screen the worker did not precache, behind a fallback that was a redirect. Riding into
 *    a tunnel and cold-opening the app produced Chrome's error page inside a chromeless
 *    window. A failed request now keeps the locally stored session and says so.
 *  - A single failed `drivers` read looked identical to "this user has no rider row", so the
 *    provider called auth.signOut() *during render* (double-invoked under StrictMode) and
 *    returned null — a blank white screen, recoverable only by force-quitting and signing in
 *    again. The read now throws when it fails, nothing signs out except a tap, and every
 *    failure renders something with a way forward.
 */
export function DriverSessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const t = useTranslations('shell.session');
  const tCommon = useTranslations('common');
  const [driver, setDriver] = React.useState<DriverWithApproval | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [problem, setProblem] = React.useState<SessionProblem | null>(null);

  const load = React.useCallback(async () => {
    const supabase = getBrowserClient();
    // A live /auth/v1/user round trip, not a local read.
    const { data: userData, error: userError } = await supabase.auth.getUser();
    const userId = userData.user?.id ?? null;

    if (!userId) {
      // getSession() reads the stored token without touching the network. Holding one and
      // failing to reach the server means "no signal", never "signed out".
      const { data: sessionData } = await supabase.auth.getSession();
      const unreachable = !navigator.onLine || isRetryableAuthFailure(userError);
      if (sessionData.session && unreachable) {
        setProblem(navigator.onLine ? 'unreachable' : 'offline');
        setLoading(false);
        return;
      }
      router.replace('/login');
      return;
    }

    try {
      const d = await getMyDriver(supabase, userId);
      setDriver(d);
      setProblem(d ? null : 'no_profile');
    } catch {
      // Keep whatever we already have on screen — a rider mid-delivery loses nothing to one
      // failed read — and let the retry below settle it.
      setProblem(navigator.onLine ? 'unreachable' : 'offline');
    }
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
    // Coming back into signal should not cost the rider a tap.
    const onOnline = () => void load();
    window.addEventListener('online', onOnline);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener('online', onOnline);
    };
  }, [load, router]);

  const retry = () => {
    setLoading(true);
    void load();
  };

  const signOut = () => {
    void getBrowserClient().auth.signOut();
    router.replace('/login');
  };

  if (loading && !driver) {
    return (
      <div className="min-h-dynamic-screen bg-background grid place-items-center">
        <div className="text-muted-foreground text-sm">{tCommon('loading')}</div>
      </div>
    );
  }

  if (!driver) {
    const noProfile = problem === 'no_profile';
    return (
      <div className="min-h-dynamic-screen bg-background grid place-items-center px-6 text-center">
        <div>
          <p className="font-display text-lg font-semibold">
            {noProfile ? t('noProfileTitle') : t('unreachableTitle')}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {noProfile
              ? t('noProfileBody')
              : problem === 'offline'
                ? t('offlineBody')
                : t('unreachableBody')}
          </p>
          <button
            onClick={retry}
            className="focus-ring bg-primary text-primary-foreground mt-5 inline-flex h-12 items-center rounded-2xl px-5 text-sm font-semibold"
          >
            {tCommon('tryAgain')}
          </button>
          <button
            onClick={signOut}
            className="focus-ring text-muted-foreground mt-3 block h-auto min-h-0 w-full text-xs underline"
          >
            {tCommon('signOut')}
          </button>
        </div>
      </div>
    );
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
