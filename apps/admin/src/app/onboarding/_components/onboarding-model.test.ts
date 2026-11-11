import { describe, expect, it } from 'vitest';
import { suggestPublicSlug } from '@favornoms/database/storefront-path';
import {
  RESTAURANT_NAME_MAX_LENGTH,
  canContinue,
  isValidSlug,
  launchPreflight,
  launchProblem,
  launchProblemKey,
  launchProblemStep,
  normalizeSlug,
  slugFieldInput,
  slugFieldValue,
  slugFromName,
  slugHint,
  slugToSend,
  type SlugField,
} from './onboarding-model';

/** restaurants_slug_check / branches_slug_check exactly as pg_get_constraintdef prints them live. */
const DB_PATTERN = new RegExp('^[a-z0-9](-?[a-z0-9])*$');
const dbAccepts = (slug: string) => DB_PATTERN.test(slug) && slug.length >= 2 && slug.length <= 64;

/** Every prefix of `name`, as a merchant typing it one character at a time leaves the input. */
const prefixes = (name: string) => Array.from({ length: [...name].length }, (_, i) => [...name].slice(0, i + 1).join(''));

const following = (name: string): SlugField => ({ name, typed: null });

/** Types `text` into the slug field one character at a time, from what it shows now. */
function typeInto(field: SlugField, text: string): SlugField {
  let next = field;
  for (const ch of text) next = { ...next, typed: slugFieldInput(slugFieldValue(next) + ch) };
  return next;
}

describe('the slug follows the name', () => {
  it('follows a Thai + Latin name typed one letter at a time, and never freezes on the first letter', () => {
    const seen = prefixes('ละมุน Lamoon').map((p) => slugFieldValue(following(p)));
    // The old wizard froze here at "l": the first value that was not empty.
    expect(seen).not.toContain('l');
    expect(seen.at(-1)).toBe('lamoon');
    expect(seen.slice(-5)).toEqual(['la', 'lam', 'lamo', 'lamoo', 'lamoon']);
    expect(seen.slice(0, -5).every((s) => s === '')).toBe(true);
    expect(slugToSend(following('ละมุน Lamoon'))).toBe('lamoon');
  });

  it('follows a Latin name typed first and Thai after it', () => {
    const seen = prefixes('Lamoon ละมุน').map((p) => slugFieldValue(following(p)));
    expect(seen.at(-1)).toBe('lamoon');
    // The space and the Thai after it never leave a trailing hyphen in what is sent.
    for (const p of prefixes('Lamoon ละมุน')) expect(slugToSend(following(p))).not.toMatch(/-$/);
  });

  it('folds accents and joins words with single hyphens', () => {
    expect(slugFromName('Phở Hà Nội')).toBe('pho-ha-noi');
    expect(slugFromName('Café Niño')).toBe('cafe-nino');
    expect(slugFromName('  Somtam   Zab!! ')).toBe('somtam-zab');
    expect(slugFromName('Đà Lạt Grill')).toBe('da-lat-grill');
    expect(slugFromName('ร้าน 99')).toBe('99');
  });

  it('gives no slug for a Thai-only name, or one with a single Latin letter', () => {
    expect(slugFromName('ละมุน')).toBe('');
    expect(slugFromName('ส้มตำแซ่บ')).toBe('');
    expect(slugFromName('ละมุน L')).toBe('');
    expect(slugFromName('')).toBe('');
  });

  it('cuts a long name to 64 characters without a hyphen at the end', () => {
    const slug = slugFromName(`${'a'.repeat(63)} b`);
    expect(slug).toBe('a'.repeat(63));
    expect(slugFromName('x'.repeat(100))).toHaveLength(64);
  });

  it('makes what the Branding card suggests for the same name', () => {
    for (const name of ['Phở Hà Nội', 'Café Niño', 'ละมุน Lamoon', 'Somtam Zab', 'ละมุน', 'L', 'Smørrebrød & Øl', `${'a'.repeat(70)}`]) {
      expect(slugFromName(name), name).toBe(suggestPublicSlug(name));
    }
  });

  it('follows the branch name the same way, starting from Main', () => {
    expect(slugFieldValue(following('Main'))).toBe('main');
    expect(slugFieldValue(following('Sukhumvit branch'))).toBe('sukhumvit-branch');
    expect(slugFieldValue(following('สาขาสุขุมวิท'))).toBe('');
  });

  it('stops following once the merchant types in the field', () => {
    const typed = typeInto(following('Lamoon'), 'x');
    expect(typed.typed).toBe('lamoonx');
    // The name changes after that; the slug does not.
    expect(slugFieldValue({ ...typed, name: 'Lamoon Thai Kitchen' })).toBe('lamoonx');
  });

  it('keeps a field the merchant emptied empty', () => {
    const cleared: SlugField = { name: 'Lamoon', typed: slugFieldInput('') };
    expect(slugFieldValue(cleared)).toBe('');
    expect(canContinue(cleared)).toBe(false);
  });
});

