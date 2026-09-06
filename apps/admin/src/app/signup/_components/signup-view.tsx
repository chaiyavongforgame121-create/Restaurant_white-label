'use client';

// The only door into the product for a brand-new owner.
//
// Was magic-link only, which meant a new owner's very first act was a round-trip through
// their inbox — and left the account with no password, so they could never use the password
// sign-in screen afterwards. Now the trial starts with email + password in one step;
// signUp mints a session immediately when the project does not require email confirmation,
// and falls back to the confirm-your-inbox message when it does.
//
// That fallback used to be a terminal card: one sentence, no controls. Email confirmation is
// ON for this project and the mailer can refuse a send (over its hourly cap) while signUp
// still reports success, so an owner whose mail never arrived had no button to press and no
// way to reach /onboarding — the first hop of the whole product, with a support ticket as
// the only exit. The card now resends, says out loud when the mail server refused, and
// offers the two other ways forward (sign in, or correct the address).
//
// /login deliberately passes `shouldCreateUser: false` so that a typo in an email address
// cannot mint an empty account and silently swallow the sign-in. This route is the
// deliberate way in. create_restaurant_with_branch starts the trial from /onboarding.

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Check, KeyRound, Mail, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';

const TRIAL_BULLETS = [
  'Every feature unlocked — delivery, AI Suite, the lot',
  'One branch, no menu-item or order limits',
  'No credit card, no charge if you walk away',
];

/** Matches /auth/update-password. Kept in step by hand rather than shared: this is a UX
 *  hint, and the real floor is the project's own password policy. */
const MIN_LENGTH = 8;

/** GoTrue's own floor between two sends to the same address. */
const RESEND_COOLDOWN_SECONDS = 60;

export function SignupView() {
  const router = useRouter();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [resending, setResending] = React.useState(false);
  const [resendNotice, setResendNotice] = React.useState<string | null>(null);
  const [resendError, setResendError] = React.useState<string | null>(null);
  const [cooldown, setCooldown] = React.useState(0);

  const confirmRedirect = () =>
    typeof window !== 'undefined'
      ? `${window.location.origin}/auth/callback?next=${encodeURIComponent('/onboarding')}`
      : undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters for your password.`);
      return;
    }
    setSubmitting(true);
    const supabase = getBrowserClient();
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        // Only used when the project requires email confirmation. Through /auth/callback,
        // since the confirmation arrives as a `?code=` that has to be exchanged.
        emailRedirectTo: confirmRedirect(),
      },
    });
    setSubmitting(false);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }
    if (data.session) {
      router.replace('/onboarding');
      router.refresh();
      return;
    }
    // GoTrue deliberately answers an address that already has an account with a fake user
    // carrying no identities, so signup cannot be used to probe who is registered. Left
    // unread it looked like success, and an owner who had simply forgotten they had signed
    // up before sat waiting for a confirmation mail that is never sent to a confirmed
    // address. Sending them to sign in is the only move that actually gets them in.
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
      setError('That email already has an account. Sign in instead, or reset the password.');
      return;
    }
    setResendNotice(null);
    setResendError(null);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    setSent(true);
  };

  const resend = async () => {
    setResending(true);
    setResendNotice(null);
    setResendError(null);
    const supabase = getBrowserClient();
    const { error: resendErr } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim(),
      options: { emailRedirectTo: confirmRedirect() },
    });
    setResending(false);
    if (!resendErr) {
      setResendNotice(`Sent again to ${email.trim()}.`);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      return;
    }
    // The mailer refusing to send is the single likeliest reason the first link never
    // arrived, and it is invisible on the signup call itself — GoTrue accepts the signup
    // whether or not the mail goes out. Here it is a real error, so say so plainly rather
    // than letting a second silent no-op look like a second successful send.
    const tooSoon =
      resendErr.status === 429 ||
      resendErr.code === 'over_email_send_rate_limit' ||
      /security purposes|rate limit/i.test(resendErr.message);
    if (tooSoon) {
      const wait = Number(/(\d+)\s*second/i.exec(resendErr.message)?.[1] ?? RESEND_COOLDOWN_SECONDS);
      setCooldown(Number.isFinite(wait) && wait > 0 ? wait : RESEND_COOLDOWN_SECONDS);
      setResendError(
        'Our mail server is over its sending limit right now. The first link may still ' +
          'arrive — otherwise try again in a moment.',
      );
      return;
    }
    setResendError(resendErr.message);
  };

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  React.useEffect(() => {
    const supabase = getBrowserClient();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        router.replace('/onboarding');
        router.refresh();
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [router]);

  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
          <Sparkles className="h-8 w-8" />
        </div>
        <h1 className="mt-5 text-center font-display text-3xl font-bold">Start your 14-day trial</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          Full access to everything. No card required.
        </p>

        <Card className="mt-6 p-5">
          {sent ? (
            <div className="text-center">
              <ShieldCheck className="mx-auto h-10 w-10 text-success" />
              <p className="mt-3 font-display text-lg font-semibold">Confirm your email</p>
              <p className="mt-1 text-sm text-muted-foreground">
                We sent a link to <strong>{email}</strong>. Open it to finish setting up your
                restaurant — then sign in with the password you just chose.
              </p>

              {resendNotice && (
                <p role="status" className="mt-3 text-sm text-success">
                  {resendNotice}
                </p>
              )}
              {resendError && (
                <p
                  role="alert"
                  className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-left text-sm text-danger"
                >
                  {resendError}
                </p>
              )}

              <Button
                type="button"
                variant="outline"
                fullWidth
                className="mt-4"
                onClick={resend}
                loading={resending}
                disabled={cooldown > 0}
                leftIcon={<RefreshCw className="h-4 w-4" />}
              >
                {cooldown > 0 ? `Send it again in ${cooldown}s` : 'Send it again'}
              </Button>

              <p className="mt-4 text-sm text-muted-foreground">
                Already opened it?{' '}
                <Link href="/login" className="font-semibold text-primary hover:underline">
                  Sign in
                </Link>
              </p>
              <button
                type="button"
                onClick={() => {
                  setSent(false);
                  setResendNotice(null);
                  setResendError(null);
                }}
                className="mt-1 text-sm text-muted-foreground underline hover:text-foreground"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <>
              <ul className="mb-5 space-y-2">
                {TRIAL_BULLETS.map((b) => (
                  <li key={b} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    {b}
                  </li>
                ))}
              </ul>
              <form className="space-y-4" onSubmit={submit}>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium">Work email</span>
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
                <label className="block">
                  <span className="mb-2 block text-sm font-medium">Password</span>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={MIN_LENGTH}
                      autoComplete="new-password"
                      className="focus-ring w-full rounded-xl border border-border bg-background py-3 pl-11 pr-4 text-base"
                    />
                  </div>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    At least {MIN_LENGTH} characters.
                  </span>
                </label>
                {error && (
                  <p role="alert" className="text-sm text-danger">
                    {error}
                  </p>
                )}
                <Button type="submit" variant="gradient" size="xl" fullWidth loading={submitting}>
                  Create my account
                </Button>
              </form>
            </>
          )}
        </Card>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </motion.div>
    </div>
  );
}
