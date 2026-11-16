import { createElement } from 'react';
import { ImageResponse } from 'next/og';
import { NextResponse } from 'next/server';
import {
  LEGACY_TAB_ICON_VARIANT,
  PLATFORM_ICON_PATHS,
  PLATFORM_TAB_ICON_PATH,
  TAB_ICON_VARIANT,
  isTrustedIconSource,
  parseAppIconVariant,
  tenantIconUrl,
  urlFingerprint,
} from '@/lib/app-identity';
import { resolveTenantOptional } from '@/lib/tenant';

interface Props {
  params: Promise<{ restaurant: string; branch: string; variant: string }>;
}

/**
 * The merchant's app icon, served from the storefront's own origin.
 *
 * The manifest used to list the merchant's icons (on the Supabase host) followed by the
 * platform's, with identical sizes, so a merchant file that failed to download still left Chrome
 * an icon to install with. Chrome on desktop resolved the duplicate sizes in favour of the later
 * entry, and every install showed the platform's orange icon. The manifest now names exactly one
 * icon per size — this route — and the fallback happens here: when the merchant's file cannot be
 * fetched, the answer is a redirect to the platform file, which Chrome follows like any other.
 *
 * `favicon-32` is the browser tab's icon (tabIcons() in app-identity), not an installed-app one:
 * a 32x32 rendered here from the merchant's 192, because Chrome on Android showed the globe for
 * a tab whose only icons were cross-origin 192/512s.
 *
 * No `.png` in the path on purpose: the middleware matcher skips image extensions, and an icon
 * requested at a storefront's old address has to go through its 308 to reach this handler.
 */
export async function GET(request: Request, { params }: Props) {
  const { restaurant, branch, variant: rawVariant } = await params;
  if (rawVariant === TAB_ICON_VARIANT) return tabIcon(request, restaurant, branch);
  if (rawVariant === LEGACY_TAB_ICON_VARIANT) return legacyTabIcon(request, restaurant, branch);
  const variant = parseAppIconVariant(rawVariant);
  if (!variant) return new NextResponse(null, { status: 404 });

  const tenant = await resolveTenantOptional(restaurant, branch);
  const src = tenant ? tenantIconUrl(tenant, variant) : null;
  const upstream = src ? await fetchTrustedPng(src) : null;
  if (!src || !upstream) return platformIcon(request, PLATFORM_ICON_PATHS[variant]);

  return new NextResponse(await upstream.arrayBuffer(), {
    headers: iconHeaders(request, src),
  });
}

/**
 * The 32x32 tab icon, scaled from the merchant's 192 — the normalised upload, so its bytes are
 * known to be a square PNG. Anything that goes wrong (no 192, an untrusted or missing file, a
 * render that throws) is the platform's own 32px cut, as the other variants fall back.
 */
async function tabIcon(request: Request, restaurant: string, branch: string): Promise<NextResponse> {
  const tenant = await resolveTenantOptional(restaurant, branch);
  const src = tenant ? tenantIconUrl(tenant, '192') : null;
  const upstream = src ? await fetchTrustedPng(src) : null;
  if (!src || !upstream) return platformIcon(request, PLATFORM_TAB_ICON_PATH);

  let png: ArrayBuffer;
  try {
    const dataUrl = `data:image/png;base64,${Buffer.from(await upstream.arrayBuffer()).toString('base64')}`;
    // ImageResponse renders lazily inside its body stream, so a bad image only throws once the
    // body is read: read it here, where a failure can still become the redirect. Its own headers
    // (a year, immutable) are dropped for ours.
    png = await new ImageResponse(
      createElement(
        'div',
        { style: { display: 'flex', width: 32, height: 32 } },
        createElement('img', { src: dataUrl, width: 32, height: 32 }),
      ),
      { width: 32, height: 32 },
    ).arrayBuffer();
  } catch {
    return platformIcon(request, PLATFORM_TAB_ICON_PATH);
  }
  // Pinned on the 192's fingerprint: that upload is what these bytes are made from.
  return new NextResponse(png, { headers: iconHeaders(request, src) });
}

/**
 * A legacy free-form favicon, passed through as it is: uploaded before the normaliser, so it may
 * be an .ico, a JPEG or a PNG of any size. Raster images only (an SVG can carry script), with the
 * file's own type. Anything else is the platform's 32px cut.
 */
async function legacyTabIcon(request: Request, restaurant: string, branch: string): Promise<NextResponse> {
  const tenant = await resolveTenantOptional(restaurant, branch);
  const src = tenant?.faviconUrl || null;
  if (!src || !isTrustedIconSource(src, process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    return platformIcon(request, PLATFORM_TAB_ICON_PATH);
  }
  let upstream: Response;
  try {
    upstream = await fetch(src, { cache: 'no-store' });
  } catch {
    return platformIcon(request, PLATFORM_TAB_ICON_PATH);
  }
  const type = (upstream.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!upstream.ok || !LEGACY_ICON_TYPES.has(type)) return platformIcon(request, PLATFORM_TAB_ICON_PATH);
  return new NextResponse(await upstream.arrayBuffer(), {
    headers: { ...iconHeaders(request, src), 'Content-Type': type },
  });
}

const LEGACY_ICON_TYPES = new Set([
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/**
 * The merchant's file, when it is one this route may vouch for: in the branding bucket, fetched,
 * and a PNG. Null otherwise.
 */
async function fetchTrustedPng(src: string): Promise<Response | null> {
  if (!isTrustedIconSource(src, process.env.NEXT_PUBLIC_SUPABASE_URL)) return null;
  let upstream: Response;
  try {
    upstream = await fetch(src, { cache: 'no-store' });
  } catch {
    return null;
  }
  // The uploader only ever writes PNGs and the manifest declares image/png, so anything else is
  // a file this route did not expect and must not vouch for.
  if (!upstream.ok || !(upstream.headers.get('content-type') ?? '').startsWith('image/png')) {
    return null;
  }
  return upstream;
}

/**
 * `v` is the fingerprint of the upload the manifest (or the tab icon link) was built from. When
 * it matches, these bytes can never change under this URL — a new upload gets a new fingerprint
 * — so the CDN may keep them for good. Without it (or with a stale one) the answer is whatever is
 * current, and must not be pinned.
 */
function iconHeaders(request: Request, src: string): HeadersInit {
  const pinned = new URL(request.url).searchParams.get('v') === urlFingerprint(src);
  return {
    'Content-Type': 'image/png',
    'Cache-Control': pinned ? PINNED_CACHE_CONTROL : CURRENT_CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
  };
}

function platformIcon(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), {
    status: 307,
    headers: { 'Cache-Control': CURRENT_CACHE_CONTROL },
  });
}

const PINNED_CACHE_CONTROL = 'public, max-age=86400, s-maxage=31536000, immutable';
/** Short, so a merchant's first upload (or a recovered storage outage) shows within a minute. */
const CURRENT_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
