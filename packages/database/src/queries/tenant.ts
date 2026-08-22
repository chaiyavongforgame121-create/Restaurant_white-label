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
  theme: TenantTheme;
  /** Per-restaurant storefront appearance (menu layout + card style), shared by all branches. */
  storefront: StorefrontSettings;
  /** Brand logo (from the branch's brand), shown on the storefront. */
  logoUrl: string | null;
  /**
   * Brand favicon (browser tab icon). Deliberately separate from logoUrl — a
   * wide storefront logo is an unreadable smudge at 32px, so falling back to it
   * would look broken rather than unbranded. Null means "use the platform icon".
   */
  faviconUrl: string | null;
}

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
      'id, restaurant_id, slug, name, address, timezone, theme_override, settings, is_active, custom_domain, brand_id, geo_lat, geo_lng, created_at, updated_at',
    )
    .eq('restaurant_id', restaurantRow.id)
    .eq('slug', branchSlug)
    .eq('is_active', true)
    .maybeSingle();
  if (bErr || !branchRow) return null;

  const r = restaurantRow as unknown as RowRestaurant;
  const b = branchRow as unknown as RowBranch;

  // Resolve theme base: brand (if attached) > restaurant.brand_settings.
  let brandTheme: TenantTheme = (r.brand_settings ?? {}) as TenantTheme;
  let brandName: string | undefined;
  let brandLogo: string | null = null;
  let brandFavicon: string | null = null;
  if (b.brand_id) {
    const { data: brandRow } = await supabase
      .from('brands')
      .select('name, theme, logo_url, favicon_url')
      .eq('id', b.brand_id)
      .maybeSingle();
    if (brandRow) {
      brandTheme = (brandRow.theme ?? brandTheme) as TenantTheme;
      brandName = brandRow.name;
      brandLogo = brandRow.logo_url ?? null;
      brandFavicon = brandRow.favicon_url ?? null;
    }
  } else {
    // Fall back to the restaurant's default brand for the ASSETS only.
    //
    // Linking a branch to a brand is optional in the admin UI and nothing
    // prompts for it, so branches.brand_id is routinely null — which meant an
    // uploaded logo or favicon was stored correctly and then never read,
    // looking to the merchant like the upload had silently failed.
    //
    // Theme and brandName deliberately do NOT fall back: they already have a
    // restaurant-level source (restaurants.brand_settings), so overriding them
    // here would silently restyle a live storefront. The assets have no such
    // source — that absence is the whole bug.
    const { data: defaultBrand } = await supabase
      .from('brands')
      .select('logo_url, favicon_url')
      .eq('restaurant_id', r.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1);
    const db = defaultBrand?.[0];
    if (db) {
      brandLogo = db.logo_url ?? null;
      brandFavicon = db.favicon_url ?? null;
    }
  }

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
    themeOverride: (b.theme_override ?? {}) as Partial<TenantTheme>,
    settings: parseSettings(b.settings),
    isActive: b.is_active,
  };

  const theme: TenantTheme = {
    ...brandTheme,
    ...branch.themeOverride,
    ...(brandName ? { brandName } : {}),
  };

  // Effective storefront = branch override (branches.settings.storefront_override)
  // over the restaurant-level value, per key. Read off the RAW b.settings jsonb —
  // parseSettings() drops unknown keys, so it must not be sourced from branch.settings.
  const restaurantStorefront = parseStorefront(r.storefront);
  const branchOverride = parseStorefrontOverride(
    (b.settings as Record<string, unknown> | null)?.storefront_override,
  );
  const storefront = mergeStorefrontOverride(restaurantStorefront, branchOverride);

  return { restaurant, branch, theme, storefront, logoUrl: brandLogo, faviconUrl: brandFavicon };
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
