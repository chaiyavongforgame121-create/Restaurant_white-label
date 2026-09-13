'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChefHat, ChevronRight, Sparkles, Store } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { describeBillingError, isValidTimeZone } from '@favornoms/shared';
import { Button, Card, buttonVariants } from '@favornoms/ui';

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

// A slug is the tenant's public web address, so an empty one is not a cosmetic slip: it
// reaches create_restaurant_with_branch and comes back as a raw Postgres message under the
// Launch button. slugify() already forces the shape as you type, but it happily reduces a
// name made only of punctuation (or a cleared field) to '', which is what has to be caught.
const SLUG_HINT = 'Letters and numbers only — this becomes part of your web address.';
const isUsableSlug = (s: string) => s.length > 0;

/** What create_restaurant_with_branch uses when no zone is sent. */
const DEFAULT_TIME_ZONE = 'America/New_York';

/** The US zones the Location card offers (b/[branchId]/branch/_components/location-card.tsx,
 *  where the list is not exported). Keep the two in step. */
const US_TIMEZONES: Array<{ value: string; label: string }> = [
  { value: 'America/New_York', label: 'Eastern — New York, Miami, Atlanta' },
  { value: 'America/Chicago', label: 'Central — Chicago, Houston, Dallas' },
  { value: 'America/Denver', label: 'Mountain — Denver, Salt Lake City' },
  { value: 'America/Phoenix', label: 'Arizona — Phoenix (no daylight saving)' },
  { value: 'America/Los_Angeles', label: 'Pacific — Los Angeles, Seattle' },
  { value: 'America/Anchorage', label: 'Alaska — Anchorage' },
  { value: 'Pacific/Honolulu', label: 'Hawaii — Honolulu' },
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

export function OnboardingWizard({ existing }: { existing: ExistingMembership | null }) {
  const router = useRouter();
  const [continuedPastNotice, setContinuedPastNotice] = React.useState(false);
  const [step, setStep] = React.useState<0 | 1 | 2>(0);
  const [restaurantName, setRestaurantName] = React.useState('');
  const [restaurantSlug, setRestaurantSlug] = React.useState('');
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
    const options = US_TIMEZONES.map((z) =>
      z.value === deviceZone ? { ...z, label: `${z.label} (this device)` } : z,
    );
    if (deviceZone && !US_TIMEZONES.some((z) => z.value === deviceZone)) {
      options.unshift({ value: deviceZone, label: `${deviceZone.replace(/_/g, ' ')} (this device)` });
    }
    return options;
  }, [deviceZone]);

  const create = async () => {
    // Step 2 has no slug fields of its own, so a slug can only be empty here if someone
    // stepped back and cleared one. Cheap to re-check, and it keeps the RPC from being the
    // thing that discovers it.
    if (!isUsableSlug(restaurantSlug) || !isUsableSlug(branchSlug)) {
      setStep(isUsableSlug(restaurantSlug) ? 1 : 0);
      setError('Give your restaurant and branch a web address before launching.');
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
      setError(
        billing?.kind === 'seats'
          ? `You are using all ${billing.limit} of your branch seats. Add a seat on the Plan page first.`
          : billing?.kind === 'inactive'
            ? 'Your subscription is not active. Choose a package before adding another restaurant.'
            : takenField
              ? `That ${takenField} web address is already taken. Go back and pick another one.`
              : rpcErr.message,
      );
      if (takenField) setStep(takenField === 'branch' ? 1 : 0);
      return;
    }
    // The RPC answering without a branch_id used to fall off the end of this function:
    // no error, no spinner, no navigation, and an owner left pressing Launch on a
    // restaurant that may well have been created.
    const r = data as { branch_id?: string; trial_granted?: boolean } | null;
    if (!r?.branch_id) {
      setError(
        'Your restaurant may have been created, but we could not open it. Sign in again to ' +
          'check before trying a second time.',
      );
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
    return (
      <div className="grid min-h-dynamic-screen place-items-center bg-gradient-to-br from-background to-muted/40 p-6">
        <Card className="w-full max-w-xl space-y-5 p-7">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
              <Store className="h-6 w-6" />
            </div>
            <h1 className="font-display text-2xl font-bold">
              {existing.canAddBranch ? 'You already have a restaurant' : 'You are already on a team'}
            </h1>
          </div>

          <div className="space-y-3 text-sm">
            {existing.canAddBranch ? (
              <p>
                {name ?? 'Your restaurant'} is already set up on this account. To open another
                location, add it as a branch in{' '}
                {existing.addBranchHref ? (
                  <Link
                    href={existing.addBranchHref}
                    className="font-medium text-primary underline underline-offset-2 hover:no-underline"
                  >
                    Brand &amp; branches &gt; Add branch
                  </Link>
                ) : (
                  <span className="font-medium">Brand &amp; branches &gt; Add branch</span>
                )}
                .
              </p>
            ) : (
              <p>
                You are on the team at {name ?? 'another restaurant'}. New locations for it are
                added by its owner or an admin.
              </p>
            )}
            <p className="text-muted-foreground">
              {existing.ownsRestaurant
                ? 'Continuing creates a separate restaurant with its own menu and billing, and no ' +
                  'free trial. It stays closed to customers until a package is approved for it.'
                : 'Continuing creates a separate restaurant of your own, with its own menu and billing.'}
            </p>
          </div>

          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" onClick={() => setContinuedPastNotice(true)}>
              Continue anyway
            </Button>
            <Link href="/" className={buttonVariants({ variant: 'gradient' })}>
              Go to my dashboard
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-gradient-to-br from-background to-muted/40 p-6">
      <Card className="w-full max-w-xl space-y-5 p-7">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
            <ChefHat className="h-6 w-6" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Step {step + 1} / 3</p>
            <h1 className="font-display text-2xl font-bold">
              {step === 0 ? 'Tell us about your restaurant' : step === 1 ? 'Set up your first branch' : 'Pick your brand colors'}
            </h1>
          </div>
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <Field label="Restaurant name">
              <input value={restaurantName} onChange={(e) => setRestaurantName(e.target.value)} className="input" placeholder="Coastal Grill" autoFocus />
            </Field>
            <Field
              label="URL slug (becomes /r/your-slug/…)"
              hint={restaurantName && !isUsableSlug(restaurantSlug) ? SLUG_HINT : null}
            >
              <input value={restaurantSlug} onChange={(e) => setRestaurantSlug(slugify(e.target.value))} className="input font-mono" placeholder="somtam-zab" />
            </Field>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <Field label="Branch name">
              <input value={branchName} onChange={(e) => setBranchName(e.target.value)} className="input" placeholder="Sukhumvit branch" />
            </Field>
            <Field
              label="Branch URL slug"
              hint={branchName && !isUsableSlug(branchSlug) ? SLUG_HINT : null}
            >
              <input value={branchSlug} onChange={(e) => setBranchSlug(slugify(e.target.value))} className="input font-mono" placeholder="sukhumvit" />
            </Field>
            <Field label="Address (optional)">
              <input value={branchAddress} onChange={(e) => setBranchAddress(e.target.value)} className="input" />
            </Field>
            <Field
              label="Time zone"
              hint="Opening hours, reports and scheduled orders run on this time zone."
            >
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
              <Field label="Primary color">
                <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="h-12 w-full rounded-xl border border-border" />
              </Field>
              <Field label="Accent color">
                <input type="color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} className="h-12 w-full rounded-xl border border-border" />
              </Field>
            </div>
            <div
              className="rounded-2xl p-6 text-white"
              style={{ background: `linear-gradient(135deg, ${primaryColor}, ${accentColor})` }}
            >
              <p className="text-xs uppercase tracking-wider text-white/80">Preview</p>
              <p className="mt-1 font-display text-2xl font-bold">{restaurantName || 'Your restaurant'}</p>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-between">
          {step > 0 ? (
            <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as 0 | 1 | 2)}>Back</Button>
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
              Continue
            </Button>
          ) : (
            <Button variant="gradient" onClick={create} loading={busy} leftIcon={<Sparkles className="h-4 w-4" />}>
              Launch my restaurant
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

function Field({ label, hint, children }: { label: string; hint?: string | null; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
