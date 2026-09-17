// The languages the apps' own interface can be shown in.
//
// This is UI chrome only — buttons, navigation, statuses, errors. It is deliberately a different
// type from `Locale` in ../types, which describes merchant CONTENT (menu names and their
// name_translations). Widening that one would make the storefront swap the dish names a merchant
// typed for seeded translations, which the owner ruled out: menu items, ingredients and restaurant
// names are shown exactly as entered, whatever language the interface is in.

export const UI_LOCALES = ['en', 'es', 'vi', 'th'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
export const DEFAULT_UI_LOCALE: UiLocale = 'en';

/** Each language named in itself, so a person can find theirs whatever the page is showing. */
export const UI_LOCALE_NAMES: Record<UiLocale, string> = {
  en: 'English',
  es: 'Español',
  vi: 'Tiếng Việt',
  th: 'ไทย',
};

/**
 * One cookie per app. On localhost the three apps share a cookie jar across ports, and in
 * production a merchant may keep the back office in Thai while their storefront follows each
 * diner's phone — one shared name would make a switch in one app flip the others.
 */
export const UI_LOCALE_COOKIE = {
  web: 'fn_locale',
  admin: 'fn_admin_locale',
  driver: 'fn_driver_locale',
} as const;

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && (UI_LOCALES as readonly string[]).includes(value);
}

/**
 * The best supported language for an Accept-Language header, by quality then order, matching on
 * the primary subtag ("th-TH" -> "th"). Falls back to English.
 */
export function negotiateUiLocale(acceptLanguage: string | null | undefined): UiLocale {
  if (!acceptLanguage) return DEFAULT_UI_LOCALE;
  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const quality = q ? Number(q.slice(2)) : 1;
      return { primary: tag.toLowerCase().split('-')[0] ?? '', quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((entry) => entry.primary && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const entry of ranked) {
    if (isUiLocale(entry.primary)) return entry.primary;
  }
  return DEFAULT_UI_LOCALE;
}

/**
 * The BCP 47 tag to hand Intl for dates and times in a UI language.
 *
 * Thai uses the Gregorian calendar here on purpose: th-TH defaults to the Buddhist era (2569),
 * which would put a different year on screen from the one on every receipt, payout and report.
 * Money is NOT formatted with this — prices stay in the restaurant's US format in every language
 * (vi-VN and es would print "1.234,50 US$" next to totals charged as $1,234.50).
 */
export function intlLocaleFor(locale: UiLocale): string {
  switch (locale) {
    case 'th':
      return 'th-TH-u-ca-gregory';
    case 'vi':
      return 'vi-VN';
    case 'es':
      return 'es';
    default:
      return 'en-US';
  }
}

type Messages = { [key: string]: string | Messages };

/**
 * `override` laid over `base`, recursively. Used to show English for any key a translation has
 * not filled in yet, instead of a raw key or a thrown error.
 */
export function mergeMessages<T extends Messages>(base: T, override: Messages | undefined): T {
  if (!override) return base;
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    if (typeof value === 'string') {
      if (value.trim() !== '') out[key] = value;
    } else if (value && typeof value === 'object') {
      out[key] = mergeMessages(
        current && typeof current === 'object' ? current : {},
        value,
      );
    }
  }
  return out as T;
}
