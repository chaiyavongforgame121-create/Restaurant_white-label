'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { LayoutGrid } from 'lucide-react';
import {
  DEFAULT_UI_LOCALE,
  isUiLocale,
  menuCardStyleLabel,
  menuLayoutLabel,
  mergeStorefrontOverride,
  parseStorefront,
  parseStorefrontOverride,
  serializeStorefrontOverride,
  type MenuCardStyle,
  type MenuLayout,
  type StorefrontOverride,
} from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Card } from '@favornoms/ui';
import { ImageUpload } from '@/components/image-upload';

// Per-branch override of the restaurant-wide storefront appearance. Stored under
// branches.settings.storefront_override (jsonb). Each control can be left on
// 'Inherit' (null) to follow the restaurant value set in Brands > Storefront.

interface Props {
  branchId: string;
  restaurantId: string;
  settings: Record<string, unknown>;
  restaurantStorefront: Record<string, unknown> | null;
}

export function StorefrontOverrideCard({ branchId, restaurantId, settings, restaurantStorefront }: Props) {
  const t = useTranslations('branch');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const router = useRouter();
  const base = React.useMemo(() => parseStorefront(restaurantStorefront), [restaurantStorefront]);
  const [override, setOverride] = React.useState<StorefrontOverride>(() =>
    parseStorefrontOverride(settings?.storefront_override ?? null),
  );
  const [heroTitleText, setHeroTitleText] = React.useState(
    () => parseStorefrontOverride(settings?.storefront_override ?? null).heroTitle ?? '',
  );
  const [heroSubtitleText, setHeroSubtitleText] = React.useState(
    () => parseStorefrontOverride(settings?.storefront_override ?? null).heroSubtitle ?? '',
  );
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const effective = mergeStorefrontOverride(base, override);

  const save = async (next: StorefrontOverride) => {
    setOverride(next);
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase
      .from('branches')
      .update({ settings: { ...settings, storefront_override: serializeStorefrontOverride(next) } })
      .eq('id', branchId);
    setSaving(false);
    if (upErr) {
      console.error('Saving the menu layout override failed', upErr);
      setError(
        upErr.message.includes('branch_manager_required')
          ? t('errors.managerRequired')
          : upErr.code === '42501'
            ? t('errors.noPermission')
            : t('errors.generic'),
      );
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  const layoutOptions: Array<{ value: MenuLayout | null; label: string }> = [
    { value: null, label: t('storefront.inherit', { label: menuLayoutLabel(base.menuLayout, locale) }) },
    ...(['list', 'grid2', 'grid3', 'grid4'] as const).map((v) => ({
      value: v,
      label: menuLayoutLabel(v, locale),
    })),
  ];
  const cardOptions: Array<{ value: MenuCardStyle | null; label: string }> = [
    { value: null, label: t('storefront.inherit', { label: menuCardStyleLabel(base.menuCardStyle, locale) }) },
    ...(['standard', 'compact'] as const).map((v) => ({
      value: v,
      label: menuCardStyleLabel(v, locale),
    })),
  ];

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <LayoutGrid className="h-5 w-5 text-primary" /> {t('storefront.title')}
        </h2>
        {savedAt && !saving && <span className="text-sm text-success">{t('storefront.saved')}</span>}
      </div>
      <p className="text-sm text-muted-foreground">
        {t.rich('storefront.description', { em: (chunks) => <em>{chunks}</em> })}
      </p>

      <div className="mt-4 space-y-4">
        <div>
          <p className="mb-1.5 text-sm font-medium">{t('storefront.layout')}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {layoutOptions.map((opt) => {
              const active = override.menuLayout === opt.value;
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  disabled={saving}
                  onClick={() => save({ ...override, menuLayout: opt.value })}
                  className={`rounded-xl border px-3 py-2 text-sm transition ${
                    active ? 'border-primary bg-primary/5 font-medium' : 'border-border bg-card'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">{t('storefront.cardStyle')}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {cardOptions.map((opt) => {
              const active = override.menuCardStyle === opt.value;
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  disabled={saving}
                  onClick={() => save({ ...override, menuCardStyle: opt.value })}
                  className={`rounded-xl border px-3 py-2 text-sm transition ${
                    active ? 'border-primary bg-primary/5 font-medium' : 'border-border bg-card'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">{t('storefront.heroHeadline')}</p>
          <input
            value={heroTitleText}
            onChange={(e) => setHeroTitleText(e.target.value)}
            onBlur={() => save({ ...override, heroTitle: heroTitleText.trim() || null })}
            disabled={saving}
            placeholder={base.heroTitle || t('storefront.heroHeadlinePlaceholder')}
            className="h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus-visible:border-primary"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('storefront.heroHeadlineHint')}</p>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">{t('storefront.heroTagline')}</p>
          <input
            value={heroSubtitleText}
            onChange={(e) => setHeroSubtitleText(e.target.value)}
            onBlur={() => save({ ...override, heroSubtitle: heroSubtitleText.trim() || null })}
            disabled={saving}
            placeholder={base.heroSubtitle || t('storefront.heroTaglinePlaceholder')}
            className="h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus-visible:border-primary"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('storefront.heroTaglineHint')}</p>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">{t('storefront.heroImage')}</p>
          <ImageUpload
            restaurantId={restaurantId}
            folder="hero"
            value={override.heroUrl}
            onChange={(url) => save({ ...override, heroUrl: url })}
            aspect="aspect-video"
            label={t('storefront.uploadHeroImage')}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('storefront.heroImageHint')}</p>
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {t('storefront.effective', {
          layout: menuLayoutLabel(effective.menuLayout, locale),
          cardStyle: menuCardStyleLabel(effective.menuCardStyle, locale),
        })}
      </p>

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}
    </Card>
  );
}
