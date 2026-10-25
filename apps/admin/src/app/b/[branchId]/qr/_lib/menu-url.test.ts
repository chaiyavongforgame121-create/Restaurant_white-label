import { afterEach, describe, expect, it, vi } from 'vitest';
import { branchMenuLink, tableMenuLink } from './menu-url';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('branchMenuLink', () => {
  it('points at the web address when the branch has one', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.favornoms.com/');
    expect(branchMenuLink('brooklyn', 'demo-favornoms', 'hamburger')).toEqual({
      url: 'https://app.favornoms.com/r/hamburger',
      missingSlugs: [],
    });
  });

  it('keeps the long address for a branch without one', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.favornoms.com');
    expect(branchMenuLink('brooklyn', 'demo-favornoms', null)).toEqual({
      url: 'https://app.favornoms.com/r/demo-favornoms/brooklyn',
      missingSlugs: [],
    });
    expect(branchMenuLink('brooklyn', 'demo-favornoms').url).toBe('https://app.favornoms.com/r/demo-favornoms/brooklyn');
  });

  it('names the missing slugs only when there is no web address to fall back on', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.favornoms.com');
    expect(branchMenuLink(null, '', null)).toEqual({ url: null, missingSlugs: ['branch', 'restaurant'] });
    expect(branchMenuLink('brooklyn', null)).toEqual({ url: null, missingSlugs: ['restaurant'] });
    expect(branchMenuLink(null, null, 'hamburger')).toEqual({
      url: 'https://app.favornoms.com/r/hamburger',
      missingSlugs: [],
    });
  });
});

describe('tableMenuLink', () => {
  it('rides the table token on the short address too', () => {
    expect(tableMenuLink('https://app.favornoms.com/r/hamburger', 'a b')).toBe(
      'https://app.favornoms.com/r/hamburger?t=a%20b',
    );
  });
});
