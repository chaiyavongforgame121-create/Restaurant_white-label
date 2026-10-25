/**
 * Storefront addresses that moved: what public.resolve_storefront_path answers, and the path a
 * request for an old address is sent on to.
 *
 * Pure on purpose — no client, no next/* — because three runtimes share it: the web app's Edge
 * middleware (which sends the 308 before anything streams), the branch layout's fallback for a
 * pair the middleware still had cached as live, and the OAuth callback.
 */

/**
 * - `live`: the pair is a storefront today, spelled exactly as asked.
 * - `redirect`: it is an address the storefront answered to before a rename (or the same one in
 *   other letter case), and `restaurantSlug`/`branchSlug` are where it lives now.
 * - `none`: nothing answers to it, or the branch it names is switched off.
 */
export type StorefrontPathStatus = 'live' | 'redirect' | 'none';

export interface StorefrontPathResolution {
  status: StorefrontPathStatus;
  restaurantSlug: string | null;
  branchSlug: string | null;
}

/** A path segment that could be a slug at all, upper case included (it redirects to lower). */
const SLUG_CANDIDATE = /^[A-Za-z0-9-]{1,64}$/;
const STOREFRONT_PATH = /^\/r\/([^/?#]+)\/([^/?#]+)(?=$|[/?#])/;

/**
 * The two slugs at the head of `/r/<restaurant>/<branch>…`, or null when the path is not a
 * storefront path or a segment could not be a slug (which no database lookup could change).
 */
export function storefrontPathSlugs(path: string): { first: string; second: string } | null {
  const match = STOREFRONT_PATH.exec(path);
  if (!match) return null;
  const [, first = '', second = ''] = match;
  if (!SLUG_CANDIDATE.test(first) || !SLUG_CANDIDATE.test(second)) return null;
  return { first, second };
}

/**
 * One row of the RPC's RETURNS TABLE (PostgREST hands back an array; a single object is accepted
 * too), or null when the answer is not one — callers then do nothing, never redirect.
 */
export function parseStorefrontPathResolution(data: unknown): StorefrontPathResolution | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.status !== 'live' && r.status !== 'redirect' && r.status !== 'none') return null;
  const slug = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return { status: r.status, restaurantSlug: slug(r.restaurant_slug), branchSlug: slug(r.branch_slug) };
}

/**
 * Where a request for `path` belongs when its slugs moved, or null when it stays put.
 *
 * `path` may carry its ?query and #hash, and they are kept: a printed table code (`?t=`) or a
 * Stripe return (`?payment_intent=…&redirect_status=…`) that lands on an old address still has to
 * arrive with its parameters. Everything after the two slugs is kept as it was. Null as well when
 * the answer would send the request to the address it is already at, so nothing can loop.
 */
export function movedStorefrontPath(path: string, resolution: StorefrontPathResolution | null): string | null {
  if (resolution?.status !== 'redirect' || !resolution.restaurantSlug || !resolution.branchSlug) return null;
  const slugs = storefrontPathSlugs(path);
  if (!slugs) return null;
  if (slugs.first === resolution.restaurantSlug && slugs.second === resolution.branchSlug) return null;
  const head = `/r/${slugs.first}/${slugs.second}`;
  return `/r/${resolution.restaurantSlug}/${resolution.branchSlug}${path.slice(head.length)}`;
}
