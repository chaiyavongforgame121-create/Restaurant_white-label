'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChefHat, ChevronRight, Sparkles, Store, UserRound } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { describeBillingError, isValidTimeZone } from '@favornoms/shared';
import { Button, Card, buttonVariants } from '@favornoms/ui';

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

// A slug is the tenant's public web address, so an empty one is not a cosmetic slip: it
// reaches create_restaurant_with_branch and comes back as a raw Postgres message under the
// Launch button. slugify() already forces the shape as you type, but it happily reduces a
// name made only of punctuation (or a cleared field) to '', which is what has to be caught.
// The hint shown for it is `onboarding.fields.slugHint`.
const isUsableSlug = (s: string) => s.length > 0;

/** What create_restaurant_with_branch uses when no zone is sent. */
const DEFAULT_TIME_ZONE = 'America/New_York';

/** The US zones the Location card offers (b/[branchId]/branch/_components/location-card.tsx,
 *  where the list is not exported). Keep the two in step. `key` names the label under
 *  `onboarding.timezones.*`; `value` is what is saved. */
const US_TIMEZONES: Array<{ value: string; key: string }> = [
  { value: 'America/New_York', key: 'eastern' },
  { value: 'America/Chicago', key: 'central' },
  { value: 'America/Denver', key: 'mountain' },
  { value: 'America/Phoenix', key: 'arizona' },
  { value: 'America/Los_Angeles', key: 'pacific' },
  { value: 'America/Anchorage', key: 'alaska' },
  { value: 'Pacific/Honolulu', key: 'hawaii' },
];

/** The signed-in user's existing place in the product, when they have one. */
export interface ExistingMembership {
  restaurantName: string | null;
  /** Holds an owner membership, so a new restaurant comes without a free trial. */
  ownsRestaurant: boolean;
  /** Owner or admin — the roles create_branch accepts. */
  canAddBranch: boolean;
  addBranchHref: string | null;
}

