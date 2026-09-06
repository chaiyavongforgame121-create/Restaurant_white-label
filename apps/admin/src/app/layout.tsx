import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ThemeProvider } from '@favornoms/ui';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = { title: 'Favornoms Merchant', description: 'Restaurant merchant app' };
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
    <html lang={locale} className={inter.variable} suppressHydrationWarning>
      <body className="min-h-dynamic-screen bg-background font-sans antialiased">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <ThemeProvider theme={{ primaryColor: '#FF6B35', accentColor: '#F7B538' }}>
            {children}
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
