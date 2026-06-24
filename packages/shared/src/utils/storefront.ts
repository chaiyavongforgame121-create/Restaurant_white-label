// Per-restaurant storefront appearance, stored in restaurants.storefront (jsonb) and
// shared by every branch of the restaurant. The actual Tailwind grid classes live in
// the web app (so its JIT scanner picks them up) — this module only holds the typed
// config, defaults, parsing, and labels used by both the admin picker and the storefront.

export type MenuLayout = 'list' | 'grid2' | 'grid3' | 'grid4';
export type MenuCardStyle = 'standard' | 'compact';

export interface StorefrontSettings {
  /** Menu item grid density. The number is the desktop column count; it scales down on
   *  smaller screens. 'list' is a single full-width column. */
  menuLayout: MenuLayout;
  /** Menu card rendering: 'standard' = photo on top, 'compact' = photo on the left. */
  menuCardStyle: MenuCardStyle;
  /** Optional hero/banner image shown at the top of the storefront. */
  heroUrl: string | null;
}

export const STOREFRONT_DEFAULTS: StorefrontSettings = {
  menuLayout: 'grid4',
  menuCardStyle: 'standard',
  heroUrl: null,
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
  };
}

/** Serialize typed settings back to the jsonb shape stored on restaurants.storefront. */
export function serializeStorefront(s: StorefrontSettings): Record<string, string | null> {
  return { menu_layout: s.menuLayout, menu_card_style: s.menuCardStyle, hero_url: s.heroUrl };
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
