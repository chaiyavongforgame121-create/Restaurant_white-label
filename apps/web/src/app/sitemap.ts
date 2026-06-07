import type { MetadataRoute } from 'next';
import { getServerClient } from '@favornoms/database/server';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://favornoms.com';
  const supabase = await getServerClient();
  const { data: branches } = await supabase
    .from('branches')
    .select('slug, restaurants(slug)')
    .eq('is_active', true);

  const staticUrls: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/ccpa`, changeFrequency: 'yearly', priority: 0.3 },
  ];

  const branchUrls: MetadataRoute.Sitemap = (branches ?? [])
    .map((b: { slug: string | null; restaurants: { slug: string | null } | { slug: string | null }[] | null }) => {
      const restSlug = Array.isArray(b.restaurants) ? b.restaurants[0]?.slug : b.restaurants?.slug;
      if (!restSlug || !b.slug) return null;
      return {
        url: `${base}/r/${restSlug}/${b.slug}`,
        changeFrequency: 'daily' as const,
        priority: 0.8,
      };
    })
    .filter((x): x is { url: string; changeFrequency: 'daily'; priority: number } => x !== null);

  return [...staticUrls, ...branchUrls];
}
