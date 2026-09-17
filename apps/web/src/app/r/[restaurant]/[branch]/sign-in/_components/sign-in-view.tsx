'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { ChefHat, Lock, Phone, ShieldCheck } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card, GoogleMark } from '@favornoms/ui';
import {
  countryDialsFor,
  countryForIso,
  currentOrigin,
  DEFAULT_COUNTRY_ISO,
  DEFAULT_UI_LOCALE,
  isUiLocale,
  safeNext,
  toE164,
} from '@favornoms/shared';
import { useAuth } from '@/components/auth/use-auth';

interface Props {
  branchId: string;
  brandName: string;
  // Preselected country, resolved from the request's country on the server. An ISO code
  // rather than a dial code, because +1 is two countries and +7 is two more.
  // Optional so any caller that has not been updated still renders; the fallback is
  // the market we sell into.
  defaultCountryIso?: string;
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

// Errors handed back by /auth/callback (the `error` query code), mapped to the `auth.errors.*`
// message a diner can act on.
const CALLBACK_ERRORS: Record<string, 'errors.oauthFailed' | 'errors.missingCode'> = {
  oauth_failed: 'errors.oauthFailed',
  missing_code: 'errors.missingCode',
};

export function SignInView({
  branchId,
  brandName,
  defaultCountryIso = DEFAULT_COUNTRY_ISO,
}: Props) {
  const t = useTranslations('auth');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const router = useRouter();
  const searchParams = useSearchParams();
  // Shared open-redirect guard — see @favornoms/shared. `next` feeds router.replace() and
  // the OAuth redirectTo, both of which will happily leave the origin. This component
  // prerenders on the server, where there is no window: currentOrigin() returns '' there,
  // which makes safeNext return null rather than throw. `next` is never rendered, so there
  // is no hydration mismatch.
  const rawNext = searchParams.get('next');
  const next = React.useMemo(() => safeNext(rawNext, currentOrigin()), [rawNext]);
  const pathname = usePathname();
  // Where to send the diner when there is no explicit `next`: the branch home, NEVER this
  // sign-in page itself. Opening /sign-in directly and using Google (whose `next` defaults
  // to the current path) would otherwise bounce straight back here after a successful login.
  const branchBase = React.useMemo(() => {
    const m = pathname?.match(/^(\/r\/[^/]+\/[^/]+)/);
    return m?.[1] ?? '/';
  }, [pathname]);
  const { user } = useAuth();
  const callbackError = searchParams.get('error');
  // Login vs Register is explicit on the phone tab so the edge function knows which path to
  // take (login must never silently create an account, and register must never take one over).
  const [phoneMode, setPhoneMode] = React.useState<'login' | 'register'>('login');
  const [countryIso, setCountryIso] = React.useState(defaultCountryIso);
  const country = React.useMemo(() => countryForIso(countryIso), [countryIso]);
  // Same entries as COUNTRY_DIALS with the country names in the interface language; the option
  // value stays the ISO code, and countryForIso() above still decides the number rules.
  const countryOptions = React.useMemo(() => countryDialsFor(locale), [locale]);
  const [phone, setPhone] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(() =>
    callbackError ? t(CALLBACK_ERRORS[callbackError] ?? 'errors.callbackFailed') : null,
  );

  // Already signed in — e.g. a Google OAuth round-trip landed back here because its
  // `next` defaulted to this page. Move the diner on instead of showing a login form they no
  // longer need. (This is what actually fixes "Google worked but bounced me back to sign-in".)
  //
  // Guarded so it can only ever fire for a session that was ALREADY there. setSession() emits
  // SIGNED_IN before it resolves and the browser client is a singleton, so without the guard
  // `user` flips on the same tick submitPhone calls goNext() and both owners dispatch a
  // navigation. Next discards the first one's in-flight RSC fetch when the second arrives, so
  // one login cost two full round-trips — 5.3s of spinning, measured in production.
  const redirected = React.useRef(false);
  React.useEffect(() => {
    if (!user || redirected.current || loading || googleLoading) return;
    redirected.current = true;
    // No router.refresh(): replace() to a different route already fetches a fresh tree, and
    // the extra action is what the navigation was racing.
    router.replace(next ?? branchBase);
  }, [user, next, branchBase, router, loading, googleLoading]);

  // Hard navigation, deliberately. setSession() has already written the auth cookie, and the
  // destination is a force-dynamic tenant page that has to be re-rendered server-side with it
  // anyway. A soft replace() can be discarded by a competing navigation, and the success path
  // never resets `loading` — so a discarded one strands the diner on a disabled spinning
  // button with no recovery. `next` is safeNext-guarded to a same-origin path above.
  const goNext = React.useCallback(() => {
    window.location.assign(next ?? branchBase);
  }, [next, branchBase]);

  const submitPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // Guard as well as `required`: the attribute is trivially bypassed and a blank
    // name leaves the restaurant with an order it cannot call out.
    if (phoneMode === 'register' && !fullName.trim()) {
      setError(t('errors.nameRequired'));
      return;
    }
    setLoading(true);
    const supabase = getBrowserClient();
    const { data, error: fnErr } = await supabase.functions.invoke('customer-auth', {
      body: {
        mode: phoneMode === 'register' ? 'signup' : 'login',
        phone: toE164(phone, country),
        password,
        branch_id: branchId,
        // Name is only collected on register; login ignores it.
        full_name: phoneMode === 'register' ? fullName.trim() : undefined,
      },
    });
    if (fnErr) {
      setLoading(false);
      // The edge function answers 200 for every expected outcome, so a transport error
      // here is either the rate limiter (429) or a genuine fault.
      const status = (fnErr as { context?: { status?: number } }).context?.status;
      setError(status === 429 ? t('errors.tooManyAttempts') : t('errors.generic'));
      return;
    }
    const res = data as AuthResult;
    if ((res.status === 'login' || res.status === 'signup') && res.access_token && res.refresh_token) {
      const { error: sessErr } = await supabase.auth.setSession({
        access_token: res.access_token,
        refresh_token: res.refresh_token,
      });
      // Was swallowed. A failure here left `loading` true forever with nothing on screen.
      if (sessErr) {
        setLoading(false);
        setError(t('errors.sessionFailed'));
        return;
      }
      // The spinner ends when the document unloads — the one exit that does not reset it.
      goNext();
      return;
    }
    setLoading(false);
    switch (res.status) {
      case 'login':
      case 'signup':
        // 200 with the right status but no tokens. It used to reach `default` by accident;
        // being explicit keeps that from silently changing meaning.
        setError(t('errors.noSession'));
        return;
      case 'weak_password':
        setError(t('errors.weakPassword'));
        return;
      case 'invalid_credentials':
        // Login only: do not reveal whether it was the phone or the password that was wrong.
        setError(t('errors.invalidCredentials'));
        return;
      case 'account_exists':
        setError(t('errors.accountExists'));
        return;
      case 'invalid_phone':
        setError(t('errors.invalidPhone'));
        return;
      case 'invalid_branch':
        setError(t('errors.invalidBranch'));
        return;
      default:
        setError(t('errors.signInFailed'));
    }
  };

