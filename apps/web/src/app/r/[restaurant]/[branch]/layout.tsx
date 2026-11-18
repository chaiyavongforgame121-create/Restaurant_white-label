import type { Metadata, Viewport } from 'next';
import { getTranslations } from 'next-intl/server';
import { ThemeProvider } from '@favornoms/ui';
import { AppShell } from '@/components/app-shell';
import { PendingCartReplay } from '@/components/pending-cart-replay';
import { PushSubscriber } from '@/components/push-subscriber';
import { CartProvider } from '@/store/cart';
import {
  DEFAULT_DARK_THEME_COLOR,
  DEFAULT_THEME_COLOR,
  hexOr,
  resolveTenant,
  storefrontNames,
} from '@/lib/tenant';
import { appleTouchIconUrl, tabIcons } from '@/lib/app-identity';
import { StorefrontAddressProvider } from '@/components/storefront-base';
import { storefrontBase } from '@favornoms/database/storefront-path';
import { TablePinProvider } from './_components/table-pin';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
  children: React.ReactNode;
}

export default async function BranchLayout({ params, children }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  // Where this storefront's pages live for the browser: /r/<web-address> when the branch has one,
  // else the long form. Never the route params, which stay the long form on the short address the
  // middleware rewrote (docs/SHORT-STOREFRONT-URLS-2026-10-26.md §3).
  const base = storefrontBase(tenant);
  const tabIconLinks = tabIcons(base, tenant);
  const appleIcon = tabIconLinks.length
    ? appleTouchIconUrl(tenant.appleIconUrl, tenant.icon192Url ?? tenant.faviconUrl, process.env.NEXT_PUBLIC_SUPABASE_URL)
    : null;

  // Per implementation.md §10.2 — merge restaurant.brand + branch.override
  // ThemeProvider applies as CSS variables on a wrapping div.
  return (
    <ThemeProvider theme={tenant.theme}>
      {/* The tab icons, rendered by this layout rather than by generateMetadata (the owner's video
          of 2026-11-18: on Chrome for Android the icon turned into the globe as soon as the diner
          moved from the menu to another page, and stayed so). Next re-renders metadata on every
          in-app navigation, taking the <link rel="icon"> elements out of <head> and putting new
          ones in; this layout stays mounted across the storefront's pages, so React hoists these
          into <head> once and never touches them again, which is what a page whose icon never
          changes looks like to the browser. generateMetadata sets icons to null so the root
          layout's FavorNoms icons are not added beside them. */}
      {tabIconLinks.map((icon) => (
        <link key={icon.url} rel="icon" href={icon.url} sizes={icon.sizes} type={icon.type} />
      ))}
      {appleIcon ? <link rel="apple-touch-icon" href={appleIcon} /> : null}
      {/* Every client component's links start from this base, not from useParams(). */}
      <StorefrontAddressProvider
        base={base}
        restaurantSlug={tenant.restaurant.slug}
        branchSlug={tenant.branch.slug}
      >
        {/* One cart per branch. Two branches of a restaurant live on the same host, and a single
            origin-wide cart showed one branch's items in the other's storefront. Above the table
            pin, which reads the cart, and above every page. */}
        <CartProvider branchId={tenant.branch.id}>
          {/* Above AppShell so the scanned table survives every navigation inside this
              storefront — the menu, the cart and the checkout all read the same pin. */}
          <TablePinProvider branchId={tenant.branch.id}>
            <AppShell
              base={base}
              // The branch's App name when it has one, else "<brand> - <branch>": the same name as
              // the tab and the installed app, so a diner who has both branches open can tell which
              // kitchen this header belongs to. Also the logo's alt text. The logo is the branch's
              // own (brand's until the branch uploads one).
              brandName={storefrontNames(tenant).full}
              logoUrl={tenant.logoUrl}
              iconUrl={tenant.icon192Url ?? tenant.faviconUrl}
            >
              <PushSubscriber />
              <PendingCartReplay branchId={tenant.branch.id} />
              {children}
            </AppShell>
          </TablePinProvider>
        </CartProvider>
      </StorefrontAddressProvider>
    </ThemeProvider>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  // One source for every name on the page, so the tab, the install dialog, the
  // home-screen label and the share card cannot drift apart again.
  const names = storefrontNames(tenant);
  const t = await getTranslations('storefront');
  const description = t('metaDescription', { name: names.full });
  // Share card uses the wide logo; the tab icon uses the square favicon. Falling
  // back to the platform icon (by omitting the key, so the root layout's value is
  // inherited) beats scaling a merchant's banner down to 32px.
  const shareImage = tenant.logoUrl ?? tenant.faviconUrl;

  return {
    // `absolute` on purpose. A bare string inherits the root layout's '%s · FavorNoms'
    // template, which put the PLATFORM's brand in the tab of every white-labelled
    // storefront — the one place a tenant's customer should never see it.
    title: { absolute: names.full },
    description,
    // Branch-scoped manifest so an install from here opens this restaurant,
    // not the platform landing page the root manifest points at. At the public base, where its
    // start_url and scope are too.
    manifest: `${storefrontBase(tenant)}/manifest.webmanifest`,
    // Our own install card reads this, so it offers the app under the name Chrome's dialog
    // shows — the manifest's `name`, from the same derivation.
    applicationName: names.app,
    // iOS ignores the manifest for A2HS naming and reads this instead, so it is the manifest's
    // `short_name`: the full "<brand> - <branch>", which the owner wants on the home screen too
    // even though a launcher may truncate it.
    appleWebApp: { capable: true, statusBarStyle: 'default', title: names.short },
    // This branch's icons (tenant resolves the whole set from the branch once it has one, from
    // the brand before) are rendered by the layout itself, where they survive in-app navigation:
    // same-origin, a 32x32 the icon route renders from the normalised 192, then the 192 through
    // the same route, keyed on the 192's fingerprint (tabIcons()), and the iPhone icon
    // (appleTouchIconUrl: the opaque appleUrl, else the 192, since iOS paints alpha black). Here
    // they are null, so the root layout's FavorNoms icons are not inherited beside them. A
    // storefront with no icon of its own omits the key and keeps the platform's.
    ...(tenant.icon192Url || tenant.faviconUrl ? { icons: null } : {}),
    // A shared link is the storefront's front door, so it carries the same name as the tab
    // and the install dialog rather than the restaurants row the merchant may have renamed
    // away from. The site name too: it was the brand alone, so a branch with an App name of
    // its own still went out on every share card under the brand's name.
    openGraph: {
      type: 'website',
      title: names.full,
      description,
      siteName: names.full,
      ...(shareImage ? { images: [shareImage] } : {}),
    },
    twitter: {
      card: shareImage ? 'summary_large_image' : 'summary',
      title: names.full,
      description,
      ...(shareImage ? { images: [shareImage] } : {}),
    },
  };
}

/**
 * The browser and installed-app chrome, in the merchant's colour.
 *
 * The root layout paints the address bar, the Android status bar and the PWA splash platform
 * orange. On a white-labelled storefront that is somebody else's brand sitting above the
 * merchant's own header — the one part of the page a tenant could not change. This is the same
 * value the branch manifest publishes as `theme_color`, so the installed app and the browser
 * tab agree instead of changing colour when you install.
 */
export async function generateViewport({ params }: Props): Promise<Viewport> {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  return {
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
    themeColor: [
      {
        media: '(prefers-color-scheme: light)',
        color: hexOr(tenant.theme.primaryColor, DEFAULT_THEME_COLOR),
      },
      // Dark stays the platform ground: a bright brand colour behind white status-bar icons
      // in dark mode is unreadable, and merchants do not configure a dark variant.
      { media: '(prefers-color-scheme: dark)', color: DEFAULT_DARK_THEME_COLOR },
    ],
  };
}
