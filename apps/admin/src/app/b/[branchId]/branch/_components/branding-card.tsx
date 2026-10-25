'use client';

// This branch's logo and app icon, on this branch's settings screen.
//
// They used to live on the restaurant's single brands row, and this card wrote that row even
// though it sits on one branch's page. A restaurant with two branches uploaded a different icon
// on each and both storefronts and both installed apps showed whichever was saved last; the App
// name field overwrote the brand's name with a branch name the same way.
//
// Now every branch owns logo_url, favicon_url, the three icon files and app_icon (migration
// 20260917150000_branch_own_identity), and this card writes only those columns of only this
// branch. It never touches brands. The brand row is still the default for a branch that has no
// logo or icon of its own, edited on the Brand & branches page, and its name is the first half
// of the storefront name "<brand> - <branch>", which this card previews but does not edit.
//
// The web address (branches.public_slug, docs/SHORT-STOREFRONT-URLS-2026-10-26.md §1) sits under
// the App name and follows it: "Hamburger" gives app.favornoms.com/r/hamburger. It is saved by
// set_branch_public_slug with the rest of the card; blank keeps the long /r/<restaurant>/<branch>,
// and is remembered in the branch's settings (WEB_ADDRESS_OPT_OUT_KEY) so a reload keeps it blank.

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Palette, Save, Store } from 'lucide-react';
import type { Json } from '@favornoms/database/types';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import {
  checkPublicSlug,
  publicSlugRefusal,
  setBranchPublicSlug,
  type PublicSlugError,
} from '@favornoms/database/queries';
import { publicBase } from '@favornoms/database/storefront-path';
import { storefrontBase } from '@/lib/site-url';
import { patchBranchSettings } from './patch-settings';
import {
  WEB_ADDRESS_OPT_OUT_KEY,
  followsAppName,
  needsAvailabilityCheck,
  readWebAddress,
  savedWebAddressOptOut,
  typedWebAddress,
  webAddressOptOut,
  webAddressSave,
  webAddressStatus,
  webAddressValue,
  type WebAddressCheck,
  type WebAddressField,
} from './web-address-model';
import { ImageUpload } from '@/components/image-upload';
import { IconUpload, type IconSet } from '@/components/icon-upload';
import { parseIconStyle, type IconStyle } from '@/components/icon-geometry';

/**
 * Tell the storefront to drop its cached copy of this branch.
 *
 * The storefront caches restaurant/branch/brand data across requests, and it is a different
 * deployment: nothing here could reach it, so a merchant who replaced their logo watched the
 * old one for as long as the storefront's TTL, decided the upload had failed, and uploaded it
 * again. Fire-and-forget by design — the storefront re-reads on its own soon enough, and a
 * save must never fail because a cache hint did.
 *
 * `no-cors` + text/plain keeps this a simple cross-origin request: no preflight, no CORS
 * configuration to keep in step on the other side. The response is opaque and is not read.
 */
function askStorefrontToRefresh(branchId: string): void {
  try {
    void fetch(`${storefrontBase()}/api/revalidate`, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ branchId }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* the storefront's own version check is the backstop */
  }
}

/**
 * The storefront's name for one branch: "<brand> - <branch>", with an ASCII hyphen.
 *
 * Only one half when the other is blank, and only one when both say the same thing (a
 * single-branch restaurant often names its branch after itself): "Coastal Grill - Coastal Grill"
 * is not a name anyone chose. Merchant text, so never translated.
 */
export function storefrontAppName(brandName: string | null | undefined, branchName: string | null | undefined): string {
  const brand = brandName?.trim() ?? '';
  const branch = branchName?.trim() ?? '';
  if (!brand || !branch) return brand || branch;
  if (brand.toLocaleLowerCase() === branch.toLocaleLowerCase()) return brand;
  return `${brand} - ${branch}`;
}

