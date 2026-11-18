import 'server-only';
import { cache } from 'react';
import type { Metadata } from 'next';
import { appIconAppleUrl, appIconStyleAppleUrl } from '@favornoms/database/queries';
import { getServerClient } from '@favornoms/database/server';

type ServerClient = Awaited<ReturnType<typeof getServerClient>>;

/**
 * The browser-tab icon of a branch's back office: the App icon the merchant uploads in Branch
 * settings -> Branding, the same set the branch's storefront wears.
 *
 * Every /b, /counter and /kitchen page used to wear the admin root layout's FavorNoms icons, so a
 * merchant who had just saved their App icon looked up at their own tab and saw ours ("the favicon
 * doesn't follow the app logo we uploaded"), while the storefront already showed theirs.
 *
 * The set is chosen exactly as resolveTenantBySlug chooses the storefront's
 * (packages/database/src/queries/tenant.ts): taken whole from the branch once it has an
 * installed-app icon of its own (icon_192_url or icon_512_url), else whole from its brand (the
 * linked brand when it is this restaurant's, else the restaurant's default one), else none, which
 * leaves the root layout's FavorNoms icons in place. Mixing the two would put the brand's tab icon
 * beside the branch's home-screen icon.
 */
export interface BranchAppIcons {
  /** A legacy free-form favicon: no known size. */
  faviconUrl: string | null;
  /** The normalised square PNGs the admin uploader writes. */
  icon192Url: string | null;
  icon512Url: string | null;
  /** The opaque 180px iPhone icon (the icon style's appleUrl), or null. */
  appleIconUrl: string | null;
}

const BRAND_ICON_COLUMNS = 'theme, favicon_url, icon_192_url, icon_512_url';

/**
 * Reads the set through the signed-in client: RLS lets staff read their branch and its brand, and
 * a platform admin the branch (branches_staff_read) and the brand of any restaurant with an active
 * branch (brands_public_read), so support sees the merchant's tab too. Null when there is no set,
 * and on any read error: the tab then keeps the FavorNoms icons, which is never worth failing a
 * back-office page over.
 */
export async function readBranchAppIcons(
  supabase: ServerClient,
  branchId: string,
): Promise<BranchAppIcons | null> {
  try {
    const { data: branch, error } = await supabase
      .from('branches')
      .select('restaurant_id, brand_id, favicon_url, icon_192_url, icon_512_url, app_icon')
      .eq('id', branchId)
      .maybeSingle();
    if (error || !branch) return null;

    if (branch.icon_192_url || branch.icon_512_url) {
      return {
        faviconUrl: branch.favicon_url ?? null,
        icon192Url: branch.icon_192_url ?? null,
        icon512Url: branch.icon_512_url ?? null,
        appleIconUrl: appIconStyleAppleUrl(branch.app_icon),
      };
    }

    // Asked together, as the storefront does. The linked brand only counts when it is this
    // restaurant's (a brand_id from before the branch_brand_other_restaurant trigger may point at
    // another restaurant's); a miss is handled exactly like no link at all.
    const [linked, fallback] = await Promise.all([
      branch.brand_id
        ? supabase
            .from('brands')
            .select(BRAND_ICON_COLUMNS)
            .eq('id', branch.brand_id)
            .eq('restaurant_id', branch.restaurant_id)
            .limit(1)
        : null,
      supabase
        .from('brands')
        .select(BRAND_ICON_COLUMNS)
        .eq('restaurant_id', branch.restaurant_id)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1),
    ]);
    if (linked?.error || fallback.error) return null;
    const brand = linked?.data?.[0] ?? fallback.data?.[0] ?? null;
    if (!brand) return null;
    return {
      faviconUrl: brand.favicon_url ?? null,
      icon192Url: brand.icon_192_url ?? null,
      icon512Url: brand.icon_512_url ?? null,
      appleIconUrl: appIconAppleUrl(brand.theme),
    };
  } catch {
    return null;
  }
}

/**
 * Only a file in this project's own public `branding` bucket, which is the only place the admin
 * uploader writes. The URLs are text a merchant can edit, and these links are rendered in a back
 * office platform admins open too: another address must not make their browser fetch it. The
 * storefront's isTrustedIconSource asks the same of the iPhone icon.
 */
export function isOwnBrandingFile(src: string | null | undefined, supabaseUrl: string | undefined): src is string {
  if (!src || !supabaseUrl) return false;
  try {
    const s = new URL(src);
    return (
      s.origin === new URL(supabaseUrl).origin &&
      s.pathname.startsWith('/storage/v1/object/public/branding/')
    );
  } catch {
    return false;
  }
}

