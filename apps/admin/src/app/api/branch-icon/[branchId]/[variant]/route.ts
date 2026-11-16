import { createElement } from 'react';
import { ImageResponse } from 'next/og';
import { NextResponse } from 'next/server';
import { getServerClient } from '@favornoms/database/server';
import {
  BRANCH_ICON_VARIANTS,
  branchTabIconSource,
  readBranchAppIcons,
  urlFingerprint,
  type BranchIconVariant,
} from '@/lib/branch-app-icon';

interface Props {
  params: Promise<{ branchId: string; variant: string }>;
}

/**
 * A branch's back-office tab icon, served from the admin's own origin: `favicon-32` (a 32x32
 * rendered from the merchant's 192) or `192` (the merchant's file itself).
 *
 * Chrome on an Android tablet showed the generic globe for the merchant's cross-origin 192/512
 * PNGs on the Supabase host (owner, 2026-11-16), while pages with same-origin 32/16 PNGs showed
 * theirs, so branchIconsMetadata links here instead. The set is read with the signed-in user's
 * RLS, the same read the tab metadata makes, so this never shows a branch's icon to someone the
 * page itself would not.
 *
 * Any failure (no set, a file outside the branding bucket, a failed fetch, not a PNG, a failed
 * render) redirects to the admin's own FavorNoms file: a FavorNoms icon beats the globe.
 *
 * No `.png` in the path on purpose: the middleware matcher skips image extensions, and this read
 * needs the session it refreshes.
 */
export async function GET(request: Request, { params }: Props) {
  const { branchId, variant: rawVariant } = await params;
  const variant = parseVariant(rawVariant);
  if (!variant || !UUID_RE.test(branchId)) return new NextResponse(null, { status: 404 });

  // Outside any try: cookies() is how Next learns this answer is per-user.
  const supabase = await getServerClient();
  const source = branchTabIconSource(
    await readBranchAppIcons(supabase, branchId),
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  if (!source) return fallback(request, variant);

  let png: ArrayBuffer;
  try {
    const upstream = await fetch(source.url, { cache: 'no-store' });
    // The uploader only writes PNGs and the links declare image/png: anything else is a file this
    // route did not expect and must not vouch for.
    if (!upstream.ok || !(upstream.headers.get('content-type') ?? '').startsWith('image/png')) {
      return fallback(request, variant);
    }
    png = await upstream.arrayBuffer();
    if (variant === 'favicon-32') png = await renderFavicon32(png);
  } catch {
    return fallback(request, variant);
  }

  // `v` is the fingerprint of the file the link was built from; when it matches, these bytes never
  // change under this URL (a new upload is a new path, so a new link). Private either way: the
  // read is per-user, so no shared cache may keep it.
  const pinned = new URL(request.url).searchParams.get('v') === urlFingerprint(source.url);
  return new NextResponse(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': pinned ? PINNED_CACHE_CONTROL : CURRENT_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * The 32x32 PNG, buffered rather than streamed: ImageResponse renders inside its body stream, so
 * a source it cannot decode would otherwise fail after a 200 had gone out, with no way left to
 * send the fallback. Buffering also drops its default `public, immutable` Cache-Control.
 */
async function renderFavicon32(source: ArrayBuffer): Promise<ArrayBuffer> {
  const src = `data:image/png;base64,${Buffer.from(source).toString('base64')}`;
  return new ImageResponse(
    createElement(
      'div',
      { style: { display: 'flex', width: 32, height: 32 } },
      createElement('img', { src, width: 32, height: 32 }),
    ),
    { width: 32, height: 32 },
  ).arrayBuffer();
}

function parseVariant(value: string): BranchIconVariant | null {
  return (BRANCH_ICON_VARIANTS as readonly string[]).includes(value) ? (value as BranchIconVariant) : null;
}

function fallback(request: Request, variant: BranchIconVariant): NextResponse {
  return NextResponse.redirect(new URL(FALLBACK_ICONS[variant], request.url), {
    status: 307,
    headers: { 'Cache-Control': CURRENT_CACHE_CONTROL },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The admin's own FavorNoms files in apps/admin/public. */
const FALLBACK_ICONS: Record<BranchIconVariant, string> = {
  'favicon-32': '/favicon-32.png',
  '192': '/icon-192.png',
};

const PINNED_CACHE_CONTROL = 'private, max-age=31536000, immutable';
/** Revalidated every time, so a new upload, a recovered fetch or a changed role shows at once. */
const CURRENT_CACHE_CONTROL = 'private, no-cache';
