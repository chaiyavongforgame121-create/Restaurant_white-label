import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Thai, Playfair_Display } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { ConnectionBanner, ThemeProvider, UiLocaleProvider } from '@favornoms/ui';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@favornoms/shared';
import { ServiceWorkerRegistrar } from '@/components/service-worker';
import { CookieBanner } from '@/components/cookie-banner';
import { InstallPrompt } from '@/components/install-prompt';
import './globals.css';

// Vietnamese needs the extended subsets; Thai has no glyphs in Inter or Playfair at all, so it
// gets its own family, loaded only when Thai text is on the page (unicode-range, not preloaded).
const inter = Inter({ subsets: ['latin', 'vietnamese'], variable: '--font-sans', display: 'swap' });
const notoThai = Noto_Sans_Thai({ subsets: ['thai'], variable: '--font-thai', display: 'swap', preload: false });
const playfair = Playfair_Display({
  subsets: ['latin', 'vietnamese'],
  variable: '--font-display',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('landing');
  return {
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://favornoms.com'),
    title: { default: t('meta.title'), template: '%s · Favornoms' },
    description: t('site.description'),
    manifest: '/manifest.webmanifest',
    applicationName: 'Favornoms',
    appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Favornoms' },
    icons: {
      icon: [
        { url: '/icon.svg', type: 'image/svg+xml' },
        { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      ],
      apple: '/apple-touch-icon.png',
    },
    openGraph: {
      type: 'website',
      siteName: 'Favornoms',
      title: t('meta.title'),
      description: t('site.ogDescription'),
      images: ['/icon-512.png'],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'Favornoms',
      description: t('site.twitterDescription'),
      images: ['/icon-512.png'],
    },
  };
}

/**
 * Chrome fires `beforeinstallprompt` exactly once, early, and never replays it.
 * On a repeat visit (warm SW + cached manifest) it lands *before* the React
 * bundle hydrates, so a listener attached in useEffect misses it for good —
 * which is why the install banner "hardly ever" appeared. Stash the event on
 * `window` from <head> instead; <InstallPrompt> consumes it whenever it mounts.
 * Keep the `__bipEvent` contract in sync with install-prompt.tsx.
 */
const CAPTURE_INSTALL_PROMPT = `!function(){var w=window;w.__bipEvent=null;w.addEventListener("beforeinstallprompt",function(e){e.preventDefault();w.__bipEvent=e});w.addEventListener("appinstalled",function(){w.__bipEvent=null})}();`;

/**
 * Every restaurant now publishes its own PWA identity, and an app installed from a menu opens
 * on that menu. Apps installed BEFORE that shared one identity with each other and with this
 * marketing site — their start_url is the origin root — so they land here instead, under a
 * Favornoms icon, for ever. Nothing can re-key an installed WebAPK; reinstalling is the only
 * route to a branded one, so say so where those people actually arrive.
 *
 * The test is: running standalone, on a page whose manifest link is the platform one. A page
 * under /r/ links its own tenant manifest, so a current install never matches — including on a
 * merchant's own domain, where the middleware rewrites "/" to the branch and the tenant
 * manifest is what ends up in the document. It runs from <body> rather than useEffect so it
 * does not wait for hydration, and unhides markup the server already sent rather than building
 * any of its own; it repeats on `load` so that hydration cannot put the attribute back.
 */
const REVEAL_LEGACY_INSTALL_NOTICE = `!function(){function r(){try{var s=(window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches)||window.navigator.standalone===true;if(!s)return;var l=document.querySelector('link[rel="manifest"]');var h=(l&&l.getAttribute("href"))||"";var i=h.indexOf("://");if(i>-1){var rest=h.slice(i+3);var q=rest.indexOf("/");h=q>-1?rest.slice(q):"/"}if(h.indexOf("/r/")===0)return;var e=document.getElementById("legacy-install-notice");if(e)e.hidden=false}catch(x){}}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",r);else r();window.addEventListener("load",r)}();`;

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
  const t = await getTranslations('landing');

  return (
    // ThemeProvider stamps `.dark` on <html> from a blocking script before the first
    // paint, so the class the browser has is deliberately one ahead of the one React
    // rendered. Without this, that difference is reported as a hydration mismatch.
    <html
      lang={locale}
      className={`${inter.variable} ${playfair.variable} ${notoThai.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: CAPTURE_INSTALL_PROMPT }} />
      </head>
      <body className="min-h-dynamic-screen bg-background font-sans antialiased">
        <div
          id="legacy-install-notice"
          role="status"
          hidden
          className="border-b border-border bg-warning/10 px-4 py-3 text-sm text-foreground"
        >
          <p className="mx-auto max-w-3xl">
            {t.rich('legacyInstall', { strong: (chunks) => <strong>{chunks}</strong> })}
          </p>
        </div>
        <NextIntlClientProvider messages={messages} locale={locale}>
          <UiLocaleProvider locale={isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE}>
            {/* Default theme; tenant layouts re-wrap with branded theme */}
            <ThemeProvider theme={{}}>
              <ConnectionBanner />
              <ServiceWorkerRegistrar />
              {children}
              <CookieBanner />
              <InstallPrompt />
            </ThemeProvider>
          </UiLocaleProvider>
        </NextIntlClientProvider>
        <script dangerouslySetInnerHTML={{ __html: REVEAL_LEGACY_INSTALL_NOTICE }} />
      </body>
    </html>
  );
}
