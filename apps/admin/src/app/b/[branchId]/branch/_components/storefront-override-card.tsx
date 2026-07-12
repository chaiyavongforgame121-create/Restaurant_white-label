'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LayoutGrid } from 'lucide-react';
import {
  MENU_CARD_STYLE_LABELS,
  MENU_LAYOUT_LABELS,
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
      setError(upErr.message);
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  const layoutOptions: Array<{ value: MenuLayout | null; label: string }> = [
    { value: null, label: `Inherit · ${MENU_LAYOUT_LABELS[base.menuLayout]}` },
    ...(['list', 'grid2', 'grid3', 'grid4'] as const).map((v) => ({
      value: v,
      label: MENU_LAYOUT_LABELS[v],
    })),
  ];
  const cardOptions: Array<{ value: MenuCardStyle | null; label: string }> = [
    { value: null, label: `Inherit · ${MENU_CARD_STYLE_LABELS[base.menuCardStyle]}` },
    ...(['standard', 'compact'] as const).map((v) => ({
      value: v,
      label: MENU_CARD_STYLE_LABELS[v],
    })),
  ];

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <LayoutGrid className="h-5 w-5 text-primary" /> Menu layout
        </h2>
        {savedAt && !saving && <span className="text-sm text-success">Saved ✓</span>}
      </div>
      <p className="text-sm text-muted-foreground">
        Override how this branch&apos;s menu looks. Leave on <em>Inherit</em> to follow the
        restaurant-wide setting from Brands &rsaquo; Storefront appearance.
      </p>

      <div className="mt-4 space-y-4">
        <div>
          <p className="mb-1.5 text-sm font-medium">Layout</p>
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
          <p className="mb-1.5 text-sm font-medium">Card style</p>
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
          <p className="mb-1.5 text-sm font-medium">Hero headline</p>
          <input
            value={heroTitleText}
            onChange={(e) => setHeroTitleText(e.target.value)}
            onBlur={() => save({ ...override, heroTitle: heroTitleText.trim() || null })}
            disabled={saving}
            placeholder={base.heroTitle || 'Welcome — order something delicious'}
            className="h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus-visible:border-primary"
          />
          <p className="mt-1 text-xs text-muted-foreground">Leave empty to inherit the restaurant-wide headline.</p>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">Hero tagline</p>
          <input
            value={heroSubtitleText}
            onChange={(e) => setHeroSubtitleText(e.target.value)}
            onBlur={() => save({ ...override, heroSubtitle: heroSubtitleText.trim() || null })}
            disabled={saving}
            placeholder={base.heroSubtitle || 'Now serving from your city'}
            className="h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus-visible:border-primary"
          />
          <p className="mt-1 text-xs text-muted-foreground">Leave empty to inherit the restaurant-wide tagline.</p>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">Hero image</p>
          <ImageUpload
            restaurantId={restaurantId}
            folder="hero"
            value={override.heroUrl}
            onChange={(url) => save({ ...override, heroUrl: url })}
            aspect="aspect-video"
            label="Upload hero image"
          />
          <p className="mt-1 text-xs text-muted-foreground">Leave empty to inherit the restaurant-wide image.</p>
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Effective on the storefront: {MENU_LAYOUT_LABELS[effective.menuLayout]} ·{' '}
        {MENU_CARD_STYLE_LABELS[effective.menuCardStyle]}
      </p>

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}
    </Card>
  );
}
