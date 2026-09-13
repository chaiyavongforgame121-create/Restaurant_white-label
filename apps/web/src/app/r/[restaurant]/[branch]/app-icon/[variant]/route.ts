import { NextResponse } from 'next/server';
import {
  PLATFORM_ICON_PATHS,
  isTrustedIconSource,
  parseAppIconVariant,
  tenantIconUrl,
  urlFingerprint,
  type AppIconVariant,
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
 * No `.png` in the path on purpose: the middleware matcher skips image extensions, and on a
 * merchant's own domain `/app-icon/192` has to go through its rewrite to reach this handler.
 */
export async function GET(request: Request, { params }: Props) {
  const { restaurant, branch, variant: rawVariant } = await params;
  const variant = parseAppIconVariant(rawVariant);
  if (!variant) return new NextResponse(null, { status: 404 });

  const tenant = await resolveTenantOptional(restaurant, branch);
  const src = tenant ? tenantIconUrl(tenant, variant) : null;
  if (!src || !isTrustedIconSource(src, process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    return platformIcon(request, variant);
  }

  let upstream: Response;
  try {
    upstream = await fetch(src, { cache: 'no-store' });
  } catch {
    return platformIcon(request, variant);
  }
  // The uploader only ever writes PNGs and the manifest declares image/png, so anything else is
  // a file this route did not expect and must not vouch for.
  if (!upstream.ok || !(upstream.headers.get('content-type') ?? '').startsWith('image/png')) {
    return platformIcon(request, variant);
  }

  // `v` is the fingerprint of the upload the manifest was built from. When it matches, these
  // bytes can never change under this URL — a new upload gets a new fingerprint — so the CDN may
  // keep them for good. Without it (or with a stale one) the answer is whatever is current, and
  // must not be pinned.
  const pinned = new URL(request.url).searchParams.get('v') === urlFingerprint(src);
  return new NextResponse(await upstream.arrayBuffer(), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': pinned ? PINNED_CACHE_CONTROL : CURRENT_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function platformIcon(request: Request, variant: AppIconVariant): NextResponse {
  return NextResponse.redirect(new URL(PLATFORM_ICON_PATHS[variant], request.url), {
    status: 307,
    headers: { 'Cache-Control': CURRENT_CACHE_CONTROL },
  });
}

const PINNED_CACHE_CONTROL = 'public, max-age=86400, s-maxage=31536000, immutable';
/** Short, so a merchant's first upload (or a recovered storage outage) shows within a minute. */
const CURRENT_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
