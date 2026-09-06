import { NextResponse } from 'next/server';
import { getServerClient } from '@favornoms/database/server';
import { resolveTenantBySlug } from '@favornoms/database/queries';
import { DEFAULT_THEME_COLOR, hexOr, resolveStorefrontVersion } from '@/lib/tenant';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

// Same constant + default list the middleware parses, so "is this a custom
// domain?" is answered identically in both places. Keep in sync with
// apps/web/src/middleware.ts.
const APEX_HOSTS = new Set(
  (process.env.NEXT_PUBLIC_APEX_HOSTS ?? 'localhost,127.0.0.1,favornoms.com,app.favornoms.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Per-tenant web app manifest.
 *
 * Without this, a diner installing from /r/thai-garden/main got an app called
 * "Favornoms" whose icon opened the platform marketing page — the root manifest
 * hardcodes `start_url: "/"`. Scoping start_url + scope to the branch makes the
 * installed icon land back on that restaurant's menu.
 *
 * Scope is host-dependent. On an apex host the branch really does live under
 * /r/{restaurant}/{branch}. On a custom domain the middleware rewrites that
 * host's "/" to the same branch, so the merchant's advertised root IS the app:
 * scoping to /r/... there would push their own homepage — and every link and QR
 * code pointing at the bare domain — outside the installed app.
 */
export async function GET(request: Request, { params }: Props) {
  const { restaurant, branch } = await params;
  const host = ((request.headers.get('host') ?? '').split(':')[0] ?? '').toLowerCase();
  const onApex = !host || APEX_HOSTS.has(host);

  // Cheap enough to ask before doing the real work, and it turns the common case — a browser
  // or CDN re-checking a manifest that has not changed — into a 304 with no body and no tenant
  // read at all. `known: false` degrades to a time bucket, so the ETag still changes, just on
  // a clock rather than on the merchant's save.
  const version = await resolveStorefrontVersion(restaurant, branch);
  const etag = `W/"${version.key}:${onApex ? 'apex' : 'custom'}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': MANIFEST_CACHE_CONTROL, Vary: 'Host' },
    });
  }

  const supabase = await getServerClient();
  const tenant = await resolveTenantBySlug(supabase, restaurant, branch);
  if (!tenant) return new NextResponse(null, { status: 404 });

  const base = onApex ? `/r/${restaurant}/${branch}` : '/';
  const name = tenant.theme.brandName ?? tenant.restaurant.name;

  const manifest = {
    // Stable identity: keeps existing installs attached if start_url ever moves.
    id: base,
    name: `${name} — ${tenant.branch.name}`,
    short_name: name,
    description: `Order from ${name} — ${tenant.branch.name}`,
    start_url: base,
    scope: base,
    display: 'standalone',
    orientation: 'portrait',
    background_color: hexOr(tenant.theme.backgroundColor, '#FFFAF5'),
    // Same value generateViewport paints the address bar with, from the same helper —
    // an installed app whose chrome changes colour on install looks broken.
    theme_color: hexOr(tenant.theme.primaryColor, DEFAULT_THEME_COLOR),
    // Tenant icons first, platform icons last. The tenant entries are only ever
    // written by the admin icon uploader, which rasterises the merchant's image to
    // exactly these dimensions — so the declared `sizes` is honest, which is what
    // Chrome's installability check actually requires. The platform icons stay as an
    // unconditional tail: a tenant asset that 404s or fails CORS then degrades to an
    // unbranded install rather than to no install button at all.
    icons: tenantIcons(tenant),
    categories: ['food', 'lifestyle', 'shopping'],
    lang: 'en',
    dir: 'ltr',
  };

  return new NextResponse(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': MANIFEST_CACHE_CONTROL,
      ETag: etag,
      // The body differs by host (apex vs custom domain), and the same path is
      // reachable on both — without this a shared cache could serve one host's
      // scope to the other.
      Vary: 'Host',
    },
  });
}

/**
 * Was `max-age=300, s-maxage=3600, stale-while-revalidate=86400`. A merchant who changed their
 * icon, app name or colour then sat behind the CDN for an hour — and for up to a day more while
 * it revalidated — BEFORE Chrome's own roughly-daily manifest re-check could even see the new
 * file. Two platform delays stacked on top of each other, and the merchant read the result as
 * "the upload didn't work".
 *
 * The body is a few hundred bytes and the ETag above makes an unchanged one a 304, so
 * revalidating every minute costs almost nothing. `max-age=0` keeps the browser asking, which
 * is the half that decides how fast an already-installed app sees the change.
 */
const MANIFEST_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

/** Only the sizes the admin uploader guarantees. A tenant that has never set an icon
 *  gets exactly the previous platform-only list. */
function tenantIcons(tenant: {
  icon192Url: string | null;
  icon512Url: string | null;
  iconMaskable512Url: string | null;
}): ManifestIcon[] {
  const icons: ManifestIcon[] = [];
  if (tenant.icon192Url) {
    icons.push({ src: tenant.icon192Url, sizes: '192x192', type: 'image/png', purpose: 'any' });
  }
  if (tenant.icon512Url) {
    icons.push({ src: tenant.icon512Url, sizes: '512x512', type: 'image/png', purpose: 'any' });
  }
  if (tenant.iconMaskable512Url) {
    icons.push({
      src: tenant.iconMaskable512Url,
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    });
  }
  icons.push(
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  );
  return icons;
}
