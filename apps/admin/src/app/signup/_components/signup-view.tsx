'use client';

// The only door into the product for a brand-new owner.
//
// Was magic-link only, which meant a new owner's very first act was a round-trip through
// their inbox — and left the account with no password, so they could never use the password
// sign-in screen afterwards. Now the trial starts with email + password in one step;
// signUp mints a session immediately when the project does not require email confirmation,
// and falls back to the confirm-your-inbox message when it does.
//
// /login deliberately passes `shouldCreateUser: false` so that a typo in an email address
// cannot mint an empty account and silently swallow the sign-in. This route is the
// deliberate way in. create_restaurant_with_branch starts the trial from /onboarding.

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Check, KeyRound, Mail, ShieldCheck, Sparkles } from 'lucide-react';
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

export function SignupView() {
  const router = useRouter();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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
        emailRedirectTo:
          typeof window !== 'undefined'
            ? `${window.location.origin}/auth/callback?next=${encodeURIComponent('/onboarding')}`
            : undefined,
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
    setSent(true);
  };

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
                {error && <p className="text-sm text-danger">{error}</p>}
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
