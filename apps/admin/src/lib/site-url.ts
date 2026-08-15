/**
 * Origin of the customer storefront, as seen from the admin app.
 *
 * Admin is a separate Vercel project with its own env set, so it cannot read the
 * web project's config — it only knows what NEXT_PUBLIC_SITE_URL is set to here.
 * When that is unset the fallback has to be an origin that actually serves the
 * storefront: `https://favornoms.com` is a parked marketing site and returns 404
 * for `/r/<restaurant>/<branch>`, which is what made printed QR codes dead on
 * arrival. Verified over HTTP 2026-08-14:
 *   favornoms.com/r/coastal-grill/brooklyn                      → 404
 *   restaurant-white-label-web.vercel.app/r/coastal-grill/brooklyn → 200
 *   app.favornoms.com                                            → does not resolve
 *
 * This is a fallback, not a policy: set NEXT_PUBLIC_SITE_URL on the admin project
 * and the branded domain takes over with no code change.
 */
const PUBLIC_FALLBACK = 'https://restaurant-white-label-web.vercel.app';

export function storefrontBase(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:3000';
  return PUBLIC_FALLBACK;
}
