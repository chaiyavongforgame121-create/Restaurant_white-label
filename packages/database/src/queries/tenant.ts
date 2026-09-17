import {
  mergeStorefrontOverride,
  parseStorefront,
  parseStorefrontOverride,
  type Branch,
  type Restaurant,
  type StorefrontSettings,
  type TenantTheme,
} from '@favornoms/shared';
import type { Database } from '../types';
import type { FavornomsClient } from '../client-type';

type RowRestaurant = Database['public']['Tables']['restaurants']['Row'];
type RowBranch = Database['public']['Tables']['branches']['Row'];

export interface ResolvedTenant {
  restaurant: Restaurant;
  branch: Branch;
  /**
   * Brand colours (the linked brand's theme, else restaurants.brand_settings) under the branch's
   * theme_override. Never carries `brandName`: the per-branch Branding card once wrote a branch's
   * name into the shared brand's theme there, and every branch then showed it. Read the name from
   * `brandName` below.
   *
   * "Linked" means branches.brand_id names a brand OF THIS RESTAURANT. A brand_id pointing at
   * another restaurant's brand is treated exactly like no link at all.
   */
  theme: TenantTheme;
  /** Per-restaurant storefront appearance (menu layout + card style), shared by all branches. */
  storefront: StorefrontSettings;
  /**
   * The brand's own name: the branch's linked brand row (only when it belongs to this
   * restaurant), else the restaurant's default brand, else restaurants.name. The storefront joins
   * it with the branch name ("Coastal Grill - Hamburger") on every surface, the installed app's
   * home-screen label included; see deriveStorefrontNames in apps/web.
   */
  brandName: string;
  /** Storefront logo: the branch's own (branches.logo_url), else its brand's. */
  logoUrl: string | null;
  /**
   * Favicon (browser tab icon). Deliberately separate from logoUrl — a wide storefront logo is an
   * unreadable smudge at 32px, so falling back to it would look broken rather than unbranded. Null
   * means "use the platform icon".
   *
   * This and the four icon fields below are ONE set, taken whole from the branch when the branch
   * has an installed-app icon of its own (branches.icon_192_url or icon_512_url), and otherwise
   * whole from the brand. Mixing the two would put the brand's tab icon beside the branch's
   * home-screen icon.
   */
  faviconUrl: string | null;
  /**
   * Exactly-sized PNGs for the web app manifest. Null means "fall back to the
   * platform icons" — a manifest entry whose declared `sizes` does not match the
   * bytes fails Chrome's installability check and removes the install prompt
   * entirely, so these are only ever written by the normalising admin uploader.
   */
  icon192Url: string | null;
  icon512Url: string | null;
  iconMaskable512Url: string | null;
  /**
   * The opaque 180px iPhone icon (the icon style's `appleUrl`) from the same source as the icon
   * files above — branches.app_icon for a branch with its own set, the brand row's
   * theme.appIcon otherwise — or null. iOS paints transparency black, and the 192 may be
   * transparent ("only the image, like a PNG"). Not validated here — the storefront checks it is
   * a file in the branding bucket before using it.
   *
   * Never read from `theme`: an unlinked branch's theme is restaurants.brand_settings (colours
   * deliberately do not fall back), which never holds it.
   */
  appleIconUrl: string | null;
}

/** The `appleUrl` of an icon style (branches.app_icon, brands.theme.appIcon), when it has one. */
export function appIconStyleAppleUrl(appIcon: unknown): string | null {
  const url = appIcon && typeof appIcon === 'object' ? (appIcon as Record<string, unknown>).appleUrl : null;
  return typeof url === 'string' && url ? url : null;
}

/** brands.theme.appIcon.appleUrl, when the theme has one. */
export function appIconAppleUrl(theme: unknown): string | null {
  return appIconStyleAppleUrl(
    theme && typeof theme === 'object' ? (theme as Record<string, unknown>).appIcon : null,
  );
}

/**
 * The theme without `brandName`. The name has one source now (ResolvedTenant.brandName); a stale
 * key left in brands.theme, restaurants.brand_settings or a branch's theme_override must not ride
 * into the storefront theme, where something could start reading it again.
 */
function withoutBrandName<T extends Partial<TenantTheme>>(theme: T): T {
  if (!('brandName' in theme)) return theme;
  const copy = { ...theme };
  delete copy.brandName;
  return copy;
}

const BRAND_COLUMNS = 'name, theme, logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url';

/**
 * Resolve a `{restaurant_slug, branch_slug}` pair to full tenant data.
 * Per implementation.md §9.2 — should be cached in Redis/KV in production.
 */
