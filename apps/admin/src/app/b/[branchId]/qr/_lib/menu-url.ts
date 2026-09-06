import { storefrontBase } from '@/lib/site-url';

export interface BranchMenuLink {
  /** The public menu address, or null when there is nothing to point a code at. */
  url: string | null;
  /** Which slug(s) are empty — drives the "fix exactly this" message. */
  missingSlugs: string[];
}

/**
 * The one address every printed code points at.
 *
 * A branch custom domain is rewritten straight to this branch's menu by the customer-app
 * middleware (resolve_custom_domain), so its root IS the menu; otherwise the storefront's
 * /r/<restaurant>/<branch> path. Shared by the branch code and the per-table codes so the
 * two can never disagree about where a scan lands.
 */
export function branchMenuLink(
  branchSlug: string | null | undefined,
  restaurantSlug: string | null | undefined,
  customDomain: string | null | undefined,
): BranchMenuLink {
  const domain = customDomain?.trim().toLowerCase();
  const missingSlugs: string[] = [];
  if (!branchSlug) missingSlugs.push('branch');
  if (!restaurantSlug) missingSlugs.push('restaurant');

  const url = domain
    ? `https://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
    : missingSlugs.length === 0
      ? `${storefrontBase()}/r/${restaurantSlug}/${branchSlug}`
      : null;

  return { url, missingSlugs };
}

/**
 * The per-table deep link — the branch menu plus the table's token.
 *
 * `?t=` rides on the existing menu URL rather than getting a route of its own because the
 * customer-app middleware clones `nextUrl` and overwrites only the pathname, so a query
 * string survives the custom-domain rewrite untouched. This is the only place that builds
 * the shape; the storefront reads it in one place too.
 */
export function tableMenuLink(menuUrl: string, token: string): string {
  return `${menuUrl}${menuUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
}
