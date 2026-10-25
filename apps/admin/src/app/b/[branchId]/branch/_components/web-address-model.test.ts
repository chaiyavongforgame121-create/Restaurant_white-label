import { describe, expect, it } from 'vitest';
import {
  WEB_ADDRESS_OPT_OUT_KEY,
  followsAppName,
  needsAvailabilityCheck,
  readWebAddress,
  savedWebAddressOptOut,
  typedWebAddress,
  webAddressOptOut,
  webAddressSave,
  webAddressStatus,
  webAddressValue,
  type WebAddressCheck,
  type WebAddressField,
} from './web-address-model';

const field = (over: Partial<WebAddressField> = {}): WebAddressField => ({
  appName: 'Hamburger',
  savedSlug: null,
  typed: null,
  ...over,
});

const taken = (slug: string): WebAddressCheck => ({ slug, answer: { available: false, error: 'slug_taken' } });
const free = (slug: string): WebAddressCheck => ({ slug, answer: { available: true } });

describe('webAddressValue', () => {
  it('is filled from the App name, accents stripped', () => {
    expect(webAddressValue(field())).toBe('hamburger');
    expect(webAddressValue(field({ appName: 'Phở Hà Nội' }))).toBe('pho-ha-noi');
  });

  it('never clears a saved address for a name with no Latin letters, or no name', () => {
    expect(webAddressValue(field({ appName: 'ร้านข้าวมันไก่', savedSlug: 'hamburger' }))).toBe('hamburger');
    expect(webAddressValue(field({ appName: '', savedSlug: 'hamburger' }))).toBe('hamburger');
    expect(webAddressValue(field({ appName: 'ร้านข้าวมันไก่' }))).toBe('');
  });

  it('holds what the merchant typed, empty included', () => {
    expect(webAddressValue(field({ typed: 'Burger-Bar ' }))).toBe('Burger-Bar ');
    expect(webAddressValue(field({ typed: '', savedSlug: 'hamburger' }))).toBe('');
  });
});

describe('typedWebAddress and followsAppName', () => {
  it('hands the field back to the App name when its own address is typed', () => {
    expect(typedWebAddress('Hamburger', 'Hamburger ')).toBeNull();
    expect(typedWebAddress('Hamburger', 'hamburger-2')).toBe('hamburger-2');
    expect(typedWebAddress('ร้านข้าวมันไก่', '')).toBe('');
  });

  it('follows when the saved address is the saved App name’s own, or there is none', () => {
    expect(followsAppName('hamburger', 'Hamburger')).toBe(true);
    expect(followsAppName(null, 'Hamburger')).toBe(true);
    expect(followsAppName('burger-bar', 'Hamburger')).toBe(false);
    expect(followsAppName('hamburger', '')).toBe(false);
  });
});

describe('choosing no web address', () => {
  it('keeps the field blank on the next visit, and a later Save leaves the address alone', () => {
    // The merchant emptied the field and saved; this is the card read again, App name unchanged.
    expect(followsAppName(null, 'Hamburger', true)).toBe(false);
    const f = field({ savedSlug: null, typed: '' });
    expect(webAddressValue(f)).toBe('');
    expect(webAddressSave(f, readWebAddress(f, null))).toEqual({ kind: 'keep' });
    expect(needsAvailabilityCheck(readWebAddress(f, null))).toBe(false);
    expect(webAddressStatus(f, readWebAddress(f, null))).toEqual({ kind: 'none' });
  });

  it('does not change how a saved address follows', () => {
    expect(followsAppName('hamburger', 'Hamburger', true)).toBe(true);
    expect(followsAppName('burger-bar', 'Hamburger', true)).toBe(false);
  });

  it('is read from the branch settings only when it is exactly true', () => {
    expect(savedWebAddressOptOut({ public_slug_cleared: true, app_name: 'Hamburger' })).toBe(true);
    for (const settings of [null, undefined, {}, { public_slug_cleared: 'true' }, { public_slug_cleared: false }, [true]]) {
      expect(savedWebAddressOptOut(settings)).toBe(false);
    }
    expect(WEB_ADDRESS_OPT_OUT_KEY).toBe('public_slug_cleared');
  });

  it('is the field emptied by hand, and typing an address again withdraws it', () => {
    expect(webAddressOptOut(field({ typed: '' }))).toBe(true);
    expect(webAddressOptOut(field({ typed: '  ', savedSlug: 'hamburger' }))).toBe(true);
    expect(webAddressOptOut(field())).toBe(false);
    expect(webAddressOptOut(field({ typed: 'burger-bar' }))).toBe(false);
    // Typing the App name's own address hands the field back to it, which withdraws it too.
    expect(webAddressOptOut(field({ typed: typedWebAddress('Hamburger', 'hamburger') }))).toBe(false);
  });
});

