import type { FavornomsClient } from '../client-type';
import type { PublicSlugError } from '../storefront-path';

export {
  RESERVED_PUBLIC_SLUGS,
  normalizePublicSlug,
  publicSlugFormatError,
  suggestPublicSlug,
  type PublicSlugError,
} from '../storefront-path';

/**
 * A branch's web address (branches.public_slug, 20261026120000; docs/SHORT-STOREFRONT-URLS-2026-10-26.md
 * §1): with one, the storefront lives at /r/<web-address>. Set in the Branding card through
 * public.set_branch_public_slug, which needs branch.settings at that branch; the column refuses
 * any other write.
 */

/** public.check_public_slug's answer, for the field's availability line. */
export interface PublicSlugCheck {
  /** What was checked, trimmed and lower case; null for "no web address". */
  slug: string | null;
  available: boolean;
  /** Why it is not available. */
  error: PublicSlugError | null;
  /** It is what the branch has now (for null: the branch has none), so saving changes nothing. */
  current: boolean;
}

/** What set_branch_public_slug saved. */
export interface PublicSlugSaved {
  publicSlug: string | null;
  /** The storefront's public base after the save: /r/<web-address>, or the long form. */
  path: string;
}

/** Every refusal the two RPCs answer with, as the error's message. */
export type PublicSlugRefusal = PublicSlugError | 'not_authorized' | 'sign_in_required' | 'branch_not_found';

const REFUSALS: readonly PublicSlugRefusal[] = [
  'slug_invalid',
  'slug_reserved',
  'slug_taken',
  'not_authorized',
  'sign_in_required',
  'branch_not_found',
];

/** Which refusal an error from set_branch_public_slug or check_public_slug is, or null for any other. */
export function publicSlugRefusal(error: { message?: string | null } | null | undefined): PublicSlugRefusal | null {
  const message = error?.message?.trim() ?? '';
  return (REFUSALS as readonly string[]).includes(message) ? (message as PublicSlugRefusal) : null;
}

/** check_public_slug's JSON, or null when it is not that shape. */
export function parsePublicSlugCheck(data: unknown): PublicSlugCheck | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.available !== 'boolean' || typeof d.current !== 'boolean') return null;
  const error = d.error === 'slug_invalid' || d.error === 'slug_reserved' || d.error === 'slug_taken' ? d.error : null;
  if (!d.available && !error) return null;
  return {
    slug: typeof d.slug === 'string' && d.slug ? d.slug : null,
    available: d.available,
    error: d.available ? null : error,
    current: d.current,
  };
}

/**
 * Whether `slug` (as typed: it is trimmed and lower-cased there) could be the branch's web address.
 * Null or blank asks about "no web address", which is always available. Throws the database error
 * on a refusal (publicSlugRefusal reads it) or an answer it cannot read.
 */
export async function checkPublicSlug(
  supabase: FavornomsClient,
  branchId: string,
  slug: string | null,
): Promise<PublicSlugCheck> {
  const { data, error } = await supabase.rpc('check_public_slug', { p_branch_id: branchId, p_slug: slug ?? '' });
  if (error) throw error;
  const check = parsePublicSlugCheck(data);
  if (!check) throw new Error('check_public_slug: unexpected answer');
  return check;
}

/**
 * Saves the branch's web address (null or blank clears it; it is trimmed and lower-cased there).
 * The old one keeps working: it becomes an address that 308s to the new one. Throws the database
 * error on a refusal — slug_invalid, slug_reserved, slug_taken, not_authorized, sign_in_required,
 * branch_not_found (publicSlugRefusal) — or on an answer it cannot read.
 */
export async function setBranchPublicSlug(
  supabase: FavornomsClient,
  branchId: string,
  slug: string | null,
): Promise<PublicSlugSaved> {
  const { data, error } = await supabase.rpc('set_branch_public_slug', { p_branch_id: branchId, p_slug: slug ?? '' });
  if (error) throw error;
  const d = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  if (typeof d.path !== 'string' || !d.path.startsWith('/r/')) throw new Error('set_branch_public_slug: unexpected answer');
  return { publicSlug: typeof d.public_slug === 'string' && d.public_slug ? d.public_slug : null, path: d.path };
}
