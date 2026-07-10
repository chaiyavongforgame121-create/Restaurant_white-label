'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Save } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';
import { ClosuresManager } from './closures-manager';
import { DeliverySettingsCard } from './delivery-settings-card';
import { HoursEditor } from './hours-editor';
import { TipSettingsCard } from './tip-settings-card';
import { StorefrontOverrideCard } from './storefront-override-card';

interface Branch {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  theme_override: Record<string, unknown>;
  settings: Record<string, unknown>;
  is_active: boolean;
  custom_domain: string | null;
  sales_tax_rate: number | null;
}

export function BranchSettings({
  branch,
  restaurantStorefront,
}: {
  branch: Branch;
  restaurantStorefront: Record<string, unknown> | null;
}) {
  const router = useRouter();
  const [name, setName] = React.useState(branch.name);
  const [address, setAddress] = React.useState(branch.address ?? '');
  const [isActive, setIsActive] = React.useState(branch.is_active);
  const [customDomain, setCustomDomain] = React.useState(branch.custom_domain ?? '');
  const [salesTaxPercent, setSalesTaxPercent] = React.useState(
    branch.sales_tax_rate != null ? String(Number(branch.sales_tax_rate) * 100) : '',
  );
  const [primaryColor, setPrimaryColor] = React.useState(
    (branch.theme_override?.primaryColor as string) ?? '#FF6B35',
  );
  const [accentColor, setAccentColor] = React.useState(
    (branch.theme_override?.accentColor as string) ?? '#F7B538',
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const parsedRate = salesTaxPercent.trim()
      ? Math.max(0, Math.min(50, Number(salesTaxPercent) || 0)) / 100
      : 0;
    const { error: updateError } = await supabase
      .from('branches')
      .update({
        name,
        address: address || null,
        is_active: isActive,
        custom_domain: customDomain.trim() ? customDomain.trim().toLowerCase() : null,
        sales_tax_rate: parsedRate,
        theme_override: { ...branch.theme_override, primaryColor, accentColor },
      })
      .eq('id', branch.id);
    setSaving(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    router.refresh();
  };

  return (
    <div className="container max-w-3xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Branch settings</h1>
        <p className="mt-1 text-muted-foreground">Identity, theme, and operating parameters</p>
      </header>

      <div className="space-y-5 px-2 lg:px-0">
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">Identity</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Branch name">
              <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
            </Field>
            <Field label="Status">
              <label className="flex h-12 items-center gap-2 rounded-xl border border-border bg-background px-4">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="h-4 w-4"
                />
                <span>{isActive ? 'Active' : 'Hidden'}</span>
                <Badge variant={isActive ? 'success' : 'muted'} className="ml-auto">
                  {isActive ? 'Online' : 'Closed'}
                </Badge>
              </label>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Address">
                <input value={address} onChange={(e) => setAddress(e.target.value)} className="input" />
              </Field>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">Brand theme</h2>
          <p className="text-sm text-muted-foreground">Customer site colors</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <ColorField label="Primary color" value={primaryColor} onChange={setPrimaryColor} />
            <ColorField label="Accent color" value={accentColor} onChange={setAccentColor} />
          </div>
          <div
            className="mt-4 rounded-2xl p-6 text-white shadow-warm"
            style={{
              background: `linear-gradient(135deg, ${primaryColor}, ${accentColor})`,
            }}
          >
            <p className="text-xs uppercase tracking-wider text-white/80">Preview</p>
            <p className="mt-1 font-display text-2xl font-bold">{name}</p>
            <p className="text-sm text-white/85">
              This is how your hero gradient and primary CTAs will look.
            </p>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">Sales tax</h2>
          <p className="text-sm text-muted-foreground">
            US state + local sales tax applied to taxable items. Enter as a percent
            (e.g. <code>8.875</code> for NYC, <code>9.5</code> for LA).
          </p>
          <div className="mt-3 max-w-xs">
            <Field label="Tax rate (%)">
              <input
                value={salesTaxPercent}
                onChange={(e) => setSalesTaxPercent(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                placeholder="0.0"
                className="input"
              />
            </Field>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">Custom domain</h2>
          <p className="text-sm text-muted-foreground">
            Point your DNS A/CNAME to the Favornoms hosting target, then enter the hostname here.
          </p>
          <div className="mt-3">
            <Field label="Hostname (e.g. order.myrestaurant.com)">
              <input
                value={customDomain}
                onChange={(e) => setCustomDomain(e.target.value)}
                placeholder="order.example.com"
                className="input"
              />
            </Field>
          </div>
        </Card>

        <HoursEditor branchId={branch.id} />

        <ClosuresManager branchId={branch.id} />

        <DeliverySettingsCard branchId={branch.id} settings={branch.settings} />

        <TipSettingsCard branchId={branch.id} settings={branch.settings} />

        <StorefrontOverrideCard
          branchId={branch.id}
          settings={branch.settings}
          restaurantStorefront={restaurantStorefront}
        />

        <Card className="p-5">
          <details>
            <summary className="cursor-pointer font-display text-lg font-semibold">
              Advanced: raw settings JSON
            </summary>
            <pre className="mt-3 overflow-x-auto rounded-xl bg-muted p-3 text-xs">
              {JSON.stringify(branch.settings, null, 2)}
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">
              Read-only snapshot of branches.settings — edit via the cards above.
            </p>
          </details>
        </Card>

        {error && (
          <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
        )}

        <Button
          variant="gradient"
          size="xl"
          onClick={save}
          loading={saving}
          leftIcon={<Save className="h-4 w-4" />}
        >
          Save changes
        </Button>
      </div>

      <style jsx>{`
        .input {
          width: 100%;
          height: 48px;
          padding: 0 1rem;
          font-size: 16px;
          border-radius: 0.875rem;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--background));
        }
        .input:focus-visible {
          outline: none;
          border-color: hsl(var(--primary));
          box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-1">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-12 cursor-pointer rounded-lg border-0 bg-transparent"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 bg-transparent text-base font-medium tracking-wider outline-none"
        />
      </div>
    </label>
  );
}
