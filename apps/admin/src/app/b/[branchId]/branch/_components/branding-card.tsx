'use client';

// Logo and favicon, on the settings screen where a merchant looks for them.
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
import { Palette, Save } from 'lucide-react';
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

function slugify(v: string): string {
  return v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

export function BrandingCard({ restaurantId, restaurantName, brand }: Props) {
  const router = useRouter();
  const { branchId } = useParams<{ branchId: string }>();
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

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const payload = {
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
        .update(payload)
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
          name: restaurantName,
          slug: slugify(restaurantName),
          is_default: true,
          theme: {},
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
        Your logo and icon, as customers see them. The logo appears at the top of your
        storefront on every page; the icon becomes the browser tab favicon and the app icon
        when someone installs your menu to their phone.
      </p>

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
          <IconUpload restaurantId={restaurantId} value={icons} onChange={setIcons} />
          <span className="mt-1.5 block text-xs text-muted-foreground">
            Square, at least 192×192. Used for the browser tab and the installed app icon.
          </span>
        </div>
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
          <span className="text-sm text-success">Saved ✓ — customers see this within seconds</span>
        )}
      </div>
    </Card>
  );
}