/** This branch's own identity columns, exactly as public.branches holds them. */
export interface BranchIdentity {
  logo_url: string | null;
  favicon_url: string | null;
  icon_192_url: string | null;
  icon_512_url: string | null;
  icon_maskable_512_url: string | null;
  /** The icon style the icon files were rendered with (brands.theme.appIcon's shape). */
  app_icon: unknown;
}

/** What the storefront shows for a branch that has no logo or icon of its own. */
export interface BrandDefaults {
  logoUrl: string | null;
  iconUrl: string | null;
}

export interface BrandingCardData {
  /** The brand half of the storefront name: the branch's brand, else the default brand, else the restaurant. */
  brandName: string;
  identity: BranchIdentity;
  brandDefaults: BrandDefaults;
}

interface Props extends BrandingCardData {
  branchId: string;
  restaurantId: string;
  /** The branch name as saved: the storefront only shows a rename once Save changes has run. */
  branchName: string;
  /** branches.settings.app_name: this branch's own App name, '' for the automatic one. */
  appNameOverride: string;
}

/** The storefront reads at most this many characters of an App name (branchAppName). */
const APP_NAME_MAX = 60;

function storefrontHost(): string {
  try {
    return new URL(storefrontBase()).host;
  } catch {
    return '';
  }
}

/** The branch's long address, which a branch with no web address keeps. */
interface LongAddress {
  restaurantSlug: string;
  branchSlug: string;
}

/** How long the field waits after the last keystroke before asking whether the address is free. */
const SLUG_CHECK_DELAY_MS = 400;

