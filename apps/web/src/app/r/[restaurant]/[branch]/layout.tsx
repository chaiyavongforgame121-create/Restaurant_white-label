import type { Metadata, Viewport } from 'next';
import { ThemeProvider } from '@favornoms/ui';
import { AppShell } from '@/components/app-shell';
import { PendingCartReplay } from '@/components/pending-cart-replay';
import { PushSubscriber } from '@/components/push-subscriber';
import { DEFAULT_DARK_THEME_COLOR, DEFAULT_THEME_COLOR, hexOr, resolveTenant } from '@/lib/tenant';
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
      {/* Above AppShell so the scanned table survives every navigation inside this
          storefront — the menu, the cart and the checkout all read the same pin. */}
      <TablePinProvider branchId={tenant.branch.id}>
        <AppShell
          base={base}
          // The branch, not the restaurant. A diner is standing in (or ordering from) ONE
          // location, and the hero already says "Now serving from <branch>" — the header
          // saying the parent company's name instead was the odd one out. Falls back to the
          // brand and then the restaurant for a branch with no name of its own.
          brandName={tenant.branch.name || tenant.theme.brandName || tenant.restaurant.name}
          logoUrl={tenant.logoUrl}
        >
          <PushSubscriber />
          <PendingCartReplay branchId={tenant.branch.id} />
          {children}
        </AppShell>
      </TablePinProvider>
    </ThemeProvider>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  // Same rule as the header: this storefront is one branch, so the tab, the installed app
  // name and the share card all say the branch. The restaurant still names the description.
  const name = tenant.branch.name || tenant.theme.brandName || tenant.restaurant.name;
  const description = `Order from ${tenant.restaurant.name} — ${tenant.branch.name}`;
  // Share card uses the wide logo; the tab icon uses the square favicon. Falling
  // back to the platform icon (by omitting the key, so the root layout's value is
  // inherited) beats scaling a merchant's banner down to 32px.
  const shareImage = tenant.logoUrl ?? tenant.faviconUrl;

  return {
    title: name,
    description,
    // Branch-scoped manifest so an install from here opens this restaurant,
    // not the platform landing page the root manifest points at.
    manifest: `/r/${restaurant}/${branch}/manifest.webmanifest`,
    applicationName: name,
    // iOS ignores the manifest for A2HS naming and reads this instead.
    appleWebApp: { capable: true, statusBarStyle: 'default', title: name },
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
            apple: tenant.icon192Url ?? tenant.faviconUrl ?? undefined,
          },
        }
      : {}),
    openGraph: {
      type: 'website',
      title: tenant.restaurant.name,
      description,
      siteName: name,
      ...(shareImage ? { images: [shareImage] } : {}),
    },
    twitter: {
      card: shareImage ? 'summary_large_image' : 'summary',
      title: tenant.restaurant.name,
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
