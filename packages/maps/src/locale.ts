// The interface languages the map components can print their own words in.
//
// Mirrors UiLocale in @favornoms/shared without importing it: this package deliberately has no
// workspace dependencies. The union is identical, so an app passes its UiLocale straight in.

export type MapsLocale = 'en' | 'es' | 'vi' | 'th';

const MAPS_LOCALES: readonly string[] = ['en', 'es', 'vi', 'th'];

/** `value` when it is one of the languages above, otherwise English. */
export function resolveMapsLocale(value: unknown): MapsLocale {
  return typeof value === 'string' && MAPS_LOCALES.includes(value) ? (value as MapsLocale) : 'en';
}
