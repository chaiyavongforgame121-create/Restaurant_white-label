/**
 * What an installed storefront is called and what its icon is — pure, so the manifest route,
 * the icon route, the branch layout and their tests share one answer.
 *
 * Nothing in here may import next/*, the database client or anything else with a runtime of
 * its own: it runs in route handlers, server components and vitest alike.
 */

export interface StorefrontNames {
  /** What the merchant set as the App name under Branding, else the restaurant's own name. */
  brand: string;
  /** This branch. */
  branch: string;
  /** Brand and branch together — the browser tab and the share card, where there is room. */
  full: string;
  /**
   * The installed app's name, everywhere an app is named: Chrome's install dialog, the
   * desktop shortcut, the Android launcher label, iOS's home screen and our own install card.
   *
   * It is the brand alone. It used to be `full` in the manifest's `name` and the brand in
   * `short_name`, so Chrome's dialog and the Windows shortcut said "Coastal Grill — Hamburger"
   * while Android said "Coastal Grill" — and neither was a thing the merchant had typed as one
   * name. The Branding card previews exactly this string.
   */
  app: string;
}

/**
 * `||` rather than `??`, after trimming: an empty or blank brand name is as absent as a missing
 * one, and letting it through produced " — Hamburger".
 */
export function deriveStorefrontNames(input: {
  brandName?: string | null;
  restaurantName?: string | null;
  branchName?: string | null;
}): StorefrontNames {
  const brand = input.brandName?.trim() || input.restaurantName?.trim() || '';
  const branch = input.branchName?.trim() || '';
  return {
    brand,
    branch,
    full: branch && brand ? `${brand} — ${branch}` : brand || branch,
    app: brand || branch,
  };
}

export type AppIconVariant = '192' | '512' | 'maskable-512';

export const APP_ICON_VARIANTS: readonly AppIconVariant[] = ['192', '512', 'maskable-512'];

export function parseAppIconVariant(value: string): AppIconVariant | null {
  return (APP_ICON_VARIANTS as readonly string[]).includes(value) ? (value as AppIconVariant) : null;
}

export interface TenantIconUrls {
  icon192Url: string | null;
  icon512Url: string | null;
  iconMaskable512Url: string | null;
}

export function tenantIconUrl(icons: TenantIconUrls, variant: AppIconVariant): string | null {
  switch (variant) {
    case '192':
      return icons.icon192Url || null;
    case '512':
      return icons.icon512Url || null;
    case 'maskable-512':
      return icons.iconMaskable512Url || null;
  }
}

/** The platform's own icons in apps/web/public — what a storefront with no upload installs as. */
export const PLATFORM_ICON_PATHS: Record<AppIconVariant, string> = {
  '192': '/icon-192.png',
  '512': '/icon-512.png',
  'maskable-512': '/icon-maskable-512.png',
};

const ICON_META: Record<AppIconVariant, { sizes: string; purpose: 'any' | 'maskable' }> = {
  '192': { sizes: '192x192', purpose: 'any' },
  '512': { sizes: '512x512', purpose: 'any' },
  'maskable-512': { sizes: '512x512', purpose: 'maskable' },
};

/**
 * FNV-1a, 32-bit, as hex. Not a security measure — a short fingerprint of the upload URL that
 * changes when the merchant uploads a new icon (every upload gets a new storage path) and at no
 * other time.
 *
 * That matters because Chrome decides an installed app's icon needs updating by comparing the
 * manifest's icon URLs. A URL that changes on every menu edit would ask Google to re-mint and
 * silently reinstall the app each time; one that never changes would keep the old icon for good.
 */
export function urlFingerprint(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: 'any' | 'maskable';
}

/**
 * The manifest's icon list: the merchant's icons and ONLY the merchant's icons when they have
 * uploaded one, the platform's when they have not. Never both.
 *
 * Both used to be listed, the platform's as a tail after the merchant's with identical sizes and
 * purposes, as a fallback in case the merchant's file failed to download. Chrome on desktop keeps
 * one bitmap per size and the later entry for a size replaced the earlier one, so the install
 * dialog and the desktop shortcut showed the platform's orange icon for a restaurant whose own
 * icon was sitting first in the list. The fallback now lives in the icon route instead (it
 * redirects to the platform file when the merchant's cannot be fetched), which is what makes it
 * safe to drop the tail.
 *
 * The src is same-origin — `{base}/app-icon/{variant}?v={fingerprint}` — so one icon URL per
 * size never 404s and never depends on a third-party host Chrome may treat differently.
 *
 * A merchant with only a maskable icon (no `any` of either size) gets the platform list: Chrome
 * will not install from a manifest without a purpose-any icon of at least 144px, and losing the
 * install button is worse than the platform's icon.
 */
export function manifestIcons(base: string, icons: TenantIconUrls): ManifestIcon[] {
  const hasAny = !!(icons.icon192Url || icons.icon512Url);
  if (!hasAny) {
    return APP_ICON_VARIANTS.map((variant) => ({
      src: PLATFORM_ICON_PATHS[variant],
      type: 'image/png',
      ...ICON_META[variant],
    }));
  }
  const list: ManifestIcon[] = [];
  for (const variant of APP_ICON_VARIANTS) {
    const url = tenantIconUrl(icons, variant);
    if (!url) continue;
    list.push({
      src: `${base}/app-icon/${variant}?v=${urlFingerprint(url)}`,
      type: 'image/png',
      ...ICON_META[variant],
    });
  }
  return list;
}

/**
 * Only files the admin uploader could have written: the project's own public `branding` bucket.
 *
 * The URL comes from a brands row a merchant can edit, and the icon route fetches it from our
 * server — without this check any merchant could point it at an arbitrary address and have the
 * storefront fetch that on their behalf.
 */
export function isTrustedIconSource(src: string, supabaseUrl: string | undefined): boolean {
  if (!supabaseUrl) return false;
  try {
    const s = new URL(src);
    const base = new URL(supabaseUrl);
    return s.origin === base.origin && s.pathname.startsWith('/storage/v1/object/public/branding/');
  } catch {
    return false;
  }
}
