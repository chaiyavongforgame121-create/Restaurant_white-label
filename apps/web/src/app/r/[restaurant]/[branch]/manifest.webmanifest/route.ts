import { NextResponse } from 'next/server';
import { manifestIcons } from '@/lib/app-identity';
import {
  DEFAULT_THEME_COLOR,
  hexOr,
  hostIsOwnDomainFor,
  hostOf,
  resolveStorefrontVersion,
  resolveTenantOptional,
  storefrontNames,
} from '@/lib/tenant';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

/**
 * Per-tenant web app manifest.
 *
 * A manifest does not merely describe an app, it NAMES one: the platform keys an installed
 * app on `id` resolved against the origin, and on Android that pair decides which WebAPK a
 * new install joins. This route used to emit `id`/`start_url`/`scope` of "/" for every
 * restaurant on the production host, so Coastal Grill, Somtam Zab and the Favornoms marketing
 * site were one application. Whichever manifest Chrome saw first owned the home-screen icon,
 * a second restaurant could not install separately at all, and the icon that did get installed
 * opened the marketing page.
 *
 * Two things fix it, and both are below: an `id` that belongs to this branch and nothing else,
 * and a start_url/scope that keep the installed app inside this restaurant.
 */
export async function GET(request: Request, { params }: Props) {
  const { restaurant, branch } = await params;

  // Scope is host-dependent. On a merchant's own domain the middleware rewrites that host's
  // "/" to this branch, so their advertised root IS the app and scoping to /r/... would push
  // their homepage — and every link and QR code pointing at the bare domain — outside the
  // installed window. Everywhere else the branch really does live under /r/{restaurant}/{branch}.
  //
  // Asking the database which of the two this is, rather than inferring it from a static list
  // of apex hosts, is the fix for the bug above: the production storefront
  // (restaurant-white-label-web.vercel.app) was never on that list, so the route believed it
  // was on somebody's custom domain and published the platform root. A host is a merchant's
  // own only when public.resolve_custom_domain — the same answer the middleware rewrites
  // on — says so, so an unknown host degrades to the /r/ form instead of to the origin root.
  const ownDomain = await hostIsOwnDomainFor(
    hostOf(request.headers.get('host')),
    restaurant,
    branch,
  );

  // Cheap enough to ask before doing the real work, and it turns the common case — a browser
  // or CDN re-checking a manifest that has not changed — into a 304 with no body and no tenant
  // read at all. `known: false` degrades to a time bucket, so the ETag still changes, just on
  // a clock rather than on the merchant's save.
  const version = await resolveStorefrontVersion(restaurant, branch);
  const etag = `W/"${version.key}:${ownDomain ? 'own' : 'platform'}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': MANIFEST_CACHE_CONTROL, Vary: 'Host' },
    });
  }

  // The version-keyed, cookie-LESS read the layout and the metadata already share. The old
  // cookie-backed one made this response vary by visitor while it was being served to a shared
  // cache under Vary: Host alone, and it let the body move without the ETag moving with it —
  // a merchant's new icon could sit behind a 304 that swore nothing had changed.
  const tenant = await resolveTenantOptional(restaurant, branch);
  if (!tenant) return new NextResponse(null, { status: 404 });

  const base = ownDomain ? '' : `/r/${restaurant}/${branch}`;
  // Deliberately no trailing slash: Next 308-redirects /r/a/b/ to /r/a/b, which would cost a
  // redirect on every cold launch, and start_url has to sit inside scope by plain path-prefix
  // comparison, so the two must agree. The cost is that a sibling branch whose slug extends
  // this one (brooklyn / brooklyn-north) falls inside this scope — a containment quirk in the
  // window, not an identity one, because `id` below still keeps the two apps apart.
  const scope = base || '/';
  // Same source as the tab, the apple title, the install card and the admin Branding preview.
  const names = storefrontNames(tenant);

  const manifest = {
    // Identity is the branch, not the URL it currently sits at. `id` is resolved as a URL
    // against the origin and compared exactly, so this is an opaque per-tenant identity that
    // survives a slug rename and the move between /r/... and a merchant's own domain; it never
    // has to resolve to a real resource. Changing it MINTS A NEW APP — anyone already
    // installed on the old shared "/" identity keeps that one for good, which is what the
    // notice on the platform landing page exists to tell them.
    id: `/?app=${tenant.branch.id}`,
    // The App name from the admin Branding card and nothing added to it. Chrome's install
    // dialog and the desktop shortcut print `name`; Android's launcher prints `short_name`.
    // They were "Coastal Grill — Hamburger" and "Coastal Grill", so the merchant typed one name
    // and customers installed another.
    name: names.app,
    short_name: names.app,
    description: `Order from ${names.full}`,
    // Where the home-screen icon lands. "/" is the marketing page on every host that is not
    // this merchant's own — the single most visible half of the bug.
    start_url: scope,
    scope,
    display: 'standalone',
    orientation: 'portrait',
    background_color: hexOr(tenant.theme.backgroundColor, '#FFFAF5'),
    // Same value generateViewport paints the address bar with, from the same helper —
    // an installed app whose chrome changes colour on install looks broken.
    theme_color: hexOr(tenant.theme.primaryColor, DEFAULT_THEME_COLOR),
    // The merchant's icons alone, from this origin, or the platform's alone — never both.
    // manifestIcons() explains why mixing them installed the wrong icon.
    icons: manifestIcons(base, tenant),
    categories: ['food', 'lifestyle', 'shopping'],
    lang: 'en',
    dir: 'ltr',
  };

  return new NextResponse(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': MANIFEST_CACHE_CONTROL,
      ETag: etag,
      // start_url and scope differ between a merchant's own domain and the platform, and the
      // same path is reachable on both — without this a shared cache could serve one host's
      // scope to the other. Nothing else in the body varies per request any more.
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