describe('readWebAddress', () => {
  it('reads the field as the database does and keeps only the check for this address', () => {
    const r = readWebAddress(field({ typed: ' Pizza ' }), taken('pizza'));
    expect(r).toEqual({ wanted: 'pizza', changed: true, problem: 'slug_taken', check: { available: false, error: 'slug_taken' } });
    expect(readWebAddress(field({ typed: 'pizza-2' }), taken('pizza')).check).toBeNull();
  });

  it('knows format and reserved words without asking', () => {
    expect(readWebAddress(field({ typed: 'pho ha noi' }), null).problem).toBe('slug_invalid');
    expect(readWebAddress(field({ typed: 'admin' }), null).problem).toBe('slug_reserved');
    expect(needsAvailabilityCheck(readWebAddress(field({ typed: 'admin' }), null))).toBe(false);
  });

  it('asks once for a changed address that passes the format, and never for an unchanged one', () => {
    expect(needsAvailabilityCheck(readWebAddress(field(), null))).toBe(true);
    expect(needsAvailabilityCheck(readWebAddress(field(), free('hamburger')))).toBe(false);
    expect(needsAvailabilityCheck(readWebAddress(field({ savedSlug: 'hamburger' }), null))).toBe(false);
    expect(needsAvailabilityCheck(readWebAddress(field({ typed: '', savedSlug: 'hamburger' }), null))).toBe(false);
  });
});

describe('webAddressSave', () => {
  const save = (f: WebAddressField, check: WebAddressCheck | null = null) => webAddressSave(f, readWebAddress(f, check));

  it('writes the App name’s address with the rest of the card', () => {
    expect(save(field(), free('hamburger'))).toEqual({ kind: 'write', slug: 'hamburger' });
    // Not answered yet: set_branch_public_slug decides.
    expect(save(field({ appName: 'Burger Bar', savedSlug: 'hamburger' }))).toEqual({ kind: 'write', slug: 'burger-bar' });
  });

  it('keeps the branch’s address when the App name’s cannot be had, and saves the rest', () => {
    expect(save(field(), taken('hamburger'))).toEqual({ kind: 'keep' });
    expect(save(field({ appName: 'Help' }))).toEqual({ kind: 'keep' });
  });

  it('stops the save for a typed address that cannot be had', () => {
    expect(save(field({ typed: 'pizza' }), taken('pizza'))).toEqual({ kind: 'refuse', problem: 'slug_taken' });
    expect(save(field({ typed: 'Phở' }))).toEqual({ kind: 'refuse', problem: 'slug_invalid' });
    expect(save(field({ typed: 'www' }))).toEqual({ kind: 'refuse', problem: 'slug_reserved' });
  });

  it('clears the address when the field is emptied, and writes nothing when unchanged', () => {
    expect(save(field({ typed: ' ', savedSlug: 'hamburger' }))).toEqual({ kind: 'write', slug: null });
    expect(save(field({ savedSlug: 'hamburger' }))).toEqual({ kind: 'keep' });
    expect(save(field({ typed: 'Hamburger', savedSlug: 'hamburger' }))).toEqual({ kind: 'keep' });
    expect(save(field({ appName: 'ร้านข้าวมันไก่' }))).toEqual({ kind: 'keep' });
  });
});

describe('webAddressStatus', () => {
  const status = (f: WebAddressField, check: WebAddressCheck | null = null) =>
    webAddressStatus(f, readWebAddress(f, check));

  it('says what an empty field means', () => {
    expect(status(field({ appName: '' }))).toEqual({ kind: 'none' });
    expect(status(field({ appName: 'ร้านข้าวมันไก่' }))).toEqual({ kind: 'noLatin' });
    expect(status(field({ typed: '', savedSlug: 'hamburger' }))).toEqual({ kind: 'clearing', old: 'hamburger' });
  });

  it('follows the check for a changed address', () => {
    expect(status(field({ savedSlug: 'hamburger' }))).toEqual({ kind: 'current' });
    expect(status(field())).toEqual({ kind: 'checking' });
    expect(status(field(), free('hamburger'))).toEqual({ kind: 'available' });
    expect(status(field(), { slug: 'hamburger', answer: 'failed' })).toEqual({ kind: 'checkFailed' });
  });

  it('tells a suggestion that cannot be had from a typed address that cannot', () => {
    expect(status(field(), taken('hamburger'))).toEqual({ kind: 'suggestionUnavailable' });
    expect(status(field({ typed: 'hamburger-x' }), taken('hamburger-x'))).toEqual({ kind: 'problem', problem: 'slug_taken' });
  });
});