export function BrandingCard({ branchId, restaurantId, branchName, brandName, identity, brandDefaults, appNameOverride }: Props) {
  const t = useTranslations('branch');
  const router = useRouter();
  const [logoUrl, setLogoUrl] = React.useState<string | null>(identity.logo_url);
  const [icons, setIcons] = React.useState<IconSet>({
    faviconUrl: identity.favicon_url,
    icon192Url: identity.icon_192_url,
    icon512Url: identity.icon_512_url,
    iconMaskable512Url: identity.icon_maskable_512_url,
  });
  // The style the current icon files were rendered with. Null for an icon made before styles
  // existed (always the old padded one), which is how the uploader knows to offer Apply.
  const [iconStyle, setIconStyle] = React.useState<IconStyle | null>(() =>
    identity.app_icon && typeof identity.app_icon === 'object' ? parseIconStyle(identity.app_icon) : null,
  );
  // A restyled icon that has not been applied yet. Saving now would publish the old files and
  // report success, so Save waits until it is applied or set back.
  const [iconPending, setIconPending] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [host, setHost] = React.useState('');
  // The App name as typed, and as last saved (what the storefront shows now).
  const [appNameInput, setAppNameInput] = React.useState(appNameOverride);
  const [savedAppName, setSavedAppName] = React.useState(appNameOverride.trim());
  // The web address. Read here after mount (the page does not select it): null while reading,
  // 'failed' when it could not be read, and then the field stays shut and Save leaves it alone.
  const [longAddress, setLongAddress] = React.useState<LongAddress | 'failed' | null>(null);
  const [savedSlug, setSavedSlug] = React.useState<string | null>(null);
  // What the merchant typed into the field, or null while it follows the App name.
  const [slugTyped, setSlugTyped] = React.useState<string | null>(null);
  const [slugCheck, setSlugCheck] = React.useState<WebAddressCheck | null>(null);
  // Whether the branch's settings say the merchant chose no web address (WEB_ADDRESS_OPT_OUT_KEY).
  const [slugOptedOut, setSlugOptedOut] = React.useState(false);

  // storefrontBase() may read window, so resolve it after mount rather than during render.
  React.useEffect(() => setHost(storefrontHost()), []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error: readErr } = await getBrowserClient()
        .from('branches')
        .select('slug, public_slug, settings, restaurants(slug)')
        .eq('id', branchId)
        .maybeSingle();
      if (cancelled) return;
      // A many-to-one embed is an object on the wire; the generated types call it a list.
      const restaurant: { slug?: unknown } | null | undefined = Array.isArray(data?.restaurants)
        ? data.restaurants[0]
        : data?.restaurants;
      const restaurantSlug = typeof restaurant?.slug === 'string' ? restaurant.slug : '';
      if (readErr || !data?.slug || !restaurantSlug) {
        if (readErr) console.error('Reading the branch web address failed', readErr);
        setLongAddress('failed');
        return;
      }
      setLongAddress({ restaurantSlug, branchSlug: data.slug });
      setSavedSlug(data.public_slug);
      const optedOut = savedWebAddressOptOut(data.settings);
      setSlugOptedOut(optedOut);
      // An address the merchant chose rather than the one the saved App name makes stays put
      // when the App name changes; the App name's own address keeps following it. No address
      // follows too, unless the merchant chose to have none: then the field stays blank.
      if (!followsAppName(data.public_slug, appNameOverride, optedOut)) setSlugTyped(data.public_slug ?? '');
    })();
    return () => {
      cancelled = true;
    };
    // Read once per branch: appNameOverride only says which saved address counts as following.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  const addressReady = longAddress !== null && longAddress !== 'failed';
  const slugField: WebAddressField = { appName: appNameInput, savedSlug, typed: slugTyped };
  // Until the branch's own address is back the field is empty and shut, and nothing is changed.
  const slugValue = addressReady ? webAddressValue(slugField) : '';
  const slugReading = readWebAddress(slugField, slugCheck);
  const wantedSlug = slugReading.wanted;
  const needsCheck = addressReady && needsAvailabilityCheck(slugReading);

  // Debounced availability check; an answer for anything but the current text is ignored.
  React.useEffect(() => {
    if (!needsCheck) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      checkPublicSlug(getBrowserClient(), branchId, wantedSlug).then(
        (result) => {
          if (cancelled) return;
          setSlugCheck({
            slug: wantedSlug,
            answer: result.available
              ? { available: true }
              : result.error
                ? { available: false, error: result.error }
                : 'failed',
          });
        },
        (err: unknown) => {
          console.error('Checking the web address failed', err);
          if (!cancelled) setSlugCheck({ slug: wantedSlug, answer: 'failed' });
        },
      );
    }, SLUG_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needsCheck, wantedSlug, branchId]);

  const autoAppName = storefrontAppName(brandName, branchName);
  const appName = appNameInput.trim() || autoAppName;
  // A branch with no icon files of its own installs with the brand's (the storefront decides on
  // the 192 and 512), so the preview has to show that rather than the FavorNoms placeholder.
  const hasOwnIcon = !!(icons.icon192Url || icons.icon512Url);
  const previewIcon = hasOwnIcon ? (icons.icon192Url ?? icons.faviconUrl) : brandDefaults.iconUrl;

  /** The database's own text is for the logs; the merchant gets a sentence they can act on. */
  const writeFailed = (err: { message: string; code?: string }) => {
    console.error('Saving branch branding failed', err);
    if (err.message.includes('branch_icon_source_forbidden')) {
      setError(t('branding.errors.uploadAgain'));
    } else if (err.message.includes('branch_brand_edit_required') || err.message.includes('branch_manager_required')) {
      // The branches row may also refuse a role below manager first; either way, what this card
      // needs is the owner or an admin.
      setError(t('branding.errors.ownerOrAdminOnly'));
    } else {
      setError(err.code === '42501' || err.message.includes('not_authorized') ? t('branding.noPermission') : t('errors.generic'));
    }
  };

  /** What the merchant can do about an address that cannot be had. */
  const slugErrorText = (problem: PublicSlugError, slug: string) =>
    problem === 'slug_reserved'
      ? t('branding.webAddress.errors.reserved', { slug })
      : problem === 'slug_taken'
        ? t('branding.webAddress.errors.taken', { slug })
        : t('branding.webAddress.errors.invalid');

  // The addresses as the merchant reads them: the host (known after mount) and the path.
  const longPath = addressReady ? publicBase(longAddress.restaurantSlug, longAddress.branchSlug) : '';
  const fullAddress = (path: string) => `${host}${path}`;
  const currentPath = addressReady ? publicBase(longAddress.restaurantSlug, longAddress.branchSlug, savedSlug) : '';
  // Where the storefront will be once Save has run, as far as is known: the wanted address unless
  // it is known it cannot be had (then the branch keeps what it has).
  const nextPath = !addressReady
    ? ''
    : slugReading.problem
      ? currentPath
      : publicBase(longAddress.restaurantSlug, longAddress.branchSlug, wantedSlug || null);

  /** The line under the field: what the address is, and whether it can be had. */
  const slugStatus = ((): { tone: 'muted' | 'success' | 'warning' | 'error'; text: string } => {
    if (longAddress === null) return { tone: 'muted', text: t('branding.webAddress.loading') };
    if (longAddress === 'failed') return { tone: 'error', text: t('branding.webAddress.loadFailed') };
    const status = webAddressStatus(slugField, slugReading);
    switch (status.kind) {
      case 'none':
        return { tone: 'muted', text: t('branding.webAddress.none') };
      case 'noLatin':
        return { tone: 'muted', text: t('branding.webAddress.noLatin') };
      case 'clearing':
        return { tone: 'warning', text: t('branding.webAddress.clearing', { old: fullAddress(`/r/${status.old}`) }) };
      case 'current':
        return { tone: 'success', text: t('branding.webAddress.current') };
      case 'checking':
        return { tone: 'muted', text: t('branding.webAddress.checking') };
      case 'checkFailed':
        return { tone: 'muted', text: t('branding.webAddress.checkFailed') };
      case 'available':
        return { tone: 'success', text: t('branding.webAddress.available') };
      case 'suggestionUnavailable':
        return {
          tone: 'warning',
          text: t('branding.webAddress.suggestionUnavailable', { slug: wantedSlug, address: fullAddress(currentPath) }),
        };
      case 'problem':
        return { tone: 'error', text: slugErrorText(status.problem, wantedSlug) };
    }
  })();

  const save = async () => {
    setError(null);
    const supabase = getBrowserClient();
    // The web address goes first, so an address that cannot be had stops the save before anything
    // else is written: the merchant fixes one field and saves once. An address the App name made
    // (the field was never typed in) never stops it: the branch keeps the address it has, and the
    // line under the field says why.
    const slugSave = addressReady ? webAddressSave(slugField, slugReading) : ({ kind: 'keep' } as const);
    if (slugSave.kind === 'refuse') return setError(slugErrorText(slugSave.problem, wantedSlug));
    if (slugSave.kind === 'write') {
      setSaving(true);
      try {
        const saved = await setBranchPublicSlug(supabase, branchId, slugSave.slug);
        setSavedSlug(saved.publicSlug);
        if (slugTyped !== null) setSlugTyped(saved.publicSlug ?? '');
      } catch (err) {
        const refusal = publicSlugRefusal(err as { message?: string });
        if (refusal !== 'slug_invalid' && refusal !== 'slug_reserved' && refusal !== 'slug_taken') {
          setSaving(false);
          return writeFailed(err as { message: string; code?: string });
        }
        // Taken since the check, or saved before it answered: the field says so either way, and
        // only an address the merchant typed stops the rest of the save.
        setSlugCheck({ slug: wantedSlug, answer: { available: false, error: refusal } });
        if (slugTyped !== null) {
          setSaving(false);
          return setError(slugErrorText(refusal, wantedSlug));
        }
      }
    }
    // Blank is a choice too (the long address), and the branch's settings remember it, whether or
    // not an address was just cleared: otherwise the next visit fills the field from the App name
    // again, and a later Save made for something else writes that address. Typing one withdraws it.
    if (addressReady) {
      const optOut = webAddressOptOut(slugField);
      if (optOut !== slugOptedOut) {
        setSaving(true);
        const { error: optOutErr } = await patchBranchSettings(branchId, { [WEB_ADDRESS_OPT_OUT_KEY]: optOut || null });
        if (optOutErr) {
          setSaving(false);
          return writeFailed(optOutErr);
        }
        setSlugOptedOut(optOut);
      }
    }
    setSaving(true);
    // .select() and a zero-row check, not just `error`: RLS refuses by filtering the row out,
    // which returns success with nothing updated.
    const { data, error: updErr } = await supabase
      .from('branches')
      .update({
        logo_url: logoUrl,
        favicon_url: icons.faviconUrl,
        icon_192_url: icons.icon192Url,
        icon_512_url: icons.icon512Url,
        icon_maskable_512_url: icons.iconMaskable512Url,
        // The style travels with the icon files it describes, and leaves with them.
        app_icon: iconStyle && icons.icon512Url ? ({ ...iconStyle } as Json) : null,
      })
      .eq('id', branchId)
      .select('id');
    setSaving(false);
    if (updErr) return writeFailed(updErr);
    if (!data || data.length === 0) {
      return setError(t('branding.noPermission'));
    }
    // The App name lives in the branch's settings (patch_branch_settings: owner and admin), and
    // is sent only when it changed. Blank removes it, which brings back "<brand> - <branch>".
    const nextAppName = appNameInput.trim().slice(0, APP_NAME_MAX);
    if (nextAppName !== savedAppName) {
      setSaving(true);
      const { error: nameErr } = await patchBranchSettings(branchId, { app_name: nextAppName || null });
      setSaving(false);
      if (nameErr) return writeFailed(nameErr);
      setSavedAppName(nextAppName);
      setAppNameInput(nextAppName);
    }
    setSavedAt(Date.now());
    askStorefrontToRefresh(branchId);
    router.refresh();
  };

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Palette className="h-5 w-5 text-primary" /> {t('branding.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('branding.description')}</p>

      {/* This branch's own name for its storefront: the header, the browser tab and the installed
          app. It is saved on the branch (settings.app_name), never on the brand, so typing here
          cannot rename another branch the way the old brand-level field did. Blank keeps the
          automatic "<brand> - <branch>", shown as the placeholder. */}
      <div className="mt-4">
        <label htmlFor={`app-name-${branchId}`} className="mb-1.5 block text-sm font-medium">
          {t('branding.appName')}
        </label>
        <input
          id={`app-name-${branchId}`}
          value={appNameInput}
          maxLength={APP_NAME_MAX}
          placeholder={autoAppName}
          onChange={(e) => {
            setAppNameInput(e.target.value);
            setSavedAt(null);
          }}
          className="focus-ring h-12 w-full rounded-xl border border-border bg-background px-4 text-base"
        />
        <span className="mt-1.5 block text-xs text-muted-foreground">{t('branding.appNameAuto', { name: autoAppName })}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {t.rich('branding.appNameSource', {
            link: (chunks) => (
              <Link href={`/b/${branchId}/brands`} className="font-medium underline">
                {chunks}
              </Link>
            ),
          })}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">{t('branding.appNameWhere')}</span>
      </div>

      {/* The web address, made from the App name until the merchant types their own. Shut until
          the branch's current one has been read, so nothing here can be saved over it unseen. */}
      <div className="mt-4">
        <label htmlFor={`web-address-${branchId}`} className="mb-1.5 block text-sm font-medium">
          {t('branding.webAddress.label')}
        </label>
        <input
          id={`web-address-${branchId}`}
          value={slugValue}
          maxLength={64}
          disabled={!addressReady}
          placeholder={addressReady ? t('branding.webAddress.placeholder') : ''}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={slugStatus.tone === 'error' || undefined}
          aria-describedby={`web-address-${branchId}-status`}
          onChange={(e) => {
            // Kept as typed (rewriting the value would move the caret); everything else reads it
            // trimmed and lower case, as the database will, and the field shows it lower case.
            setSlugTyped(typedWebAddress(appNameInput, e.target.value));
            setSavedAt(null);
          }}
          className="focus-ring h-12 w-full rounded-xl border border-border bg-background px-4 text-base lowercase disabled:opacity-60"
        />
        {addressReady && (
          <span className="mt-1.5 block break-all font-mono text-xs text-foreground">
            {fullAddress(wantedSlug ? `/r/${wantedSlug}` : longPath)}
          </span>
        )}
        <span
          id={`web-address-${branchId}-status`}
          aria-live="polite"
          className={`mt-1 block text-xs ${
            slugStatus.tone === 'error'
              ? 'text-destructive'
              : slugStatus.tone === 'warning'
                ? 'text-warning'
                : slugStatus.tone === 'success'
                  ? 'text-success'
                  : 'text-muted-foreground'
          }`}
        >
          {slugStatus.text}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">{t('branding.webAddress.hint')}</span>
      </div>

      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <div>
          <span className="mb-2 block text-sm font-medium">{t('branding.logo')}</span>
          <ImageUpload
            restaurantId={restaurantId}
            // The storage policy scopes writes by the restaurant folder; the branch id in the
            // file name only says which branch a file belongs to.
            folder={`logo-${branchId}`}
            removeBackground
            value={logoUrl}
            onChange={(url) => {
              // Every logo change — upload, background removal, Undo, remove — is unsaved until
              // Save, so the previous "Saved ✓" must not keep claiming otherwise.
              setLogoUrl(url);
              setSavedAt(null);
            }}
            aspect="aspect-[3/1]"
            label={t('branding.uploadLogo')}
          />
          <span className="mt-1.5 block text-xs text-muted-foreground">
            {!logoUrl && brandDefaults.logoUrl ? t('branding.logoFromBrand') : t('branding.logoHint')}
          </span>
        </div>
        <div>
          <span className="mb-2 block text-sm font-medium">{t('branding.icon')}</span>
          <IconUpload
            restaurantId={restaurantId}
            fileTag={branchId}
            value={icons}
            onChange={(next) => {
              setIcons(next);
              setSavedAt(null);
            }}
            appliedStyle={iconStyle}
            onAppliedStyleChange={setIconStyle}
            onPendingChange={setIconPending}
          />
          <span className="mt-1.5 block text-xs text-muted-foreground">{t('branding.iconHint')}</span>
        </div>
      </div>

      {/* The same name and icon the storefront manifest publishes for this branch, so what the
          merchant sees here is what Chrome's install window and the home screen will show. */}
      <div className="mt-5">
        <span className="mb-2 block text-sm font-medium">{t('branding.installPreview')}</span>
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-muted/30 p-3">
          {previewIcon ? (
            // eslint-disable-next-line @next/next/no-img-element -- a storage URL chosen at runtime
            <img
              src={previewIcon}
              alt=""
              width={48}
              height={48}
              className="h-12 w-12 shrink-0 rounded-xl object-cover"
            />
          ) : (
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
              <Store className="h-6 w-6" />
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{appName}</p>
            {/* The address the app opens at once saved: the web address, or the long one. */}
            {host && <p className="truncate text-xs text-muted-foreground">{fullAddress(nextPath)}</p>}
          </div>
        </div>
        <span className="mt-1.5 block text-xs text-muted-foreground">
          {hasOwnIcon
            ? t('branding.publishHint')
            : previewIcon
              ? t('branding.iconFromBrand')
              : t('branding.noIconHint')}
        </span>
      </div>

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button
          onClick={save}
          loading={saving}
          disabled={iconPending}
          leftIcon={<Save className="h-4 w-4" />}
        >
          {t('branding.save')}
        </Button>
        {iconPending ? (
          <span className="text-sm text-muted-foreground">{t('branding.iconPending')}</span>
        ) : (
          savedAt &&
          !saving && (
            <span className="text-sm text-success">{t('branding.saved')}</span>
          )
        )}
      </div>
    </Card>
  );
}
