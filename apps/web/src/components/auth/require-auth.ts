'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './use-auth';

/**
 * Gate a mutating action (add-to-cart, checkout) behind a signed-in session.
 * Browsing the menu — including after the order-type gate — stays open to
 * everyone; only these actions require login.
 *
 * When signed out we route to the storefront's own sign-in with `next` set to
 * where the diner was, so they land back here after authenticating. That is the
 * same `?next=` contract SignInView reads (safeNext-guarded).
 */
export function useRequireAuth() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // Sign-in lives at `${base}/sign-in`, where base is the /r/{restaurant}/{branch}
  // prefix. Deriving it from the pathname lets any page under a branch gate an
  // action without threading route params through every caller.
  const base = React.useMemo(() => {
    const m = pathname?.match(/^(\/r\/[^/]+\/[^/]+)/);
    return m ? m[1] : '';
  }, [pathname]);

  /**
   * Run `action` when signed in; otherwise redirect to sign-in with `next`
   * pointing back to `nextPath` (defaults to the current path).
   *
   * `onSignedOut` runs just before the redirect. Callers use it to park whatever the
   * diner had configured (see lib/pending-cart) so the trip through sign-in does not
   * throw their selection away.
   */
  const requireAuthThen = React.useCallback(
    (action: () => void, nextPath?: string, onSignedOut?: () => void) => {
      // Session still resolving: treat the tap as a no-op rather than risk
      // bouncing an already-signed-in diner to sign-in on a fast click.
      if (loading) return;
      if (user) {
        action();
        return;
      }
      onSignedOut?.();
      const next = nextPath ?? pathname ?? base;
      router.push(`${base}/sign-in?next=${encodeURIComponent(next)}`);
    },
    [loading, user, router, pathname, base],
  );

  return { user, loading, requireAuthThen };
}
