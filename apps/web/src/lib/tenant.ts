import { notFound } from 'next/navigation';
import { cache } from 'react';
import { getServerClient } from '@favornoms/database/server';
import {
  getStorefrontStatus,
  resolveTenantBySlug,
  type ResolvedTenant,
  type StorefrontStatus,
} from '@favornoms/database/queries';

/**
 * Resolve `{restaurant_slug, branch_slug}` to ResolvedTenant.
 * Wrapped in React `cache()` so multiple components in one RSC render
 * share a single DB call.
 *
 * Production: wrap with Redis/KV per implementation.md §9.3 (3-layer cache).
 */
export const resolveTenant = cache(
  async (restaurantSlug: string, branchSlug: string): Promise<ResolvedTenant> => {
    const supabase = await getServerClient();
    const tenant = await resolveTenantBySlug(supabase, restaurantSlug, branchSlug);
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
