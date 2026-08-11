'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { ChefHat, Lock, Mail, Phone, ShieldCheck } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';
import { currentOrigin, safeNext } from '@favornoms/shared';

interface Props {
  branchId: string;
  brandName: string;
}

// Phone sign-in is password-based (no SMS, no cost): the `customer-auth` edge function
// takes an explicit mode so login and register are never ambiguous. Google is offered
// alongside it and is the identity we require before loyalty points can be redeemed.
interface AuthResult {
  status:
    | 'login'
    | 'signup'
    | 'invalid_phone'
    | 'invalid_branch'
    | 'weak_password'
    | 'invalid_credentials'
    | 'account_exists'
    | 'error';
  access_token?: string;
  refresh_token?: string;
  error?: string;
}

// Errors handed back by /auth/callback, mapped to something a diner can act on.
const CALLBACK_ERRORS: Record<string, string> = {
  oauth_failed: 'Google sign-in didn’t complete. Please try again.',
  missing_code: 'That sign-in link has expired. Please try again.',
};

export function SignInView({ branchId, brandName }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Shared open-redirect guard — see @favornoms/shared. `next` feeds router.replace() and
  // the OAuth redirectTo, both of which will happily leave the origin. This component
  // prerenders on the server, where there is no window: currentOrigin() returns '' there,
  // which makes safeNext return null rather than throw. `next` is never rendered, so there
  // is no hydration mismatch.
  const rawNext = searchParams.get('next');
  const next = React.useMemo(() => safeNext(rawNext, currentOrigin()), [rawNext]);
  const callbackError = searchParams.get('error');
  const [stage, setStage] = React.useState<'phone' | 'email' | 'email_sent'>('phone');
  // Login vs Register is explicit on the phone tab so the edge function knows which path to
  // take (login must never silently create an account, and register must never take one over).
  const [phoneMode, setPhoneMode] = React.useState<'login' | 'register'>('login');
  const [phone, setPhone] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [emailAddr, setEmailAddr] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(
    callbackError ? (CALLBACK_ERRORS[callbackError] ?? 'We couldn’t finish that sign-in. Please try again.') : null,
  );

  // Normalize US numbers: (555) 234-5678 → +15552345678 for Supabase
  const normalizePhone = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('+')) return `+${trimmed.replace(/\D/g, '')}`;
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    return `+${digits}`;
  };

  const goNext = () => {
    if (next) {
      router.replace(next);
    } else {
      router.back();
    }
    router.refresh();
  };

  const submitPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = getBrowserClient();
    const { data, error: fnErr } = await supabase.functions.invoke('customer-auth', {
      body: {
        mode: phoneMode === 'register' ? 'signup' : 'login',
        phone: normalizePhone(phone),
        password,
        branch_id: branchId,
        // Name is only collected on register; login ignores it.
        full_name: phoneMode === 'register' ? fullName.trim() || undefined : undefined,
      },
    });
    if (fnErr) {
      setLoading(false);
      // The edge function answers 200 for every expected outcome, so a transport error
      // here is either the rate limiter (429) or a genuine fault.
      const status = (fnErr as { context?: { status?: number } }).context?.status;
      setError(
        status === 429
          ? 'Too many attempts. Please wait a few minutes and try again.'
          : 'Something went wrong. Please try again.',
      );
      return;
    }
    const res = data as AuthResult;
    if ((res.status === 'login' || res.status === 'signup') && res.access_token && res.refresh_token) {
      await supabase.auth.setSession({
        access_token: res.access_token,
        refresh_token: res.refresh_token,
      });
      goNext();
      return;
    }
    setLoading(false);
    switch (res.status) {
      case 'weak_password':
        setError('Password must be at least 8 characters.');
        return;
      case 'invalid_credentials':
        // Login only: do not reveal whether it was the phone or the password that was wrong.
        setError('Wrong phone number or password.');
        return;
      case 'account_exists':
        setError('You already have an account — please log in.');
        return;
      case 'invalid_phone':
        setError('That phone number doesn’t look right. Please check and try again.');
        return;
      case 'invalid_branch':
        setError('This location isn’t available right now. Please refresh and try again.');
        return;
      default:
        setError('Couldn’t sign you in. Please try again.');
    }
  };

  const submitGoogle = async () => {
    setError(null);
    setGoogleLoading(true);
    const supabase = getBrowserClient();
    const target = next ?? window.location.pathname;
    const { error: oauthErr } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(target)}`,
      },
    });
    // On success the browser is already navigating to Google — leave the spinner up.
    if (oauthErr) {
      setGoogleLoading(false);
      setError(oauthErr.message);
    }
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = getBrowserClient();
    const redirectTo = typeof window !== 'undefined'
      ? `${window.location.origin}${next ?? window.location.pathname}`
      : undefined;
    const { error } = await supabase.auth.signInWithOtp({
      email: emailAddr.trim().toLowerCase(),
      options: {
        emailRedirectTo: redirectTo,
        data: { signup_type: 'customer', branch_id: branchId, full_name: fullName.trim() || undefined },
      },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setStage('email_sent');
  };

  return (
    <div className="container max-w-md py-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="text-center"
      >
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
          <ChefHat className="h-8 w-8" />
        </div>
        <h1 className="mt-4 font-display text-3xl font-bold">Welcome to {brandName}</h1>
        <p className="mt-1 text-muted-foreground">
          {stage === 'phone' && 'Sign in with your phone to track orders and earn points'}
          {stage === 'email' && "Sign in with email — we'll send you a one-time link"}
          {stage === 'email_sent' && `We sent a link to ${emailAddr}`}
        </p>
      </motion.div>

      <Card className="mt-6 p-5">
        {stage !== 'email_sent' && (
          <>
            <button
              type="button"
              onClick={submitGoogle}
              disabled={googleLoading}
              className="focus-ring flex h-14 w-full items-center justify-center gap-3 rounded-xl border border-border bg-card text-base font-semibold shadow-soft transition-shadow hover:shadow-warm disabled:opacity-60"
            >
              <GoogleMark className="h-5 w-5" />
              {googleLoading ? 'Opening Google…' : 'Continue with Google'}
            </button>
            <div className="my-4 flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
            </div>
            <div className="mb-4 flex rounded-full bg-muted p-1 text-sm font-semibold">
              <button
                type="button"
                onClick={() => { setStage('phone'); setError(null); }}
                className={`focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 transition-colors ${
                  stage === 'phone' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
                }`}
              >
                <Phone className="h-3.5 w-3.5" /> Phone
              </button>
              <button
                type="button"
                onClick={() => { setStage('email'); setError(null); }}
                className={`focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 transition-colors ${
                  stage === 'email' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
                }`}
              >
                <Mail className="h-3.5 w-3.5" /> Email
              </button>
            </div>
          </>
        )}
        {stage === 'phone' ? (
          <form onSubmit={submitPhone} className="space-y-4">
            <div className="flex rounded-full bg-muted p-1 text-sm font-semibold">
              <button
                type="button"
                onClick={() => { setPhoneMode('login'); setError(null); }}
                className={`focus-ring flex-1 rounded-full py-1.5 transition-colors ${
                  phoneMode === 'login' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
                }`}
              >
                Log in
              </button>
              <button
                type="button"
                onClick={() => { setPhoneMode('register'); setError(null); }}
                className={`focus-ring flex-1 rounded-full py-1.5 transition-colors ${
                  phoneMode === 'register' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
                }`}
              >
                Register
              </button>
            </div>
            {phoneMode === 'register' && (
              <label className="block">
                <span className="mb-2 block text-sm font-medium">Full name (optional)</span>
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoComplete="name"
                  placeholder="Your name"
                  className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
                />
              </label>
            )}
            <label className="block">
              <span className="mb-2 block text-sm font-medium">Phone number</span>
              <div className="relative">
                <Phone className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  required
                  placeholder="(555) 234-5678"
                  className="focus-ring w-full rounded-xl border border-border bg-background py-3 pl-11 pr-4 text-base"
                />
              </div>
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">Password</span>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete={phoneMode === 'register' ? 'new-password' : 'current-password'}
                  minLength={8}
                  required
                  placeholder={phoneMode === 'register' ? 'At least 8 characters' : 'Your password'}
                  className="focus-ring w-full rounded-xl border border-border bg-background py-3 pl-11 pr-4 text-base"
                />
              </div>
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" variant="gradient" size="xl" fullWidth loading={loading}>
              {phoneMode === 'register' ? 'Create account' : 'Log in'}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              By continuing you agree to our{' '}
              <a href="/terms" className="text-primary underline">Terms</a> and{' '}
              <a href="/privacy" className="text-primary underline">Privacy</a>.
            </p>
          </form>
        ) : stage === 'email' ? (
          <form onSubmit={submitEmail} className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">Full name (optional)</span>
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoComplete="name"
                placeholder="Your name"
                className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">Email</span>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={emailAddr}
                  onChange={(e) => setEmailAddr(e.target.value)}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                  className="focus-ring w-full rounded-xl border border-border bg-background py-3 pl-11 pr-4 text-base"
                />
              </div>
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" variant="gradient" size="xl" fullWidth loading={loading}>
              Send magic link
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              By continuing you agree to our{' '}
              <a href="/terms" className="text-primary underline">Terms</a> and{' '}
              <a href="/privacy" className="text-primary underline">Privacy</a>.
            </p>
          </form>
        ) : (
          <div className="space-y-3 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-success/15 text-success">
              <Mail className="h-7 w-7" />
            </div>
            <h3 className="font-display text-lg font-semibold">Check your inbox</h3>
            <p className="text-sm text-muted-foreground">
              We sent a sign-in link to <strong>{emailAddr}</strong>. Open it on this device to
              continue.
            </p>
            <button
              type="button"
              onClick={() => { setStage('email'); setError(null); }}
              className="focus-ring block w-full py-2 text-center text-sm font-medium text-primary"
            >
              ← Use a different email
            </button>
          </div>
        )}
      </Card>

      <div className="mt-6 flex items-center gap-2 rounded-2xl bg-muted/50 p-4 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
        Your phone number and password keep your orders and points private to {brandName}.
      </div>
    </div>
  );
}

// Official Google "G" — brand guidelines require these exact colours, so this is the one
// place in the storefront that intentionally bypasses the tenant theme tokens.
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
