'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, ExternalLink, Lock, Palette, Plus, Save, Settings, Star } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import type { Json } from '@favornoms/database/types';
import {
  DEFAULT_UI_LOCALE,
  canAddBranch,
  describeBillingError,
  intlLocaleFor,
  isUiLocale,
  menuCardStyleLabel,
  menuLayoutLabel,
  parseStorefront,
  serializeStorefront,
  type Entitlements,
  type StorefrontSettings,
} from '@favornoms/shared';
import { Badge, Button, Card, IconButton } from '@favornoms/ui';
import { ImageUpload } from '@/components/image-upload';
import { IconUpload, type IconSet } from '@/components/icon-upload';
import { parseIconStyle, type IconStyle } from '@/components/icon-geometry';
import { storefrontAppName } from '../../branch/_components/branding-card';
import { TimezoneSelect, deviceTimeZone } from '../../branch/_components/timezone-select';

interface Brand {
  id: string;
  slug: string;
  name: string;
  theme: Record<string, unknown>;
  logo_url: string | null;
  favicon_url: string | null;
  icon_192_url: string | null;
  icon_512_url: string | null;
  icon_maskable_512_url: string | null;
  is_default: boolean;
  created_at: string;
}

interface BranchRow {
  id: string;
  name: string;
  /** Null only when the read left it out; used to keep a suggested slug unique. */
  slug: string | null;
  brand_id: string | null;
  is_active: boolean;
  timezone: string;
  /** The public menu address: the branch's custom domain when set, else
   *  /r/<restaurant>/<branch>. Null when a slug is missing. */
  storefront_url: string | null;
}

/** What the Create brand button inserts, worked out by the page from the restaurant row. */
interface NewBrandSeed {
  /** Merchant text (the restaurant's name), stored as brands.name, so never translated. */
  name: string;
  /** The restaurant's own theme (restaurants.brand_settings without brandName and logoUrl). */
  theme: Record<string, unknown>;
}

interface Props {
  restaurantId: string;
  restaurantName: string;
  newBrand: NewBrandSeed;
  currentBranchId: string;
  /**
   * The owner, a restaurant-wide admin or a platform admin: the only people the restaurants and
   * brands policies let change the shared storefront defaults and the brand. A branch-scoped admin
   * still opens this page (brand.edit) to add a branch, but those editors are read-only for them.
   */
  canEditShared: boolean;
  /** Per active branch, what the viewer may copy from it into a new branch. */
  copyCaps: Record<string, CopyCaps>;
  brands: Brand[];
  branches: BranchRow[];
  storefront: Record<string, unknown>;
  entitlements: Entitlements;
}

/** The capabilities copy_branch_setup asks for at the source branch. */
export interface CopyCaps {
  /** menu.manage: the menu, combos included. */
  menu: boolean;
  /** branch.settings: hours, settings, tax and the look. */
  settings: boolean;
  /** loyalty.manage: the loyalty programme and rewards. */
  loyalty: boolean;
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

/** slugify for a field being typed into: a trailing hyphen stays, or "down-town" could never
 *  be typed (the hyphen vanished the moment it was pressed). slugify() tidies it on save. */
const typedSlug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-/, '').slice(0, 64);

/**
 * The slug suggested for a new branch's name. A Thai or Vietnamese name has no a-z to make one
 * from, which used to leave the field empty and the dialog answering "Enter a branch name and a
 * URL slug" to an owner who had typed both they could. Falls back to branch-<n>, and a slug another
 * branch of this restaurant already uses gets the first free number.
 */
function suggestSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name);
  if (base.length >= 2 && !taken.has(base)) return base;
  const stem = base.length >= 2 ? base.slice(0, 58).replace(/-$/, '') : 'branch';
  for (let n = Math.max(2, taken.size + 1); n < 10_000; n++) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now().toString(36)}`;
}

const BRAND_COLUMNS =
  'id, slug, name, theme, logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url, is_default, created_at';

/** A database error in words a merchant can use; the raw text only goes to the console. */
function dbErrorKey(err: { message: string; code?: string }): 'errors.permissionDenied' | 'errors.generic' {
  console.error(err.message);
  return err.code === '42501' ? 'errors.permissionDenied' : 'errors.generic';
}

export function BrandsManager({
  restaurantId,
  restaurantName,
  newBrand,
  currentBranchId,
  canEditShared,
  copyCaps,
  brands: initialBrands,
  branches,
  storefront,
  entitlements,
}: Props) {
  const t = useTranslations('brands');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const router = useRouter();
  const [brands, setBrands] = React.useState(initialBrands);
  const [editing, setEditing] = React.useState<Brand | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [store, setStore] = React.useState(() => parseStorefront(storefront));
  const [storeSaving, setStoreSaving] = React.useState(false);
  const [storeSaved, setStoreSaved] = React.useState(false);
  const [addingBranch, setAddingBranch] = React.useState(false);
  const [creatingBrand, setCreatingBrand] = React.useState(false);
  const [createBrandError, setCreateBrandError] = React.useState<string | null>(null);

  /** The restaurant's brands as the database has them now, or null when the read failed. */
  const loadBrands = async (): Promise<Brand[] | null> => {
    const supabase = getBrowserClient();
    const { data, error: readErr } = await supabase
      .from('brands')
      .select(BRAND_COLUMNS)
      .eq('restaurant_id', restaurantId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    if (readErr) {
      console.error(readErr.message);
      return null;
    }
    return (data ?? []) as unknown as Brand[];
  };

  const refresh = async () => {
    const next = await loadBrands();
    if (next) setBrands(next);
  };

  /**
   * The restaurant's one brand, for a restaurant that has none. Nothing else creates it:
   * create_restaurant_with_branch never inserts a brands row, and the Branding card on Branch
   * settings writes only its own branch (20260917150000_branch_own_identity). RLS
   * (brands_default_brand_insert) lets the owner or a brand.edit holder insert the first brand
   * and refuses any second one, so pressing this twice, or in two tabs, cannot make two.
   */
  const createBrand = async () => {
    setCreatingBrand(true);
    setCreateBrandError(null);
    const supabase = getBrowserClient();
    const name = newBrand.name.trim();
    // A Thai or Vietnamese name has no a-z to make a slug from. The slug is only an identifier the
    // editor lets the owner change, so a taken one is retried once with part of this restaurant's
    // id rather than stopping the owner at a field they never saw.
    const base = slugify(name) || 'brand';
    const slugs = [base, `${base.slice(0, 55)}-${restaurantId.replace(/-/g, '').slice(0, 8)}`];
    let failure: { message: string; code?: string } | null = null;
    for (const slug of slugs) {
      const { data, error: insErr } = await supabase
        .from('brands')
        .insert({
          restaurant_id: restaurantId,
          name,
          slug,
          is_default: true,
          theme: newBrand.theme as Json,
        })
        .select(BRAND_COLUMNS)
        .single();
      if (!insErr && data) {
        const created = data as unknown as Brand;
        setCreatingBrand(false);
        setBrands([created]);
        setEditing(created);
        router.refresh();
        return;
      }
      failure = insErr;
      if (!(insErr?.code === '23505' && insErr.message.includes('slug'))) break;
    }

    // Refused. The usual reason is that the brand exists already (another tab or another owner
    // made it first), which RLS reports as 42501, exactly like a missing permission. Look before
    // blaming the role, and open the brand that is there.
    const current = await loadBrands();
    setCreatingBrand(false);
    if (current && current.length > 0) {
      setBrands(current);
      setEditing(current[0] ?? null);
      router.refresh();
      return;
    }
    if (failure) console.error(failure.message);
    setCreateBrandError(
      failure?.code === '42501' ? t('brandList.errors.notAllowed') : t('errors.generic'),
    );
  };

  const saveStorefront = async (next: StorefrontSettings) => {
    if (!canEditShared) return;
    const previous = store;
    setStore(next);
    setStoreSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    // .select() so an update RLS filters out (zero rows, no error) is reported as refused
    // instead of showing "Saved" for a change that never happened.
    const { data: savedRows, error: upErr } = await supabase
      .from('restaurants')
      .update({ storefront: serializeStorefront(next) })
      .eq('id', restaurantId)
      .select('id');
    setStoreSaving(false);
    if (upErr || !savedRows || savedRows.length === 0) {
      setStore(previous);
      setError(t(upErr ? dbErrorKey(upErr) : 'errors.permissionDenied'));
      return;
    }
    setStoreSaved(true);
    setTimeout(() => setStoreSaved(false), 2000);
    router.refresh();
  };

  const branchCountByBrand = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const b of branches) {
      const key = b.brand_id ?? '_unassigned';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [branches]);

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('header.title')}</h1>
          <p className="mt-1 text-muted-foreground">
            {t('header.subtitle', { restaurant: restaurantName })}
          </p>
        </div>
      </header>

      {/* No loyalty "pool" switch any more: every branch runs its own loyalty programme, with
          its own points, rewards and settings, on its own Loyalty page
          (20260918120000_loyalty_per_branch locks restaurants.loyalty_scope to 'branch'). */}

      <Card className="mb-6 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">{t('storefront.title')}</h2>
          {storeSaved && <span className="text-sm text-success">{t('storefront.saved')}</span>}
        </div>
        <p className="text-sm text-muted-foreground">{t('storefront.description')}</p>
        {!canEditShared && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('shared.ownerOnly')}</span>
          </p>
        )}
        {/* A disabled fieldset disables every control inside it, the image uploader's included. */}
        <fieldset disabled={!canEditShared} className="mt-4 min-w-0 space-y-4 disabled:opacity-60">
          <div>
            <p className="mb-1.5 text-sm font-medium">{t('storefront.menuLayout')}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(['list', 'grid2', 'grid3', 'grid4'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  disabled={storeSaving}
                  onClick={() => saveStorefront({ ...store, menuLayout: opt })}
                  className={`rounded-xl border px-3 py-2 text-sm transition ${
                    store.menuLayout === opt ? 'border-primary bg-primary/5 font-medium' : 'border-border bg-card'
                  }`}
                >
                  {menuLayoutLabel(opt, locale)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">{t('storefront.cardStyle')}</p>
            <div className="grid grid-cols-2 gap-2">
              {(['standard', 'compact'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  disabled={storeSaving}
                  onClick={() => saveStorefront({ ...store, menuCardStyle: opt })}
                  className={`rounded-xl border px-3 py-2 text-sm transition ${
                    store.menuCardStyle === opt ? 'border-primary bg-primary/5 font-medium' : 'border-border bg-card'
                  }`}
                >
                  {menuCardStyleLabel(opt, locale)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">{t('storefront.heroTitle')}</p>
            <input
              value={store.heroTitle}
              onChange={(e) => setStore({ ...store, heroTitle: e.target.value })}
              onBlur={(e) => saveStorefront({ ...store, heroTitle: e.target.value })}
              placeholder={t('storefront.heroTitlePlaceholder')}
              className="h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus-visible:border-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('storefront.heroTitleHint')}</p>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">{t('storefront.heroSubtitle')}</p>
            <input
              value={store.heroSubtitle}
              onChange={(e) => setStore({ ...store, heroSubtitle: e.target.value })}
              onBlur={(e) => saveStorefront({ ...store, heroSubtitle: e.target.value })}
              placeholder={t('storefront.heroSubtitlePlaceholder')}
              className="h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus-visible:border-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('storefront.heroSubtitleHint')}</p>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">{t('storefront.heroImage')}</p>
            <ImageUpload
              restaurantId={restaurantId}
              folder="hero"
              value={store.heroUrl}
              onChange={(url) => saveStorefront({ ...store, heroUrl: url })}
              aspect="aspect-video"
              label={t('storefront.uploadHero')}
            />
          </div>
        </fieldset>
      </Card>

      <Card className="mb-6 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold">{t('branches.title')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('branches.description', { restaurant: restaurantName })}
            </p>
          </div>
          {/* Pay first, then create (owner decision 2026-07-25). The branches
              trigger enforces this regardless; sending the merchant to the plan
              page is friendlier than letting them fill a form that will be
              refused on submit. */}
          {canAddBranch(entitlements) ? (
            <Button variant="gradient" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setAddingBranch(true)}>
              {t('branches.add')}
            </Button>
          ) : (
            <Link href={`/b/${currentBranchId}/settings/plan`}>
              <Button variant="outline" leftIcon={<Plus className="h-4 w-4" />}>
                {t('branches.addSeat')}
              </Button>
            </Link>
          )}
        </div>
        {!canAddBranch(entitlements) && (
          <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
            {t('branches.seatsUsed', {
              used: entitlements.branchesUsed,
              seats: entitlements.branchSeats,
            })}
          </p>
        )}
        <div className="mt-3 space-y-2">
          {branches.map((b) => (
            <div
              key={b.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-border px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-medium">{b.name}</span>
                {!b.is_active && <Badge variant="muted">{t('branches.hidden')}</Badge>}
              </div>
              {/* The card promises every branch its own storefront URL, and a hidden branch
                  was otherwise reachable only through Head office — so each row links to
                  both the live menu and the branch's own settings. */}
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {b.is_active && b.storefront_url ? (
                  <a
                    href={b.storefront_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-w-0 max-w-[18rem] items-center gap-1 font-medium text-primary hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{b.storefront_url.replace(/^https?:\/\//, '')}</span>
                  </a>
                ) : (
                  <span className="text-muted-foreground">
                    {b.is_active ? t('branches.noStorefront') : t('branches.offlineHidden')}
                  </span>
                )}
                <Link
                  href={`/b/${b.id}/branch`}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  <Settings className="h-3.5 w-3.5" />
                  {t('branches.settings')}
                </Link>
              </div>
            </div>
          ))}
          {branches.length === 0 && <p className="text-sm text-muted-foreground">{t('branches.empty')}</p>}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t('branches.copyNote')}</p>
      </Card>

      {error && <p className="mb-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

      <div className="space-y-3 px-2 lg:px-0">
        {!canEditShared && brands.length > 0 && (
          <p className="flex items-start gap-2 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('shared.ownerOnly')}</span>
          </p>
        )}
        {brands.map((brand) => {
          const branchCount = branchCountByBrand.get(brand.id) ?? 0;
          const primaryColor = (brand.theme?.primaryColor as string) ?? '#FF6B35';
          const accentColor = (brand.theme?.accentColor as string) ?? '#F7B538';
          return (
            <Card key={brand.id} className="overflow-hidden">
              <div className="flex items-center gap-4 p-4">
                <div
                  className="h-14 w-14 shrink-0 rounded-2xl"
                  style={{ background: `linear-gradient(135deg, ${primaryColor}, ${accentColor})` }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-display text-lg font-semibold">{brand.name}</h3>
                    {brand.is_default && (
                      <Badge variant="muted" className="gap-1">
                        <Star className="h-3 w-3" /> {t('brandList.default')}
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {t('brandList.meta', { slug: brand.slug, count: branchCount })}
                  </p>
                </div>
                <IconButton label={t('brandList.edit')} onClick={() => setEditing(brand)} disabled={!canEditShared}>
                  <Palette className="h-4 w-4" />
                </IconButton>
              </div>
            </Card>
          );
        })}
        {/* A restaurant starts with no brands row at all (create_restaurant_with_branch writes
            restaurants.brand_settings and never a brand), and nothing else makes one now that the
            Branding card writes only its own branch, so the first brand is created here. Until
            then storefronts take the brand half of their name from restaurants.name. */}
        {brands.length === 0 && (
          <Card className="space-y-3 p-6 text-center text-sm text-muted-foreground">
            <p className="font-display text-lg font-semibold text-foreground">{t('brandList.emptyTitle')}</p>
            <p>
              {t.rich('brandList.empty', {
                link: (chunks) => (
                  <Link
                    href={`/b/${currentBranchId}/branch`}
                    className="font-medium text-primary hover:underline"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
            <p className="text-xs">{t('brandList.createHint', { name: newBrand.name })}</p>
            {!canEditShared && <p className="text-xs">{t('shared.ownerOnly')}</p>}
            {createBrandError && (
              <p className="rounded-xl bg-destructive/10 px-4 py-3 text-destructive">{createBrandError}</p>
            )}
            <div className="flex justify-center">
              <Button
                variant="gradient"
                onClick={createBrand}
                loading={creatingBrand}
                disabled={!newBrand.name.trim() || !canEditShared}
                leftIcon={<Plus className="h-4 w-4" />}
              >
                {t('brandList.create')}
              </Button>
            </div>
          </Card>
        )}
      </div>

      {editing && (
        <BrandEditor
          restaurantId={restaurantId}
          brand={editing}
          branches={branches}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
            router.refresh();
          }}
        />
      )}

      {addingBranch && (
        <BranchCreator
          restaurantId={restaurantId}
          brands={brands}
          branches={branches}
          copyCaps={copyCaps}
          currentBranchId={currentBranchId}
          onClose={() => setAddingBranch(false)}
          onSaved={() => {
            setAddingBranch(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/** What copy_branch_setup reports back. Read defensively: an older function returns fewer keys. */
interface CopyResult {
  categories_copied: number;
  items_copied: number;
  modifier_groups_copied: number;
  combos_copied: number;
  /** Copied dishes whose stock tracking was switched off: the new kitchen has counted nothing. */
  stock_tracking_off: number;
  hours_copied: number;
  schedule_windows_copied: number;
  settings_copied: boolean;
  tax_copied: boolean;
  sales_tax_rate: number | null;
  /** The source took bank transfers, and this branch cannot until it uploads its own QR. */
  transfer_needs_qr: boolean;
  look_copied: boolean;
  loyalty_copied: boolean;
  rewards_copied: number;
  /** Free-item rewards left behind: their dish was not copied (the menu box was unticked). */
  rewards_skipped: number;
}

function readCopyResult(data: unknown): CopyResult {
  const row = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const rate = Number(row.sales_tax_rate);
  return {
    categories_copied: count(row.categories_copied),
    items_copied: count(row.items_copied),
    modifier_groups_copied: count(row.modifier_groups_copied),
    combos_copied: count(row.combos_copied),
    stock_tracking_off: count(row.stock_tracking_off),
    hours_copied: count(row.hours_copied),
    schedule_windows_copied: count(row.schedule_windows_copied),
    settings_copied: row.settings_copied === true,
    tax_copied: row.tax_copied === true,
    sales_tax_rate: row.sales_tax_rate != null && Number.isFinite(rate) ? rate : null,
    transfer_needs_qr: row.transfer_needs_qr === true,
    look_copied: row.look_copied === true,
    loyalty_copied: row.loyalty_copied === true,
    rewards_copied: count(row.rewards_copied),
    rewards_skipped: count(row.rewards_skipped),
  };
}

type CopyErrorCode = 'copyMenuNotEmpty' | 'copyNotAuthorized' | 'copyFailed';

/** copy_branch_setup refusals worth their own words; anything else is logged. The RPC refuses to
 *  copy a menu into a branch that already has one rather than duplicating every dish, so that
 *  answer names the box to untick. */
function copyErrorCode(message: string): CopyErrorCode {
  if (message.includes('target_menu_not_empty')) return 'copyMenuNotEmpty';
  if (message.includes('not_authorized')) return 'copyNotAuthorized';
  console.error(message);
  return 'copyFailed';
}

type CreateErrorCode =
  | 'notAuthorized'
  | 'nameRequired'
  | 'slugTaken'
  | 'invalidSlug'
  | 'invalidTimezone'
  | 'invalidTaxRate'
  | 'invalidBrand'
  | 'generic';

/** create_branch refusals that are not billing ones; anything unrecognised is logged. */
function createErrorCode(err: { message: string; code?: string }): CreateErrorCode {
  if (err.message.includes('not_authorized')) return 'notAuthorized';
  if (err.message.includes('name_and_slug_required')) return 'nameRequired';
  if (err.message.includes('slug_taken') || (err.code === '23505' && err.message.includes('slug'))) {
    return 'slugTaken';
  }
  if (err.message.includes('invalid_slug')) return 'invalidSlug';
  if (err.message.includes('invalid_timezone')) return 'invalidTimezone';
  if (err.message.includes('invalid_tax_rate')) return 'invalidTaxRate';
  if (err.message.includes('invalid_brand')) return 'invalidBrand';
  console.error(err.message);
  return 'generic';
}

/** A 0.0701 tax rate as "7.01%" in the viewer's language. */
function formatTaxRate(rate: number, locale: string): string {
  try {
    return new Intl.NumberFormat(intlLocaleFor(isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE), {
      style: 'percent',
      maximumFractionDigits: 3,
    }).format(rate);
  } catch {
    return `${Math.round(rate * 100_000) / 1000}%`;
  }
}

/** The next steps at a new branch, each a link to the screen that does it. `key` names
 *  brands.created.todo.<key>; `path` is under /b/<new branch>. */
const NEXT_STEPS: Array<{ key: 'pin' | 'tables' | 'tax' | 'paymentQr' | 'stock' | 'staff' | 'riders' | 'loyalty'; path: string }> = [
  { key: 'pin', path: 'branch' },
  { key: 'tables', path: 'tables' },
  { key: 'tax', path: 'branch' },
  { key: 'paymentQr', path: 'branch' },
  { key: 'stock', path: 'inventory' },
  { key: 'staff', path: 'staff' },
  { key: 'riders', path: 'drivers' },
  { key: 'loyalty', path: 'loyalty' },
];

function BranchCreator({
  restaurantId,
  brands,
  branches,
  copyCaps,
  currentBranchId,
  onClose,
  onSaved,
}: {
  restaurantId: string;
  brands: Brand[];
  branches: BranchRow[];
  copyCaps: Record<string, CopyCaps>;
  currentBranchId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('brands');
  const locale = useLocale();
  // Only branches this viewer may copy the menu and settings from. An admin of one branch was
  // offered every branch; picking another one let create_branch take a seat and the copy then
  // fail with not_authorized.
  const activeBranches = React.useMemo(
    () => branches.filter((b) => b.is_active && copyCaps[b.id]?.menu && copyCaps[b.id]?.settings),
    [branches, copyCaps],
  );
  const takenSlugs = React.useMemo(
    () => new Set(branches.map((b) => b.slug).filter((s): s is string => !!s)),
    [branches],
  );
  const [name, setName] = React.useState('');
  // Follows the name until the owner types a slug of their own.
  const [slugInput, setSlugInput] = React.useState<string | null>(null);
  const slug = slugInput ?? (name.trim() ? suggestSlug(name, takenSlugs) : '');
  const [address, setAddress] = React.useState('');
  // A new branch used to start from nothing: an empty menu, no hours (which counts as open
  // 24/7) and default payment settings, with the only copy tool hidden behind "Create a
  // franchise group". Default to copying the branch the owner is standing in.
  const [sourceId, setSourceId] = React.useState(
    () => (activeBranches.find((b) => b.id === currentBranchId) ?? activeBranches[0])?.id ?? '',
  );
  const source = activeBranches.find((b) => b.id === sourceId) ?? null;
  const [copyMenu, setCopyMenu] = React.useState(true);
  const [copyHours, setCopyHours] = React.useState(true);
  const [copySettings, setCopySettings] = React.useState(true);
  // Off by default: a second branch usually wants its own look, and the brand's colours already
  // apply to a branch that sets none.
  const [copyLook, setCopyLook] = React.useState(false);
  // Off by default too: each branch runs its own loyalty programme, and a new one starts on the
  // platform defaults with an empty rewards list unless the owner asks for a copy.
  const [copyLoyaltyTicked, setCopyLoyalty] = React.useState(false);
  // loyalty.manage at the source is its own capability; without it the option is not offered.
  const canCopyLoyalty = !!source && !!copyCaps[source.id]?.loyalty;
  const copyLoyalty = copyLoyaltyTicked && canCopyLoyalty;
  // Opening hours, scheduling and "today" in reports are read in the branch's own zone. This
  // used to follow the source branch, which is how a Bangkok branch ended up on America/Chicago;
  // the device the owner is setting it up on is the better first guess.
  const [timezone, setTimezone] = React.useState(
    () => deviceTimeZone() ?? source?.timezone ?? 'America/New_York',
  );
  const [brandId, setBrandId] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Set once create_branch has committed. From then on the dialog can only retry the copy:
  // pressing Create again would open a second branch and take a second seat.
  const [created, setCreated] = React.useState<{ id: string | null; salesTaxRate: number | null } | null>(null);
  const [copied, setCopied] = React.useState<CopyResult | null>(null);
  // Nothing left to do in the dialog but read what happened and what comes next.
  const [finished, setFinished] = React.useState(false);

  const wantsCopy = !!source && (copyMenu || copyHours || copySettings || copyLook || copyLoyalty);
  // Once the branch exists, dismissing the dialog must still refresh the list behind it.
  const close = created ? onSaved : onClose;

  // Runs after create_branch has committed, so a failure here leaves a real branch behind
  // with nothing in it. It is separate from create so the owner can retry only the copy.
  const runCopy = async (targetId: string) => {
    if (!source || !wantsCopy) {
      setCopied(null);
      setFinished(true);
      return;
    }
    const supabase = getBrowserClient();
    const { data, error: copyErr } = await supabase.rpc('copy_branch_setup', {
      p_source_branch_id: source.id,
      p_target_branch_id: targetId,
      p_copy_menu: copyMenu,
      p_copy_hours: copyHours,
      p_copy_settings: copySettings,
      p_copy_look: copyLook,
      p_copy_loyalty: copyLoyalty,
    });
    if (copyErr) {
      setError(t(`creator.errors.${copyErrorCode(copyErr.message)}`, { source: source.name }));
      return;
    }
    setCopied(readCopyResult(data));
    setFinished(true);
  };

  const create = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const { data, error: rpcErr } = await supabase.rpc('create_branch', {
      p_restaurant_id: restaurantId,
      p_name: name.trim(),
      p_slug: slugify(slug) || suggestSlug(name, takenSlugs),
      p_address: address.trim() || undefined,
      p_timezone: timezone,
      p_brand_id: brandId || undefined,
    });
    if (rpcErr) {
      setSaving(false);
      // The BEFORE INSERT trigger on branches is the real gate; this arm only
      // ever runs if the UI let a stale seat count through (or two tabs raced).
      const billing = describeBillingError(rpcErr);
      if (billing?.kind === 'seats') {
        setError(t('creator.errors.seats', { limit: billing.limit }));
      } else if (billing?.kind === 'inactive') {
        setError(t('creator.errors.inactive'));
      } else {
        setError(t(`creator.errors.${createErrorCode(rpcErr)}`));
      }
      return;
    }
    const reply = (data ?? {}) as { branch_id?: unknown; sales_tax_rate?: unknown };
    const newId = reply.branch_id;
    if (typeof newId !== 'string') {
      setSaving(false);
      if (!wantsCopy) {
        onSaved();
        return;
      }
      setCreated({ id: null, salesTaxRate: null });
      setError(t('creator.errors.noBranchId'));
      return;
    }
    const rate = Number(reply.sales_tax_rate);
    setCreated({ id: newId, salesTaxRate: reply.sales_tax_rate != null && Number.isFinite(rate) ? rate : null });
    await runCopy(newId);
    setSaving(false);
  };

  const retryCopy = async () => {
    const targetId = created?.id;
    if (!targetId) return;
    setSaving(true);
    setError(null);
    await runCopy(targetId);
    setSaving(false);
  };

  const taxRate = copied?.tax_copied ? copied.sales_tax_rate : (created?.salesTaxRate ?? null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={close}
    >
      <Card className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-y-auto p-6 sm:max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
        {created?.id && finished ? (
          <>
            <h2 className="font-display text-xl font-semibold">{t('created.title')}</h2>
            <div className="space-y-1 text-sm">
              {copied && source ? (
                <>
                  <p>{t('created.copiedFrom', { name, source: source.name })}</p>
                  <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {copyMenu && (
                      <li>
                        {t('created.menu', {
                          categories: copied.categories_copied,
                          items: copied.items_copied,
                          groups: copied.modifier_groups_copied,
                        })}
                      </li>
                    )}
                    {copyMenu && copied.combos_copied > 0 && (
                      <li>{t('created.combos', { count: copied.combos_copied })}</li>
                    )}
                    {copyHours && <li>{t('created.hours', { count: copied.hours_copied })}</li>}
                    {copySettings && (
                      <li>
                        {copied.settings_copied
                          ? t('created.settingsCopied')
                          : t('created.settingsNone')}
                      </li>
                    )}
                    {copySettings && copied.schedule_windows_copied > 0 && (
                      <li>{t('created.scheduleWindows', { count: copied.schedule_windows_copied })}</li>
                    )}
                    {copyLook && copied.look_copied && <li>{t('created.lookCopied')}</li>}
                    {copyLoyalty && copied.loyalty_copied && (
                      <li>{t('created.loyaltyCopied', { count: copied.rewards_copied })}</li>
                    )}
                  </ul>
                </>
              ) : (
                <p>{t('created.empty', { name })}</p>
              )}
            </div>
            {copied?.transfer_needs_qr && (
              <p className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>{t('created.transferOff')}</span>
              </p>
            )}
            {copied && copied.rewards_skipped > 0 && (
              <p className="flex items-start gap-2 rounded-xl bg-muted px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>{t('created.rewardsSkipped', { count: copied.rewards_skipped })}</span>
              </p>
            )}
            {copied && copied.stock_tracking_off > 0 && (
              <p className="flex items-start gap-2 rounded-xl bg-muted px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>{t('created.stockOff', { count: copied.stock_tracking_off })}</span>
              </p>
            )}
            <div className="rounded-xl bg-muted px-3 py-2 text-sm">
              <p className="font-medium">{t('created.todoTitle', { name })}</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                {NEXT_STEPS.map((step) => (
                  <li key={step.key}>
                    <Link
                      href={`/b/${created.id}/${step.path}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {step.key === 'tax'
                        ? t('created.todo.tax', {
                            rate: taxRate != null ? formatTaxRate(taxRate, locale) : '0%',
                          })
                        : t(`created.todo.${step.key}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onSaved}>{t('created.done')}</Button>
              <Link href={`/b/${created.id}/branch`}>
                <Button variant="gradient">{t('created.openSettings')}</Button>
              </Link>
            </div>
          </>
        ) : (
          <>
            <h2 className="font-display text-xl font-semibold">{t('creator.title')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('creator.fields.name')}>
                <input value={name} onChange={(e) => setName(e.target.value)} disabled={!!created} maxLength={120} className="input disabled:opacity-60" placeholder={t('creator.fields.namePlaceholder')} autoFocus />
              </Field>
              <Field label={t('creator.fields.slug')}>
                <input
                  value={slug}
                  onChange={(e) => setSlugInput(typedSlug(e.target.value))}
                  disabled={!!created}
                  dir="ltr"
                  className="input disabled:opacity-60"
                  placeholder={t('creator.fields.slugPlaceholder')}
                />
                <span className="mt-1 block text-xs text-muted-foreground">{t('creator.fields.slugHint')}</span>
              </Field>
              <div className="sm:col-span-2">
                <Field label={t('creator.fields.address')}>
                  <input value={address} onChange={(e) => setAddress(e.target.value)} disabled={!!created} className="input disabled:opacity-60" />
                </Field>
              </div>
              <Field label={t('creator.fields.timezone')}>
                <TimezoneSelect
                  value={timezone}
                  onChange={setTimezone}
                  disabled={!!created}
                  className="h-12 w-full rounded-[0.875rem] border border-border bg-background px-4 text-base outline-none focus-visible:border-primary disabled:opacity-60"
                />
                <span className="mt-1 block text-xs text-muted-foreground">{t('creator.fields.timezoneHint')}</span>
              </Field>
              <Field label={t('creator.fields.brand')}>
                <select value={brandId} onChange={(e) => setBrandId(e.target.value)} disabled={!!created} className="input disabled:opacity-60">
                  <option value="">{t('creator.fields.brandNone')}</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </Field>
              <div className="space-y-2 sm:col-span-2">
                <Field label={t('creator.fields.startFrom')}>
                  <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} disabled={saving} className="input disabled:opacity-60">
                    <option value="">{t('creator.fields.startFromNothing')}</option>
                    {activeBranches.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </Field>
                {source && (
                  <div className="space-y-2 rounded-xl bg-muted/40 p-3 text-sm">
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={copyMenu} onChange={(e) => setCopyMenu(e.target.checked)} disabled={saving} className="mt-1" />
                      <span>
                        {t('creator.copy.menu')}
                        <span className="block text-xs text-muted-foreground">{t('creator.copy.menuHint')}</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={copyHours} onChange={(e) => setCopyHours(e.target.checked)} disabled={saving} className="mt-1" />
                      <span>
                        {t('creator.copy.hours')}
                        <span className="block text-xs text-muted-foreground">{t('creator.copy.hoursHint')}</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={copySettings} onChange={(e) => setCopySettings(e.target.checked)} disabled={saving} className="mt-1" />
                      <span>
                        {t('creator.copy.settings')}
                        <span className="block text-xs text-muted-foreground">{t('creator.copy.settingsHint')}</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={copyLook} onChange={(e) => setCopyLook(e.target.checked)} disabled={saving} className="mt-1" />
                      <span>
                        {t('creator.copy.look')}
                        <span className="block text-xs text-muted-foreground">{t('creator.copy.lookHint')}</span>
                      </span>
                    </label>
                    {canCopyLoyalty && (
                      <label className="flex items-start gap-2">
                        <input type="checkbox" checked={copyLoyaltyTicked} onChange={(e) => setCopyLoyalty(e.target.checked)} disabled={saving} className="mt-1" />
                        <span>
                          {t('creator.copy.loyalty')}
                          <span className="block text-xs text-muted-foreground">{t('creator.copy.loyaltyHint')}</span>
                        </span>
                      </label>
                    )}
                    {/* The payment QR is a bank account. Copying it sent the new branch's
                        transfers to the other branch's account, so it never travels. */}
                    <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs text-foreground">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                      <span>{t('creator.copy.qrNever')}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{t('creator.copy.notCopied')}</p>
                  </div>
                )}
              </div>
            </div>

            {error && <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>{created ? t('creator.close') : t('creator.cancel')}</Button>
              {created && !saving ? (
                created.id ? (
                  <Button variant="gradient" onClick={retryCopy} disabled={!wantsCopy}>
                    {t('creator.retryCopy')}
                  </Button>
                ) : null
              ) : (
                <Button
                  variant="gradient"
                  onClick={create}
                  loading={saving}
                  disabled={!name.trim() || !!created}
                  leftIcon={<Plus className="h-4 w-4" />}
                >
                  {created ? t('creator.copying') : t('creator.create')}
                </Button>
              )}
            </div>
          </>
        )}

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
      </Card>
    </div>
  );
}

/** A failure already worded for the merchant, as opposed to an unexpected exception. */
class ShownError extends Error {}

function BrandEditor({
  restaurantId,
  brand,
  branches,
  onClose,
  onSaved,
}: {
  restaurantId: string;
  brand: Brand;
  branches: BranchRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('brands');
  const [name, setName] = React.useState(brand.name);
  const [slug, setSlug] = React.useState(brand.slug);
  const [primaryColor, setPrimaryColor] = React.useState(
    (brand.theme?.primaryColor as string) ?? '#FF6B35',
  );
  const [accentColor, setAccentColor] = React.useState(
    (brand.theme?.accentColor as string) ?? '#F7B538',
  );
  const [logoUrl, setLogoUrl] = React.useState(brand.logo_url ?? '');
  const [icons, setIcons] = React.useState<IconSet>({
    faviconUrl: brand.favicon_url,
    icon192Url: brand.icon_192_url,
    icon512Url: brand.icon_512_url,
    iconMaskable512Url: brand.icon_maskable_512_url,
  });
  // Same contract as the Branding card: the style the current icon files were rendered with,
  // null for an icon made before styles existed.
  const [iconStyle, setIconStyle] = React.useState<IconStyle | null>(() =>
    brand.theme && 'appIcon' in brand.theme ? parseIconStyle(brand.theme.appIcon) : null,
  );
  // A restyled icon not applied yet: saving would keep the old files and close the dialog.
  const [iconPending, setIconPending] = React.useState(false);
  const [isDefault, setIsDefault] = React.useState(brand.is_default);
  const [linkedBranchIds, setLinkedBranchIds] = React.useState<Set<string>>(
    () => new Set(branches.filter((b) => b.brand_id === brand.id).map((b) => b.id)),
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The brand name is the first half of every branch's storefront name, so the hint shows it
  // joined to a real branch rather than describing the rule in the abstract — one named
  // differently from the brand, or the example collapses to the brand alone.
  const exampleBranch =
    branches.find((b) => b.name.trim().toLocaleLowerCase() !== name.trim().toLocaleLowerCase())?.name ??
    branches[0]?.name;
  const exampleName = storefrontAppName(name || t('editor.nameFallback'), exampleBranch);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      // No theme.brandName: brands.name is the one source of the brand's name, and a copy in the
      // theme is what a branch name once overwrote. Saving clears a stale one.
      const theme: Record<string, unknown> = { ...brand.theme, primaryColor, accentColor };
      delete theme.brandName;
      // appIcon travels with the icon files it describes, and leaves with them.
      if (iconStyle && icons.icon512Url) theme.appIcon = iconStyle;
      else delete theme.appIcon;
      const payload = {
        restaurant_id: restaurantId,
        name,
        slug: slugify(slug) || slugify(name) || brand.slug,
        theme,
        logo_url: logoUrl || null,
        favicon_url: icons.faviconUrl,
        icon_192_url: icons.icon192Url,
        icon_512_url: icons.icon512Url,
        icon_maskable_512_url: icons.iconMaskable512Url,
        is_default: isDefault,
      };
      // `.select()` matters: brands writes are gated on the 'brand.edit' capability, and
      // RLS denies by filtering the row out rather than raising. A role without it used to
      // see "saved", the dialog close, and nothing change — while the image had already
      // reached the bucket.
      const { data: updated, error: upErr } = await supabase
        .from('brands')
        .update(payload)
        .eq('id', brand.id)
        .select('id');
      if (upErr) {
        throw new ShownError(
          upErr.code === '23505' && upErr.message.includes('slug')
            ? t('editor.errors.slugTaken')
            : t(dbErrorKey(upErr)),
        );
      }
      if (!updated || updated.length === 0) {
        throw new ShownError(t('editor.errors.notSaved'));
      }
      const brandId = brand.id;

      // Reconcile branch linkage
      const want = new Set(linkedBranchIds);
      const linkUpdates: Array<PromiseLike<unknown>> = [];
      for (const b of branches) {
        const isLinked = b.brand_id === brandId;
        const shouldBeLinked = want.has(b.id);
        if (isLinked && !shouldBeLinked) {
          linkUpdates.push(
            supabase.from('branches').update({ brand_id: null }).eq('id', b.id) as unknown as PromiseLike<unknown>,
          );
        } else if (!isLinked && shouldBeLinked) {
          linkUpdates.push(
            supabase.from('branches').update({ brand_id: brandId }).eq('id', b.id) as unknown as PromiseLike<unknown>,
          );
        }
      }
      await Promise.all(linkUpdates);
      onSaved();
    } catch (err) {
      if (err instanceof ShownError) {
        setError(err.message);
      } else {
        console.error(err);
        setError(t('errors.generic'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-2xl space-y-4 overflow-y-auto p-6 sm:max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-xl font-semibold">{t('editor.title')}</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('editor.name')}>
            <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
            <span className="mt-1 block text-xs text-muted-foreground">
              {t('editor.nameHint', { example: exampleName })}
            </span>
          </Field>
          <Field label={t('editor.slug')}>
            <input
              value={slug}
              onChange={(e) => setSlug(typedSlug(e.target.value))}
              className="input"
              placeholder={t('editor.slugPlaceholder')}
            />
          </Field>
          <Field label={t('editor.primaryColor')}>
            <input
              type="color"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="h-12 w-full rounded-xl border border-border bg-background"
            />
          </Field>
          <Field label={t('editor.accentColor')}>
            <input
              type="color"
              value={accentColor}
              onChange={(e) => setAccentColor(e.target.value)}
              className="h-12 w-full rounded-xl border border-border bg-background"
            />
          </Field>
          {/* The brand's logo and icon are only the fallback for a branch with none of its own:
              every branch owns its identity (20260917150000_branch_own_identity) and uploads it
              under its own Branch settings, so changing these never repaints a branch that has. */}
          <div className="sm:col-span-2">
            <Field label={t('editor.logo')}>
              <ImageUpload
                restaurantId={restaurantId}
                folder="logo"
                removeBackground
                value={logoUrl || null}
                onChange={(url) => setLogoUrl(url ?? '')}
                aspect="aspect-[3/1]"
                label={t('editor.uploadLogo')}
              />
            </Field>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('editor.logoHint')}</p>
          </div>
          <div className="sm:col-span-2">
            {/* Kept separate from the logo rather than derived from it: the logo is
                a wide lockup that turns to mush at 32px, which reads as a broken
                site rather than an unbranded one. */}
            {/* A <div>, not Field's <label>: inside a label every click on the style panel's
                previews, captions and gaps was forwarded to the hidden file input and opened
                the file picker, and the Zoom label ended up nested inside another label. */}
            <div>
              <span className="mb-1.5 block text-sm font-medium">{t('editor.appIcon')}</span>
              <IconUpload
                restaurantId={restaurantId}
                value={icons}
                onChange={setIcons}
                appliedStyle={iconStyle}
                onAppliedStyleChange={setIconStyle}
                onPendingChange={setIconPending}
              />
              <div className="mt-2 text-xs text-muted-foreground">
                <p>{t('editor.appIconHint')}</p>
                {icons.faviconUrl && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={icons.faviconUrl} alt="" className="h-4 w-4 rounded-sm object-cover" />
                    {/* The brand alone, never joined to a branch: a branch with an icon of its own
                        does not show this one, so pairing it with a real branch name could preview
                        a tab that no storefront has. */}
                    <span className="truncate text-foreground">{name.trim() || t('editor.tabFallback')}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div
          className="rounded-2xl p-6 text-white"
          style={{ background: `linear-gradient(135deg, ${primaryColor}, ${accentColor})` }}
        >
          <p className="text-xs uppercase tracking-wider text-white/80">{t('editor.preview')}</p>
          <p className="mt-1 font-display text-2xl font-bold">{name || t('editor.nameFallback')}</p>
        </div>

        <Card className="bg-muted/30 p-4">
          <p className="text-sm font-medium">{t('editor.linkedBranches')}</p>
          <p className="mb-2 text-xs text-muted-foreground">{t('editor.linkedHint')}</p>
          <div className="space-y-1">
            {branches.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={linkedBranchIds.has(b.id)}
                  onChange={(e) => {
                    const next = new Set(linkedBranchIds);
                    if (e.target.checked) next.add(b.id);
                    else next.delete(b.id);
                    setLinkedBranchIds(next);
                  }}
                />
                {b.name}
                {!b.is_active && <Badge variant="muted">{t('branches.hidden')}</Badge>}
              </label>
            ))}
          </div>
        </Card>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          {t('editor.setDefault')}
        </label>

        {error && <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {iconPending && (
            <span className="mr-auto text-sm text-muted-foreground">{t('editor.iconPending')}</span>
          )}
          <Button variant="ghost" onClick={onClose}>{t('editor.cancel')}</Button>
          <Button
            variant="gradient"
            onClick={save}
            loading={saving}
            disabled={!name || iconPending}
            leftIcon={<Save className="h-4 w-4" />}
          >
            {t('editor.save')}
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
      </Card>
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