  const submitGoogle = async () => {
    setError(null);
    setGoogleLoading(true);
    const supabase = getBrowserClient();
    const target = next ?? branchBase;
    const { error: oauthErr } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(target)}`,
      },
    });
    // On success the browser is already navigating to Google — leave the spinner up.
    if (oauthErr) {
      setGoogleLoading(false);
      // The auth server's message is English and technical; keep it for the console only.
      console.error('[sign-in] Google OAuth failed', oauthErr);
      setError(t('errors.googleUnavailable'));
    }
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
        <h1 className="mt-4 font-display text-3xl font-bold">{t('signIn.welcome', { brandName })}</h1>
        <p className="mt-1 text-muted-foreground">{t('signIn.subtitle')}</p>
      </motion.div>

      <Card className="mt-6 p-5">
        <button
          type="button"
          onClick={submitGoogle}
          disabled={googleLoading}
          className="focus-ring flex h-14 w-full items-center justify-center gap-3 rounded-xl border border-border bg-card text-base font-semibold shadow-soft transition-shadow hover:shadow-warm disabled:opacity-60"
        >
          <GoogleMark className="h-5 w-5" />
          {googleLoading ? t('signIn.openingGoogle') : t('signIn.continueWithGoogle')}
        </button>
        <div className="my-4 flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span className="h-px flex-1 bg-border" /> {t('signIn.or')} <span className="h-px flex-1 bg-border" />
        </div>
        <form onSubmit={submitPhone} className="space-y-4">
            <div className="flex rounded-full bg-muted p-1 text-sm font-semibold">
              <button
                type="button"
                onClick={() => { setPhoneMode('login'); setError(null); }}
                className={`focus-ring flex-1 rounded-full py-1.5 transition-colors ${
                  phoneMode === 'login' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
                }`}
              >
                {t('signIn.logIn')}
              </button>
              <button
                type="button"
                onClick={() => { setPhoneMode('register'); setError(null); }}
                className={`focus-ring flex-1 rounded-full py-1.5 transition-colors ${
                  phoneMode === 'register' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
                }`}
              >
                {t('signIn.register')}
              </button>
            </div>
            {phoneMode === 'register' && (
              <label className="block">
                <span className="mb-2 block text-sm font-medium">{t('signIn.fullName')}</span>
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoComplete="name"
                  required
                  placeholder={t('signIn.fullNamePlaceholder')}
                  className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
                />
              </label>
            )}
            <label className="block">
              <span className="mb-2 block text-sm font-medium">{t('signIn.phoneNumber')}</span>
              <div className="flex gap-2">
                <select
                  value={countryIso}
                  onChange={(e) => setCountryIso(e.target.value)}
                  aria-label={t('signIn.countryCode')}
                  className="focus-ring w-32 shrink-0 rounded-xl border border-border bg-background px-2 py-3 text-base"
                >
                  {countryOptions.map((c) => (
                    <option key={c.iso} value={c.iso}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <div className="relative flex-1">
                  <Phone className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    required
                    placeholder={country.placeholder}
                    className="focus-ring w-full rounded-xl border border-border bg-background py-3 pl-11 pr-4 text-base"
                  />
                </div>
              </div>
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">{t('signIn.password')}</span>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete={phoneMode === 'register' ? 'new-password' : 'current-password'}
                  minLength={8}
                  required
                  placeholder={
                    phoneMode === 'register'
                      ? t('signIn.passwordPlaceholderNew')
                      : t('signIn.passwordPlaceholderCurrent')
                  }
                  className="focus-ring w-full rounded-xl border border-border bg-background py-3 pl-11 pr-4 text-base"
                />
              </div>
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" variant="gradient" size="xl" fullWidth loading={loading}>
              {phoneMode === 'register' ? t('signIn.createAccount') : t('signIn.logIn')}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {t.rich('signIn.legal', {
                terms: (chunks) => (
                  <a href="/terms" className="text-primary underline">
                    {chunks}
                  </a>
                ),
                privacy: (chunks) => (
                  <a href="/privacy" className="text-primary underline">
                    {chunks}
                  </a>
                ),
              })}
            </p>
        </form>
      </Card>

      <div className="mt-6 flex items-center gap-2 rounded-2xl bg-muted/50 p-4 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
        {t('signIn.privacyNote', { brandName })}
      </div>
    </div>
  );
}
