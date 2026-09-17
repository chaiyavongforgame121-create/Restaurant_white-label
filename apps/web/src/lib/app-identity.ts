/**
 * What an installed storefront is called and what its icon is — pure, so the manifest route,
 * the icon route, the branch layout and their tests share one answer.
 *
 * Nothing in here may import next/*, the database client or anything else with a runtime of
 * its own: it runs in route handlers, server components and vitest alike.
 */

export interface StorefrontNames {
  /** The brand's name (the brands row), else the restaurant's own name. */
  brand: string;
  /** This branch. */
  branch: string;
  /**
   * What this storefront is called: "<brand> - <branch>", e.g. "Coastal Grill - Hamburger" —
   * the browser tab, the header, the share card, the account and sign-in pages, the receipt.
   * An ASCII hyphen between spaces, because that is how the owner writes it and it survives
   * every launcher, font and share sheet an em dash does not.
   *
   * Just one of the two when they are the same name (a restaurant whose only branch is called
   * what the brand is) or when either is blank, so nothing ever reads "Somtam Zab - Somtam Zab"
   * or " - Hamburger".
   */
  full: string;
  /**
   * The installed app's name wherever there is room for it: Chrome's install dialog, the desktop
   * shortcut, the manifest `name`, <meta name="application-name"> and our own install card.
   *
   * It is `full`. It used to be the brand alone, so two branches of one restaurant installed as
   * two apps with the same name (and, before branches had icons of their own, the same icon) —
   * a customer could not tell which one ordered from which kitchen.
   */
  app: string;
  /**
   * The label under a home-screen icon: the manifest `short_name` and iOS's
   * apple-mobile-web-app-title.
   *
   * It is `full` too, because the owner wants "<brand> - <branch>" on every surface, the
   * home screen included. Launchers may cut a long label down (roughly 12 characters on Android,
   * so two branches can both read "Coastal Gril…"); that is accepted. It was briefly the branch
   * name alone for a restaurant with several branches, which put a label on the home screen that
   * named no restaurant at all.
   */
  short: string;
}

/**
 * `||` rather than `??`, after trimming: an empty or blank name is as absent as a missing one,
 * and letting it through produced " - Hamburger".
 *
 * Depends on the three names alone — nothing about the restaurant's other branches — so a branch
 * being added or retired never renames an app somebody already installed.
 */
export function deriveStorefrontNames(input: {
  brandName?: string | null;
  restaurantName?: string | null;
  branchName?: string | null;
}): StorefrontNames {
  const brand = input.brandName?.trim() || input.restaurantName?.trim() || '';
  const branch = input.branchName?.trim() || '';
  const sameName = brand.toLowerCase() === branch.toLowerCase();
  const full = brand && branch && !sameName ? `${brand} - ${branch}` : brand || branch;
  return { brand, branch, full, app: full, short: full };
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
 * The iPhone home-screen icon (apple-touch-icon).
 *
 * iOS fills transparent pixels with black. When a merchant keeps their tab and computer icons
 * transparent ("only the image, like a PNG"), the admin also renders an opaque 180px copy and
 * saves it as the icon style's appleUrl (branches.app_icon, or brands.theme.appIcon for a branch
 * still on the brand's set); the tenant resolver hands it over as `tenant.appleIconUrl`, from the
 * same source as the rest of the icon set. (Reading it from `tenant.theme` missed every branch
 * not linked to a brand, whose theme is the restaurant's colours — the usual case.) Without one
 * it falls back to `fallback` (the 192), which older uploads always rendered opaque. Only a file
 * in the branding bucket is trusted.
 */
export function appleTouchIconUrl(
  appleUrl: string | null | undefined,
  fallback: string | null | undefined,
  supabaseUrl: string | undefined,
): string | null {
  if (appleUrl && isTrustedIconSource(appleUrl, supabaseUrl)) return appleUrl;
  return fallback || null;
}

/**
 * Only files the admin uploader could have written: the project's own public `branding` bucket.
 *
 * The URL comes from a branches or brands row a merchant can edit, and the icon route fetches it from our
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
