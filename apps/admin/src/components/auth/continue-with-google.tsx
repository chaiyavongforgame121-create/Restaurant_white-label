'use client';

// "Continue with Google" for the back office: sign-up (free trial), sign-in and staff invitations.
//
// Google has already verified the address, so nobody waits for a confirmation email, and nothing
// is sent through Supabase's mailer (about two emails an hour, team members only). The same Google
// provider already signs diners in on the storefront.
//
// The return trip goes through /auth/callback, which trades the PKCE code for the session cookie.
// redirectTo is built from THIS page's origin: the code verifier is a cookie on this host, so a
// callback on any other host cannot finish the sign-in. `via=google` lets the callback word a
// failure as a Google one instead of as a stale email link.

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { getBrowserClient } from '@favornoms/database/client';
import { safeNext } from '@favornoms/shared';
import { GoogleMark, cn } from '@favornoms/ui';

/** LINE, Facebook and Instagram open links in their own browser, where Google refuses to sign anyone in. */
export function isInAppBrowser(userAgent: string): boolean {
  return /\bLine\/|FBAN|FBAV|Instagram/i.test(userAgent);
}

export function ContinueWithGoogle({
  next,
  loginHint,
  className,
}: {
  /** Where to land after signing in; checked with safeNext, so an outside URL falls back to '/'. */
  next: string;
  /** Pre-selects this account in Google's chooser (not enforced; the invitation check is). */
  loginHint?: string | null;
  className?: string;
}) {
  const t = useTranslations('auth');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [inApp, setInApp] = React.useState(false);

  // Read after mount: the server has no user agent to render the same thing with.
  React.useEffect(() => {
    setInApp(isInAppBrowser(window.navigator.userAgent));
  }, []);

  const start = async () => {
    setError(null);
    setLoading(true);
    const origin = window.location.origin;
    const target = safeNext(next, origin) ?? '/';
    const { error: oauthError } = await getBrowserClient().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(target)}&via=google`,
        // Always offer the account chooser: on a shared tablet Google would otherwise reuse whoever
        // signed in last, which is exactly the wrong person for an invitation.
        queryParams: loginHint
          ? { prompt: 'select_account', login_hint: loginHint }
          : { prompt: 'select_account' },
      },
    });
    // On success the browser is already on its way to Google; leave the spinner up.
    if (oauthError) {
      setLoading(false);
      console.error('[auth] Google sign-in could not start', oauthError);
      setError(t('errors.googleUnavailable'));
    }
  };

  return (
    <div className={cn('space-y-2', className)}>
      <button
        type="button"
        onClick={() => void start()}
        disabled={loading}
        className="focus-ring flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-border bg-card text-base font-semibold shadow-soft transition-shadow hover:shadow-warm disabled:opacity-60"
      >
        <GoogleMark className="h-5 w-5" />
        {loading ? t('google.opening') : t('google.continue')}
      </button>
      {inApp && <p className="text-xs text-warning">{t('google.inAppBrowser')}</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** The "or" rule between Google and the email form. */
export function AuthDivider({ className }: { className?: string }) {
  const t = useTranslations('auth');
  return (
    <div
      className={cn(
        'my-4 flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground',
        className,
      )}
    >
      <span className="h-px flex-1 bg-border" /> {t('google.or')} <span className="h-px flex-1 bg-border" />
    </div>
  );
}
