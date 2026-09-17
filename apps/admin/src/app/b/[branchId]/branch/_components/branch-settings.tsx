'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Save } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { DEFAULT_UI_LOCALE, billingErrorMessage, describeBillingError, isUiLocale } from '@favornoms/shared';
import { Badge, Button, Card } from '@favornoms/ui';
import { AddonUpsellCard } from '@/components/addon-upsell-card';
import { ClosuresManager } from './closures-manager';
import { DeliverySettingsCard } from './delivery-settings-card';
import { HoursEditor } from './hours-editor';
import { PaymentMethodsCard } from './payment-methods-card';
import { DeliveryHoursCard } from './delivery-hours-card';
import { LocationCard } from './location-card';
import { ScheduledOrdersCard } from './scheduled-orders-card';
import { BrandingCard, type BrandingBrand } from './branding-card';
import { ServiceFeeCard } from './service-fee-card';
import { TipSettingsCard } from './tip-settings-card';
import { StorefrontOverrideCard } from './storefront-override-card';

interface Branch {
  id: string;
  restaurant_id: string;
  name: string;
  address: string | null;
  timezone: string;
  theme_override: Record<string, unknown>;
  settings: Record<string, unknown>;
  is_active: boolean;
  custom_domain: string | null;
  sales_tax_rate: number | null;
  geo_lat: number | null;
  geo_lng: number | null;
}