describe('the slug field', () => {
  it('lets a hyphen be typed between two words', () => {
    // The old field ran slugify on every keystroke, which dropped the hyphen as soon as it was typed.
    const field = typeInto({ name: 'ละมุน', typed: '' }, 'lamoon-thai');
    expect(slugFieldValue(field)).toBe('lamoon-thai');
    expect(slugToSend(field)).toBe('lamoon-thai');
  });

  it('turns a space into a hyphen and never doubles one', () => {
    expect(slugFieldInput('lamoon ')).toBe('lamoon-');
    expect(slugFieldInput('lamoon--')).toBe('lamoon-');
    expect(slugFieldInput('lamoon - thai')).toBe('lamoon-thai');
    expect(slugFieldInput('-lamoon')).toBe('lamoon');
    expect(slugFieldInput('Lamoon_Thai')).toBe('lamoon-thai');
  });

  it('drops what cannot be in a web address', () => {
    expect(slugFieldInput('ละมุน')).toBe('');
    expect(slugFieldInput('LAMOON')).toBe('lamoon');
    expect(slugFieldInput('café')).toBe('cafe');
  });

  it('is normalised before it is checked and sent', () => {
    expect(normalizeSlug('lamoon-')).toBe('lamoon');
    expect(slugToSend({ name: 'x', typed: 'lamoon-' })).toBe('lamoon');
    expect(canContinue({ name: 'Lamoon', typed: 'lamoon-' })).toBe(true);
  });

  it('holds at most 64 characters', () => {
    expect(slugFieldInput('a'.repeat(80))).toHaveLength(64);
  });
});

describe('the validity rule', () => {
  const candidates = [
    '',
    'a',
    'ab',
    'a1',
    '12',
    'a-b',
    'lamoon-thai',
    'a--b',
    '-ab',
    'ab-',
    '-',
    'AB',
    'Ab',
    'a_b',
    'a b',
    'a.b',
    'café',
    'ละมุน',
    'a'.repeat(64),
    'a'.repeat(65),
    `${'a-'.repeat(31)}ab`,
    `${'a-'.repeat(32)}a`,
  ];

  it('agrees with restaurants_slug_check / branches_slug_check on every candidate', () => {
    for (const s of candidates) expect(isValidSlug(s), JSON.stringify(s)).toBe(dbAccepts(s));
  });

  it('refuses one character, which is what the old wizard sent', () => {
    expect(isValidSlug('l')).toBe(false);
  });

  it('only ever sends something the database takes, or nothing', () => {
    const inputs = [
      'ละมุน Lamoon',
      '  --Somtam  Zab--  ',
      'Phở Hà Nội',
      '!!!',
      'a',
      'ab-',
      'x'.repeat(63) + '-y',
      'Ünïcödé ÄÖÜ ß',
      'ﬁsh & chips',
      '日本料理 Sakura',
    ];
    for (const raw of inputs) {
      const sent = normalizeSlug(raw);
      expect(sent.length <= 64, raw).toBe(true);
      if (sent.length >= 2) expect(dbAccepts(sent), raw).toBe(true);
      const fromName = slugFromName(raw);
      expect(fromName === '' || dbAccepts(fromName), raw).toBe(true);
    }
  });
});

describe('the line under a slug field', () => {
  it('says nothing before anything is typed', () => {
    expect(slugHint(following(''))).toBeNull();
  });

  it('asks for Latin letters when the name is Thai only', () => {
    expect(slugHint(following('ละมุน'))).toBe('latinOnly');
    expect(slugHint({ name: 'ละมุน', typed: '' })).toBe('latinOnly');
    expect(slugHint(following('สาขาสุขุมวิท'))).toBe('latinOnly');
  });

  it('gives the rule when what is there is too short or was emptied', () => {
    expect(slugHint(following('ละมุน L'))).toBe('rule');
    expect(slugHint({ name: 'Lamoon', typed: '' })).toBe('rule');
    expect(slugHint({ name: 'ละมุน', typed: 'l' })).toBe('rule');
    expect(slugHint({ name: '', typed: '' })).toBe('rule');
  });

  it('says nothing once the slug is one the database takes', () => {
    expect(slugHint(following('ละมุน La'))).toBeNull();
    expect(slugHint({ name: 'ละมุน', typed: 'lamoon-' })).toBeNull();
  });
});

