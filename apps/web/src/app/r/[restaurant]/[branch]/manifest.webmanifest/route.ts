import { NextResponse } from 'next/server';
import { manifestIcons, urlFingerprint } from '@/lib/app-identity';
import { DEFAULT_THEME_COLOR, hexOr, resolveTenantOptional, storefrontNames } from '@/lib/tenant';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

/**
 * Per-tenant web app manifest.
 *
 * A manifest does not merely describe an app, it NAMES one: the platform keys an installed
 * app on `id` resolved against the origin, and on Android that pair decides which WebAPK a
 * new install joins. This route used to emit `id`/`start_url`/`scope` of "/" for every
 * restaurant on the production host, so Coastal Grill, Somtam Zab and the FavorNoms marketing
 * site were one application. Whichever manifest Chrome saw first owned the home-screen icon,
 * a second restaurant could not install separately at all, and the icon that did get installed
 * opened the marketing page.
 *
 * Two things fix it, and both are below: an `id` that belongs to this branch and nothing else,
 * and a start_url/scope that keep the installed app inside this restaurant.
 */
export async function GET(request: Request, { params }: Props) {
  const { restaurant, branch } = await params;

  // The version-keyed, cookie-LESS read the layout and the metadata already share. The old
  // cookie-backed one made this response vary by visitor while it was being served to a shared
  // cache under Vary: Host alone, and it let the body move without the ETag moving with it —
  // a merchant's new icon could sit behind a 304 that swore nothing had changed.
  const tenant = await resolveTenantOptional(restaurant, branch);
  if (!tenant) return new NextResponse(null, { status: 404 });

  // Every storefront lives under /r/{restaurant}/{branch} on the platform's hosts: merchant custom
  // domains are gone (2026-10-26), and with them the one case whose app was scoped to the origin
  // root. Never "/" — that is the marketing page, the bug described above.
  const base = `/r/${restaurant}/${branch}`;
  // Deliberately no trailing slash: Next 308-redirects /r/a/b/ to /r/a/b, which would cost a
  // redirect on every cold launch, and start_url has to sit inside scope by plain path-prefix
  // comparison, so the two must agree. The cost is that a sibling branch whose slug extends
  // this one (brooklyn / brooklyn-north) falls inside this scope — a containment quirk in the
  // window, not an identity one, because `id` below still keeps the two apps apart.
  const scope = base;
  // Same source as the tab, the apple title, the install card and the admin Branding preview.
  const names = storefrontNames(tenant);

  const manifest = {
    // Identity is the branch, not the URL it currently sits at. `id` is resolved as a URL
    // against the origin and compared exactly, so this is an opaque per-tenant identity that
    // survives a slug rename (the old address 308s to the new one); it never has to resolve to a
    // real resource. Changing it MINTS A NEW APP — anyone already installed on the old shared "/"
    // identity keeps that one for good, which is what the notice on the platform landing page
    // exists to tell them.
    id: `/?app=${tenant.branch.id}`,
    // The branch's App name when it has one, else "<brand> - <branch>", in both. Chrome's install
    // dialog and the desktop shortcut print `name`, and it used to be the brand alone, so a
    // restaurant's two branches installed as two apps with one name. Android's launcher and iOS
    // print `short_name` (the apple title agrees with it); the owner wants the full name there as
    // well, and a launcher cutting it at about 12 characters is accepted.
    name: names.app,
    short_name: names.short,
    description: `Order from ${names.full}`,
    // Where the home-screen icon lands. "/" is the marketing page — the single most visible half
    // of the bug.
    start_url: scope,
    scope,
    display: 'standalone',
    orientation: 'portrait',
    background_color: hexOr(tenant.theme.backgroundColor, '#FFFAF5'),
    // Same value generateViewport paints the address bar with, from the same helper —
    // an installed app whose chrome changes colour on install looks broken.
    theme_color: hexOr(tenant.theme.primaryColor, DEFAULT_THEME_COLOR),
    // The merchant's icons alone, from this origin, or the platform's alone — never both.
    // manifestIcons() explains why mixing them installed the wrong icon. They are THIS branch's
    // set (the resolver takes it whole from the branch once it has one), under this branch's
    // path, with `?v` fingerprinting this branch's upload URL — so a new upload on one branch
    // re-icons that branch's installed app and no other.
    icons: manifestIcons(base, tenant),
    categories: ['food', 'lifestyle', 'shopping'],
    lang: 'en',
    dir: 'ltr',
  };

  // The ETag is a fingerprint of the body itself, not of the storefront version. The version
  // only moves when this branch's own rows do, and a deploy that changes what the manifest says
  // changes this body without that (this one renamed every installed app, and a version-keyed
  // ETag would have kept answering 304 to every browser holding the old name). The tenant read
  // above is a warm cache hit keyed on the version, so hashing the real body costs next to
  // nothing, and an unchanged manifest is still a 304 with no body.
  const body = JSON.stringify(manifest);
  const etag = `W/"${urlFingerprint(body)}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': MANIFEST_CACHE_CONTROL },
    });
  }

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': MANIFEST_CACHE_CONTROL,
      ETag: etag,
      // No Vary: Host any more. start_url and scope used to differ between a merchant's own
      // domain and the platform; with custom domains gone nothing in the body varies by request.
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
