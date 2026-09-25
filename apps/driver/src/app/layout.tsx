import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Thai } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { ConnectionBanner, ThemeProvider, UiLocaleProvider } from '@favornoms/ui';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@favornoms/shared';
import { APP_NAME } from '@/components/brand-mark';
import { ServiceWorkerRegistrar } from '@/components/service-worker';
import { DriverInstallPrompt } from '@/components/install-prompt';
import './globals.css';

const inter = Inter({ subsets: ['latin', 'vietnamese'], variable: '--font-sans', display: 'swap' });
const notoThai = Noto_Sans_Thai({ subsets: ['thai'], variable: '--font-thai', display: 'swap' });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell');
  return {
    title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
    description: t('metaDescription'),
    manifest: '/manifest.webmanifest',
    applicationName: APP_NAME,
    // 'black-translucent' hands the status-bar strip to the web view, and almost nothing in the
    // app compensated: installed on an iPhone, the Navigate button on /app/active, every screen
    // heading and the offline banner all sat under the Dynamic Island. 'default' makes iOS
    // reserve the strip. viewportFit 'cover' below still matters — it is what pb-safe reads for
    // the home indicator at the bottom.
    appleWebApp: { capable: true, statusBarStyle: 'default', title: APP_NAME },
    // Next only emits the apple- prefixed form, which Chrome has deprecated and warns about on
    // every load.
    other: { 'mobile-web-app-capable': 'yes' },
    icons: {
      // Tab icons come from favicon.*, a cut of the car with no speed lines and solid wheels —
      // at 16-32px icon.svg's details smear into a blob. Browsers choose among these by their
      // own rules, which is why every candidate is the same car. public/favicon.ico (16/32/48)
      // is deliberately not listed: it exists for the bare /favicon.ico request some browsers
      // and crawlers still make, which otherwise 404s. icon-192 is for surfaces that read link
      // tags but not the manifest.
      icon: [
        { url: '/favicon.svg', type: 'image/svg+xml' },
        { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
        { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
        { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      ],
      // 180x180, full-bleed and with no alpha channel: iOS rounds the corners itself and
      // paints any transparency black, so the RGBA icon-512 cannot stand in for it.
      apple: '/apple-touch-icon.png',
    },
  };
}

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
          <UiLocaleProvider locale={isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE}>
            <ThemeProvider theme={{ primaryColor: '#FF6B35', accentColor: '#F7B538' }}>
              <ConnectionBanner />
              <ServiceWorkerRegistrar />
              {children}
              {/* Mounted at the root rather than inside the app shell; which routes it stays
                  quiet on is its own decision (NO_PROMPT_ROUTES). */}
              <DriverInstallPrompt />
            </ThemeProvider>
          </UiLocaleProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
