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
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
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

  return (
    // ThemeProvider stamps `.dark` on <html> from a blocking script before the first
    // paint, so the class the browser has is deliberately one ahead of the one React
    // rendered. Without this, that difference is reported as a hydration mismatch.
    <html
      lang={locale}
      className={`${inter.variable} ${playfair.variable}`}
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
            <strong>Installed this from a restaurant&apos;s menu?</strong> It was installed before
            each restaurant had an app of its own, so it can only ever open this page. Open that
            restaurant&apos;s menu in your browser and install it again — the new one carries their
            name and logo and starts on their menu. You can remove this one afterwards.
          </p>
        </div>
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
        <script dangerouslySetInnerHTML={{ __html: REVEAL_LEGACY_INSTALL_NOTICE }} />
      </body>
    </html>
  );
}
