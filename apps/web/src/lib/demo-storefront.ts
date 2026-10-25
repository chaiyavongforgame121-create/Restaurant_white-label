import { unstable_cache } from 'next/cache';
import { getAnonServerClient } from '@favornoms/database/server';
import {
  movedStorefrontPath,
  resolveStorefrontPath,
  type StorefrontPathResolution,
} from '@favornoms/database/queries';

/**
 * The showcase store's long form: restaurant "Demo-FavorNoms", branch Hamburger. It answers
 * whatever happens (it 308s to the short form once the branch has a web address).
 */
export const DEMO_STOREFRONT_LONG_PATH = '/r/demo-favornoms/brooklyn';

/**
 * Where the landing page's and the 404 page's "see the live menu" link points, given what
 * resolve_storefront_path answers for the long form: the branch's web address once it has one
 * (20261026120000 gives Hamburger `hamburger` when the word is free), else the long form.
 */
export function demoStorefrontHref(resolution: StorefrontPathResolution | null): string {
  return movedStorefrontPath(DEMO_STOREFRONT_LONG_PATH, resolution) ?? DEMO_STOREFRONT_LONG_PATH;
}

/**
 * The demo link, read at most once an hour. Asked rather than written down because the short
 * address exists only once the migration has given the branch one, and only when the word was
 * free; until then, or when the database cannot be reached, the long form still lands there.
 */
export const demoStorefrontPath = unstable_cache(
  async (): Promise<string> => {
    try {
      return demoStorefrontHref(await resolveStorefrontPath(getAnonServerClient(), 'demo-favornoms', 'brooklyn'));
    } catch {
      // The landing page and the 404 page render without a database; the long form still lands.
      return DEMO_STOREFRONT_LONG_PATH;
    }
  },
  ['demo-storefront-path-v1'],
  { revalidate: 3600 },
);
