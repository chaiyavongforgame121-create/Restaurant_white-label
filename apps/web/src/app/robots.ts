import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://favornoms.com';
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: ['/account', '/r/*/checkout', '/r/*/sign-in'] },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
