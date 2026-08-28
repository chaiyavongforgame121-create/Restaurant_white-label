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
import { Building2, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { currentOrigin, safeNext } from '@favornoms/shared';

/** GoTrue's own error codes plus the ones /auth/callback raises, in the words a restaurant
 *  manager can act on. An unmapped code still renders — as itself — rather than vanishing. */
const ERROR_COPY: Record<string, string> = {
  otp_expired:
    'That sign-in link has expired or was already used. Links work only once, and some mail apps open them automatically. Sign in with your password below.',
  access_denied:
    'That sign-in link is no longer valid. Sign in with your password below, or request a new link.',
  exchange_failed:
    'That link was opened in a different browser from the one that requested it. Sign in with your password below.',
  missing_code: 'That link was incomplete. Sign in with your password below.',
  link: 'That access link is no longer valid.',
};

export function LoginView({ next, error: initialError }: { next: string; error: string | null }) {
  const router = useRouter();
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
  const [error, setError] = React.useState<string | null>(
    initialError ? (ERROR_COPY[initialError] ?? `Sign-in failed (${initialError}).`) : null,
  );

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
      setError(
        authError.message === 'Invalid login credentials'
          ? 'Wrong email or password. If you have never set a password, use "Forgot password?" to create one.'
          : authError.message,
      );
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
      setError(otpError.message);
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
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
          <Building2 className="h-8 w-8" />
        </div>
        <h1 className="mt-5 text-center font-display text-3xl font-bold">Favornoms Merchant</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          Sign in to manage your restaurant
        </p>

        <Card className="mt-6 p-5">
          {sent ? (
            <div className="text-center">
              <ShieldCheck className="mx-auto h-10 w-10 text-success" />
              <p className="mt-3 font-display text-lg font-semibold">Check your inbox</p>
              <p className="mt-1 text-sm text-muted-foreground">
                We sent a sign-in link to <strong>{email}</strong>. It works once, and only in
                this browser.
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
                Use a password instead
              </Button>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={mode === 'password' ? signInWithPassword : sendLink}
            >
              <label className="block">
                <span className="mb-2 block text-sm font-medium">Email</span>
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
                  <span className="mb-2 block text-sm font-medium">Password</span>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      placeholder="Your password"
                      className="focus-ring w-full rounded-xl border border-border bg-background py-3 pl-11 pr-4 text-base"
                    />
                  </div>
                </label>
              )}

              {error && <p className="text-sm text-danger">{error}</p>}

              <Button type="submit" variant="gradient" size="xl" fullWidth loading={submitting}>
                {mode === 'password' ? 'Sign in' : 'Send sign-in link'}
              </Button>

              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  className="font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setMode(mode === 'password' ? 'link' : 'password');
                    setError(null);
                  }}
                >
                  {mode === 'password' ? 'Email me a link instead' : 'Use a password instead'}
                </button>
                <Link
                  href="/forgot-password"
                  className="font-medium text-muted-foreground hover:text-foreground"
                >
                  Forgot password?
                </Link>
              </div>
            </form>
          )}
        </Card>

        {/* shouldCreateUser stays false above, so an unknown email fails here
            rather than silently creating an empty account. /signup is the
            deliberate way in. */}
        <p className="mt-4 text-center text-sm text-muted-foreground">
          New to Favornoms?{' '}
          <Link href="/signup" className="font-semibold text-primary hover:underline">
            Start a free 14-day trial
          </Link>
        </p>
      </motion.div>
    </div>
  );
}
