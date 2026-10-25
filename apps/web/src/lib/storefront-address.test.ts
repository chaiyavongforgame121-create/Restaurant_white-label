import { describe, expect, it } from 'vitest';
import { isUnderBase, parsePublicBase } from './storefront-address';

describe('isUnderBase', () => {
  it('holds for the base itself and every page under it, in either form', () => {
    expect(isUnderBase('/r/hamburger', '/r/hamburger')).toBe(true);
    expect(isUnderBase('/r/hamburger/cart', '/r/hamburger')).toBe(true);
    expect(isUnderBase('/r/hamburger/orders/A-12/receipt', '/r/hamburger')).toBe(true);
    expect(isUnderBase('/r/demo-favornoms/brooklyn/checkout', '/r/demo-favornoms/brooklyn')).toBe(true);
  });

  it('does not hold for an address that only starts with the same letters', () => {
    expect(isUnderBase('/r/hamburger-house', '/r/hamburger')).toBe(false);
    expect(isUnderBase('/r/demo-favornoms/brooklyn-north/cart', '/r/demo-favornoms/brooklyn')).toBe(false);
  });

  it('does not hold between the two forms of one storefront', () => {
    expect(isUnderBase('/r/demo-favornoms/brooklyn/cart', '/r/hamburger')).toBe(false);
    expect(isUnderBase('/r/hamburger/cart', '/r/demo-favornoms/brooklyn')).toBe(false);
  });

  it('never holds for an empty base', () => {
    expect(isUnderBase('/r/hamburger', '')).toBe(false);
    expect(isUnderBase('', '')).toBe(false);
  });
});

describe('parsePublicBase', () => {
  it('accepts a short or a long base', () => {
    expect(parsePublicBase('/r/hamburger')).toBe('/r/hamburger');
    expect(parsePublicBase('/r/demo-favornoms/brooklyn')).toBe('/r/demo-favornoms/brooklyn');
  });

  it('ignores anything that is not a storefront base', () => {
    for (const value of [
      null,
      undefined,
      '',
      '/r',
      '/r/',
      '/r/Hamburger',
      '/r/hamburger/',
      '/r/a/b/c',
      '/x/hamburger',
      'r/hamburger',
      'https://evil.example/r/hamburger',
      '/r/ham--burger',
      `/r/${'a'.repeat(65)}`,
    ]) {
      expect(parsePublicBase(value)).toBeNull();
    }
  });
});
