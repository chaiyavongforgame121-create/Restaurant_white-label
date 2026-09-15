import { describe, expect, it } from 'vitest';
import {
  appleTouchIconUrl,
  deriveStorefrontNames,
  isTrustedIconSource,
  manifestIcons,
  parseAppIconVariant,
  urlFingerprint,
} from './app-identity';

const SUPABASE = 'https://abc.supabase.co';
const upload = (name: string) => `${SUPABASE}/storage/v1/object/public/branding/r1/${name}.png`;
const BASE = '/r/coastal-grill/brooklyn';

const FULL_SET = {
  icon192Url: upload('icon-192-aaa'),
  icon512Url: upload('icon-512-aaa'),
  iconMaskable512Url: upload('icon-maskable-512-aaa'),
};
const NO_ICONS = { icon192Url: null, icon512Url: null, iconMaskable512Url: null };

describe('deriveStorefrontNames', () => {
  it('names the installed app after the brand alone, and keeps brand — branch for the tab', () => {
    const names = deriveStorefrontNames({
      brandName: 'Coastal Grill',
      restaurantName: 'Coastal Grill LLC',
      branchName: 'Hamburger',
    });
    expect(names.app).toBe('Coastal Grill');
    expect(names.full).toBe('Coastal Grill — Hamburger');
    expect(names.brand).toBe('Coastal Grill');
    expect(names.branch).toBe('Hamburger');
  });

  it('treats a blank brand as absent and falls back to the restaurant, then the branch', () => {
    expect(deriveStorefrontNames({ brandName: '   ', restaurantName: 'Somtam Zab', branchName: 'Main' }).app).toBe(
      'Somtam Zab',
    );
    expect(deriveStorefrontNames({ brandName: '', restaurantName: '', branchName: 'Main' })).toEqual({
      brand: '',
      branch: 'Main',
      full: 'Main',
      app: 'Main',
    });
  });

  it('trims what the merchant typed', () => {
    expect(deriveStorefrontNames({ brandName: '  Burger Joint ', branchName: ' Downtown ' }).full).toBe(
      'Burger Joint — Downtown',
    );
  });
});

describe('manifestIcons', () => {
  it('lists only the merchant icons, same-origin, when they uploaded a set', () => {
    const icons = manifestIcons(BASE, FULL_SET);
    expect(icons).toHaveLength(3);
    for (const icon of icons) {
      expect(icon.src.startsWith(`${BASE}/app-icon/`)).toBe(true);
      expect(icon.src).not.toContain('supabase');
      expect(icon.type).toBe('image/png');
    }
    // The platform files must not trail the list: Chrome desktop kept the later of two icons
    // with the same size, which is how the orange icon beat the merchant's.
    expect(icons.some((i) => i.src.startsWith('/icon'))).toBe(false);
    expect(icons.map((i) => [i.sizes, i.purpose])).toEqual([
      ['192x192', 'any'],
      ['512x512', 'any'],
      ['512x512', 'maskable'],
    ]);
  });

  it('declares at most one icon per size and purpose', () => {
    const keys = manifestIcons(BASE, FULL_SET).map((i) => `${i.sizes}/${i.purpose}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('changes an icon URL when the upload changes, and not otherwise', () => {
    const a = manifestIcons(BASE, FULL_SET);
    const again = manifestIcons(BASE, { ...FULL_SET });
    const replaced = manifestIcons(BASE, { ...FULL_SET, icon192Url: upload('icon-192-bbb') });
    expect(again).toEqual(a);
    expect(replaced[0]!.src).not.toBe(a[0]!.src);
    expect(replaced[1]!.src).toBe(a[1]!.src);
  });

  it('uses the platform icons when nothing was uploaded', () => {
    expect(manifestIcons(BASE, NO_ICONS).map((i) => i.src)).toEqual([
      '/icon-192.png',
      '/icon-512.png',
      '/icon-maskable-512.png',
    ]);
  });

  it('uses the platform icons when only a maskable exists, so the install button survives', () => {
    const icons = manifestIcons(BASE, { ...NO_ICONS, iconMaskable512Url: upload('m') });
    expect(icons.every((i) => i.src.startsWith('/icon'))).toBe(true);
  });

  it('leaves a missing variant out rather than mixing in a platform icon', () => {
    const icons = manifestIcons(BASE, { ...FULL_SET, iconMaskable512Url: null });
    expect(icons).toHaveLength(2);
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(false);
  });

  it('roots icons at the origin on a merchant domain', () => {
    expect(manifestIcons('', FULL_SET)[0]!.src.startsWith('/app-icon/192?v=')).toBe(true);
  });
});

describe('urlFingerprint', () => {
  it('is stable, short hex', () => {
    expect(urlFingerprint('x')).toBe(urlFingerprint('x'));
    expect(urlFingerprint(upload('a'))).toMatch(/^[0-9a-f]{8}$/);
    expect(urlFingerprint(upload('a'))).not.toBe(urlFingerprint(upload('b')));
  });
});

describe('parseAppIconVariant', () => {
  it('accepts the three variants and nothing else', () => {
    expect(parseAppIconVariant('192')).toBe('192');
    expect(parseAppIconVariant('512')).toBe('512');
    expect(parseAppIconVariant('maskable-512')).toBe('maskable-512');
    expect(parseAppIconVariant('1024')).toBeNull();
    expect(parseAppIconVariant('../192')).toBeNull();
  });
});

describe('appleTouchIconUrl', () => {
  const apple = upload('icon-apple-180-aaa');
  const fallback = upload('icon-192-aaa');

  it('uses the opaque iPhone icon the admin saved', () => {
    expect(appleTouchIconUrl(apple, fallback, SUPABASE)).toBe(apple);
  });

  it('falls back to the 192 for brands that have none, or an untrusted one', () => {
    expect(appleTouchIconUrl(null, fallback, SUPABASE)).toBe(fallback);
    expect(appleTouchIconUrl(undefined, fallback, SUPABASE)).toBe(fallback);
    expect(appleTouchIconUrl('https://evil.example/a.png', fallback, SUPABASE)).toBe(fallback);
    expect(appleTouchIconUrl(apple, fallback, undefined)).toBe(fallback);
    expect(appleTouchIconUrl(null, null, SUPABASE)).toBeNull();
  });
});

describe('isTrustedIconSource', () => {
  it('accepts files in the project branding bucket', () => {
    expect(isTrustedIconSource(upload('icon-192-aaa'), SUPABASE)).toBe(true);
  });

  it('refuses other hosts, other buckets, traversal out of the bucket and junk', () => {
    expect(isTrustedIconSource('https://evil.example/storage/v1/object/public/branding/x.png', SUPABASE)).toBe(false);
    expect(isTrustedIconSource(`${SUPABASE}/storage/v1/object/public/menu/x.png`, SUPABASE)).toBe(false);
    expect(isTrustedIconSource(`${SUPABASE}/storage/v1/object/public/branding/../private/x.png`, SUPABASE)).toBe(false);
    expect(isTrustedIconSource('http://169.254.169.254/latest/meta-data', SUPABASE)).toBe(false);
    expect(isTrustedIconSource('not a url', SUPABASE)).toBe(false);
    expect(isTrustedIconSource(upload('a'), undefined)).toBe(false);
  });
});
