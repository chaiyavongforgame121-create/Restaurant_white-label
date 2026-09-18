import { describe, expect, it } from 'vitest';
import { countryForTimezone, readCounterPhone } from './counter-phone';

const us = countryForTimezone('America/Chicago');
const th = countryForTimezone('Asia/Bangkok');

describe('countryForTimezone', () => {
  it('reads the country a branch dials from off its timezone, US by default', () => {
    expect(us.iso).toBe('US');
    expect(th.iso).toBe('TH');
    expect(countryForTimezone(null).iso).toBe('US');
    expect(countryForTimezone('Mars/Olympus').iso).toBe('US');
  });
});

describe('readCounterPhone', () => {
  it('is empty when nothing was typed', () => {
    expect(readCounterPhone('  ', us)).toEqual({ state: 'empty', e164: null });
  });

  it("reads a local number against the branch's country", () => {
    expect(readCounterPhone('(555) 123-4567', us)).toEqual({ state: 'valid', e164: '+15551234567' });
    expect(readCounterPhone('081 234 5678', th)).toEqual({ state: 'valid', e164: '+66812345678' });
  });

  it('takes a number typed with its own country code as it stands', () => {
    expect(readCounterPhone('+44 20 7946 0958', us)).toEqual({ state: 'valid', e164: '+442079460958' });
  });

  it('refuses a number too short to be anybody', () => {
    expect(readCounterPhone('555 12', us).state).toBe('invalid');
  });

  it("refuses the walk-in placeholder, whoever types it", () => {
    expect(readCounterPhone('+10000000000', us).state).toBe('invalid');
    expect(readCounterPhone('0000000000', us).state).toBe('invalid');
  });

  it('only calls valid what place-order will accept as E.164', () => {
    // place-order: /^\+[1-9][0-9]{6,14}$/
    const E164 = /^\+[1-9][0-9]{6,14}$/;
    for (const raw of ['(555) 123-4567', '081 234 5678', '+44 20 7946 0958', '+0 123 456 789', '+999 1234 5678 9012 34']) {
      const p = readCounterPhone(raw, raw.startsWith('08') ? th : us);
      if (p.state === 'valid') expect(p.e164, raw).toMatch(E164);
    }
    expect(readCounterPhone('+0 123 456 789', us).state).toBe('invalid');
  });
});
