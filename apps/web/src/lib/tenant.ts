import { notFound } from 'next/navigation';
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { getAnonServerClient, getServerClient } from '@favornoms/database/server';
import {
  getStorefrontStatus,
  resolveTenantBySlug,
  type ResolvedTenant,
  type StorefrontStatus,
} from '@favornoms/database/queries';

/**
 * Tenant data (restaurant + branch + brand theme) is identical for every visitor and changes
 * only when the merchant edits branch settings — so it is cached ACROSS requests, not just
 * within one render. This is what stops every navigation from re-paying the three sequential
 * restaurants -> branches -> brands round-trips (~1.5s each warm, far worse cold) that were a
 * large part of the "everything is slow" report.
 *
 * The cached function uses the cookie-LESS anon client on purpose: unstable_cache must not
 * touch request cookies, and the storefront is publicly readable, so the anon role sees the
 * same rows. A branch config change takes up to `revalidate` seconds to appear — an acceptable
 * trade for a storefront. Bump the tag / revalidate if that ever needs to be instant.
 */
const cachedTenantBySlug = unstable_cache(
  async (restaurantSlug: string, branchSlug: string): Promise<ResolvedTenant | null> => {
    const supabase = getAnonServerClient();
    return resolveTenantBySlug(supabase, restaurantSlug, branchSlug);
  },
  ['tenant-by-slug'],
  // Was 300s. Branding is edited in a DIFFERENT app (admin), which cannot call
  // revalidateTag('tenant') here — so this window is the ONLY thing between a merchant
  // pressing "Save branding" and seeing their logo. Five minutes of staring at the old one
  // reads as a failed upload; the merchant re-uploads, and re-uploads again. Thirty seconds
  // still absorbs the storefront's read traffic (one fetch per window for every visitor)
  // while keeping the edit loop honest.
  { revalidate: 30, tags: ['tenant'] },
);

/**
 * Resolve `{restaurant_slug, branch_slug}` to ResolvedTenant.
 * React `cache()` dedupes within one RSC render; the inner unstable_cache dedupes across
 * requests for 5 minutes.
 */
export const resolveTenant = cache(
  async (restaurantSlug: string, branchSlug: string): Promise<ResolvedTenant> => {
    const tenant = await cachedTenantBySlug(restaurantSlug, branchSlug);
    if (!tenant) notFound();
    return tenant;
  },
);

/**
 * What this storefront may show an anonymous visitor: `entitled` (the
 * subscription deadline has not passed), plus the two customer-visible
 * feature flags. Anon-executable RPC, fails closed, `cache()`d for the render.
 *
 * Read this at the *page* level, not in the branch layout: suspension must
 * darken the ordering surfaces while leaving order tracking and receipts for
 * already-placed orders reachable. A layout cannot tell those apart.
 */
export const resolveStorefrontStatus = cache(
  async (branchId: string): Promise<StorefrontStatus> => {
    const supabase = await getServerClient();
    return getStorefrontStatus(supabase, branchId);
  },
);
