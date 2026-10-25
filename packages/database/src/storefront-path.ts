/**
 * Storefront addresses: what public.resolve_storefront_path answers, the path a request is sent on
 * to (an old address) or served from (a short one), a storefront's public base, and the web
 * address rules the Branding card shares with the database.
 *
 * Pure on purpose — no client, no next/* — because several runtimes share it: the web app's Edge
 * middleware (which sends the 308 before anything streams and rewrites a short address), the
 * branch layout's fallback for a pair the middleware still had cached as live, the OAuth callback,
 * client components building links, and the admin app.
 *
 * Two forms of one storefront (docs/SHORT-STOREFRONT-URLS-2026-10-26.md):
 *  - the long form `/r/<restaurant>/<branch>/…`, the only route the app has;
 *  - the short form `/r/<web-address>/…` of a branch that has a web address (branches.public_slug),
 *    which the middleware rewrites onto the long form. A branch with one is linked ONLY by it.
 */

/**
 * - `live`: a long-form pair, spelled exactly as asked, of a branch with no web address.
 * - `short`: the first segment is a live web address; served from the long form of
 *   `restaurantSlug`/`branchSlug` (whatever follows the web address is the page).
 * - `redirect`: the request belongs at `publicBase` — the long form of a branch that has a web
 *   address, an address the storefront answered to before a rename (restaurant, branch or web
 *   address), or the same one in other letter case.
 * - `none`: nothing answers to it, or the branch it names is switched off.
 */
export type StorefrontPathStatus = 'live' | 'short' | 'redirect' | 'none';

export interface StorefrontPathResolution {
  status: StorefrontPathStatus;
  /** The branch's long form today (null for `none`). */
  restaurantSlug: string | null;
  branchSlug: string | null;
  /** The branch's web address, or null when it has none. */
  publicSlug: string | null;
  /**
   * Where the storefront's pages live for the browser: `/r/<publicSlug>` or
   * `/r/<restaurant>/<branch>` (null for `none`). Always built here from the slugs above, never
   * taken from the wire as a path.
   */
  publicBase: string | null;
  /**
   * How many path segments after `/r/` the answer covers: 1 for a web address (or an old one),
   * 2 for a long-form pair (or an old one), 0 for `none`.
   */
  segments: 0 | 1 | 2;
}

