'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Bike, ChevronLeft, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { getBrowserClient } from '@favornoms/database/client';
import { sendPhoneOtp, verifyPhoneOtp } from '@favornoms/database/queries';
import { Button } from '@favornoms/ui';

// Normalize US numbers: (555) 234-5678 → +15552345678
function normalizePhone(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) return `+${trimmed.replace(/\D/g, '')}`;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export function LoginView() {
  const t = useTranslations('login');
  const router = useRouter();

  const [stage, setStage] = React.useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [otp, setOtp] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submitPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const supabase = getBrowserClient();
    const { error } = await sendPhoneOtp(supabase, normalizePhone(phone), {
      signup_type: 'driver',
      full_name: fullName.trim() || undefined,
    });
    setSubmitting(false);
    if (error) {
      setError(error.message);
      return;
    }
    setStage('otp');
  };

  const submitOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const supabase = getBrowserClient();
    const { error } = await verifyPhoneOtp(supabase, normalizePhone(phone), otp);
    if (error) {
      setSubmitting(false);
      setError(error.message);
      return;
    }
    router.replace('/app/home');
    router.refresh();
  };

  return (
    <div className="relative grid min-h-dynamic-screen grid-rows-[1fr_auto] overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-gradient-warm" />
      <div className="absolute inset-0 -z-10 bg-noise opacity-30" />

      <section className="flex flex-col items-center justify-center px-6 pt-12 text-white">
        <motion.div
          animate={{ y: [0, -10, 0] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          className="grid h-24 w-24 place-items-center rounded-[28px] bg-white/20 backdrop-blur"
        >
          <Bike className="h-12 w-12" />
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.5 }}
          className="mt-6 text-center font-display text-4xl font-bold leading-tight"
        >
          {t('title')}
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.5 }}
          className="mt-2 max-w-xs text-center text-white/85"
        >
          {stage === 'phone' ? t('subtitle') : t('otpSubtitle', { phone })}
        </motion.p>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Trusted by 2,300+ drivers
        </motion.div>
      </section>

      <section className="rounded-t-[32px] bg-card px-5 pb-safe pt-7">
        {stage === 'phone' ? (
          <form className="space-y-4" onSubmit={submitPhone}>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">{t('fullName')}</span>
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoComplete="name"
                placeholder={t('fullNamePlaceholder')}
                className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-4 text-base placeholder:text-muted-foreground"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">{t('phone')}</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                required
                placeholder={t('phonePlaceholder')}
                className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-4 text-lg font-medium tracking-wide placeholder:font-normal placeholder:text-muted-foreground"
              />
            </label>
            {error && <p className="text-sm font-medium text-danger">{error}</p>}
            <Button type="submit" variant="gradient" size="xl" fullWidth loading={submitting}>
              {t('continue')}
            </Button>
            <p className="text-center text-xs leading-relaxed text-muted-foreground">
              {t('byContinuing')}
            </p>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={submitOtp}>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">{t('otpCode')}</span>
              <input
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                maxLength={6}
                placeholder="000000"
                className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-4 text-center text-2xl font-bold tracking-[0.5em]"
              />
            </label>
            {error && <p className="text-sm font-medium text-danger">{error}</p>}
            <Button
              type="submit"
              variant="gradient"
              size="xl"
              fullWidth
              loading={submitting}
              disabled={otp.length !== 6}
            >
              {t('verify')}
            </Button>
            <button
              type="button"
              onClick={() => {
                setStage('phone');
                setOtp('');
                setError(null);
              }}
              className="focus-ring inline-flex w-full items-center justify-center gap-1 py-2 text-sm font-medium text-primary"
            >
              <ChevronLeft className="h-4 w-4" />
              {t('changeNumber')}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