export async function resolveTenantBySlug(
  supabase: FavornomsClient,
  restaurantSlug: string,
  branchSlug: string,
): Promise<ResolvedTenant | null> {
  // Two-step query — simpler typing than nested join with !inner.
  const { data: restaurantRow, error: rErr } = await supabase
    .from('restaurants')
    .select('id, slug, name, brand_settings, owner_user_id, created_at, updated_at, storefront')
    .eq('slug', restaurantSlug)
    .maybeSingle();
  if (rErr || !restaurantRow) return null;

  const { data: branchRow, error: bErr } = await supabase
    .from('branches')
    .select(
      'id, restaurant_id, slug, name, address, timezone, theme_override, settings, is_active, custom_domain, brand_id, geo_lat, geo_lng, created_at, updated_at, logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url, app_icon',
    )
    .eq('restaurant_id', restaurantRow.id)
    .eq('slug', branchSlug)
    .eq('is_active', true)
    .maybeSingle();
  if (bErr || !branchRow) return null;

  const r = restaurantRow as unknown as RowRestaurant;
  const b = branchRow as unknown as RowBranch;

  const [linkedResult, defaultResult] = await Promise.all([
    // The linked brand, and only if it is this restaurant's. brand ids are publicly readable, so
    // a brand_id pointing at another restaurant's brand (written before the
    // branch_brand_other_restaurant trigger existed) would otherwise put that restaurant's name,
    // colours and icons on this storefront. A miss is handled exactly like no link at all.
    b.brand_id
      ? supabase
          .from('brands')
          .select(BRAND_COLUMNS)
          .eq('id', b.brand_id)
          .eq('restaurant_id', r.id)
          .limit(1)
      : null,
    // The restaurant's default brand, for the NAME and the fallback ASSETS when there is no
    // (valid) link.
    //
    // Linking a branch to a brand is optional in the admin UI and nothing prompts for it,
    // so branches.brand_id is routinely null. The THEME still deliberately does not fall
    // back: colours have a restaurant-level source (restaurants.brand_settings), so
    // overriding them here would silently restyle a live storefront. The name does, because
    // migration 20260904132000 made one brand row per restaurant a hard invariant — there is
    // no question of WHICH brand's name would win. `theme` is read only for appIcon.appleUrl.
    supabase
      .from('brands')
      .select(BRAND_COLUMNS)
      .eq('restaurant_id', r.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1),
  ]);
  const linkedBrandRow = linkedResult?.data?.[0] ?? null;
  const brandRow = linkedBrandRow ?? defaultResult.data?.[0] ?? null;

  // Resolve theme base: linked brand of this restaurant (if attached) > restaurant.brand_settings.
  const brandTheme = withoutBrandName(
    (linkedBrandRow?.theme ? linkedBrandRow.theme : (r.brand_settings ?? {})) as TenantTheme,
  );
  const brandName = brandRow?.name?.trim() || r.name;

  // The icon set is taken whole from one source. A branch owns its set once it has an
  // installed-app icon of its own; until then (a branch created after 20260917150000's backfill
  // that has never saved one) it renders exactly what the brand has.
  const branchOwnsIcons = !!(b.icon_192_url || b.icon_512_url);
  const icons = branchOwnsIcons
    ? {
        faviconUrl: b.favicon_url ?? null,
        icon192Url: b.icon_192_url ?? null,
        icon512Url: b.icon_512_url ?? null,
        iconMaskable512Url: b.icon_maskable_512_url ?? null,
        appleIconUrl: appIconStyleAppleUrl(b.app_icon),
      }
    : {
        faviconUrl: brandRow?.favicon_url ?? null,
        icon192Url: brandRow?.icon_192_url ?? null,
        icon512Url: brandRow?.icon_512_url ?? null,
        iconMaskable512Url: brandRow?.icon_maskable_512_url ?? null,
        appleIconUrl: appIconAppleUrl(brandRow?.theme),
      };

  const restaurant: Restaurant = {
    id: r.id,
    slug: r.slug,
    name: r.name,
    brandSettings: brandTheme,
  };

  const branch: Branch = {
    id: b.id,
    restaurantId: b.restaurant_id,
    slug: b.slug,
    name: b.name,
    address: b.address ?? '',
    geoLocation: { lat: b.geo_lat ?? 0, lng: b.geo_lng ?? 0 },
    themeOverride: withoutBrandName((b.theme_override ?? {}) as Partial<TenantTheme>),
    settings: parseSettings(b.settings),
    isActive: b.is_active,
  };

  const theme: TenantTheme = {
    ...brandTheme,
    ...branch.themeOverride,
  };

  // Effective storefront = branch override (branches.settings.storefront_override)
  // over the restaurant-level value, per key. Read off the RAW b.settings jsonb —
  // parseSettings() drops unknown keys, so it must not be sourced from branch.settings.
  const restaurantStorefront = parseStorefront(r.storefront);
  const branchOverride = parseStorefrontOverride(
    (b.settings as Record<string, unknown> | null)?.storefront_override,
  );
  const storefront = mergeStorefrontOverride(restaurantStorefront, branchOverride);

  return {
    restaurant,
    branch,
    theme,
    storefront,
    brandName,
    logoUrl: b.logo_url || brandRow?.logo_url || null,
    ...icons,
  };
}

function parseSettings(raw: unknown): Branch['settings'] {
  const s = (raw ?? {}) as Record<string, unknown>;
  return {
    currency: (s.currency as string) ?? 'USD',
    salesTaxRate: s.sales_tax_rate as number | undefined,
    deliveryRadiusKm: (s.delivery_radius_km as number) ?? 8,
    driverSearchRadiusKm: s.driver_search_radius_km as number | undefined,
    driverDispatchTimeoutSeconds: s.driver_dispatch_timeout_seconds as number | undefined,
    serviceFeePercent: s.service_fee_percent as number | undefined,
    timezone: (s.timezone as string | undefined) ?? 'America/New_York',
  };
}
