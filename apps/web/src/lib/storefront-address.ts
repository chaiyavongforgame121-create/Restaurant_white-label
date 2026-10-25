/**
 * The storefront's address as the browser sees it (docs/SHORT-STOREFRONT-URLS-2026-10-26.md §3).
 *
 * A branch with a web address lives at `/r/<web-address>/…`; the middleware serves that from the
 * app's only route, `/r/<restaurant>/<branch>/…`, so the route params are the long form even when
 * the browser is on the short one. Links are built from the public base (storefrontBase in
 * @favornoms/database/storefront-path), never from the params; these helpers answer the questions
 * the app asks about a path against that base. Pure, so the middleware, server components and
 * tests share them.
 */

/** A slug as the database stores it (restaurants_slug_check, branches' checks). */
const SLUG = /^[a-z0-9](-?[a-z0-9])*$/;

/**
 * Whether `pathname` (no query string) is the storefront at `base` or one of its pages:
 * `/r/hamburger` and `/r/hamburger/cart` are under `/r/hamburger`, `/r/hamburger-north` is not.
 */
export function isUnderBase(pathname: string, base: string): boolean {
  if (!base) return false;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * A public base the middleware could have sent (PUBLIC_BASE_HEADER): `/r/<slug>` or
 * `/r/<slug>/<slug>`, else null. The middleware drops whatever a client sends under that name, but
 * a value that is not a storefront base is ignored rather than trusted all the same.
 */
export function parsePublicBase(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value.split('/');
  if (parts[0] !== '' || parts[1] !== 'r' || parts.length < 3 || parts.length > 4) return null;
  return parts.slice(2).every((p) => p.length <= 64 && SLUG.test(p)) ? value : null;
}
