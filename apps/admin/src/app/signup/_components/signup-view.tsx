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
// That mailer is Supabase's built-in one: about two emails an hour, delivered only to the
// project's team members, so for a real owner the confirmation mail effectively never comes.
// Continue with Google therefore sits above the form and again on the confirm card. Google has
// already verified the address, so the owner lands on /onboarding with no email at all, and
// /onboarding starts the trial exactly as it does for a password account.
//
// /login deliberately passes `shouldCreateUser: false` so that a typo in an email address
// cannot mint an empty account and silently swallow the sign-in. This route is the
// deliberate way in. create_restaurant_with_branch starts the trial from /onboarding.

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { Check, KeyRound, Mail, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { AuthDivider, ContinueWithGoogle } from '@/components/auth/continue-with-google';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { authErrorKey } from '../../auth/_lib/auth-error';

/** `auth.signup.trial.*` keys. */
const TRIAL_BULLETS = ['everyFeature', 'oneBranch', 'noCard'] as const;

/** Matches /auth/update-password. Kept in step by hand rather than shared: this is a UX
 *  hint, and the real floor is the project's own password policy. */
const MIN_LENGTH = 8;

/** GoTrue's own floor between two sends to the same address. */
const RESEND_COOLDOWN_SECONDS = 60;

export function SignupView() {
  const router = useRouter();
  const t = useTranslations('auth');
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
      setError(t('signup.errors.passwordTooShort', { min: MIN_LENGTH }));
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
      console.error('[signup] signUp failed:', signUpError.message);
      setError(t(authErrorKey(signUpError)));
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
      setError(t('errors.accountExists'));
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
      setResendNotice(t('signup.sentAgain', { email: email.trim() }));
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
      setResendError(t('signup.errors.mailLimit'));
      return;
    }
    console.error('[signup] resend failed:', resendErr.message);
    setResendError(t(authErrorKey(resendErr)));
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

  const signInLink = (c: React.ReactNode) => (
    <Link href="/login" className="font-semibold text-primary hover:underline">
      {c}
    </Link>
  );

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
          <Sparkles className="h-8 w-8" />
        </div>
        <h1 className="mt-5 text-center font-display text-3xl font-bold">{t('signup.title')}</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">{t('signup.subtitle')}</p>

        <Card className="mt-6 p-5">
          {sent ? (
            <div className="text-center">
              <ShieldCheck className="mx-auto h-10 w-10 text-success" />
              <p className="mt-3 font-display text-lg font-semibold">{t('signup.confirmTitle')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t.rich('signup.confirmBody', { email, strong: (c) => <strong>{c}</strong> })}
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
                {cooldown > 0 ? t('signup.resendIn', { seconds: cooldown }) : t('signup.resend')}
              </Button>

              {/* The resend above goes through the same capped mailer, so it is not a real way
                  out. Google with the address they typed is: GoTrue treats a Google-verified
                  email as confirmed. login_hint pre-selects that account in Google's chooser. */}
              <AuthDivider />
              <p className="text-sm text-muted-foreground">
                {t.rich('signup.googleInstead', { email, strong: (c) => <strong>{c}</strong> })}
              </p>
              <ContinueWithGoogle next="/onboarding" loginHint={email.trim()} className="mt-3" />

              <p className="mt-4 text-sm text-muted-foreground">
                {t.rich('signup.alreadyOpened', { link: signInLink })}
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
                {t('signup.differentEmail')}
              </button>
            </div>
          ) : (
            <>
              <ul className="mb-5 space-y-2">
                {TRIAL_BULLETS.map((b) => (
                  <li key={b} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    {t(`signup.trial.${b}`)}
                  </li>
                ))}
              </ul>
              <ContinueWithGoogle next="/onboarding" />
              <p className="mt-2 text-center text-xs text-muted-foreground">
                {t('signup.googleFastest')}
              </p>
              <AuthDivider />
              <form className="space-y-4" onSubmit={submit}>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium">{t('fields.workEmail')}</span>
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
                  <span className="mb-2 block text-sm font-medium">{t('fields.password')}</span>
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
                    {t('fields.minLength', { min: MIN_LENGTH })}
                  </span>
                </label>
                {error && (
                  <p role="alert" className="text-sm text-danger">
                    {error}
                  </p>
                )}
                <Button type="submit" variant="gradient" size="xl" fullWidth loading={submitting}>
                  {t('signup.submit')}
                </Button>
              </form>
            </>
          )}
        </Card>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t.rich('signup.haveAccount', { link: signInLink })}
        </p>
      </motion.div>
    </div>
  );
}
