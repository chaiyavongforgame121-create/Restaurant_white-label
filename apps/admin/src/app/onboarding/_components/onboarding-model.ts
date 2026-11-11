// The onboarding wizard's two web addresses (restaurants.slug, branches.slug) as decisions without
// React, so they can be tested: what each slug field holds, the line under it, whether a step may
// go on, and which of create_restaurant_with_branch's refusals a merchant can fix themselves.
//
// No restaurant was created from 2026-09-19 until this was found (live logs, 2026-11-09). The
// wizard copied the name into the slug only while the slug was empty, so a name typed one letter
// at a time froze it at the first Latin letter ("ละมุน Lamoon" left "l"), and the only check
// before Launch was "not empty". The database wants 2 to 64 characters, so Launch came back 23514
// restaurants_slug_check and the screen said only "We couldn't create your restaurant".
//
// Now a slug field follows its name on every change until the merchant types in it; one rule, the
// database's own, decides the hint, Continue and Launch; and a refusal the merchant can fix gets
// its own sentence and sends them back to the step with the field.

/**
 * restaurants_slug_check and branches_slug_check, as the live database has them:
 * `slug ~ '^[a-z0-9](-?[a-z0-9])*$' and length(slug) between 2 and 64`.
 */
export const SLUG_PATTERN = /^[a-z0-9](-?[a-z0-9])*$/;
export const SLUG_MIN_LENGTH = 2;
export const SLUG_MAX_LENGTH = 64;

/** restaurants_name_check: 1 to 200 characters. The name input stops at this many. */
export const RESTAURANT_NAME_MAX_LENGTH = 200;

/** Whether the database would take `slug` as a restaurant or branch slug. */
export function isValidSlug(slug: string): boolean {
  return slug.length >= SLUG_MIN_LENGTH && slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
}

/** Letters NFD leaves whole, folded as suggestPublicSlug (@favornoms/database/storefront-path) folds them. */
const FOLD: Record<string, string> = { đ: 'd', ð: 'd', ø: 'o', ł: 'l', æ: 'ae', œ: 'oe', ß: 'ss', þ: 'th', ı: 'i' };

/** Lower case with the accents taken off ("Phở Hà Nội" -> "pho ha noi"). Thai stays Thai. */
function foldLatin(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[đðøłæœßþı]/g, (c) => FOLD[c] ?? c);
}

/**
 * What a keystroke leaves in a slug field: lower case, accents folded, any run of other
 * characters (a space, Thai, punctuation) one hyphen, no hyphen in front, at most 64 characters.
 * A hyphen at the end stays, so one can be typed between two words; normalizeSlug drops it.
 */
export function slugFieldInput(raw: string): string {
  return foldLatin(raw).replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, SLUG_MAX_LENGTH);
}

/** What is checked and sent for a field's text: as slugFieldInput, with no hyphen at either end. */
export function normalizeSlug(value: string): string {
  let slug = foldLatin(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > SLUG_MAX_LENGTH) slug = slug.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, '');
  return slug;
}

/**
 * The slug a name gives ("Phở Hà Nội" -> "pho-ha-noi", "ละมุน Lamoon" -> "lamoon"), or '' when it
 * has fewer than two Latin letters or digits to give (a Thai name): the merchant then types one.
 */
export function slugFromName(name: string): string {
  const slug = normalizeSlug(name);
  return slug.length >= SLUG_MIN_LENGTH ? slug : '';
}

/** One slug field and the name it follows (the restaurant's, or the branch's). */
export interface SlugField {
  /** The name as typed now. */
  name: string;
  /** What the merchant typed into the slug field (slugFieldInput's result), or null while it follows the name. */
  typed: string | null;
}

/** What the field shows. */
export function slugFieldValue(field: SlugField): string {
  return field.typed ?? slugFromName(field.name);
}

/** What create_restaurant_with_branch is sent for the field. */
export function slugToSend(field: SlugField): string {
  return normalizeSlug(slugFieldValue(field));
}

/**
 * The line under a slug field:
 * - `latinOnly`: there is no slug and the name has no Latin letters or digits to make one from,
 *   so the merchant has to type the web address in Latin letters;
 * - `rule`: what is there is not a slug the database takes (too short, empty, too long);
 * - null: it is fine, or nothing has been typed into the name or the field yet.
 */
