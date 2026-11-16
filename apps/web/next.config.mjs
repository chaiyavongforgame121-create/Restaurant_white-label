import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Metadata always in <head>, for every visitor (the owner's report of 2026-11-16: the tab icon
  // "sometimes shows, sometimes not"). Next 15 streams generateMetadata into <body> when it
  // resolves after the first bytes went out, which every cold or slow request does, and browsers
  // read <link rel="icon"> from <head> only (Chromium's Document::IconURLs; the HTML spec does not
  // make "icon" body-ok), so the storefront's own icon was dropped for the platform default. This
  // regex makes every user agent get what HTML-limited bots get: metadata before the body.
  htmlLimitedBots: /.*/,
  transpilePackages: ['@favornoms/ui', '@favornoms/shared', '@favornoms/database', '@favornoms/maps'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: '**.supabase.co' },
    ],
  },
};

export default withNextIntl(nextConfig);
