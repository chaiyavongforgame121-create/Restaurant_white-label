'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChefHat, ChevronRight, Sparkles } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

export function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = React.useState<0 | 1 | 2>(0);
  const [restaurantName, setRestaurantName] = React.useState('');
  const [restaurantSlug, setRestaurantSlug] = React.useState('');
  const [branchName, setBranchName] = React.useState('Main');
  const [branchSlug, setBranchSlug] = React.useState('main');
  const [branchAddress, setBranchAddress] = React.useState('');
  const [primaryColor, setPrimaryColor] = React.useState('#FF6B35');
  const [accentColor, setAccentColor] = React.useState('#F7B538');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (restaurantName && !restaurantSlug) setRestaurantSlug(slugify(restaurantName));
  }, [restaurantName, restaurantSlug]);

  const create = async () => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      router.push('/login?next=/onboarding');
      return;
    }
    const { data, error: rpcErr } = await supabase.rpc('create_restaurant_with_branch', {
      p_restaurant_name: restaurantName,
      p_restaurant_slug: restaurantSlug,
      p_branch_name: branchName,
      p_branch_slug: branchSlug,
      p_branch_address: branchAddress || null,
      p_theme: { primaryColor, accentColor, brandName: restaurantName },
    });
    setBusy(false);
    if (rpcErr) {
      const { describePlanError } = await import('@favornoms/database/queries');
      const planErr = describePlanError(rpcErr);
      if (planErr) {
        setError(
          `Your current plan only allows ${planErr.limit} ${planErr.key}. Please upgrade before adding more.`,
        );
      } else {
        setError(rpcErr.message);
      }
      return;
    }
    const r = data as { branch_id?: string } | null;
    if (r?.branch_id) router.push(`/b/${r.branch_id}/dashboard`);
  };

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
            <Field label="URL slug (becomes /r/your-slug/…)">
              <input value={restaurantSlug} onChange={(e) => setRestaurantSlug(slugify(e.target.value))} className="input font-mono" placeholder="somtam-zab" />
            </Field>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <Field label="Branch name">
              <input value={branchName} onChange={(e) => setBranchName(e.target.value)} className="input" placeholder="Sukhumvit branch" />
            </Field>
            <Field label="Branch URL slug">
              <input value={branchSlug} onChange={(e) => setBranchSlug(slugify(e.target.value))} className="input font-mono" placeholder="sukhumvit" />
            </Field>
            <Field label="Address (optional)">
              <input value={branchAddress} onChange={(e) => setBranchAddress(e.target.value)} className="input" />
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

        {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        <div className="flex justify-between">
          {step > 0 ? (
            <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as 0 | 1 | 2)}>Back</Button>
          ) : <span />}
          {step < 2 ? (
            <Button
              variant="gradient"
              onClick={() => setStep((s) => (s + 1) as 0 | 1 | 2)}
              disabled={step === 0 ? !restaurantName : !branchName}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-sm font-medium">{label}</span>{children}</label>;
}
