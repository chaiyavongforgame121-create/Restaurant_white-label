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
  // 'black-translucent' hands the status-bar strip to the web view, and almost nothing in the
  // app compensated: installed on an iPhone, the Navigate button on /app/active, every screen
  // heading and the offline banner all sat under the Dynamic Island. 'default' makes iOS
  // reserve the strip. viewportFit 'cover' below still matters — it is what pb-safe reads for
  // the home indicator at the bottom.
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Favornoms Driver' },
  // Next only emits the apple- prefixed form, which Chrome has deprecated and warns about on
  // every load.
  other: { 'mobile-web-app-capable': 'yes' },
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
    <html
      lang={locale}
      className={`${inter.variable} ${notoThai.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: CAPTURE_INSTALL_PROMPT }} />
      </head>
      <body className="min-h-dynamic-screen bg-background font-sans antialiased">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <ThemeProvider theme={{ primaryColor: '#FF6B35', accentColor: '#F7B538' }}>
            <ConnectionBanner />
            <ServiceWorkerRegistrar />
            {children}
            {/* Mounted at the root rather than inside the app shell; which routes it stays
                quiet on is its own decision (NO_PROMPT_ROUTES). */}
            <DriverInstallPrompt />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
