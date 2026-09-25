import { describe, expect, it } from 'vitest';
import {
  COUNTRY_DIALS,
  countryForIso,
  DEFAULT_COUNTRY_ISO,
  formatPhone,
  toE164,
  type CountryDial,
} from './phone';

/**
 * The implementation this replaced, transcribed exactly from
 * apps/web/.../sign-in/_components/sign-in-view.tsx before the country list was shared.
 *
 * It is the oracle, not a reference: a customer's login is a synthetic email derived from
 * these digits, so a US or TH number that normalises differently is a DIFFERENT ACCOUNT and
 * the owner is locked out of their own. Every case below is checked against it.
 */
const legacyNormalize = (raw: string, dial: '+1' | '+66'): string => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) return `+${trimmed.replace(/\D/g, '')}`;
  let digits = trimmed.replace(/\D/g, '');
  const cc = dial.slice(1);
  if (digits.length > 10 && digits.startsWith(cc)) digits = digits.slice(cc.length);
  if (dial === '+66' && digits.length === 10 && digits.startsWith('0')) digits = digits.slice(1);
  return `${dial}${digits}`;
};

const us = countryForIso('US');
const th = countryForIso('TH');

describe('toE164 is byte-compatible with the sign-in form it replaced', () => {
  const US_INPUTS = [
    '5552345678',
    '(555) 234-5678',
    '555-234-5678',
    '555 234 5678',
    '15552345678',
    '1 (555) 234-5678',
    '+15552345678',
    '+1 555 234 5678',
    '  5552345678  ',
  ];

  it.each(US_INPUTS)('US %s', (input) => {
    expect(toE164(input, us)).toBe(legacyNormalize(input, '+1'));
  });

  const TH_INPUTS = [
    '0812345678',
    '081 234 5678',
    '081-234-5678',
    '812345678',
    '+66812345678',
    '+66 81 234 5678',
    '  0812345678  ',
  ];

  it.each(TH_INPUTS)('TH %s', (input) => {
    expect(toE164(input, th)).toBe(legacyNormalize(input, '+66'));
  });

  it('produces the numbers those inputs are supposed to produce', () => {
    expect(toE164('(555) 234-5678', us)).toBe('+15552345678');
    expect(toE164('0812345678', th)).toBe('+66812345678');
  });
});

describe('toE164', () => {
  it('takes a pasted international number verbatim, ignoring the picker', () => {
    expect(toE164('+44 7400 123456', countryForIso('US'))).toBe('+447400123456');
    expect(toE164('+66812345678', countryForIso('GB'))).toBe('+66812345678');
  });

  it('treats 00 and 011 as a plus', () => {
    expect(toE164('0066812345678', us)).toBe('+66812345678');
    expect(toE164('011 66 81 234 5678', us)).toBe('+66812345678');
  });

  it('strips a trunk 0 where the country has one', () => {
    expect(toE164('07400123456', countryForIso('GB'))).toBe('+447400123456');
    expect(toE164('0612345678', countryForIso('FR'))).toBe('+33612345678');
  });

  it('strips a trunk 8 for Russia rather than mistaking it for a country code', () => {
    // +7 is the country code AND 8 is the trunk, which is what breaks a naive implementation.
    expect(toE164('89161234567', countryForIso('RU'))).toBe('+79161234567');
    expect(toE164('79161234567', countryForIso('RU'))).toBe('+79161234567');
    expect(toE164('9161234567', countryForIso('RU'))).toBe('+79161234567');
  });

  it('keeps an Italian leading zero, because it is part of the number', () => {
    // +39 06 … is a real Rome landline. Stripping the zero the way Thailand needs would make
    // it unreachable.
    expect(toE164('06 1234 5678', countryForIso('IT'))).toBe('+390612345678');
    expect(toE164('3123456789', countryForIso('IT'))).toBe('+393123456789');
  });

  it('does not strip a leading zero in a country with no trunk prefix', () => {
    // Singapore numbers never start with 0, but if one is typed the digit must survive so the
    // number fails visibly rather than becoming somebody else's.
    expect(toE164('81234567', countryForIso('SG'))).toBe('+6581234567');
  });

  it('leaves an implausible length alone instead of guessing', () => {
    expect(toE164('123', us)).toBe('+1123');
    expect(toE164('0', th)).toBe('+660');
  });

  it('returns the bare dial code for empty input', () => {
    expect(toE164('', us)).toBe('+1');
    expect(toE164('   ', th)).toBe('+66');
  });

  it('ignores letters and punctuation', () => {
    expect(toE164('(555) CALL-NOW', us)).toBe('+1555');
  });
});

