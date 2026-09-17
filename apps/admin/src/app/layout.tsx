import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Thai } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { DialogProvider, ThemeProvider, UiLocaleProvider } from '@favornoms/ui';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@favornoms/shared';
import './globals.css';

// Vietnamese needs Inter's extended subset; Thai has no glyphs in Inter, so it gets its own family,
// loaded only when Thai text is on the page (unicode-range, not preloaded).
const inter = Inter({ subsets: ['latin', 'vietnamese'], variable: '--font-sans', display: 'swap' });
const notoThai = Noto_Sans_Thai({ subsets: ['thai'], variable: '--font-thai', display: 'swap', preload: false });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.metadata');
  return { title: t('title'), description: t('description') };
}
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#FF6B35',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  // ThemeProvider's blocking script stamps `.dark` on <html> before first paint, so the
  // client sees a class the server never rendered; without suppressHydrationWarning React
  // logs a hydration mismatch on every dark-mode load.
  return (
    <html lang={locale} className={`${inter.variable} ${notoThai.variable}`} suppressHydrationWarning>
      <body className="min-h-dynamic-screen bg-background font-sans antialiased">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <UiLocaleProvider locale={isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE}>
            <ThemeProvider theme={{ primaryColor: '#FF6B35', accentColor: '#F7B538' }}>
              {/* Mounted at the root so every back-office screen can ask a question without
                  reaching for window.confirm, which the browser is free to refuse. */}
              <DialogProvider>{children}</DialogProvider>
            </ThemeProvider>
          </UiLocaleProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
