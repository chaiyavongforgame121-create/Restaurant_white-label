// Per-restaurant storefront appearance, stored in restaurants.storefront (jsonb) and
// shared by every branch of the restaurant. The actual Tailwind grid classes live in
// the web app (so its JIT scanner picks them up) — this module only holds the typed
// config, defaults, parsing, and labels used by both the admin picker and the storefront.

export type MenuLayout = 'list' | 'grid2' | 'grid3' | 'grid4';
export type MenuCardStyle = 'standard' | 'compact';

export interface StorefrontSettings {
  /** Menu item grid density. The number is the column count shown at every screen
   *  width (WYSIWYG). 'list' is a single full-width column. */
  menuLayout: MenuLayout;
  /** Menu card rendering: 'standard' = photo on top, 'compact' = photo on the left. */
  menuCardStyle: MenuCardStyle;
  /** Optional hero/banner image shown at the top of the storefront. */
  heroUrl: string | null;
  /** Headline shown in the storefront hero. Empty = use the built-in default. */
  heroTitle: string;
  /** Tagline under the headline. Empty = "Now serving from {branch}". */
  heroSubtitle: string;
}

export const STOREFRONT_DEFAULTS: StorefrontSettings = {
  menuLayout: 'grid4',
  menuCardStyle: 'standard',
  heroUrl: null,
  heroTitle: '',
  heroSubtitle: '',
};

const MENU_LAYOUTS: readonly MenuLayout[] = ['list', 'grid2', 'grid3', 'grid4'];
const MENU_CARD_STYLES: readonly MenuCardStyle[] = ['standard', 'compact'];

/** Parse restaurants.storefront jsonb into typed settings, falling back to defaults. */
export function parseStorefront(raw: unknown): StorefrontSettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  const layout = s.menu_layout as MenuLayout;
  const card = s.menu_card_style as MenuCardStyle;
  const hero = typeof s.hero_url === 'string' && s.hero_url.length > 0 ? (s.hero_url as string) : null;
  return {
    menuLayout: MENU_LAYOUTS.includes(layout) ? layout : STOREFRONT_DEFAULTS.menuLayout,
    menuCardStyle: MENU_CARD_STYLES.includes(card) ? card : STOREFRONT_DEFAULTS.menuCardStyle,
    heroUrl: hero,
    heroTitle: typeof s.hero_title === 'string' ? s.hero_title : '',
    heroSubtitle: typeof s.hero_subtitle === 'string' ? s.hero_subtitle : '',
  };
}

/** Serialize typed settings back to the jsonb shape stored on restaurants.storefront. */
export function serializeStorefront(s: StorefrontSettings): Record<string, string | null> {
  return {
    menu_layout: s.menuLayout,
    menu_card_style: s.menuCardStyle,
    hero_url: s.heroUrl,
    hero_title: s.heroTitle,
    hero_subtitle: s.heroSubtitle,
  };
}

export const MENU_LAYOUT_LABELS: Record<MenuLayout, string> = {
  list: 'List · 1 column',
  grid2: 'Grid · 2 columns',
  grid3: 'Grid · 3 columns',
  grid4: 'Grid · 4 columns',
};
export const MENU_CARD_STYLE_LABELS: Record<MenuCardStyle, string> = {
  standard: 'Standard (photo on top)',
  compact: 'Compact (photo on left)',
};

// ---- Per-branch override -------------------------------------------------
// Each branch of a restaurant may override the restaurant-level storefront.
// Stored at branches.settings.storefront_override (jsonb). A null/absent key
// means "inherit the restaurant value", so this shares the SAME jsonb key names
// as serializeStorefront (menu_layout / menu_card_style / hero_url).

export interface StorefrontOverride {
  menuLayout: MenuLayout | null;
  menuCardStyle: MenuCardStyle | null;
  heroUrl: string | null;
  heroTitle: string | null;
  heroSubtitle: string | null;
}

export const STOREFRONT_OVERRIDE_EMPTY: StorefrontOverride = {
  menuLayout: null,
  menuCardStyle: null,
  heroUrl: null,
  heroTitle: null,
  heroSubtitle: null,
};

/** Parse branches.settings.storefront_override jsonb. Unlike parseStorefront,
 *  missing/invalid values become null (inherit), NOT the storefront defaults. */
export function parseStorefrontOverride(raw: unknown): StorefrontOverride {
  const s = (raw ?? {}) as Record<string, unknown>;
  const layout = s.menu_layout as MenuLayout;
  const card = s.menu_card_style as MenuCardStyle;
  const hero =
    typeof s.hero_url === 'string' && s.hero_url.length > 0 ? (s.hero_url as string) : null;
  return {
    menuLayout: MENU_LAYOUTS.includes(layout) ? layout : null,
    menuCardStyle: MENU_CARD_STYLES.includes(card) ? card : null,
    heroUrl: hero,
    heroTitle:
      typeof s.hero_title === 'string' && s.hero_title.length > 0 ? (s.hero_title as string) : null,
    heroSubtitle:
      typeof s.hero_subtitle === 'string' && s.hero_subtitle.length > 0
        ? (s.hero_subtitle as string)
        : null,
  };
}

/** Serialize an override back to the jsonb stored on branches.settings.storefront_override.
 *  Null keys are OMITTED so the stored object only carries explicit overrides
 *  (a fully-inheriting branch serializes to {}). */
export function serializeStorefrontOverride(o: StorefrontOverride): Record<string, string> {
  const out: Record<string, string> = {};
  if (o.menuLayout) out.menu_layout = o.menuLayout;
  if (o.menuCardStyle) out.menu_card_style = o.menuCardStyle;
  if (o.heroUrl) out.hero_url = o.heroUrl;
  if (o.heroTitle) out.hero_title = o.heroTitle;
  if (o.heroSubtitle) out.hero_subtitle = o.heroSubtitle;
  return out;
}

/** Effective storefront for a branch: per key, the branch override wins when set,
 *  otherwise inherit the restaurant-level base. */
export function mergeStorefrontOverride(
  base: StorefrontSettings,
  override: StorefrontOverride | null | undefined,
): StorefrontSettings {
  if (!override) return base;
  return {
    menuLayout: override.menuLayout ?? base.menuLayout,
    menuCardStyle: override.menuCardStyle ?? base.menuCardStyle,
    heroUrl: override.heroUrl ?? base.heroUrl,
    heroTitle: override.heroTitle ?? base.heroTitle,
    heroSubtitle: override.heroSubtitle ?? base.heroSubtitle,
  };
}
