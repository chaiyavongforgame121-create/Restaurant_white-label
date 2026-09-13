'use client';

// App name, logo and icon, on the settings screen where a merchant looks for them.
//
// They were never missing — they live in the Brands page, inside an editor that only opens
// once a brand exists. A restaurant that has never created one (Coastal Grill had not) sees
// "No brands yet" and no upload control anywhere, which reads exactly like the feature
// vanished. Branding is not a multi-brand concept to most merchants; it is "my logo".
//
// This card edits the SAME brands row the storefront reads (resolveTenant falls back to the
// restaurant's default brand for assets when a branch has no brand_id), and creates that row
// on first save if there is none. The Brands page still exists for anyone genuinely running
// several brands; nothing here replaces it.

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Palette, Save, Store } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { storefrontBase } from '@/lib/site-url';
import { ImageUpload } from '@/components/image-upload';
import { IconUpload, type IconSet } from '@/components/icon-upload';

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

export interface BrandingBrand {
  id: string;
  name: string;
  theme?: Record<string, unknown> | null;
  logo_url: string | null;
  favicon_url: string | null;
  icon_192_url: string | null;
  icon_512_url: string | null;
  icon_maskable_512_url: string | null;
}

interface Props {
  restaurantId: string;
  restaurantName: string;
  /** The brand this branch actually renders from, or null when none exists yet. */
  brand: BrandingBrand | null;
}

/** Long enough for a real restaurant name; Chrome's dialog and every launcher cut far sooner. */
const APP_NAME_MAX = 40;
/** Android and iOS both start truncating under the icon at about this many characters. */
const HOME_SCREEN_FITS = 12;

function slugify(v: string): string {
  return v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

function storefrontHost(): string {
  try {
    return new URL(storefrontBase()).host;
  } catch {
    return '';
  }
}

export function BrandingCard({ restaurantId, restaurantName, brand }: Props) {
  const router = useRouter();
  const { branchId } = useParams<{ branchId: string }>();
  const [appName, setAppName] = React.useState<string>(brand?.name || restaurantName);
  const [logoUrl, setLogoUrl] = React.useState<string | null>(brand?.logo_url ?? null);
  const [icons, setIcons] = React.useState<IconSet>({
    faviconUrl: brand?.favicon_url ?? null,
    icon192Url: brand?.icon_192_url ?? null,
    icon512Url: brand?.icon_512_url ?? null,
    iconMaskable512Url: brand?.icon_maskable_512_url ?? null,
  });
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [host, setHost] = React.useState('');

  // storefrontBase() may read window, so resolve it after mount rather than during render.
  React.useEffect(() => setHost(storefrontHost()), []);

  const trimmedName = appName.trim();
  const previewIcon = icons.icon192Url ?? icons.faviconUrl;

  const save = async () => {
    if (!trimmedName) {
      setError('Give your app a name — it is what customers see under the icon.');
      return;
    }
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const payload = {
      // The storefront names the installed app after brands.name. theme.brandName is kept in
      // step because the Brands page writes both, and an older reader may still look there.
      name: trimmedName,
      logo_url: logoUrl,
      favicon_url: icons.faviconUrl,
      icon_192_url: icons.icon192Url,
      icon_512_url: icons.icon512Url,
      icon_maskable_512_url: icons.iconMaskable512Url,
    };

    if (brand) {
      // .select() and a zero-row check, not just `error`: RLS refuses by filtering the row
      // out, which returns success with nothing updated. brands writes are gated on the
      // 'brand.edit' capability.
      const { data, error: updErr } = await supabase
        .from('brands')
        .update({ ...payload, theme: { ...(brand.theme ?? {}), brandName: trimmedName } })
        .eq('id', brand.id)
        .select('id');
      setSaving(false);
      if (updErr) return setError(updErr.message);
      if (!data || data.length === 0) {
        return setError("That didn't save — your role may not be allowed to change branding.");
      }
    } else {
      const { data, error: insErr } = await supabase
        .from('brands')
        .insert({
          restaurant_id: restaurantId,
          slug: slugify(trimmedName),
          is_default: true,
          theme: { brandName: trimmedName },
          ...payload,
        })
        .select('id');
      setSaving(false);
      if (insErr) return setError(insErr.message);
      if (!data || data.length === 0) {
        return setError("That didn't save — your role may not be allowed to change branding.");
      }
    }
    setSavedAt(Date.now());
    if (branchId) askStorefrontToRefresh(branchId);
    router.refresh();
  };

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Palette className="h-5 w-5 text-primary" /> Branding
      </h2>
      <p className="text-sm text-muted-foreground">
        Your app name, logo and icon, as customers see them. The logo appears at the top of your
        storefront on every page; the name and icon are what customers get when they install
        your menu to their phone or computer.
      </p>

      <label className="mt-4 block">
        <span className="mb-1.5 block text-sm font-medium">App name</span>
        <input
          value={appName}
          maxLength={APP_NAME_MAX}
          onChange={(e) => {
            setAppName(e.target.value);
            setSavedAt(null);
          }}
          placeholder={restaurantName}
          className="input"
        />
        <span className="mt-1.5 block text-xs text-muted-foreground">
          Shown in the install window, under the home-screen icon and on the desktop shortcut.
          {trimmedName.length > HOME_SCREEN_FITS &&
            ` Phones may shorten names longer than ${HOME_SCREEN_FITS} characters under the icon.`}
        </span>
      </label>

      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <div>
          <span className="mb-2 block text-sm font-medium">Logo</span>
          <ImageUpload
            restaurantId={restaurantId}
            folder="logo"
            value={logoUrl}
            onChange={setLogoUrl}
            aspect="aspect-[3/1]"
            label="Upload logo"
          />
          <span className="mt-1.5 block text-xs text-muted-foreground">
            A wide image works best — it replaces your restaurant name in the header.
          </span>
        </div>
        <div>
          <span className="mb-2 block text-sm font-medium">Icon</span>
          <IconUpload
            restaurantId={restaurantId}
            value={icons}
            onChange={(next) => {
              setIcons(next);
              setSavedAt(null);
            }}
          />
          <span className="mt-1.5 block text-xs text-muted-foreground">
            Square, at least 192×192. Used for the browser tab and the installed app icon.
          </span>
        </div>
      </div>

      {/* The same name and icon the storefront manifest publishes, so what the merchant sees
          here is what Chrome's install window and the home screen will show. */}
      <div className="mt-5">
        <span className="mb-2 block text-sm font-medium">What customers see when they install</span>
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
            <p className="truncate text-sm font-semibold">{trimmedName || restaurantName}</p>
            {host && <p className="truncate text-xs text-muted-foreground">{host}</p>}
          </div>
        </div>
        <span className="mt-1.5 block text-xs text-muted-foreground">
          {previewIcon
            ? 'Save to publish. Someone who already installed the app gets the new name and icon the next time Chrome checks for updates, usually within a day — removing and reinstalling shows it straight away.'
            : 'No icon yet — installs use the Favornoms icon until you upload one.'}
        </span>
      </div>

      {!brand && (
        <p className="mt-3 text-xs text-muted-foreground">
          Saving creates your restaurant&apos;s default brand — nothing else changes.
        </p>
      )}
      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          Save branding
        </Button>
        {savedAt && !saving && (
          <span className="text-sm text-success">Saved ✓ — customers see this within a minute</span>
        )}
      </div>
    </Card>
  );
}
