'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { ChefHat, Mail, Phone, ShieldCheck } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { sendPhoneOtp, verifyPhoneOtp } from '@favornoms/database/queries';
import { Button, Card } from '@favornoms/ui';

interface Props {
  branchId: string;
  brandName: string;
}

// Only allow internal redirects to prevent open-redirect attacks.
function safeNext(next: string | null): string | null {
  if (!next) return null;
  if (!next.startsWith('/')) return null;
  if (next.startsWith('//')) return null;
  return next;
}

export function SignInView({ branchId, brandName }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const [stage, setStage] = React.useState<'phone' | 'otp' | 'email' | 'email_sent'>('phone');
  const [phone, setPhone] = React.useState('');
  const [emailAddr, setEmailAddr] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [otp, setOtp] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Normalize US numbers: (555) 234-5678 → +15552345678 for Supabase
  const normalizePhone = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('+')) return `+${trimmed.replace(/\D/g, '')}`;
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    return `+${digits}`;
  };

  const submitPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const e164 = normalizePhone(phone);
    const supabase = getBrowserClient();
    const { error } = await sendPhoneOtp(supabase, e164, {
      signup_type: 'customer',
      branch_id: branchId,
      full_name: fullName.trim() || undefined,
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setStage('otp');
  };

  const submitOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = getBrowserClient();
    const { error } = await verifyPhoneOtp(supabase, normalizePhone(phone), otp);
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    if (next) {
      router.replace(next);
    } else {
      router.back();
    }
    router.refresh();
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
          {stage === 'email' && 'Sign in with email — we&apos;ll send you a one-time link'}
          {stage === 'email_sent' && `We sent a link to ${emailAddr}`}
          {stage === 'otp' && `Enter the code we sent to ${phone}`}
        </p>
      </motion.div>

      <Card className="mt-6 p-5">
        {(stage === 'phone' || stage === 'email') && (
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
        )}
        {stage === 'phone' ? (
          <form onSubmit={submitPhone} className="space-y-4">
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
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" variant="gradient" size="xl" fullWidth loading={loading}>
              Send code
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
        ) : stage === 'email_sent' ? (
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
        ) : (
          <form onSubmit={submitOtp} className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">6-digit code</span>
              <input
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                maxLength={6}
                placeholder="000000"
                className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-center text-2xl font-bold tracking-[0.5em]"
              />
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" variant="gradient" size="xl" fullWidth loading={loading} disabled={otp.length !== 6}>
              Verify
            </Button>
            <button
              type="button"
              onClick={() => setStage('phone')}
              className="focus-ring block w-full py-2 text-center text-sm font-medium text-primary"
            >
              ← Change number
            </button>
          </form>
        )}
      </Card>

      <div className="mt-6 flex items-center gap-2 rounded-2xl bg-muted/50 p-4 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
        We use one-time codes — never store passwords. Your phone is private to {brandName}.
      </div>
    </div>
  );
}