/**
 * FNV-1a, 32-bit, as hex: exactly the storefront's urlFingerprint (apps/web/src/lib/app-identity.ts).
 * Not a security measure, a cache key: every upload gets a new storage path, so the `?v=` of a tab
 * icon link changes when the merchant uploads a new icon and at no other time.
 */
export function urlFingerprint(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The file a branch's tab icon is made from, which the metadata and the /api/branch-icon route
 * must agree on: the own 192 (`sized`, a real 192x192 PNG), else the own legacy favicon (no known
 * size), else none. A 512 alone is no tab icon, as on the storefront.
 */
export function branchTabIconSource(
  icons: BranchAppIcons | null,
  supabaseUrl: string | undefined,
): { url: string; sized: boolean } | null {
  if (!icons) return null;
  if (isOwnBrandingFile(icons.icon192Url, supabaseUrl)) return { url: icons.icon192Url, sized: true };
  if (isOwnBrandingFile(icons.faviconUrl, supabaseUrl)) return { url: icons.faviconUrl, sized: false };
  return null;
}

/** The variants /api/branch-icon/<branchId>/<variant> serves. */
export const BRANCH_ICON_VARIANTS = ['favicon-32', '192'] as const;
export type BranchIconVariant = (typeof BRANCH_ICON_VARIANTS)[number];

/**
 * The `icons` metadata for a set, or {} to inherit the root layout's FavorNoms icons. Nothing
 * else: the admin manifest, title and app name stay FavorNoms Merchant.
 *
 * Every tab icon link is same-origin, through /api/branch-icon. Chrome on an Android tablet showed
 * the generic globe for the merchant's cross-origin 192/512 PNGs on the Supabase host (2026-11-16)
 * while same-origin 32/16 PNGs showed, so the tab is offered a 32x32 rendered from the source
 * first, then the source itself. Sizes are claimed only for the real 192; a legacy free-form
 * favicon is one link with no sizes, because claiming dimensions a file does not have is worse
 * than claiming none. `?v=` is the source's fingerprint, which lets the route pin the bytes.
 *
 * The iPhone icon stays the cross-origin file, as before: the opaque appleUrl (iOS paints
 * transparency black, and the 192 may be transparent), else the 192, else the favicon.
 */
export function branchIconsMetadata(
  branchId: string,
  icons: BranchAppIcons | null,
  supabaseUrl: string | undefined,
): Metadata {
  const source = branchTabIconSource(icons, supabaseUrl);
  if (!icons || !source) return {};
  const route = `/api/branch-icon/${encodeURIComponent(branchId)}`;
  const v = urlFingerprint(source.url);
  const own = (url: string | null) => (isOwnBrandingFile(url, supabaseUrl) ? url : null);
  return {
    icons: {
      icon: source.sized
        ? [
            { url: `${route}/favicon-32?v=${v}`, sizes: '32x32', type: 'image/png' },
            { url: `${route}/192?v=${v}`, sizes: '192x192', type: 'image/png' },
          ]
        : [{ url: `${route}/192?v=${v}`, type: 'image/png' }],
      apple: own(icons.appleIconUrl) ?? own(icons.icon192Url) ?? own(icons.faviconUrl) ?? undefined,
    },
  };
}

/**
 * What the /b, /counter and /kitchen layouts return from generateMetadata: `icons: null` when the
 * branch (or its brand) has a tab icon, so the root layout's FavorNoms icons are not inherited,
 * else {} to keep them. The branch's own links are rendered by the layout itself (BranchTabIcons),
 * where they survive in-app navigation: Next re-renders metadata on every navigation, taking the
 * <link rel="icon"> elements out of <head> and putting new ones in, and Chrome on Android left the
 * tab on the globe after that (the owner's video, 2026-11-18).
 */
export async function branchTabIconsMetadata(branchId: string): Promise<Metadata> {
  return (await getBranchIconMetadata(branchId)).icons ? { icons: null } : {};
}

/**
 * The branch's tab icon set as metadata, or {} for none: the links BranchTabIcons renders.
 * The branch's own tab icon, else its brand's, else {} (the FavorNoms icons). Read once per request however many
 * segments ask. Not cached beyond the request: the Branding card calls router.refresh() after a
 * save, and the new icon has to be in the tab on that render.
 */
export const getBranchIconMetadata = cache(async (branchId: string): Promise<Metadata> => {
  // Outside readBranchAppIcons' try: cookies() is how Next learns this render is per-user, and
  // that must not be swallowed.
  const supabase = await getServerClient();
  return branchIconsMetadata(
    branchId,
    await readBranchAppIcons(supabase, branchId),
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
});
