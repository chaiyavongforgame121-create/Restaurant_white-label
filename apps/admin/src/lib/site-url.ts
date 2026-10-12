/**
 * Origin of the customer storefront, as seen from the admin app.
 *
 * Admin is a separate Vercel project with its own env set, so it cannot read the
 * web project's config — it only knows what NEXT_PUBLIC_SITE_URL is set to here.
 * When that is unset the fallback has to be an origin that actually serves the
 * storefront: `https://favornoms.com` is a parked marketing site and returns 404
 * for `/r/<restaurant>/<branch>`, which is what made printed QR codes dead on
 * arrival. Since 2026-10-12 the storefront is served at app.favornoms.com (a CNAME
 * to the web project on Vercel), and the old restaurant-white-label-web.vercel.app
 * address keeps working for codes printed before then.
 *
 * This is a fallback, not a policy: NEXT_PUBLIC_SITE_URL on the admin project wins.
 */
const PUBLIC_FALLBACK = 'https://app.favornoms.com';

export function storefrontBase(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:3000';
  return PUBLIC_FALLBACK;
}
