// Shared open-redirect guard for every sign-in flow (diner storefront, merchant
// back-office, platform console).
//
// `next` comes straight off the query string and ends up in places that will happily leave
// the origin: a server-side NextResponse.redirect() in /auth/callback (an HTTP 302 issued
// *from the merchant's own domain*), router.replace() on SIGNED_IN, and the
// `emailRedirectTo` of a magic link. A hostile value therefore turns the tenant's own
// domain into a phishing hop — and on the back-office surfaces the session it hands over is
// a staff one.
//
// A `startsWith('//')` check is NOT sufficient. The WHATWG URL parser
//   (a) strips leading ASCII control characters from the input, and
//   (b) treats a BACKSLASH as a path separator for special schemes (http/https),
// so `/\evil.com`, `/\/evil.com` and `/<TAB>//evil.com` all resolve to https://evil.com/.
// Path traversal is a third route in: `/..//evil.com` normalizes to the protocol-relative
// path `//evil.com`, which is same-origin by URL.origin but cross-origin to router.replace.
//
// Hence three layers: strip controls, require exactly one leading separator (slash OR
// backslash), then resolve against the real origin and re-check both the origin and the
// normalized path.
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

// A single leading "/" that is not followed by another path separator.
const SAME_ORIGIN_PATH = /^\/(?![/\\])/;

/**
 * Returns a normalized same-origin `path + search + hash`, or null if `next` is missing,
 * malformed, or points anywhere off `origin`.
 *
 * Callers that need a landing page rather than "no opinion" should spell the fallback out:
 * `safeNext(next, origin) ?? '/'`.
 *
 * @param origin absolute origin to resolve against — `request.nextUrl.origin` on the
 *   server, `window.location.origin` in the browser. An empty string (SSR, where there is
 *   no window) is safe: it makes `new URL` throw and the whole thing returns null.
 */
export function safeNext(next: string | null | undefined, origin: string): string | null {
  if (!next) return null;
  const candidate = next.replace(CONTROL_CHARS, '');
  if (!SAME_ORIGIN_PATH.test(candidate)) return null;
  try {
    const dest = new URL(candidate, origin);
    if (dest.origin !== origin) return null;
    const resolved = `${dest.pathname}${dest.search}${dest.hash}`;
    // `..` segments can normalize back into a protocol-relative "//host" path even though
    // dest.origin still looks local, so re-run the separator check on the result.
    if (!SAME_ORIGIN_PATH.test(resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Browser-side origin, or '' during SSR/prerender. Passing '' makes safeNext return null
 * instead of throwing, so client components can compute a target at module scope without a
 * `typeof window` dance at every call site.
 */
export function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}
