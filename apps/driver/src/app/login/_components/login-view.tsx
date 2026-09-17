'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Bike, Sparkles } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { getBrowserClient } from '@favornoms/database/client';
import {
  countryDialsFor,
  countryForIso,
  DEFAULT_COUNTRY_ISO,
  toE164,
  type UiLocale,
} from '@favornoms/shared';
import { Button } from '@favornoms/ui';
import { LocaleSwitcher } from '@/components/locale-switcher';

// Password-based phone auth (no SMS): the `driver-auth` edge function takes an explicit
// mode. Log in -> phone + password; Register -> phone + password + a short profile, then
// the account is created and signed in.

interface AuthResult {
  status:
    | 'login'
    | 'signup'
    | 'needs_profile'
    | 'invalid_phone'
    | 'weak_password'
    | 'invalid_credentials'
    | 'account_exists'
    | 'error';
  access_token?: string;
  refresh_token?: string;
  error?: string;
}

// The value is what driver-auth stores; the label is translated under login.vehicleTypes.
const VEHICLE_TYPES = ['motorcycle', 'car', 'bicycle', 'scooter'] as const;

export function LoginView() {
  const router = useRouter();
  const t = useTranslations('login');
  const tErrors = useTranslations('errors');
  const locale = useLocale() as UiLocale;

  // Login vs Register is explicit so the edge function never has to guess: login must not
  // create an account, register must not take one over.
  const [mode, setMode] = React.useState<'login' | 'register'>('login');
  const [phone, setPhone] = React.useState('');
  // The rider app never had a country selector, so whatever was typed went to driver-auth
  // as-is and the edge function's "prepend 1 if it looks like ten digits" fallback decided
  // the account key. A rider outside the US got a number that was not theirs.
  const [countryIso, setCountryIso] = React.useState(DEFAULT_COUNTRY_ISO);
  const country = React.useMemo(() => countryForIso(countryIso), [countryIso]);
  const countries = React.useMemo(() => countryDialsFor(locale), [locale]);
  const [password, setPassword] = React.useState('');
  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [vehicleType, setVehicleType] = React.useState('motorcycle');
  const [vehiclePlate, setVehiclePlate] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const muted = (chunks: React.ReactNode) => (
    <span className="text-muted-foreground">{chunks}</span>
  );

  const applySession = async (data: AuthResult) => {
    const supabase = getBrowserClient();
    await supabase.auth.setSession({
      access_token: data.access_token!,
      refresh_token: data.refresh_token!,
    });
    router.replace('/app/home');
    router.refresh();
  };

  const callAuth = async (body: Record<string, unknown>): Promise<AuthResult | null> => {
    const supabase = getBrowserClient();
    const { data, error: fnErr } = await supabase.functions.invoke('driver-auth', { body });
    if (fnErr) {
      setError(tErrors('generic'));
      return null;
    }
    return data as AuthResult;
  };

  // Shared mapping for the statuses that don't carry a session.
  const showStatusError = (status: AuthResult['status']) => {
    switch (status) {
      case 'weak_password':
        setError(tErrors('auth.weakPassword'));
        return;
      case 'invalid_credentials':
        // Login only: don't reveal whether the phone or the password was wrong.
        setError(tErrors('auth.invalidCredentials'));
        return;
      case 'account_exists':
        setError(tErrors('auth.accountExists'));
        return;
      case 'needs_profile':
        // A phone with no rider profile yet — send them through Register to finish setup.
        setMode('register');
        setError(tErrors('auth.needsProfile'));
        return;
      case 'invalid_phone':
        setError(tErrors('auth.invalidPhone'));
        return;
      default:
        setError(tErrors('auth.couldNotContinue'));
    }
  };

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await callAuth({ mode: 'login', phone: toE164(phone, country), password });
    setSubmitting(false);
    if (!res) return;
    if (res.status === 'login') return applySession(res);
    showStatusError(res.status);
  };

  const submitRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const full_name = `${firstName.trim()} ${lastName.trim()}`.trim();
    if (!full_name) {
      setError(t('nameRequired'));
      return;
    }
    setSubmitting(true);
    const res = await callAuth({
      mode: 'signup',
      phone: toE164(phone, country),
      password,
      profile: {
        full_name,
        vehicle_type: vehicleType,
        vehicle_plate: vehiclePlate.trim() || undefined,
        email: email.trim() || undefined,
      },
    });
    setSubmitting(false);
    if (!res) return;
    if (res.status === 'signup' || res.status === 'login') return applySession(res);
    showStatusError(res.status);
  };

  return (
    <div className="relative grid min-h-dynamic-screen grid-rows-[1fr_auto] overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-gradient-warm" />
      <div className="absolute inset-0 -z-10 bg-noise opacity-30" />

      <div className="absolute right-4 top-4 z-10">
        <LocaleSwitcher />
      </div>

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
          {mode === 'login' ? t('title') : t('registerTitle')}
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.5 }}
          className="mt-2 max-w-xs text-center text-white/85"
        >
          {mode === 'login' ? t('subtitle') : t('registerSubtitle')}
        </motion.p>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t('trustedBy')}
        </motion.div>
      </section>

      <section className="rounded-t-[32px] bg-card px-5 pb-safe pt-7">
        <div className="mb-5 flex rounded-full bg-muted p-1 text-sm font-semibold">
          <button
            type="button"
            onClick={() => { setMode('login'); setError(null); }}
            className={`focus-ring flex-1 rounded-full py-2 transition-colors ${
              mode === 'login' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
            }`}
          >
            {t('tabLogin')}
          </button>
          <button
            type="button"
            onClick={() => { setMode('register'); setError(null); }}
            className={`focus-ring flex-1 rounded-full py-2 transition-colors ${
              mode === 'register' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
            }`}
          >
            {t('tabRegister')}
          </button>
        </div>
        <form className="space-y-4" onSubmit={mode === 'login' ? submitLogin : submitRegister}>
          <label className="block">
            <span className="mb-2 block text-sm font-medium">{t('phone')}</span>
            <div className="flex gap-2">
              <select
                value={countryIso}
                onChange={(e) => setCountryIso(e.target.value)}
                aria-label={t('countryCode')}
                className="focus-ring w-32 shrink-0 rounded-2xl border border-border bg-background px-2 py-4 text-base"
              >
                {countries.map((c) => (
                  <option key={c.iso} value={c.iso}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                required
                placeholder={country.placeholder}
                className="focus-ring w-full min-w-0 flex-1 rounded-2xl border border-border bg-background px-4 py-4 text-lg font-medium tracking-wide placeholder:font-normal placeholder:text-muted-foreground"
              />
            </div>
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-medium">{t('password')}</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              minLength={8}
              required
              placeholder={
                mode === 'register' ? t('passwordNewPlaceholder') : t('passwordPlaceholder')
              }
              className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base placeholder:text-muted-foreground"
            />
          </label>
          {mode === 'register' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-2 block text-sm font-medium">{t('firstName')}</span>
                  <input
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    autoComplete="given-name"
                    required
                    placeholder={t('firstNamePlaceholder')}
                    className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base placeholder:text-muted-foreground"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium">{t('lastName')}</span>
                  <input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    autoComplete="family-name"
                    required
                    placeholder={t('lastNamePlaceholder')}
                    className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base placeholder:text-muted-foreground"
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-2 block text-sm font-medium">{t('vehicle')}</span>
                <select
                  value={vehicleType}
                  onChange={(e) => setVehicleType(e.target.value)}
                  className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base"
                >
                  {VEHICLE_TYPES.map((v) => (
                    <option key={v} value={v}>
                      {t(`vehicleTypes.${v}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium">{t.rich('plate', { muted })}</span>
                <input
                  value={vehiclePlate}
                  onChange={(e) => setVehiclePlate(e.target.value)}
                  placeholder={t('platePlaceholder')}
                  className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base uppercase placeholder:normal-case placeholder:text-muted-foreground"
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium">{t.rich('email', { muted })}</span>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  autoComplete="email"
                  placeholder={t('emailPlaceholder')}
                  className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base placeholder:text-muted-foreground"
                />
              </label>
            </>
          )}
          {error && <p className="text-sm font-medium text-danger">{error}</p>}
          <Button type="submit" variant="gradient" size="xl" fullWidth loading={submitting}>
            {mode === 'login' ? t('submitLogin') : t('submitRegister')}
          </Button>
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            {t('byContinuing')}
          </p>
        </form>
      </section>
    </div>
  );
}