/** A path segment that could be a slug at all, upper case included (it redirects to lower). */
const SLUG_CANDIDATE = /^[A-Za-z0-9-]{1,64}$/;
/** A slug as the database stores it (restaurants_slug_check, branches' checks). */
const SLUG = /^[a-z0-9](-?[a-z0-9])*$/;
const STOREFRONT_PATH = /^\/r\/([^/?#]+)\/([^/?#]+)(?=$|[/?#])/;
const STOREFRONT_HEAD = /^\/r\/([^/?#]+)(?:\/([^/?#]+))?(?=$|[/?#])/;

/**
 * The two slugs at the head of `/r/<restaurant>/<branch>…`, or null when the path is not a
 * long-form storefront path or a segment could not be a slug (which no database lookup could
 * change). A short address has one segment that matters; read it with storefrontPathHead.
 */
export function storefrontPathSlugs(path: string): { first: string; second: string } | null {
  const match = STOREFRONT_PATH.exec(path);
  if (!match) return null;
  const [, first = '', second = ''] = match;
  if (!SLUG_CANDIDATE.test(first) || !SLUG_CANDIDATE.test(second)) return null;
  return { first, second };
}

/**
 * What resolve_storefront_path is asked about a path: the first segment after `/r/` (a restaurant
 * slug, a web address, or an old one) and the second when it could be a branch slug — null when
 * there is none or it could not be one (`manifest.webmanifest`, an empty segment), which only a
 * short address can use and the database never needs. Null when the path is not under `/r/` or
 * the first segment could not be a slug.
 */
export function storefrontPathHead(path: string): { first: string; second: string | null } | null {
  const match = STOREFRONT_HEAD.exec(path);
  if (!match) return null;
  const [, first = '', second] = match;
  if (!SLUG_CANDIDATE.test(first)) return null;
  return { first, second: second && SLUG_CANDIDATE.test(second) ? second : null };
}

/** `/r/<publicSlug>` when the branch has a web address, else `/r/<restaurant>/<branch>`. */
export function publicBase(restaurantSlug: string, branchSlug: string, publicSlug?: string | null): string {
  return publicSlug ? `/r/${publicSlug}` : `/r/${restaurantSlug}/${branchSlug}`;
}

/**
 * A storefront's public base, for every customer link it builds (`${storefrontBase(t)}/cart`):
 * never the route params, which are the long form even when the browser is on the short one.
 * Takes a ResolvedTenant, or anything shaped like one.
 */
export function storefrontBase(tenant: {
  restaurant: { slug: string };
  branch: { slug: string };
  publicSlug?: string | null;
}): string {
  return publicBase(tenant.restaurant.slug, tenant.branch.slug, tenant.publicSlug);
}

const NONE: StorefrontPathResolution = {
  status: 'none',
  restaurantSlug: null,
  branchSlug: null,
  publicSlug: null,
  publicBase: null,
  segments: 0,
};

/**
 * One row of the RPC's RETURNS TABLE (PostgREST hands back an array; a single object is accepted
 * too), or null when the answer is not one — callers then do nothing, never redirect. A row from
 * before 20261026120000 (no public_slug / segments) reads as the long form it was.
 */
export function parseStorefrontPathResolution(data: unknown): StorefrontPathResolution | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const status = r.status;
  if (status !== 'live' && status !== 'short' && status !== 'redirect' && status !== 'none') return null;
  if (status === 'none') return { ...NONE };
  const slug = (v: unknown) => (typeof v === 'string' && SLUG.test(v) ? v : null);
  const restaurantSlug = slug(r.restaurant_slug);
  const branchSlug = slug(r.branch_slug);
  const publicSlug = slug(r.public_slug);
  if (!restaurantSlug || !branchSlug) return null;
  if (status === 'short' && !publicSlug) return null;
  const segments = r.segments === 1 || r.segments === 2 ? r.segments : status === 'short' ? 1 : 2;
  return {
    status,
    restaurantSlug,
    branchSlug,
    publicSlug,
    publicBase: publicBase(restaurantSlug, branchSlug, publicSlug),
    segments,
  };
}

/** What follows the first `segments` segments after `/r/` (rest of the path, ?query, #hash), or null. */
function pathAfter(path: string, segments: 1 | 2): string | null {
  const head = segments === 1 ? /^\/r\/[^/?#]+(?=$|[/?#])/ : /^\/r\/[^/?#]+\/[^/?#]+(?=$|[/?#])/;
  const match = head.exec(path);
  return match ? path.slice(match[0].length) : null;
}

/**
 * Where a request for `path` belongs when the answer is `redirect`, or null when it stays put.
 *
 * `resolution` must be the answer for this path's own head (storefrontPathHead(path)): it says
 * how many segments it covers, and those are replaced by its public base. `path` may carry its
 * ?query and #hash, and they are kept: a printed table code (`?t=`) or a Stripe return
 * (`?payment_intent=…&redirect_status=…`) that lands on an old address still has to arrive with
 * its parameters. Everything after the replaced segments is kept as it was. Null as well when the
 * answer would send the request to the address it is already at, so nothing can loop.
 */
export function movedStorefrontPath(path: string, resolution: StorefrontPathResolution | null): string | null {
  if (resolution?.status !== 'redirect' || !resolution.publicBase) return null;
  if (resolution.segments !== 1 && resolution.segments !== 2) return null;
  const rest = pathAfter(path, resolution.segments);
  if (rest === null) return null;
  const target = `${resolution.publicBase}${rest}`;
  return target === path ? null : target;
}

/**
 * The long-form path a `short` answer is served from — `/r/<web-address>/cart?t=1` is
 * `/r/<restaurant>/<branch>/cart?t=1` — or null for any other answer. The browser keeps the short
 * URL; this is the middleware's rewrite target.
 */
export function shortStorefrontRewrite(path: string, resolution: StorefrontPathResolution | null): string | null {
  if (resolution?.status !== 'short' || !resolution.restaurantSlug || !resolution.branchSlug) return null;
  const rest = pathAfter(path, 1);
  if (rest === null) return null;
  return `/r/${resolution.restaurantSlug}/${resolution.branchSlug}${rest}`;
}

// ---------------------------------------------------------------------------------------------
// The web address (branches.public_slug)
// ---------------------------------------------------------------------------------------------

/**
 * Words a web address may never be. Keep in step with private.public_slug_problem
 * (20261026120000_branch_public_slugs.sql).
 */
export const RESERVED_PUBLIC_SLUGS: readonly string[] = [
  'r',
  'api',
  'auth',
  'admin',
  'app',
  'www',
  'help',
  'privacy',
  'terms',
  'ccpa',
];

/** What set_branch_public_slug / check_public_slug answer when a web address cannot be had. */
export type PublicSlugError = 'slug_invalid' | 'slug_reserved' | 'slug_taken';

/** What a person typed, as the database reads it: trimmed and lower case; '' for nothing. */
export function normalizePublicSlug(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * The checks that need no database, in the database's order: a reserved word, then the slug rule
 * (2–64 lower-case letters, digits, single hyphens). Null when `slug` (already normalised) passes
 * both; whether it is taken only check_public_slug can say.
 */
export function publicSlugFormatError(slug: string): Exclude<PublicSlugError, 'slug_taken'> | null {
  if (RESERVED_PUBLIC_SLUGS.includes(slug)) return 'slug_reserved';
  if (slug.length < 2 || slug.length > 64 || !SLUG.test(slug)) return 'slug_invalid';
  return null;
}

/** Letters NFD leaves whole. */
const FOLD: Record<string, string> = { đ: 'd', ð: 'd', ø: 'o', ł: 'l', æ: 'ae', œ: 'oe', ß: 'ss', þ: 'th', ı: 'i' };

/**
 * A web address suggested from an App name: lower case, accents stripped ("Phở Hà Nội" ->
 * "pho-ha-noi", "Café Niño" -> "cafe-nino"), anything else between words a single hyphen, cut to
 * 64 characters. '' when the name gives fewer than two usable characters (a Thai name, say): the
 * field is then left for the merchant to type in Latin letters. Reserved words are not filtered
 * here; the availability check names them.
 */
export function suggestPublicSlug(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[đðøłæœßþı]/g, (c) => FOLD[c] ?? c);
  let slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 64) slug = slug.slice(0, 64).replace(/-+$/g, '');
  return slug.length >= 2 ? slug : '';
}
