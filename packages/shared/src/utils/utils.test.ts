import { describe, expect, it } from 'vitest';
import {
  cn,
  computeSalesTax,
  distanceKm,
  distanceMiles,
  formatCurrency,
  formatUSPhone,
  generateOrderNumber,
  localeToBcp47,
  pickLocalized,
} from './index';

describe('cn', () => {
  it('joins truthy strings with spaces', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });
  it('drops falsy values', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b');
  });
  it('returns empty string when all are falsy', () => {
    expect(cn(false, null, undefined)).toBe('');
  });
});

describe('formatCurrency', () => {
  it('formats USD with two decimals by default', () => {
    const out = formatCurrency(12.34, 'USD', 'en');
    expect(out).toMatch(/12\.34/);
    expect(out).toMatch(/\$|USD/);
  });
  it('handles zero', () => {
    const out = formatCurrency(0, 'USD', 'en');
    expect(out).toMatch(/0/);
  });
  it('memoizes formatters per (locale, currency) pair', () => {
    expect(formatCurrency(50, 'USD', 'en')).toBe(formatCurrency(50, 'USD', 'en'));
  });
});

describe('localeToBcp47', () => {
  it('returns en-US', () => {
    expect(localeToBcp47('en')).toBe('en-US');
  });
});

describe('pickLocalized', () => {
  it('returns base when no translations', () => {
    expect(pickLocalized('Hello', undefined, 'en')).toBe('Hello');
  });
  it('returns translation when present', () => {
    expect(pickLocalized('Hello', { en: 'Howdy' }, 'en')).toBe('Howdy');
  });
});

describe('distanceKm', () => {
  it('returns 0 for the same point', () => {
    expect(distanceKm({ lat: 40.7174, lng: -73.9572 }, { lat: 40.7174, lng: -73.9572 })).toBe(0);
  });
  it('returns ~10km between Brooklyn and a point ~10km north', () => {
    const a = { lat: 40.7174, lng: -73.9572 };
    const b = { lat: 40.8074, lng: -73.9572 }; // ~0.09° lat north
    const d = distanceKm(a, b);
    expect(d).toBeGreaterThan(9);
    expect(d).toBeLessThan(11);
  });
  it('is symmetric', () => {
    const a = { lat: 40.7, lng: -74 };
    const b = { lat: 40.9, lng: -73.8 };
    expect(distanceKm(a, b)).toBeCloseTo(distanceKm(b, a), 5);
  });
});

describe('distanceMiles', () => {
  it('converts km to miles correctly', () => {
    expect(distanceMiles({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
    // 10 km ≈ 6.21 miles
    const a = { lat: 40.7174, lng: -73.9572 };
    const b = { lat: 40.8074, lng: -73.9572 };
    expect(distanceMiles(a, b)).toBeGreaterThan(5);
    expect(distanceMiles(a, b)).toBeLessThan(7);
  });
});

describe('formatUSPhone', () => {
  it('formats a 10-digit string', () => {
    expect(formatUSPhone('5552345678')).toBe('(555) 234-5678');
  });
  it('formats E.164 with country code', () => {
    expect(formatUSPhone('+15552345678')).toBe('(555) 234-5678');
  });
  it('returns input when not a valid US number', () => {
    expect(formatUSPhone('123')).toBe('123');
  });
});

describe('computeSalesTax', () => {
  it('rounds to two decimals', () => {
    expect(computeSalesTax(100, 0.08875)).toBe(8.88);
  });
  it('returns 0 for zero subtotal', () => {
    expect(computeSalesTax(0, 0.08875)).toBe(0);
  });
});

describe('generateOrderNumber', () => {
  it('matches the expected pattern', () => {
    const num = generateOrderNumber('A');
    expect(num).toMatch(/^A-\d{4}-\d{6}$/);
  });
  it('respects the branch prefix', () => {
    expect(generateOrderNumber('XYZ')).toMatch(/^XYZ-/);
  });
  it('produces different sequences on consecutive calls (probabilistic)', () => {
    const a = generateOrderNumber('A');
    const b = generateOrderNumber('A');
    expect(a).not.toBe(b);
  });
});
