import type { Metadata } from 'next';
import { ThemeProvider } from '@favornoms/ui';
import { AppShell } from '@/components/app-shell';
import { PendingCartReplay } from '@/components/pending-cart-replay';
import { PushSubscriber } from '@/components/push-subscriber';
import { resolveTenant } from '@/lib/tenant';

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
      <AppShell base={base} brandName={tenant.theme.brandName ?? tenant.restaurant.name}>
        <PushSubscriber />
        <PendingCartReplay branchId={tenant.branch.id} />
        {children}
      </AppShell>
    </ThemeProvider>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const name = tenant.theme.brandName ?? tenant.restaurant.name;
  const description = `Order from ${tenant.restaurant.name} — ${tenant.branch.name}`;
  // Share card uses the wide logo; the tab icon uses the square favicon. Falling
  // back to the platform icon (by omitting the key, so the root layout's value is
  // inherited) beats scaling a merchant's banner down to 32px.
  const shareImage = tenant.logoUrl ?? tenant.faviconUrl;

  return {
    title: tenant.restaurant.name,
    description,
    // Branch-scoped manifest so an install from here opens this restaurant,
    // not the platform landing page the root manifest points at.
    manifest: `/r/${restaurant}/${branch}/manifest.webmanifest`,
    applicationName: name,
    // iOS ignores the manifest for A2HS naming and reads this instead.
    appleWebApp: { capable: true, statusBarStyle: 'default', title: name },
    // No `sizes`/`type` declared: these are arbitrary merchant uploads and
    // claiming dimensions the file does not have is worse than claiming none —
    // the same reason the branch manifest route keeps serving platform PNGs.
    ...(tenant.faviconUrl
      ? { icons: { icon: [{ url: tenant.faviconUrl }], apple: tenant.faviconUrl } }
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
