// The Branding card's "Web address" field (branches.public_slug,
// docs/SHORT-STOREFRONT-URLS-2026-10-26.md §1), as decisions without React so they can be tested:
// what the field holds, what the line under it says, and what Save does with it.
//
// The field follows the App name ("Phở Hà Nội" -> pho-ha-noi) until the merchant types in it. An
// address the App name made is a suggestion: when it cannot be had, Save keeps the branch's address
// and says so, and never stops the rest of the card saving. An address the merchant typed is a
// request: when it cannot be had, Save stops with the reason, before anything is written.

import {
  normalizePublicSlug,
  publicSlugFormatError,
  suggestPublicSlug,
  type PublicSlugError,
} from '@favornoms/database/storefront-path';

export interface WebAddressField {
  /** The App name as typed now. */
  appName: string;
  /** The branch's web address as saved (null: none, the long address). */
  savedSlug: string | null;
  /** What the merchant typed into the field, or null while it follows the App name. */
  typed: string | null;
}

/**
 * What the field holds: what was typed; else the App name's address; else (a name with no Latin
 * letters, or none) the saved address, so a Thai App name never clears a web address.
 */
export function webAddressValue(field: WebAddressField): string {
  return field.typed ?? (suggestPublicSlug(field.appName) || field.savedSlug || '');
}

/**
 * What a keystroke in the field leaves as `typed`: the text as typed, or null when it spells the
 * App name's own address, which hands the field back to the App name (as a reload would).
 */
export function typedWebAddress(appName: string, input: string): string | null {
  const suggested = suggestPublicSlug(appName);
  return suggested && normalizePublicSlug(input) === suggested ? null : input;
}

/**
 * Whether a saved web address is the one the saved App name makes, so the field keeps following
 * the App name. No web address follows too: the field is then filled from the App name, unless the
 * merchant chose to have none (`optedOut`, see WEB_ADDRESS_OPT_OUT_KEY), when it stays blank.
 */
export function followsAppName(savedSlug: string | null, savedAppName: string, optedOut = false): boolean {
  if (!savedSlug) return !optedOut;
  return savedSlug === suggestPublicSlug(savedAppName);
}

/**
 * The branches.settings key (written with patch_branch_settings) that remembers the merchant chose
 * no web address. Without it a reload would fill the empty field from the App name again, and any
 * later Save, made only for the logo say, would quietly give the branch that address.
 */
export const WEB_ADDRESS_OPT_OUT_KEY = 'public_slug_cleared';

/** Whether the branch's saved settings say the merchant chose no web address. */
export function savedWebAddressOptOut(settings: unknown): boolean {
  return (
    !!settings &&
    typeof settings === 'object' &&
    !Array.isArray(settings) &&
    (settings as Record<string, unknown>)[WEB_ADDRESS_OPT_OUT_KEY] === true
  );
}

/**
 * Whether the field, as Save leaves it, is a choice of no web address: emptied by hand. Typing an
 * address again, or the App name's own (which hands the field back to it), withdraws the choice.
 */
export function webAddressOptOut(field: WebAddressField): boolean {
  return field.typed !== null && normalizePublicSlug(field.typed) === '';
}

/** check_public_slug's last answer, for the address it was asked about. */
export interface WebAddressCheck {
  slug: string;
  answer: { available: true } | { available: false; error: PublicSlugError } | 'failed';
}

export interface WebAddressReading {
  /** What the field asks for, as the database reads it ('' for no web address). */
  wanted: string;
  /** It differs from what the branch has, so Save would write it. */
  changed: boolean;
  /** Why it cannot be had, as far as is known: the format and reserved words at once, then the check. */
  problem: PublicSlugError | null;
  /** The check's answer for `wanted`; null while none has come back for it. */
  check: WebAddressCheck['answer'] | null;
}

export function readWebAddress(field: WebAddressField, lastCheck: WebAddressCheck | null): WebAddressReading {
  const wanted = normalizePublicSlug(webAddressValue(field));
  const changed = wanted !== (field.savedSlug ?? '');
  const check = lastCheck?.slug === wanted ? lastCheck.answer : null;
  const format = wanted ? publicSlugFormatError(wanted) : null;
  const taken = check && check !== 'failed' && !check.available ? check.error : null;
  return { wanted, changed, problem: changed ? (format ?? taken) : null, check };
}

/** Whether the field needs check_public_slug: a changed address that passes the format. */
export function needsAvailabilityCheck(reading: WebAddressReading): boolean {
  return reading.changed && !!reading.wanted && !reading.problem && reading.check === null;
}

/** What Save does with the field. */
export type WebAddressSave =
  /** Nothing to write: unchanged, or a suggestion that cannot be had. */
  | { kind: 'keep' }
  /** set_branch_public_slug with this (null clears it). */
  | { kind: 'write'; slug: string | null }
  /** A typed address that cannot be had: nothing is saved. */
  | { kind: 'refuse'; problem: PublicSlugError };

export function webAddressSave(field: WebAddressField, reading: WebAddressReading): WebAddressSave {
  if (!reading.changed) return { kind: 'keep' };
  if (reading.problem) return field.typed === null ? { kind: 'keep' } : { kind: 'refuse', problem: reading.problem };
  return { kind: 'write', slug: reading.wanted || null };
}

/** The line under the field. */
export type WebAddressStatus =
  /** No web address and none asked for: the long address stays. */
  | { kind: 'none' }
  /** As 'none', because the App name has no Latin letters to make one from. */
  | { kind: 'noLatin' }
  /** The field was emptied: saving goes back to the long address, and `old` forwards there. */
  | { kind: 'clearing'; old: string }
  /** What the branch has now. */
  | { kind: 'current' }
  | { kind: 'checking' }
  | { kind: 'checkFailed' }
  | { kind: 'available' }
  /** The App name's address cannot be had: saving keeps the branch's own. */
  | { kind: 'suggestionUnavailable' }
  /** The typed address cannot be had. */
  | { kind: 'problem'; problem: PublicSlugError };

export function webAddressStatus(field: WebAddressField, reading: WebAddressReading): WebAddressStatus {
  if (!reading.wanted) {
    if (field.savedSlug) return { kind: 'clearing', old: field.savedSlug };
    return field.appName.trim() && !suggestPublicSlug(field.appName) ? { kind: 'noLatin' } : { kind: 'none' };
  }
  if (!reading.changed) return { kind: 'current' };
  if (reading.problem) {
    return field.typed === null ? { kind: 'suggestionUnavailable' } : { kind: 'problem', problem: reading.problem };
  }
  if (reading.check === null) return { kind: 'checking' };
  if (reading.check === 'failed') return { kind: 'checkFailed' };
  return { kind: 'available' };
}
