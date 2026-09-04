import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Thai } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ConnectionBanner, ThemeProvider } from '@favornoms/ui';
import { ServiceWorkerRegistrar } from '@/components/service-worker';
import { DriverInstallPrompt } from '@/components/install-prompt';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const notoThai = Noto_Sans_Thai({ subsets: ['thai'], variable: '--font-thai', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Favornoms Driver', template: '%s · Favornoms Driver' },
  description: 'Driver app for the Favornoms food delivery platform.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Favornoms Driver',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Favornoms Driver' },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    // 180x180 with the alpha already flattened. The 512 PNG is RGBA and iOS
    // paints its transparency black, which is why this file was generated.
    apple: '/apple-touch-icon.png',
  },
};

/**
 * Chrome fires `beforeinstallprompt` exactly once, early, and never replays it.
 * On a repeat visit (warm SW + cached manifest) it lands *before* the React
 * bundle hydrates, so a listener attached in useEffect misses it for good.
 * Stash the event on `window` from <head> instead; <DriverInstallPrompt>
 * consumes it whenever it mounts. Keep the `__bipEvent` contract in sync with
 * install-prompt.tsx.
 */
const CAPTURE_INSTALL_PROMPT = `!function(){var w=window;w.__bipEvent=null;w.addEventListener("beforeinstallprompt",function(e){e.preventDefault();w.__bipEvent=e});w.addEventListener("appinstalled",function(){w.__bipEvent=null})}();`;

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
    <html lang={locale} className={`${inter.variable} ${notoThai.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: CAPTURE_INSTALL_PROMPT }} />
      </head>
      <body className="min-h-dynamic-screen bg-background font-sans antialiased">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <ThemeProvider theme={{ primaryColor: '#FF6B35', accentColor: '#F7B538' }}>
            <ConnectionBanner />
            <ServiceWorkerRegistrar />
            {children}
            {/* Root, not app/layout: a first-time rider lands on /login. */}
            <DriverInstallPrompt />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