export function OnboardingWizard({
  existing,
  signedInEmail = null,
}: {
  existing: ExistingMembership | null;
  /** Set only for a user with no memberships at all; see SignedInAsNotice. */
  signedInEmail?: string | null;
}) {
  const router = useRouter();
  const t = useTranslations('onboarding');
  const [continuedPastNotice, setContinuedPastNotice] = React.useState(false);
  const [step, setStep] = React.useState<0 | 1 | 2>(0);
  const [restaurantName, setRestaurantName] = React.useState('');
  const [restaurantSlug, setRestaurantSlug] = React.useState('');
  // Sent to create_restaurant_with_branch as the branch's name, so it stays as it has always been.
  const [branchName, setBranchName] = React.useState('Main');
  const [branchSlug, setBranchSlug] = React.useState('main');
  const [branchAddress, setBranchAddress] = React.useState('');
  const [timezone, setTimezone] = React.useState(DEFAULT_TIME_ZONE);
  const [deviceZone, setDeviceZone] = React.useState<string | null>(null);
  const [primaryColor, setPrimaryColor] = React.useState('#FF6B35');
  const [accentColor, setAccentColor] = React.useState('#F7B538');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (restaurantName && !restaurantSlug) setRestaurantSlug(slugify(restaurantName));
  }, [restaurantName, restaurantSlug]);

  // The wizard never sent a zone, so every store opened on America/New_York: a Chicago
  // store closed an hour early and a Bangkok store's "today" report started at noon. The
  // device's zone is the best first guess. Read after mount rather than during render,
  // because the server renders this too and would guess its own zone instead.
  React.useEffect(() => {
    let detected: string | undefined;
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      detected = undefined;
    }
    if (detected && isValidTimeZone(detected)) {
      setDeviceZone(detected);
      setTimezone(detected);
    }
  }, []);

  const zoneOptions = React.useMemo(() => {
    const options = US_TIMEZONES.map((z) => {
      const label = t(`timezones.${z.key}`);
      return { value: z.value, label: z.value === deviceZone ? t('timezones.thisDevice', { zone: label }) : label };
    });
    if (deviceZone && !US_TIMEZONES.some((z) => z.value === deviceZone)) {
      options.unshift({ value: deviceZone, label: t('timezones.thisDevice', { zone: deviceZone.replace(/_/g, ' ') }) });
    }
    return options;
  }, [deviceZone, t]);

  const create = async () => {
    // Step 2 has no slug fields of its own, so a slug can only be empty here if someone
    // stepped back and cleared one. Cheap to re-check, and it keeps the RPC from being the
    // thing that discovers it.
    if (!isUsableSlug(restaurantSlug) || !isUsableSlug(branchSlug)) {
      setStep(isUsableSlug(restaurantSlug) ? 1 : 0);
      setError(t('errors.slugMissing'));
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setBusy(false);
      router.push('/login?next=/onboarding');
      return;
    }
    const { data, error: rpcErr } = await supabase.rpc('create_restaurant_with_branch', {
      p_restaurant_name: restaurantName,
      p_restaurant_slug: restaurantSlug,
      p_branch_name: branchName,
      p_branch_slug: branchSlug,
      p_branch_address: branchAddress || null,
      p_timezone: isValidTimeZone(timezone) ? timezone : DEFAULT_TIME_ZONE,
      p_theme: { primaryColor, accentColor, brandName: restaurantName },
    });
    setBusy(false);
    if (rpcErr) {
      // create_restaurant_with_branch does not refuse a further restaurant on billing
      // grounds — it creates it without a package (trial_granted false, handled below).
      // These arms stay so a billing refusal, should it ever come, reads as a sentence.
      const billing = describeBillingError(rpcErr);
      // A taken slug is the one failure a new owner can actually fix, and it is likelier
      // than any of the above: two restaurants called Thai Garden slugify identically. Left
      // as rpcErr.message it read 'duplicate key value violates unique constraint
      // "restaurants_slug_key"' on the very first screen of the product.
      const takenField = rpcErr.code === '23505'
        ? /branch/i.test(`${rpcErr.message} ${rpcErr.details ?? ''}`)
          ? 'branch'
          : 'restaurant'
        : null;
      if (!billing && !takenField) {
        // Anything else is database text a new owner cannot act on; keep it for the console.
        console.error('[onboarding] create_restaurant_with_branch failed:', rpcErr.message);
      }
      setError(
        billing?.kind === 'seats'
          ? t('errors.seatsFull', { limit: billing.limit })
          : billing?.kind === 'inactive'
            ? t('errors.subscriptionInactive')
            : takenField === 'branch'
              ? t('errors.branchSlugTaken')
              : takenField === 'restaurant'
                ? t('errors.restaurantSlugTaken')
                : t('errors.generic'),
      );
      if (takenField) setStep(takenField === 'branch' ? 1 : 0);
      return;
    }
    // The RPC answering without a branch_id used to fall off the end of this function:
    // no error, no spinner, no navigation, and an owner left pressing Launch on a
    // restaurant that may well have been created.
    const r = data as { branch_id?: string; trial_granted?: boolean } | null;
    if (!r?.branch_id) {
      setError(t('errors.notOpened'));
      return;
    }
    // An owner's second restaurant gets no trial, and the back office would bounce them to
    // the Plan page as "suspended" anyway — going there directly lets that page explain why
    // instead. Only an explicit false does this; an older function without the key keeps
    // today's landing.
    router.push(
      r.trial_granted === false
        ? `/b/${r.branch_id}/settings/plan?no_trial=1`
        : `/b/${r.branch_id}/dashboard`,
    );
  };

  if (existing && !continuedPastNotice) {
    const name = existing.restaurantName;
    const addBranchLink = (c: React.ReactNode) =>
      existing.addBranchHref ? (
        <Link
          href={existing.addBranchHref}
          className="font-medium text-primary underline underline-offset-2 hover:no-underline"
        >
          {c}
        </Link>
      ) : (
        <span className="font-medium">{c}</span>
      );
    return (
      <div className="grid min-h-dynamic-screen place-items-center bg-gradient-to-br from-background to-muted/40 p-6">
        <Card className="w-full max-w-xl space-y-5 p-7">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
              <Store className="h-6 w-6" />
            </div>
            <h1 className="font-display text-2xl font-bold">
              {existing.canAddBranch ? t('notice.ownerTitle') : t('notice.teamTitle')}
            </h1>
          </div>

          <div className="space-y-3 text-sm">
            {existing.canAddBranch ? (
              <p>
                {name
                  ? t.rich('notice.ownerBody', { name, link: addBranchLink })
                  : t.rich('notice.ownerBodyUnnamed', { link: addBranchLink })}
              </p>
            ) : (
              <p>{name ? t('notice.teamBody', { name }) : t('notice.teamBodyUnnamed')}</p>
            )}
            <p className="text-muted-foreground">
              {existing.ownsRestaurant ? t('notice.ownsRestaurant') : t('notice.separateRestaurant')}
            </p>
          </div>

          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" onClick={() => setContinuedPastNotice(true)}>
              {t('notice.continueAnyway')}
            </Button>
            <Link href="/" className={buttonVariants({ variant: 'gradient' })}>
              {t('notice.goToDashboard')}
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-gradient-to-br from-background to-muted/40 p-6">
      <Card className="w-full max-w-xl space-y-5 p-7">
        {signedInEmail && <SignedInAsNotice email={signedInEmail} />}

        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
            <ChefHat className="h-6 w-6" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              {t('wizard.step', { current: step + 1, total: 3 })}
            </p>
            <h1 className="font-display text-2xl font-bold">
              {step === 0
                ? t('wizard.restaurantTitle')
                : step === 1
                  ? t('wizard.branchTitle')
                  : t('wizard.colorsTitle')}
            </h1>
          </div>
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <Field label={t('fields.restaurantName')}>
              <input value={restaurantName} onChange={(e) => setRestaurantName(e.target.value)} className="input" placeholder={t('fields.restaurantNamePlaceholder')} autoFocus />
            </Field>
            <Field
              label={t('fields.restaurantSlug')}
              hint={restaurantName && !isUsableSlug(restaurantSlug) ? t('fields.slugHint') : null}
            >
              <input value={restaurantSlug} onChange={(e) => setRestaurantSlug(slugify(e.target.value))} className="input font-mono" placeholder="somtam-zab" />
            </Field>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <Field label={t('fields.branchName')}>
              <input value={branchName} onChange={(e) => setBranchName(e.target.value)} className="input" placeholder={t('fields.branchNamePlaceholder')} />
            </Field>
            <Field
              label={t('fields.branchSlug')}
              hint={branchName && !isUsableSlug(branchSlug) ? t('fields.slugHint') : null}
            >
              <input value={branchSlug} onChange={(e) => setBranchSlug(slugify(e.target.value))} className="input font-mono" placeholder="sukhumvit" />
            </Field>
            <Field label={t('fields.address')}>
              <input value={branchAddress} onChange={(e) => setBranchAddress(e.target.value)} className="input" />
            </Field>
            <Field label={t('fields.timezone')} hint={t('fields.timezoneHint')}>
              <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="input">
                {zoneOptions.map((z) => (
                  <option key={z.value} value={z.value}>
                    {z.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('fields.primaryColor')}>
                <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="h-12 w-full rounded-xl border border-border" />
              </Field>
              <Field label={t('fields.accentColor')}>
                <input type="color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} className="h-12 w-full rounded-xl border border-border" />
              </Field>
            </div>
            <div
              className="rounded-2xl p-6 text-white"
              style={{ background: `linear-gradient(135deg, ${primaryColor}, ${accentColor})` }}
            >
              <p className="text-xs uppercase tracking-wider text-white/80">{t('fields.preview')}</p>
              <p className="mt-1 font-display text-2xl font-bold">{restaurantName || t('fields.previewFallbackName')}</p>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-between gap-2">
          {step > 0 ? (
            <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as 0 | 1 | 2)}>{t('wizard.back')}</Button>
          ) : <span />}
          {step < 2 ? (
            <Button
              variant="gradient"
              onClick={() => setStep((s) => (s + 1) as 0 | 1 | 2)}
              disabled={
                step === 0
                  ? !restaurantName || !isUsableSlug(restaurantSlug)
                  : !branchName || !isUsableSlug(branchSlug)
              }
              rightIcon={<ChevronRight className="h-4 w-4" />}
            >
              {t('wizard.continue')}
            </Button>
          ) : (
            <Button variant="gradient" onClick={create} loading={busy} leftIcon={<Sparkles className="h-4 w-4" />}>
              {t('wizard.launch')}
            </Button>
          )}
        </div>

        <style jsx>{`
          .input { width: 100%; height: 48px; padding: 0 1rem; font-size: 16px; border-radius: 0.875rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
          .input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
        `}</style>
      </Card>
    </div>
  );
}

// "Continue with Google" on /login creates an account for whichever Google account is picked,
// so an owner who picks the wrong one is sent here instead of to their dashboard. Nothing on the
// wizard said which account was signed in, so they could believe their restaurant was gone, or
// build a second one and start a second trial. Shown only to a user with no memberships: anyone
// with one already got the existing-restaurant notice above.
function SignedInAsNotice({ email }: { email: string }) {
  const router = useRouter();
  const t = useTranslations('onboarding.account');
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const switchAccount = async () => {
    setBusy(true);
    setFailed(false);
    // This browser only. The account picked by mistake may be one its holder is signed in with
    // elsewhere (the customer ordering app uses the same accounts), and choosing the wrong one on
    // this page is no reason to end those sessions too.
    const { error } = await getBrowserClient().auth.signOut({ scope: 'local' });
    if (error) {
      // supabase-js keeps the session when the sign-out request itself fails, so going on to
      // /login would show a sign-in form to someone who is still signed in as this account.
      console.error('[onboarding] signOut failed:', error.message);
      setBusy(false);
      setFailed(true);
      return;
    }
    // No ?next=/onboarding: the right account has its memberships, and '/' opens its restaurant.
    router.replace('/login');
    // Drops the server output cached for the account that just signed out.
    router.refresh();
  };

  return (
    <div className="flex gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm">
      <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p>
          {t.rich('signedInAs', {
            email,
            strong: (c) => <strong className="break-all font-semibold">{c}</strong>,
          })}
        </p>
        <p className="text-muted-foreground">{t('differentAccountHint')}</p>
        {failed && (
          <p role="alert" className="text-destructive">
            {t('signOutFailed')}
          </p>
        )}
        <Button variant="outline" size="sm" className="mt-1" loading={busy} onClick={switchAccount}>
          {t('useDifferentAccount')}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string | null; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
