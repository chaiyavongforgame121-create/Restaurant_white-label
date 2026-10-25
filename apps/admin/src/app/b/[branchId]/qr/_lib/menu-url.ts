import { storefrontBase } from '@/lib/site-url';

export interface BranchMenuLink {
  /** The public menu address, or null when there is nothing to point a code at. */
  url: string | null;
  /** Which slug(s) are empty — drives the "fix exactly this" message. */
  missingSlugs: string[];
}

/**
 * The one address every printed code points at: the storefront's /r/<restaurant>/<branch>
 * path. Shared by the branch code and the per-table codes so the two can never disagree about
 * where a scan lands.
 *
 * There is no custom-domain form any more (removed 2026-10-26). If a slug is ever renamed, a code
 * already printed keeps working: the storefront 308s the old address to the new one, query string
 * included (storefront_path_aliases).
 */
export function branchMenuLink(
  branchSlug: string | null | undefined,
  restaurantSlug: string | null | undefined,
): BranchMenuLink {
  const missingSlugs: string[] = [];
  if (!branchSlug) missingSlugs.push('branch');
  if (!restaurantSlug) missingSlugs.push('restaurant');

  const url = missingSlugs.length === 0 ? `${storefrontBase()}/r/${restaurantSlug}/${branchSlug}` : null;

  return { url, missingSlugs };
}

/**
 * The per-table deep link — the branch menu plus the table's token.
 *
 * `?t=` rides on the existing menu URL rather than getting a route of its own, and survives the
 * storefront's redirect from an old address untouched (the middleware keeps the query string).
 * This is the only place that builds the shape; the storefront reads it in one place too.
 */
export function tableMenuLink(menuUrl: string, token: string): string {
  return `${menuUrl}${menuUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
}
