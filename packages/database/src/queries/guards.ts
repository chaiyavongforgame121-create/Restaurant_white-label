// Route guards for Next.js server components.
//
// These are a UX layer, not the security boundary — the security boundary is
// the SQL triggers (orders / payments / deliveries / branches) and the
// SECURITY DEFINER functions, which hold whether or not a page renders. What
// these buy is a coherent surface: a suspended merchant sees the billing page
// instead of a wall of failed writes.
//
// All three throw on denial so a server component can `await` them in one line.

import { hasFeature, isEntitled, type Entitlements, type FeatureKey } from '@favornoms/shared';
import type { FavornomsClient } from '../client-type';
import { getEntitlements, getEntitlementsForBranch } from './billing';

export type EntitlementDenial = 'inactive' | 'feature' | 'platform_admin';

export class EntitlementError extends Error {
  readonly kind: EntitlementDenial;
  readonly feature?: FeatureKey;
  readonly entitlements?: Entitlements;

  constructor(kind: EntitlementDenial, feature?: FeatureKey, entitlements?: Entitlements) {
    super(kind === 'feature' ? `feature_not_entitled:${feature}` : `billing_${kind}`);
    this.name = 'EntitlementError';
    this.kind = kind;
    this.feature = feature;
    this.entitlements = entitlements;
  }
}

/** Throws unless the restaurant is paid up. Returns the entitlements for reuse. */
export async function assertEntitled(
  supabase: FavornomsClient,
  restaurantId: string,
): Promise<Entitlements> {
  const ent = await getEntitlements(supabase, restaurantId);
  if (!isEntitled(ent)) throw new EntitlementError('inactive', undefined, ent);
  return ent;
}

/** Throws unless the restaurant is paid up AND the package includes `key`. */
export async function assertFeature(
  supabase: FavornomsClient,
  restaurantId: string,
  key: FeatureKey,
): Promise<Entitlements> {
  const ent = await getEntitlements(supabase, restaurantId);
  if (!isEntitled(ent)) throw new EntitlementError('inactive', key, ent);
  if (!hasFeature(ent, key)) throw new EntitlementError('feature', key, ent);
  return ent;
}

/** Branch-keyed variant — most merchant routes only have a branchId in the URL. */
export async function assertBranchFeature(
  supabase: FavornomsClient,
  branchId: string,
  key: FeatureKey,
): Promise<Entitlements> {
  const ent = await getEntitlementsForBranch(supabase, branchId);
  if (!isEntitled(ent)) throw new EntitlementError('inactive', key, ent);
  if (!hasFeature(ent, key)) throw new EntitlementError('feature', key, ent);
  return ent;
}

/**
 * Platform-admin gate. Asks the database the same question its own
 * SECURITY DEFINER functions ask, so the two can never disagree.
 * Fails closed: any error is a denial.
 */
export async function isPlatformAdmin(supabase: FavornomsClient): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('is_platform_admin');
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

export async function assertPlatformAdmin(supabase: FavornomsClient): Promise<void> {
  if (!(await isPlatformAdmin(supabase))) throw new EntitlementError('platform_admin');
}