describe('stepping forward and Launch', () => {
  it('needs a name and a valid slug', () => {
    expect(canContinue(following('ละมุน Lamoon'))).toBe(true);
    expect(canContinue(following('ละมุน L'))).toBe(false);
    expect(canContinue(following('ละมุน'))).toBe(false);
    expect(canContinue({ name: 'ละมุน', typed: 'lamoon' })).toBe(true);
    expect(canContinue({ name: '   ', typed: 'lamoon' })).toBe(false);
    expect(canContinue(following('Main'))).toBe(true);
  });

  it('sends the merchant to the field that is wrong before anything is sent', () => {
    expect(launchPreflight(following('ละมุน Lamoon'), following('Main'))).toBeNull();
    const restaurant = launchPreflight({ name: 'ละมุน', typed: 'l' }, following('Main'));
    expect(restaurant).toEqual({ field: 'restaurant', kind: 'slugInvalid' });
    expect(launchProblemStep(restaurant!)).toBe(0);
    const branch = launchPreflight(following('Lamoon'), following('สาขาสุขุมวิท'));
    expect(branch).toEqual({ field: 'branch', kind: 'slugInvalid' });
    expect(launchProblemStep(branch!)).toBe(1);
  });

  it('keeps the restaurant name inside restaurants_name_check', () => {
    expect(RESTAURANT_NAME_MAX_LENGTH).toBe(200);
  });
});

describe('create_restaurant_with_branch refusals', () => {
  it('names the field for the two slug check constraints', () => {
    // As the live logs of 2026-11-09 have it.
    const restaurant = launchProblem({
      code: '23514',
      message: 'new row for relation "restaurants" violates check constraint "restaurants_slug_check"',
    });
    expect(restaurant).toEqual({ field: 'restaurant', kind: 'slugInvalid' });
    expect(launchProblemKey(restaurant!)).toBe('errors.restaurantSlugInvalid');
    expect(launchProblemStep(restaurant!)).toBe(0);

    const branch = launchProblem({
      code: '23514',
      message: 'new row for relation "branches" violates check constraint "branches_slug_check"',
    });
    expect(branch).toEqual({ field: 'branch', kind: 'slugInvalid' });
    expect(launchProblemKey(branch!)).toBe('errors.branchSlugInvalid');
    expect(launchProblemStep(branch!)).toBe(1);
  });

  it('names the restaurant field for a taken restaurant slug, whatever the slug spells', () => {
    const taken = launchProblem({
      code: '23505',
      message: 'duplicate key value violates unique constraint "restaurants_slug_key"',
    });
    expect(taken).toEqual({ field: 'restaurant', kind: 'slugTaken' });
    expect(launchProblemKey(taken!)).toBe('errors.restaurantSlugTaken');
    // The old /branch/ test on message + details blamed the branch field for this one.
    const branchy = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "restaurants_slug_key"',
      details: 'Key (slug)=(branch-and-vine) already exists.',
    };
    expect(launchProblem(branchy)).toEqual({ field: 'restaurant', kind: 'slugTaken' });
  });

  it("names the restaurant field when the slug is a storefront's web address (restaurants_slug_namespace)", () => {
    const err = { code: '23505', message: 'slug_taken', details: null, hint: "That address is a storefront's web address. Pick another." };
    expect(launchProblem(err)).toEqual({ field: 'restaurant', kind: 'slugTaken' });
  });

  it('names the branch field for a taken branch slug', () => {
    const taken = launchProblem({
      code: '23505',
      message: 'duplicate key value violates unique constraint "branches_restaurant_id_slug_key"',
    });
    expect(taken).toEqual({ field: 'branch', kind: 'slugTaken' });
    expect(launchProblemKey(taken!)).toBe('errors.branchSlugTaken');
  });

  it('leaves everything else to the generic sentence', () => {
    expect(launchProblem({ code: '23514', message: 'new row for relation "restaurants" violates check constraint "restaurants_name_check"' })).toBeNull();
    expect(launchProblem({ code: '23505', message: 'duplicate key value violates unique constraint "uniq_staff_user_branch"' })).toBeNull();
    expect(launchProblem({ code: 'P0001', message: 'auth_required' })).toBeNull();
    expect(launchProblem({ code: 'P0001', message: 'invalid_location' })).toBeNull();
    expect(launchProblem({ message: 'Failed to fetch' })).toBeNull();
    expect(launchProblem({})).toBeNull();
  });
});
