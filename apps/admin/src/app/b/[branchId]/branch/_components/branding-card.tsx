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

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Palette, Save, Store } from 'lucide-react';
import type { Json } from '@favornoms/database/types';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { storefrontBase } from '@/lib/site-url';
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
}

function storefrontHost(): string {
  try {
    return new URL(storefrontBase()).host;
  } catch {
    return '';
  }
}

export function BrandingCard({ branchId, restaurantId, branchName, brandName, identity, brandDefaults }: Props) {
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

  // storefrontBase() may read window, so resolve it after mount rather than during render.
  React.useEffect(() => setHost(storefrontHost()), []);

  const appName = storefrontAppName(brandName, branchName);
  // A branch with no icon files of its own installs with the brand's (the storefront decides on
  // the 192 and 512), so the preview has to show that rather than the Favornoms placeholder.
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
      setError(err.code === '42501' ? t('branding.noPermission') : t('errors.generic'));
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
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

      {/* Read-only on purpose: both halves have a home of their own, and a name typed here
          used to land on the brand and rename every other branch with it. */}
      <div className="mt-4">
        <span className="mb-1.5 block text-sm font-medium">{t('branding.appName')}</span>
        <p className="truncate rounded-xl border border-border bg-muted/40 px-4 py-3 text-base">{appName}</p>
        <span className="mt-1.5 block text-xs text-muted-foreground">
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
            {host && <p className="truncate text-xs text-muted-foreground">{host}</p>}
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
