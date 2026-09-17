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
import { appleTouchIconUrl } from '@/lib/app-identity';
import { TablePinProvider } from './_components/table-pin';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
  children: React.ReactNode;
}

export default async function BranchLayout({ params, children }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const base = `/r/${restaurant}/${branch}`;

  // Per implementation.md §10.2 — merge restaurant.brand + branch.override
  // ThemeProvider applies as CSS variables on a wrapping div.
  return (
    <ThemeProvider theme={tenant.theme}>
      {/* One cart per branch. Two branches of a restaurant live on the same host, and a single
          origin-wide cart showed one branch's items in the other's storefront. Above the table
          pin, which reads the cart, and above every page. */}
      <CartProvider branchId={tenant.branch.id}>
        {/* Above AppShell so the scanned table survives every navigation inside this
            storefront — the menu, the cart and the checkout all read the same pin. */}
        <TablePinProvider branchId={tenant.branch.id}>
          <AppShell
            base={base}
            // "<brand> - <branch>", the same name as the tab and the installed app, so a diner
            // who has both branches open can tell which kitchen this header belongs to. Also the
            // logo's alt text. The logo is the branch's own (brand's until the branch uploads one).
            brandName={storefrontNames(tenant).full}
            logoUrl={tenant.logoUrl}
          >
            <PushSubscriber />
            <PendingCartReplay branchId={tenant.branch.id} />
            {children}
          </AppShell>
        </TablePinProvider>
      </CartProvider>
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
    // `absolute` on purpose. A bare string inherits the root layout's '%s · Favornoms'
    // template, which put the PLATFORM's brand in the tab of every white-labelled
    // storefront — the one place a tenant's customer should never see it.
    title: { absolute: names.full },
    description,
    // Branch-scoped manifest so an install from here opens this restaurant,
    // not the platform landing page the root manifest points at.
    manifest: `/r/${restaurant}/${branch}/manifest.webmanifest`,
    // Our own install card reads this, so it offers the app under the name Chrome's dialog
    // shows — the manifest's `name`, from the same derivation.
    applicationName: names.app,
    // iOS ignores the manifest for A2HS naming and reads this instead, so it is the manifest's
    // `short_name`: the full "<brand> - <branch>", which the owner wants on the home screen too
    // even though a launcher may truncate it.
    appleWebApp: { capable: true, statusBarStyle: 'default', title: names.short },
    // Every icon below is this branch's (tenant resolves the whole set from the branch once it
    // has one, from the brand before). The hrefs are the upload URLs themselves, and every
    // upload gets a new storage path, so a branch's new icon is a new href without a `?v`.
    // Sizes are declared only for the normalised icons the admin uploader produced —
    // those really are 192x192/512x512 PNGs. A legacy free-form favicon (uploaded
    // before normalisation existed) still gets no `sizes`, because claiming dimensions
    // a file does not have is worse than claiming none.
    // `apple` prefers the 192: iOS renders alpha as black, and the normalised variants
    // are flattened onto an opaque ground while a raw upload may not be.
    ...(tenant.icon192Url || tenant.faviconUrl
      ? {
          icons: {
            icon: [
              ...(tenant.icon192Url
                ? [{ url: tenant.icon192Url, sizes: '192x192', type: 'image/png' }]
                : []),
              ...(tenant.icon512Url
                ? [{ url: tenant.icon512Url, sizes: '512x512', type: 'image/png' }]
                : []),
              ...(!tenant.icon192Url && tenant.faviconUrl ? [{ url: tenant.faviconUrl }] : []),
            ],
            // iOS paints transparency black, so it gets the merchant's opaque iPhone icon when
            // there is one — the 192 may be transparent ("only the image, like a PNG").
            apple:
              appleTouchIconUrl(
                tenant.appleIconUrl,
                tenant.icon192Url ?? tenant.faviconUrl,
                process.env.NEXT_PUBLIC_SUPABASE_URL,
              ) ?? undefined,
          },
        }
      : {}),
    // A shared link is the storefront's front door, so it carries the same name as the tab
    // and the install dialog rather than the restaurants row the merchant may have renamed
    // away from.
    openGraph: {
      type: 'website',
      title: names.full,
      description,
      siteName: names.brand,
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
