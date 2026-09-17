'use client';

// Merchant sign-in.
//
// This was magic-link only, which broke in three ways at once and was the wrong shape for
// the job regardless:
//   1. `emailRedirectTo` pointed at this app's own origin, which is not in Supabase's
//      redirect allow-list, so GoTrue discarded it and bounced to the Site URL (the
//      customer marketing site) instead.
//   2. Nothing ever spent the returned `?code=` — apps/admin had no /auth/callback.
//   3. Single-use links get consumed by mail-client link scanners before a human clicks,
//      surfacing as `otp_expired`.
//
// Password is now the primary door: signInWithPassword returns a session directly, with no
// email round-trip and no redirect allow-list involved, which is also what a cashier or line
// cook signing into a shared tablet at the start of every shift actually needs. The magic
// link survives as a secondary option for anyone who would rather not keep a password.

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { Building2, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { currentOrigin, safeNext } from '@favornoms/shared';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { authErrorKey } from '../../auth/_lib/auth-error';

/** GoTrue's own error codes plus the ones /auth/callback raises, as `auth.login.errors.*` keys in
 *  the words a restaurant manager can act on. An unmapped code still renders — as itself, inside
 *  a translated sentence — rather than vanishing. */
const ERROR_KEYS: Record<string, string> = {
  otp_expired: 'login.errors.otpExpired',
  access_denied: 'login.errors.accessDenied',
  exchange_failed: 'login.errors.exchangeFailed',
  missing_code: 'login.errors.missingCode',
  link: 'login.errors.link',
};

export function LoginView({ next, error: initialError }: { next: string; error: string | null }) {
  const router = useRouter();
  const t = useTranslations('auth');
  // Shared open-redirect guard — see @favornoms/shared. `next` feeds router.replace() on
  // SIGNED_IN and the magic-link emailRedirectTo below, so a hostile value would hand a
  // freshly-minted *staff* session to an attacker's page. Falls back to the dashboard root.
  // During prerender currentOrigin() is '' and this resolves to '/', but target is never
  // rendered, so hydration can't mismatch.
  const target = safeNext(next, currentOrigin()) ?? '/';
  const [mode, setMode] = React.useState<'password' | 'link'>('password');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(() => {
    if (!initialError) return null;
    const key = ERROR_KEYS[initialError];
    return key ? t(key) : t('login.errors.unknown', { code: initialError });
  });

  const signInWithPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const supabase = getBrowserClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (authError) {
      // GoTrue says "Invalid login credentials" both for a wrong password and for an account
      // that has never had one set — a real case here, since every account created before
      // this screen existed was magic-link only. Name that second possibility.
      if (authError.message === 'Invalid login credentials') {
        setError(t('login.errors.wrongPassword'));
      } else {
        console.error('[login] signInWithPassword failed:', authError.message);
        setError(t(authErrorKey(authError)));
      }
      return;
    }
    router.replace(target);
    router.refresh();
  };

  const sendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const supabase = getBrowserClient();
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        // Must land on /auth/callback, not on `target` directly: the link comes back as
        // ?code= and only that route can trade it for a session.
        emailRedirectTo:
          typeof window !== 'undefined'
            ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(target)}`
            : undefined,
        shouldCreateUser: false,
      },
    });
    setSubmitting(false);
    if (otpError) {
      console.error('[login] signInWithOtp failed:', otpError.message);
      setError(t(authErrorKey(otpError)));
      return;
    }
    setSent(true);
  };

  React.useEffect(() => {
    const supabase = getBrowserClient();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        router.replace(target);
        router.refresh();
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [router, target]);

  return (
    <div className="relative grid min-h-dynamic-screen place-items-center bg-background px-4 pb-10 pt-16">
      <div className="absolute right-4 top-4">
        <LocaleSwitcher />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
          <Building2 className="h-8 w-8" />
        </div>
        {/* Product name, the same in every language. */}
        <h1 className="mt-5 text-center font-display text-3xl font-bold">Favornoms Merchant</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">{t('login.subtitle')}</p>

        <Card className="mt-6 p-5">
          {sent ? (
            <div className="text-center">
              <ShieldCheck className="mx-auto h-10 w-10 text-success" />
              <p className="mt-3 font-display text-lg font-semibold">{t('login.checkInbox')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t.rich('login.linkSent', { email, strong: (c) => <strong>{c}</strong> })}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-4"
                onClick={() => {
                  setSent(false);
                  setMode('password');
                }}
              >
                {t('login.usePassword')}
              </Button>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={mode === 'password' ? signInWithPassword : sendLink}
            >
              <label className="block">
                <span className="mb-2 block text-sm font-medium">{t('fields.email')}</span>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    placeholder="owner@example.com"
                    className="focus-ring w-full rounded-xl border border-border bg-background py-3 pl-11 pr-4 text-base"
                  />
                </div>
              </label>

              {mode === 'password' && (
                <label className="block">
                  <span className="mb-2 block text-sm font-medium">{t('fields.password')}</span>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      placeholder={t('fields.passwordPlaceholder')}
                      className="focus-ring w-full rounded-xl border border-border bg-background py-3 pl-11 pr-4 text-base"
                    />
                  </div>
                </label>
              )}

              {error && <p className="text-sm text-danger">{error}</p>}

              <Button type="submit" variant="gradient" size="xl" fullWidth loading={submitting}>
                {mode === 'password' ? t('login.signIn') : t('login.sendLink')}
              </Button>

              <div className="flex items-center justify-between gap-3 text-sm">
                <button
                  type="button"
                  className="text-left font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setMode(mode === 'password' ? 'link' : 'password');
                    setError(null);
                  }}
                >
                  {mode === 'password' ? t('login.emailLink') : t('login.usePassword')}
                </button>
                <Link
                  href="/forgot-password"
                  className="text-right font-medium text-muted-foreground hover:text-foreground"
                >
                  {t('login.forgotPassword')}
                </Link>
              </div>
            </form>
          )}
        </Card>

        {/* shouldCreateUser stays false above, so an unknown email fails here
            rather than silently creating an empty account. /signup is the
            deliberate way in. */}
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t.rich('login.newHere', {
            link: (c) => (
              <Link href="/signup" className="font-semibold text-primary hover:underline">
                {c}
              </Link>
            ),
          })}
        </p>
      </motion.div>
    </div>
  );
}
