import { NextResponse } from 'next/server';
import { getServerClient } from '@favornoms/database/server';
import { resolveTenantBySlug } from '@favornoms/database/queries';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

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
  const supabase = await getServerClient();
  const tenant = await resolveTenantBySlug(supabase, restaurant, branch);
  if (!tenant) return new NextResponse(null, { status: 404 });

  const host = ((request.headers.get('host') ?? '').split(':')[0] ?? '').toLowerCase();
  const onApex = !host || APEX_HOSTS.has(host);
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
    theme_color: hexOr(tenant.theme.primaryColor, '#FF6B35'),
    // Platform PNGs, deliberately: the tenant logo is an arbitrary merchant
    // upload of unknown dimensions, and declaring a `sizes` the file does not
    // match makes the app fail Chrome's installability check outright.
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    categories: ['food', 'lifestyle', 'shopping'],
    lang: 'en',
    dir: 'ltr',
  };

  return new NextResponse(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
      // The body differs by host (apex vs custom domain), and the same path is
      // reachable on both — without this a shared cache could serve one host's
      // scope to the other.
      Vary: 'Host',
    },
  });
}

/** Manifest colours must be valid CSS colours; tenant theme values are free text. */
function hexOr(value: string | undefined, fallback: string): string {
  return value && HEX_COLOR.test(value) ? value : fallback;
}
