import { notFound } from 'next/navigation';
import { cache } from 'react';
import { getServerClient } from '@favornoms/database/server';
import { resolveTenantBySlug, type ResolvedTenant } from '@favornoms/database/queries';

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
