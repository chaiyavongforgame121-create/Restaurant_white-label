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
// An address that already has an account is not an edge case here: every app shares one
// Supabase project, so a former staff member or a storefront diner arrives with a login of
// their own, and signUp cannot make a second one. Sending them off to sign in stranded them
// on the page meant to start their trial, so signup tries the password they typed: if it is
// theirs they continue to /onboarding like anyone else, and if not, the form offers Google or
// an emailed link to set a new password (existing-account.ts).
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
import {
  existingAccountOutcome,
  mailRetryAfter,
  passwordLinkRefusalKey,
  signUpFoundAccount,
} from './existing-account';

/** `auth.signup.trial.*` keys. */
const TRIAL_BULLETS = ['everyFeature', 'oneBranch', 'noCard'] as const;

/** Matches /auth/update-password. Kept in step by hand rather than shared: this is a UX
 *  hint, and the real floor is the project's own password policy. */
const MIN_LENGTH = 8;

/** GoTrue's own floor between two sends to the same address. */
const RESEND_COOLDOWN_SECONDS = 60;

/** Seconds left on a mail button, ticking down once a second. */
function useCountdown(): [number, React.Dispatch<React.SetStateAction<number>>] {
  const [left, setLeft] = React.useState(0);
  React.useEffect(() => {
    if (left <= 0) return;
    const id = window.setTimeout(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [left]);
  return [left, setLeft];
}

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
  const [cooldown, setCooldown] = useCountdown();
  // The address already has an account and the password typed is not its password.
  const [otherPassword, setOtherPassword] = React.useState(false);
  // The address that was tried, as typed when the form went: the panel names it and the link goes
  // to it, even if the field was edited while the sign-in was on its way.
  const [triedEmail, setTriedEmail] = React.useState('');
  const [sendingLink, setSendingLink] = React.useState(false);
  // A link went to this address; like linkCooldown it belongs to the address, so only a new
  // address clears it, not a password change or another submit.
  const [linkSent, setLinkSent] = React.useState(false);
  const [linkError, setLinkError] = React.useState<string | null>(null);
  const [linkCooldown, setLinkCooldown] = useCountdown();

  // Both a successful submit and the SIGNED_IN listener below land here, and auth-js runs the
  // listener before signUp / signInWithPassword resolve, so whichever comes second is dropped
  // rather than queueing a second navigation.
  const leaving = React.useRef(false);
  const continueToOnboarding = React.useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    router.replace('/onboarding');
    router.refresh();
  }, [router]);

  const confirmRedirect = () =>
    typeof window !== 'undefined'
      ? `${window.location.origin}/auth/callback?next=${encodeURIComponent('/onboarding')}`
      : undefined;

  // Advice about the address and password just tried; stale the moment either field changes.
  const clearAdvice = () => {
    setError(null);
    setOtherPassword(false);
    setLinkError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAdvice();
    if (password.length < MIN_LENGTH) {
      setError(t('signup.errors.passwordTooShort', { min: MIN_LENGTH }));
      return;
    }
    setSubmitting(true);
    const supabase = getBrowserClient();
    const address = email.trim();
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: address,
      password,
      options: {
        // Only used when the project requires email confirmation. Through /auth/callback,
        // since the confirmation arrives as a `?code=` that has to be exchanged.
        emailRedirectTo: confirmRedirect(),
      },
    });
    // The address already has an account: GoTrue answers with a fake, identity-less user (or,
    // with confirmation off, user_already_exists), and no confirmation mail is ever sent to it.
    // Reading that as success left them waiting for a mail; reading it as "go and sign in" left
    // a former staff member or storefront diner with no way to start the trial they came for.
    // If the password they typed is theirs, signing in with it is all it takes.
    if (signUpFoundAccount({ user: data.user, error: signUpError })) {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: address, password });
      if (!signInError) {
        // The spinner stays up until /onboarding replaces this page.
        continueToOnboarding();
        return;
      }
      setSubmitting(false);
      if (existingAccountOutcome(signInError) === 'other_password') {
        setTriedEmail(address);
        setOtherPassword(true);
        return;
      }
      // Not confirmed yet, rate limited, or the server failed: the shared wording covers each.
      console.error('[signup] signing in to the existing account failed:', signInError.message);
      setError(t(authErrorKey(signInError)));
      return;
    }
    if (signUpError) {
      setSubmitting(false);
      console.error('[signup] signUp failed:', signUpError.message);
      setError(t(authErrorKey(signUpError)));
      return;
    }
    if (data.session) {
      continueToOnboarding();
      return;
    }
    setSubmitting(false);
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
    const wait = mailRetryAfter(resendErr, RESEND_COOLDOWN_SECONDS);
    if (wait !== null) {
      setCooldown(wait);
      setResendError(t('signup.errors.mailLimit'));
      return;
    }
    console.error('[signup] resend failed:', resendErr.message);
    setResendError(t(authErrorKey(resendErr)));
  };

  // For an existing account whose password they do not know, or that never had one.
  const sendPasswordLink = async () => {
    setSendingLink(true);
    setLinkError(null);
    const { error: linkErr } = await getBrowserClient().auth.resetPasswordForEmail(triedEmail, {
      // The same redirect as /forgot-password: the link opens /auth/update-password, which goes on
      // to '/' once the password is saved, and '/' sends an account with no restaurant, staff
      // place or invitation to /onboarding.
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/auth/update-password')}`,
    });
    setSendingLink(false);
    if (!linkErr) {
      setLinkSent(true);
      setLinkCooldown(RESEND_COOLDOWN_SECONDS);
      return;
    }
    const wait = mailRetryAfter(linkErr, RESEND_COOLDOWN_SECONDS);
    if (wait !== null) {
      setLinkCooldown(wait);
      setLinkError(t(passwordLinkRefusalKey(linkSent)));
      return;
    }
    console.error('[signup] resetPasswordForEmail failed:', linkErr.message);
    setLinkError(t(authErrorKey(linkErr)));
  };

  React.useEffect(() => {
    const supabase = getBrowserClient();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') continueToOnboarding();
    });
    return () => sub.subscription.unsubscribe();
  }, [continueToOnboarding]);

  const signInLink = (c: React.ReactNode) => (
    <Link href="/login" className="font-semibold text-primary hover:underline">
      {c}
    </Link>
  );

  const strong = (c: React.ReactNode) => <strong>{c}</strong>;

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
                {t.rich('signup.confirmBody', { email, strong })}
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
                {t.rich('signup.googleInstead', { email, strong })}
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
                      onChange={(e) => {
                        setEmail(e.target.value);
                        clearAdvice();
                        // GoTrue's wait between two mails is per address; a new one starts clear.
                        setLinkSent(false);
                        setLinkCooldown(0);
                      }}
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
                      onChange={(e) => {
                        setPassword(e.target.value);
                        clearAdvice();
                      }}
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
                {otherPassword && (
                  <div className="space-y-3 rounded-xl bg-warning/10 p-3 text-sm">
                    <p role="alert">
                      {t.rich('signup.existingAccount.body', { email: triedEmail, strong })}
                    </p>
                    {/* Google needs no button of its own here: it is the first thing on the card. */}
                    <Button
                      type="button"
                      variant="outline"
                      fullWidth
                      onClick={sendPasswordLink}
                      loading={sendingLink}
                      disabled={linkCooldown > 0}
                      leftIcon={<Mail className="h-4 w-4 shrink-0" />}
                      // The label runs long in Spanish and Vietnamese; let it wrap, not clip.
                      className="h-auto whitespace-normal py-2.5 text-center"
                    >
                      {/* A disabled button always says how long; "again" only once a link went out. */}
                      {linkCooldown > 0
                        ? linkSent
                          ? t('signup.resendIn', { seconds: linkCooldown })
                          : t('signup.existingAccount.sendLinkIn', { seconds: linkCooldown })
                        : linkSent
                          ? t('signup.resend')
                          : t('signup.existingAccount.sendLink')}
                    </Button>
                    {linkSent && (
                      <p role="status" className="text-success">
                        {t.rich('signup.existingAccount.linkSent', { email: triedEmail, strong })}
                      </p>
                    )}
                    {linkError && (
                      <p role="alert" className="text-danger">
                        {linkError}
                      </p>
                    )}
                  </div>
                )}
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