export function BranchSettings({
  branch,
  restaurantStorefront,
  restaurantName,
  brand,
  canUseDelivery,
  canUseCard,
}: {
  branch: Branch;
  restaurantStorefront: Record<string, unknown> | null;
  restaurantName: string;
  brand: BrandingBrand | null;
  canUseDelivery: boolean;
  canUseCard: boolean;
}) {
  const t = useTranslations('branch');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const router = useRouter();
  const [name, setName] = React.useState(branch.name);
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
  // Branch colours win over the brand's on the storefront, so a branch may only carry its own
  // once someone picks them. The pickers start on the platform orange when the branch has
  // none, and "Save changes" used to write that orange back every time: renaming a new
  // branch repainted its storefront orange over the owner's brand colours.
  const [primaryTouched, setPrimaryTouched] = React.useState(false);
  const [accentTouched, setAccentTouched] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [seatLimit, setSeatLimit] = React.useState<{ used: number; seats: number } | null>(null);

  const save = async () => {
    const domain = normaliseCustomDomain(customDomain);
    if (domain.invalid != null) {
      setError(t('settings.domain.invalid', { input: domain.invalid }));
      return;
    }
    setSaving(true);
    setError(null);
    setSeatLimit(null);
    const supabase = getBrowserClient();
    const parsedRate = salesTaxPercent.trim()
      ? Math.max(0, Math.min(50, Number(salesTaxPercent) || 0)) / 100
      : 0;
    const { error: updateError } = await supabase
      .from('branches')
      .update({
        name,
        is_active: isActive,
        custom_domain: domain.value,
        sales_tax_rate: parsedRate,
        // Colours the branch already had stay as they are through the spread; only a picker
        // the owner actually moved is written.
        theme_override: {
          ...branch.theme_override,
          ...(primaryTouched ? { primaryColor } : {}),
          ...(accentTouched ? { accentColor } : {}),
        },
      })
      .eq('id', branch.id);
    setSaving(false);
    if (updateError) {
      // Hiding a branch frees its seat, so switching it back on needs a free seat again and
      // the database refuses with plan_limit_exceeded:branches:<used>/<seats>. The raw code
      // told the owner nothing about what to do next.
      const billing = describeBillingError(updateError);
      if (billing?.kind === 'seats') {
        setSeatLimit({ used: billing.current, seats: billing.limit });
        return;
      }
      console.error('Saving branch settings failed', updateError);
      if (billing) {
        setError(billingErrorMessage(billing, locale));
      } else if (updateError.message.includes('branch_privileged_column_forbidden')) {
        setError(t('errors.ownerOnlyDomain'));
      } else if (updateError.message.includes('branch_manager_required')) {
        setError(t('errors.managerRequired'));
      } else if (updateError.code === '23505' && /custom_domain/.test(updateError.message)) {
        setError(t('errors.domainTaken'));
      } else if (updateError.code === '42501') {
        setError(t('errors.noPermission'));
      } else {
        setError(t('errors.generic'));
      }
      return;
    }
    router.refresh();
  };

  return (
    <div className="container max-w-3xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('settings.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('settings.subtitle')}</p>
      </header>

      <div className="space-y-5 px-2 lg:px-0">
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('settings.identity.title')}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.identity.branchName')}>
              <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
            </Field>
            <Field label={t('settings.identity.status')}>
              <label className="flex h-12 items-center gap-2 rounded-xl border border-border bg-background px-4">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="h-4 w-4"
                />
                <span>{isActive ? t('settings.identity.active') : t('settings.identity.hidden')}</span>
                <Badge variant={isActive ? 'success' : 'muted'} className="ml-auto">
                  {isActive ? t('settings.identity.online') : t('settings.identity.closed')}
                </Badge>
              </label>
            </Field>
          </div>
        </Card>

        {/* Address lives here, not in Identity. Editing branches.address directly leaves
            geo_location behind, and every delivery decision is made from the pin — so the
            two have to move together, which is what set_branch_location enforces. */}
        <LocationCard
          branch={{
            id: branch.id,
            address: branch.address,
            geo_lat: branch.geo_lat,
            geo_lng: branch.geo_lng,
            timezone: branch.timezone,
          }}
        />

        {/* Next to Brand theme on purpose: colours, logo and icon are one decision, and the
            merchant looks for all three in the same place. */}
        <BrandingCard
          restaurantId={branch.restaurant_id}
          restaurantName={restaurantName}
          brand={brand}
        />

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('settings.theme.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('settings.theme.subtitle')}</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <ColorField
              label={t('settings.theme.primary')}
              value={primaryColor}
              onChange={(v) => {
                setPrimaryColor(v);
                setPrimaryTouched(true);
              }}
            />
            <ColorField
              label={t('settings.theme.accent')}
              value={accentColor}
              onChange={(v) => {
                setAccentColor(v);
                setAccentTouched(true);
              }}
            />
          </div>
          <div
            className="mt-4 rounded-2xl p-6 text-white shadow-warm"
            style={{
              background: `linear-gradient(135deg, ${primaryColor}, ${accentColor})`,
            }}
          >
            <p className="text-xs uppercase tracking-wider text-white/80">{t('settings.theme.preview')}</p>
            <p className="mt-1 font-display text-2xl font-bold">{name}</p>
            <p className="text-sm text-white/85">{t('settings.theme.previewHint')}</p>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('settings.tax.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t.rich('settings.tax.description', { code: (chunks) => <code>{chunks}</code> })}
          </p>
          <div className="mt-3 max-w-xs">
            <Field label={t('settings.tax.rate')}>
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
          <h2 className="font-display text-lg font-semibold">{t('settings.domain.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('settings.domain.description')}</p>
          <div className="mt-3">
            <Field label={t('settings.domain.label')}>
              <input
                value={customDomain}
                onChange={(e) => setCustomDomain(e.target.value)}
                placeholder="order.example.com"
                className="input"
              />
            </Field>
          </div>
        </Card>

        <HoursEditor branchId={branch.id} timezone={branch.timezone} />

        <ClosuresManager branchId={branch.id} timezone={branch.timezone} />


        {/* Sits directly after Opening hours on purpose: the picker's available times

            ARE those hours, so the two are read together. */}

        <ScheduledOrdersCard branchId={branch.id} settings={branch.settings} />

        {canUseDelivery ? (
          <>
            <DeliverySettingsCard branchId={branch.id} settings={branch.settings} />
            {/* Grouped with the other delivery settings and behind the same entitlement:
                delivery hours and self-delivery are meaningless without the add-on. */}
            <DeliveryHoursCard branchId={branch.id} settings={branch.settings} />
          </>
        ) : (
          <AddonUpsellCard
            branchId={branch.id}
            title={t('settings.delivery.title')}
            addon="delivery"
            price={49}
            description={t('settings.delivery.description')}
            bullets={[
              t('settings.delivery.bulletFees'),
              t('settings.delivery.bulletDispatch'),
              t('settings.delivery.bulletTracking'),
            ]}
          />
        )}

        <PaymentMethodsCard
          branchId={branch.id}
          restaurantId={branch.restaurant_id}
          settings={branch.settings}
          canUseCard={canUseCard}
        />

        {/* Card-only surcharge, so it sits directly under Payment methods — the two are
            read together, and the fee is dead without the card entitlement. */}
        <ServiceFeeCard branchId={branch.id} settings={branch.settings} canUseCard={canUseCard} />

        <TipSettingsCard branchId={branch.id} settings={branch.settings} />

        <StorefrontOverrideCard
          branchId={branch.id}
          restaurantId={branch.restaurant_id}
          settings={branch.settings}
          restaurantStorefront={restaurantStorefront}
        />

        <Card className="p-5">
          <details>
            <summary className="cursor-pointer font-display text-lg font-semibold">
              {t('settings.advanced.title')}
            </summary>
            <pre className="mt-3 overflow-x-auto rounded-xl bg-muted p-3 text-xs">
              {JSON.stringify(branch.settings, null, 2)}
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">{t('settings.advanced.hint')}</p>
          </details>
        </Card>

        {error && (
          <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
        )}

        {seatLimit && (
          <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {t.rich('settings.seatLimit', {
              seats: seatLimit.seats,
              link: (chunks) => (
                <Link href={`/b/${branch.id}/settings/plan`} className="font-medium underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        )}

        <Button
          variant="gradient"
          size="xl"
          onClick={save}
          loading={saving}
          leftIcon={<Save className="h-4 w-4" />}
        >
          {t('settings.save')}
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

/**
 * A custom domain is a HOSTNAME, and the field never checked that it was one — a live
 * branch had "hamburger" saved in it, which is the branch's name typed into the wrong box.
 * That row is what the storefront asks about every unrecognised Host header, and since the
 * per-branch manifest now decides a PWA's identity from the same answer, junk here stops
 * being cosmetic. Paste-tolerant: a merchant copying from their browser bar sends
 * "https://order.example.com/" and means order.example.com.
 *
 * `invalid` carries what the merchant typed when it is not a hostname; the caller words the
 * message in the interface language.
 */
function normaliseCustomDomain(raw: string): { value: string | null; invalid: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, invalid: null };
  const host = trimmed
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    return { value: null, invalid: trimmed };
  }
  return { value: host, invalid: null };
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
