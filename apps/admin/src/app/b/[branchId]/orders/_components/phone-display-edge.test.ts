import { describe, expect, it } from 'vitest';
import { COUNTRY_DIALS, formatPhone, toE164 } from '@favornoms/shared';
import * as edge from '../../../../../../../../supabase/functions/_shared/phone-display';

/**
 * issue-tax-invoice prints the seller's phone on the receipt it renders, through a hand mirror of
 * formatPhone: a Deno function cannot import packages/shared, but a module with no imports can be
 * run from here. supabase/functions/_shared/phone-display.ts imports nothing for exactly this
 * reason.
 *
 * What is at stake: the owner asked for every number the product shows to read
 * "+1 (xxx) xxx-xxxx". A mirror that drifted would print a number on the receipt one way and on
 * the order screen another. These fail as soon as either copy changes without the other.
 */

describe('the dial table', () => {
  it('holds every dial code COUNTRY_DIALS offers, once', () => {
    const shared = [...new Set(COUNTRY_DIALS.map((c) => c.dial.slice(1)))].sort();
    expect([...edge.DIAL_CODES].sort()).toEqual(shared);
    expect(new Set(edge.DIAL_CODES).size).toBe(edge.DIAL_CODES.length);
  });

  it('knows the same national shapes COUNTRY_DIALS does', () => {
    const shared: Record<string, number[][]> = {};
    for (const c of COUNTRY_DIALS) {
      if (!c.displayGroups) continue;
      (shared[c.dial.slice(1)] ??= []).push(c.displayGroups);
    }
    expect(edge.DISPLAY_GROUPS).toEqual(shared);
  });
});

describe('formatPhone mirror', () => {
  it('reads the way the owner asked', () => {
    expect(edge.formatPhone('+15552345678')).toBe('+1 (555) 234-5678');
    // A +66 number cannot honestly be shown as +1; it gets Thailand's own grouping.
    expect(edge.formatPhone('+66980358264')).toBe('+66 98 035 8264');
    // The till's walk-in stand-in is nobody's number.
    expect(edge.formatPhone('+10000000000')).toBe('');
  });

  it('answers exactly as packages/shared does, for every country the picker offers', () => {
    const digits = '98765432109876543';
    const corpus = new Set<string>([
      '',
      '   ',
      '+',
      'not a number',
      '+999',
      '12345',
      '555-0100',
      '5552345678',
      '15552345678',
      '(555) 234-5678',
      '+1 (555) 234-5678',
      '+66 98 035 8264',
      '+10000000000',
      '+10005551234',
      '+18765551234',
      '0812345678',
      ' +66980358264 ',
    ]);
    for (const c of COUNTRY_DIALS) {
      const dial = c.dial.slice(1);
      const lengths = new Set([
        ...c.nsnLengths,
        Math.min(...c.nsnLengths) - 1,
        Math.max(...c.nsnLengths) + 1,
        3,
        4,
        5,
      ]);
      for (const n of lengths) {
        const nsn = digits.slice(0, n);
        corpus.add(`+${dial}${nsn}`);
        corpus.add(`+${dial} ${nsn}`);
        corpus.add(`+${dial}${'0'.repeat(n)}`);
        corpus.add(`${dial}${nsn}`);
        corpus.add(`${c.trunk ?? ''}${nsn}`);
      }
      corpus.add(c.placeholder);
      corpus.add(toE164(c.placeholder, c));
    }
    const drift = [...corpus]
      .map((input) => ({ input, shared: formatPhone(input), edge: edge.formatPhone(input) }))
      .filter((r) => r.shared !== r.edge);
    expect(drift).toEqual([]);
  });

  it('is empty for no number at all', () => {
    expect(edge.formatPhone(null)).toBe('');
    expect(edge.formatPhone(undefined)).toBe('');
  });
});