export type SlugHint = 'latinOnly' | 'rule';

export function slugHint(field: SlugField): SlugHint | null {
  const slug = slugToSend(field);
  if (isValidSlug(slug)) return null;
  const named = field.name.trim() !== '';
  if (!named && field.typed === null) return null;
  if (slug === '' && named && !/[a-z0-9]/.test(foldLatin(field.name))) return 'latinOnly';
  return 'rule';
}

/** Whether Continue may leave the step: a name, and a slug the database takes. */
export function canContinue(field: SlugField): boolean {
  return field.name.trim() !== '' && isValidSlug(slugToSend(field));
}

/** Which of the two slugs a problem is about. */
export type SlugOwner = 'restaurant' | 'branch';

/** A Launch failure the merchant can fix in a slug field. */
export interface LaunchProblem {
  field: SlugOwner;
  kind: 'slugInvalid' | 'slugTaken';
}

/** The step that holds the field. */
export function launchProblemStep(problem: LaunchProblem): 0 | 1 {
  return problem.field === 'restaurant' ? 0 : 1;
}

/** The `onboarding.errors.*` sentence for a problem. */
export function launchProblemKey(
  problem: LaunchProblem,
): 'errors.restaurantSlugInvalid' | 'errors.branchSlugInvalid' | 'errors.restaurantSlugTaken' | 'errors.branchSlugTaken' {
  if (problem.kind === 'slugInvalid') {
    return problem.field === 'restaurant' ? 'errors.restaurantSlugInvalid' : 'errors.branchSlugInvalid';
  }
  return problem.field === 'restaurant' ? 'errors.restaurantSlugTaken' : 'errors.branchSlugTaken';
}

/**
 * Checked on Launch before anything is sent. The steps already hold Continue back on the same
 * rule, so this only catches a field changed on a step and left by Back.
 */
export function launchPreflight(restaurant: SlugField, branch: SlugField): LaunchProblem | null {
  if (!isValidSlug(slugToSend(restaurant))) return { field: 'restaurant', kind: 'slugInvalid' };
  if (!isValidSlug(slugToSend(branch))) return { field: 'branch', kind: 'slugInvalid' };
  return null;
}

/** The parts of a PostgREST error this reads. */
export interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
}

/**
 * What a create_restaurant_with_branch error means for a slug field, or null when it is none of
 * the slug refusals (the wizard then says errors.generic and logs the raw message).
 *
 * Read by constraint name, not by searching the text for "branch": the old /branch/ test blamed
 * the branch field for a taken restaurant slug like "branch-and-vine", because Postgres repeats
 * the slug in the detail ('Key (slug)=(branch-and-vine) already exists.').
 * - 23514 restaurants_slug_check / branches_slug_check: the slug's shape;
 * - 23505 restaurants_slug_key: another restaurant has it;
 * - 23505 'slug_taken': restaurants_slug_namespace (20261026120000_branch_public_slugs.sql, the
 *   live trigger is the same) refuses a restaurant slug that is a branch's web address or an old
 *   one. It is the only slug refusal that namespace raises on a restaurant insert; the branch side
 *   (branches_public_slug_rules) runs only for a public_slug, which this RPC never sets;
 * - 23505 branches_restaurant_id_slug_key: the restaurant already has a branch at that slug (a
 *   new restaurant has none, but it costs nothing to name the field).
 */
export function launchProblem(err: RpcErrorLike): LaunchProblem | null {
  const message = (err.message ?? '').trim();
  const constraint = /constraint "([^"]+)"/.exec(message)?.[1] ?? null;
  if (err.code === '23514') {
    if (constraint === 'restaurants_slug_check') return { field: 'restaurant', kind: 'slugInvalid' };
    if (constraint === 'branches_slug_check') return { field: 'branch', kind: 'slugInvalid' };
    return null;
  }
  if (err.code === '23505') {
    if (message === 'slug_taken' || constraint === 'restaurants_slug_key') return { field: 'restaurant', kind: 'slugTaken' };
    if (constraint === 'branches_restaurant_id_slug_key') return { field: 'branch', kind: 'slugTaken' };
  }
  return null;
}
