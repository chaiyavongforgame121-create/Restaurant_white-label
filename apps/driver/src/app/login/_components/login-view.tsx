'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Bike, Sparkles } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';

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

const VEHICLE_TYPES = [
  { value: 'motorcycle', label: 'Motorcycle' },
  { value: 'car', label: 'Car' },
  { value: 'bicycle', label: 'Bicycle' },
  { value: 'scooter', label: 'Scooter' },
];

export function LoginView() {
  const router = useRouter();

  // Login vs Register is explicit so the edge function never has to guess: login must not
  // create an account, register must not take one over.
  const [mode, setMode] = React.useState<'login' | 'register'>('login');
  const [phone, setPhone] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [vehicleType, setVehicleType] = React.useState('motorcycle');
  const [vehiclePlate, setVehiclePlate] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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
      setError('Something went wrong. Please try again.');
      return null;
    }
    return data as AuthResult;
  };

  // Shared mapping for the statuses that don't carry a session.
  const showStatusError = (status: AuthResult['status']) => {
    switch (status) {
      case 'weak_password':
        setError('Password must be at least 8 characters.');
        return;
      case 'invalid_credentials':
        // Login only: don't reveal whether the phone or the password was wrong.
        setError('Wrong phone number or password.');
        return;
      case 'account_exists':
        setError('You already have an account — please log in.');
        return;
      case 'needs_profile':
        // A phone with no rider profile yet — send them through Register to finish setup.
        setMode('register');
        setError('Finish creating your rider account to continue.');
        return;
      case 'invalid_phone':
        setError('That phone number doesn’t look right. Please check and try again.');
        return;
      default:
        setError('Couldn’t continue. Please try again.');
    }
  };

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await callAuth({ mode: 'login', phone, password });
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
      setError('Please enter your name.');
      return;
    }
    setSubmitting(true);
    const res = await callAuth({
      mode: 'signup',
      phone,
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
          {mode === 'login' ? 'Welcome back' : 'Become a rider'}
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.5 }}
          className="mt-2 max-w-xs text-center text-white/85"
        >
          {mode === 'login'
            ? 'Log in with your phone number and password to start accepting deliveries.'
            : 'Sign up with your phone number to start accepting deliveries.'}
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
        <div className="mb-5 flex rounded-full bg-muted p-1 text-sm font-semibold">
          <button
            type="button"
            onClick={() => { setMode('login'); setError(null); }}
            className={`focus-ring flex-1 rounded-full py-2 transition-colors ${
              mode === 'login' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
            }`}
          >
            Log in
          </button>
          <button
            type="button"
            onClick={() => { setMode('register'); setError(null); }}
            className={`focus-ring flex-1 rounded-full py-2 transition-colors ${
              mode === 'register' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
            }`}
          >
            Register
          </button>
        </div>
        <form className="space-y-4" onSubmit={mode === 'login' ? submitLogin : submitRegister}>
          <label className="block">
            <span className="mb-2 block text-sm font-medium">Phone number</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              placeholder="(555) 234-5678"
              className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-4 text-lg font-medium tracking-wide placeholder:font-normal placeholder:text-muted-foreground"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-medium">Password</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              minLength={8}
              required
              placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
              className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base placeholder:text-muted-foreground"
            />
          </label>
          {mode === 'register' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-2 block text-sm font-medium">First name</span>
                  <input
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    autoComplete="given-name"
                    required
                    placeholder="Alex"
                    className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base placeholder:text-muted-foreground"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium">Last name</span>
                  <input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    autoComplete="family-name"
                    required
                    placeholder="Morgan"
                    className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base placeholder:text-muted-foreground"
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-2 block text-sm font-medium">Vehicle</span>
                <select
                  value={vehicleType}
                  onChange={(e) => setVehicleType(e.target.value)}
                  className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base"
                >
                  {VEHICLE_TYPES.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium">
                  License plate <span className="text-muted-foreground">(optional)</span>
                </span>
                <input
                  value={vehiclePlate}
                  onChange={(e) => setVehiclePlate(e.target.value)}
                  placeholder="ABC-1234"
                  className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base uppercase placeholder:normal-case placeholder:text-muted-foreground"
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium">
                  Email <span className="text-muted-foreground">(optional)</span>
                </span>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  className="focus-ring w-full rounded-2xl border border-border bg-background px-4 py-3.5 text-base placeholder:text-muted-foreground"
                />
              </label>
            </>
          )}
          {error && <p className="text-sm font-medium text-danger">{error}</p>}
          <Button type="submit" variant="gradient" size="xl" fullWidth loading={submitting}>
            {mode === 'login' ? 'Log in' : 'Create account'}
          </Button>
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            By continuing you agree to our Terms &amp; Privacy.
          </p>
        </form>
      </section>
    </div>
  );
}
