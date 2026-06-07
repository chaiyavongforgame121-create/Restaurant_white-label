import type { Metadata, Viewport } from 'next';
import { Inter, Playfair_Display } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ConnectionBanner, ThemeProvider } from '@favornoms/ui';
import { ServiceWorkerRegistrar } from '@/components/service-worker';
import { CookieBanner } from '@/components/cookie-banner';
import { InstallPrompt } from '@/components/install-prompt';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://favornoms.com'),
  title: { default: 'Favornoms — All-in-one ordering platform for restaurants', template: '%s · Favornoms' },
  description:
    'Run online ordering, kitchen display, POS, driver dispatch, and Stripe payments from one platform. Built for US restaurants.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Favornoms',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Favornoms' },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    apple: '/icon-512.png',
  },
  openGraph: {
    type: 'website',
    siteName: 'Favornoms',
    title: 'Favornoms — All-in-one ordering platform for restaurants',
    description:
      'Run online ordering, kitchen display, POS, driver dispatch, and Stripe payments from one platform.',
    images: ['/icon-512.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Favornoms',
    description:
      'All-in-one ordering platform for US restaurants — Stripe payments, kitchen display, driver dispatch.',
    images: ['/icon-512.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FF6B35' },
    { media: '(prefers-color-scheme: dark)', color: '#1a0e08' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} className={`${inter.variable} ${playfair.variable}`}>
      <body className="min-h-dynamic-screen bg-background font-sans antialiased">
        <NextIntlClientProvider messages={messages} locale={locale}>
          {/* Default theme; tenant layouts re-wrap with branded theme */}
          <ThemeProvider theme={{}}>
            <ConnectionBanner />
            <ServiceWorkerRegistrar />
            {children}
            <CookieBanner />
            <InstallPrompt />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