describe('COUNTRY_DIALS', () => {
  it('leads with the two countries the product already sells into', () => {
    expect(COUNTRY_DIALS[0]?.iso).toBe('US');
    expect(COUNTRY_DIALS[1]?.iso).toBe('TH');
  });

  it('offers materially more than the two it used to', () => {
    expect(COUNTRY_DIALS.length).toBeGreaterThan(30);
  });

  it('has a unique ISO code per entry', () => {
    const isos = COUNTRY_DIALS.map((c) => c.iso);
    expect(new Set(isos).size).toBe(isos.length);
  });

  it('keys on ISO rather than dial, because dial codes are shared', () => {
    const byDial = (dial: string) => COUNTRY_DIALS.filter((c) => c.dial === dial).map((c) => c.iso);
    expect(byDial('+1')).toEqual(['US', 'CA']);
    expect(byDial('+7').sort()).toEqual(['KZ', 'RU']);
  });

  it('gives every entry a usable placeholder and at least one valid length', () => {
    for (const c of COUNTRY_DIALS) {
      expect(c.dial.startsWith('+')).toBe(true);
      expect(c.placeholder.length).toBeGreaterThan(3);
      expect(c.nsnLengths.length).toBeGreaterThan(0);
      expect(c.nsnLengths.every((n) => n >= 6 && n <= 13)).toBe(true);
    }
  });

  it('never gives a +1 country a trunk prefix', () => {
    for (const c of COUNTRY_DIALS.filter((x) => x.dial === '+1')) {
      expect(c.trunk).toBeNull();
    }
  });

  it('uses 8, not 0, for the +7 countries', () => {
    for (const c of COUNTRY_DIALS.filter((x) => x.dial === '+7')) {
      expect(c.trunk).toBe('8');
    }
  });

  it('round-trips its own placeholder back to a number starting with its dial code', () => {
    for (const c of COUNTRY_DIALS) {
      expect(toE164(c.placeholder, c).startsWith(c.dial)).toBe(true);
    }
  });
});

describe('countryForIso', () => {
  it('finds a country', () => {
    expect(countryForIso('TH').dial).toBe('+66');
    expect(countryForIso('th').dial).toBe('+66');
    expect(countryForIso(' gb ').dial).toBe('+44');
  });

  it('falls back to the default rather than throwing', () => {
    expect(countryForIso(null).iso).toBe(DEFAULT_COUNTRY_ISO);
    expect(countryForIso(undefined).iso).toBe(DEFAULT_COUNTRY_ISO);
    expect(countryForIso('XX').iso).toBe(DEFAULT_COUNTRY_ISO);
    expect(countryForIso('').iso).toBe(DEFAULT_COUNTRY_ISO);
  });
});

describe('formatPhone', () => {
  it('never shows a ten-digit number from another country as an American one', () => {
    // Singapore, Denmark and Norway have eight-digit national numbers, so their E.164 is ten
    // digits — the NANP branch used to take them.
    expect(formatPhone('+6581234567')).not.toMatch(/^\+1 /);
    expect(formatPhone('+4532123456')).not.toMatch(/^\+1 /);
    expect(formatPhone('+4740612345')).not.toMatch(/^\+1 /);
    expect(formatPhone('+6581234567').startsWith('+65')).toBe(true);
  });

  it('formats a bare ten-digit number as +1 only when it looks North American', () => {
    expect(formatPhone('6266386401')).toBe('+1 (626) 638-6401');
    expect(formatPhone('(626) 638-6401')).toBe('+1 (626) 638-6401');
    // A Thai mobile typed without its country code: left as typed, not turned into +1 (081).
    expect(formatPhone('0812345678')).toBe('0812345678');
  });

  it("keeps the owner's format for every US number and the grouping for a Thai one", () => {
    expect(formatPhone('+16266386401')).toBe('+1 (626) 638-6401');
    expect(formatPhone('+66980358264')).toBe('+66 98 035 8264');
  });

  it('is the format the owner asked for', () => {
    expect(formatPhone('+15552345678')).toBe('+1 (555) 234-5678');
  });

  it('formats a bare ten-digit US number the same way', () => {
    expect(formatPhone('5552345678')).toBe('+1 (555) 234-5678');
  });

  it('groups other countries readably', () => {
    // Thailand is written 081 234 5678, so its stored form reads back the same way.
    expect(formatPhone('+66812345678')).toBe('+66 81 234 5678');
    expect(formatPhone('+447400123456')).toBe('+44 7 400 123 456');
  });

  it('does not let +1 claim a Jamaican +1876 number', () => {
    // Both are NANP: 1876 is the area code, so this is a normal 11-digit +1 number.
    expect(formatPhone('+18765551234')).toBe('+1 (876) 555-1234');
  });

  it('returns anything it cannot parse untouched', () => {
    expect(formatPhone('not a number')).toBe('not a number');
    expect(formatPhone('+999')).toBe('+999');
    expect(formatPhone('12345')).toBe('12345');
  });

  it('refuses the till’s walk-in placeholder rather than dressing it up as a real number', () => {
    expect(formatPhone('+10000000000')).toBe('');
    // A real number that merely starts with zeros after the code is untouched.
    expect(formatPhone('+10005551234')).toBe('+1 (000) 555-1234');
  });

  it('is empty for empty input', () => {
    expect(formatPhone('')).toBe('');
    expect(formatPhone(null)).toBe('');
    expect(formatPhone(undefined)).toBe('');
  });

  it('never emits a string safe to put in a tel: href', () => {
    // Documents the contract rather than testing behaviour: the formatted value contains
    // characters a dialler must not receive, which is why call sites keep the raw number.
    expect(formatPhone('+15552345678')).toMatch(/[()\s-]/);
  });
});

describe('a country list entry is enough to drive a form', () => {
  const sample: CountryDial | undefined = COUNTRY_DIALS.find((c) => c.iso === 'GB');
  it('exposes what a picker needs', () => {
    expect(sample).toBeDefined();
    expect(sample?.label).toContain('+44');
    expect(sample?.trunk).toBe('0');
  });
});
