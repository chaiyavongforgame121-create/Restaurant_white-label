'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Lock, Save } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { DEFAULT_UI_LOCALE, billingErrorMessage, describeBillingError, isUiLocale } from '@favornoms/shared';
import { Badge, Button, Card } from '@favornoms/ui';
import { AddonUpsellCard } from '@/components/addon-upsell-card';
import { oneTimePriceToShow } from '@/lib/delivery-gate-model';
import { ClosuresManager } from './closures-manager';
import { DeliverySettingsCard } from './delivery-settings-card';
import { HoursEditor } from './hours-editor';
import { PaymentMethodsCard } from './payment-methods-card';
import { CardPaymentsCard, type CardPaymentsAccountRow } from './card-payments-card';
import type { CardAccountState } from './card-payments-model';
import { DeliveryHoursCard } from './delivery-hours-card';
import { LocationCard } from './location-card';
import { ScheduledOrdersCard } from './scheduled-orders-card';
import { BrandingCard, type BrandingCardData } from './branding-card';
import { ServiceFeeCard } from './service-fee-card';
import { TipSettingsCard } from './tip-settings-card';
import { useSettingsPatch } from './patch-settings';
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
  branding,
  canUseDelivery,
  deliveryPrices,
  canUseCard,
  canEditSettings,
  cardPayments,
}: {
  branch: Branch;
  restaurantStorefront: Record<string, unknown> | null;
  /** This branch's own logo and icons, and the brand name and defaults the card previews with. */
  branding: BrandingCardData;
  /** Delivery is sold per branch — THIS branch's answer, not the restaurant's. */
  canUseDelivery: boolean;
  /** What turning delivery on for THIS branch costs, straight from billing_products. Either
   *  number is null when it could not be read; the card then leaves it out. `once` is 0 when
   *  `alreadyUnlocked`: the branch paid its one-time unlock before and switched delivery off,
   *  so switching it back on costs only the monthly price. */
  deliveryPrices: {
    once: number | null;
    monthly: number | null;
    alreadyUnlocked: boolean;
    planHref: string;
  };
  canUseCard: boolean;
  /** branch.settings (owner and admin): what patch_branch_settings requires for the cards below. */
  canEditSettings: boolean;
  /** The branch's Stripe account and the restaurant's other ones, as RLS let the page read them. */
  cardPayments: {
    account: CardAccountState | null;
    restaurantAccounts: CardPaymentsAccountRow[];
    /** billing.manage: may connect, share and disconnect. */
    canConnect: boolean;
    /** branch.settings: may see the account at all. */
    canView: boolean;
  };
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
  // 0% can be the right rate (prices that already include tax). The dashboard's setup checklist
  // asks about a 0% branch until this is ticked; it lives in settings, not in a column.
  const [zeroTaxConfirmed, setZeroTaxConfirmed] = React.useState(
    branch.settings?.sales_tax_zero_confirmed === true,
  );
  const saveSettingsPatch = useSettingsPatch(branch.id, () => ({
    sales_tax_zero_confirmed: branch.settings?.sales_tax_zero_confirmed === true,
  }));
  const taxIsZero = !(Number(salesTaxPercent) > 0);
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
    // First, so a refusal (it needs the branch settings permission) stops the save before the
    // columns below are written. Nothing is sent when the tick did not change.
    if (parsedRate === 0) {
      const { error: flagError } = await saveSettingsPatch({ sales_tax_zero_confirmed: zeroTaxConfirmed });
      if (flagError) {
        setSaving(false);
        console.error('Saving the 0% sales tax answer failed', flagError);
        setError(flagError.code === '42501' ? t('errors.noPermission') : t('errors.generic'));
        return;
      }
    }
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
            merchant looks for all three in the same place. The saved branch name, not the input
            above: the storefront name only changes once Save changes has run. */}
        <BrandingCard
          branchId={branch.id}
          restaurantId={branch.restaurant_id}
          branchName={branch.name}
          {...branding}
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
          {taxIsZero && (
            <label className="mt-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={zeroTaxConfirmed}
                // Saved through patch_branch_settings, like the cards below.
                disabled={!canEditSettings}
                onChange={(e) => setZeroTaxConfirmed(e.target.checked)}
                className="mt-1"
              />
              <span>
                {t('settings.tax.zeroConfirmed')}
                <span className="block text-xs text-muted-foreground">{t('settings.tax.zeroConfirmedHint')}</span>
              </span>
            </label>
          )}
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

        {/* Every card from here to the storefront layout saves through patch_branch_settings,
            which needs branch.settings. Without it (a manager) they are shown but locked: a
            disabled fieldset disables every control inside, the QR uploader's included. */}
        <fieldset disabled={!canEditSettings} className="m-0 min-w-0 space-y-5 border-0 p-0">
          {!canEditSettings && (
            <p className="flex items-start gap-2 rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('settings.readOnly')}</span>
            </p>
          )}

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
              // Read from billing_products, never written here: this card said $49 while the
              // catalog said $59 for months. Delivery is bought per branch, so the link
              // carries the branch and the description names it.
              price={deliveryPrices.monthly ?? undefined}
              // A 0 (the unlock was paid before) is left out rather than printed as "$0
              // once", and the description says why.
              oneTimePrice={oneTimePriceToShow(deliveryPrices.once)}
              href={deliveryPrices.planHref}
              description={
                deliveryPrices.alreadyUnlocked
                  ? t('settings.delivery.descriptionUnlocked', { branch: branch.name })
                  : t('settings.delivery.description', { branch: branch.name })
              }
              bullets={[
                t('settings.delivery.bulletFees'),
                t('settings.delivery.bulletDispatch'),
                t('settings.delivery.bulletTracking'),
              ]}
            />
          )}

          {/* Where the branch's card money is paid, directly above the methods it enables: the
              card method reaches diners only once this account can take charges. */}
          <CardPaymentsCard
            branchId={branch.id}
            branchName={branch.name}
            account={cardPayments.account}
            restaurantAccounts={cardPayments.restaurantAccounts}
            canConnect={cardPayments.canConnect}
            canView={cardPayments.canView}
            canUseCard={canUseCard}
          />

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
        </fieldset>

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
