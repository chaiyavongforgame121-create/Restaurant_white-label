import { describe, expect, it } from 'vitest';
import {
  RESERVED_PUBLIC_SLUGS,
  movedStorefrontPath,
  normalizePublicSlug,
  parseStorefrontPathResolution,
  publicBase,
  publicSlugFormatError,
  shortStorefrontRewrite,
  storefrontBase,
  storefrontPathHead,
  storefrontPathSlugs,
  suggestPublicSlug,
  type StorefrontPathResolution,
} from './storefront-path';

/** A redirect to the long form of restaurantSlug/branchSlug, covering a long-form pair. */
const moved = (restaurantSlug: string, branchSlug: string): StorefrontPathResolution => ({
  status: 'redirect',
  restaurantSlug,
  branchSlug,
  publicSlug: null,
  publicBase: `/r/${restaurantSlug}/${branchSlug}`,
  segments: 2,
});

/** The live showcase branch once it has its web address. */
const HAMBURGER = { restaurantSlug: 'demo-favornoms', branchSlug: 'brooklyn', publicSlug: 'hamburger', publicBase: '/r/hamburger' };
const toShort = (segments: 1 | 2): StorefrontPathResolution => ({ status: 'redirect', ...HAMBURGER, segments });
const short: StorefrontPathResolution = { status: 'short', ...HAMBURGER, segments: 1 };

describe('storefrontPathSlugs', () => {
  it('reads the two slugs at the head of a storefront path, with or without more after them', () => {
    expect(storefrontPathSlugs('/r/coastal-grill/brooklyn')).toEqual({ first: 'coastal-grill', second: 'brooklyn' });
    expect(storefrontPathSlugs('/r/coastal-grill/brooklyn/orders/A-1')).toEqual({ first: 'coastal-grill', second: 'brooklyn' });
    expect(storefrontPathSlugs('/r/coastal-grill/brooklyn?t=abc')).toEqual({ first: 'coastal-grill', second: 'brooklyn' });
    expect(storefrontPathSlugs('/r/Coastal-Grill/Brooklyn')).toEqual({ first: 'Coastal-Grill', second: 'Brooklyn' });
  });

  it('is null for anything that is not one, so no lookup is spent on it', () => {
    expect(storefrontPathSlugs('/')).toBeNull();
    expect(storefrontPathSlugs('/r/demo-favornoms')).toBeNull();
    expect(storefrontPathSlugs('/r/demo-favornoms/')).toBeNull();
    expect(storefrontPathSlugs('/auth/callback')).toBeNull();
    expect(storefrontPathSlugs('/rx/a/b')).toBeNull();
    expect(storefrontPathSlugs('/r/a%20b/c')).toBeNull();
    expect(storefrontPathSlugs('/r/a.b/c')).toBeNull();
    expect(storefrontPathSlugs(`/r/${'a'.repeat(65)}/c`)).toBeNull();
  });
});

describe('storefrontPathHead', () => {
  it('reads a web address alone, with a page after it, or a long-form pair', () => {
    expect(storefrontPathHead('/r/hamburger')).toEqual({ first: 'hamburger', second: null });
    expect(storefrontPathHead('/r/hamburger/')).toEqual({ first: 'hamburger', second: null });
    expect(storefrontPathHead('/r/hamburger?t=abc')).toEqual({ first: 'hamburger', second: null });
    expect(storefrontPathHead('/r/hamburger/cart')).toEqual({ first: 'hamburger', second: 'cart' });
    expect(storefrontPathHead('/r/hamburger/orders/A-12?x=1')).toEqual({ first: 'hamburger', second: 'orders' });
    expect(storefrontPathHead('/r/demo-favornoms/brooklyn/cart')).toEqual({ first: 'demo-favornoms', second: 'brooklyn' });
    expect(storefrontPathHead('/r/Hamburger/Cart')).toEqual({ first: 'Hamburger', second: 'Cart' });
  });

  it('drops a second segment that could not be a slug (only a short address can use one)', () => {
    expect(storefrontPathHead('/r/hamburger/manifest.webmanifest')).toEqual({ first: 'hamburger', second: null });
    expect(storefrontPathHead('/r/hamburger/a%20b')).toEqual({ first: 'hamburger', second: null });
  });

  it('is null when the path is not under /r/ or the first segment could not be a slug', () => {
    expect(storefrontPathHead('/')).toBeNull();
    expect(storefrontPathHead('/r')).toBeNull();
    expect(storefrontPathHead('/r/')).toBeNull();
    expect(storefrontPathHead('/rx/a')).toBeNull();
    expect(storefrontPathHead('/sw.js')).toBeNull();
    expect(storefrontPathHead('/r/a.b')).toBeNull();
    expect(storefrontPathHead(`/r/${'a'.repeat(65)}`)).toBeNull();
  });
});

describe('publicBase / storefrontBase', () => {
  it('is the short form when the branch has a web address, the long form otherwise', () => {
    expect(publicBase('demo-favornoms', 'brooklyn', 'hamburger')).toBe('/r/hamburger');
    expect(publicBase('demo-favornoms', 'brooklyn', null)).toBe('/r/demo-favornoms/brooklyn');
    expect(publicBase('demo-favornoms', 'brooklyn')).toBe('/r/demo-favornoms/brooklyn');
    expect(publicBase('demo-favornoms', 'brooklyn', '')).toBe('/r/demo-favornoms/brooklyn');
  });

  it('reads a tenant, including one cached before it carried a web address', () => {
    const tenant = { restaurant: { slug: 'demo-favornoms' }, branch: { slug: 'brooklyn' } };
    expect(storefrontBase({ ...tenant, publicSlug: 'hamburger' })).toBe('/r/hamburger');
    expect(storefrontBase({ ...tenant, publicSlug: null })).toBe('/r/demo-favornoms/brooklyn');
    expect(storefrontBase(tenant)).toBe('/r/demo-favornoms/brooklyn');
  });
});

describe('parseStorefrontPathResolution', () => {
  it('reads the first row PostgREST returns, or a single object', () => {
    expect(
      parseStorefrontPathResolution([
        { status: 'short', restaurant_slug: 'demo-favornoms', branch_slug: 'brooklyn', public_slug: 'hamburger', public_base: '/r/hamburger', segments: 1 },
      ]),
    ).toEqual(short);
    expect(
      parseStorefrontPathResolution({
        status: 'redirect',
        restaurant_slug: 'demo-favornoms',
        branch_slug: 'brooklyn',
        public_slug: 'hamburger',
        public_base: '/r/hamburger',
        segments: 2,
      }),
    ).toEqual(toShort(2));
    expect(
      parseStorefrontPathResolution([
        { status: 'live', restaurant_slug: 'sample', branch_slug: 'main', public_slug: null, public_base: '/r/sample/main', segments: 2 },
      ]),
    ).toEqual({ status: 'live', restaurantSlug: 'sample', branchSlug: 'main', publicSlug: null, publicBase: '/r/sample/main', segments: 2 });
    expect(parseStorefrontPathResolution({ status: 'none', restaurant_slug: null, branch_slug: null }))
      .toEqual({ status: 'none', restaurantSlug: null, branchSlug: null, publicSlug: null, publicBase: null, segments: 0 });
  });

  it('reads a row from before the web address (three columns) as the long form it was', () => {
    expect(parseStorefrontPathResolution([{ status: 'redirect', restaurant_slug: 'demo-favornoms', branch_slug: 'brooklyn' }]))
      .toEqual(moved('demo-favornoms', 'brooklyn'));
    expect(parseStorefrontPathResolution([{ status: 'live', restaurant_slug: 'demo-favornoms', branch_slug: 'brooklyn' }]))
      .toMatchObject({ status: 'live', publicBase: '/r/demo-favornoms/brooklyn', segments: 2 });
  });

  it('builds the public base from the slugs, never from a path on the wire', () => {
    const parsed = parseStorefrontPathResolution([
      { status: 'redirect', restaurant_slug: 'a', branch_slug: 'b', public_slug: null, public_base: '//evil.example', segments: 1 },
    ]);
    expect(parsed?.publicBase).toBe('/r/a/b');
  });

  it('is null for anything else, so a caller never redirects or rewrites on it', () => {
    expect(parseStorefrontPathResolution([])).toBeNull();
    expect(parseStorefrontPathResolution(null)).toBeNull();
    expect(parseStorefrontPathResolution('redirect')).toBeNull();
    expect(parseStorefrontPathResolution([{ status: 'moved', restaurant_slug: 'a', branch_slug: 'b' }])).toBeNull();
    // A slug that is not one (a path, upper case, a host) is not followed anywhere.
    expect(parseStorefrontPathResolution([{ status: 'redirect', restaurant_slug: null, branch_slug: 'b' }])).toBeNull();
    expect(parseStorefrontPathResolution([{ status: 'redirect', restaurant_slug: '../x', branch_slug: 'b' }])).toBeNull();
    expect(parseStorefrontPathResolution([{ status: 'redirect', restaurant_slug: 'A', branch_slug: 'b' }])).toBeNull();
    // A short answer needs its web address.
    expect(parseStorefrontPathResolution([{ status: 'short', restaurant_slug: 'a', branch_slug: 'b', public_slug: null }])).toBeNull();
    expect(
      parseStorefrontPathResolution([{ status: 'redirect', restaurant_slug: 'a', branch_slug: 'b', public_slug: 'evil.example/x' }]),
    ).toMatchObject({ publicSlug: null, publicBase: '/r/a/b' });
  });
});

describe('movedStorefrontPath', () => {
  it('sends an old address to the new one, keeping the rest of the path and the whole query string', () => {
    expect(movedStorefrontPath('/r/coastal-grill/brooklyn', moved('demo-favornoms', 'brooklyn')))
      .toBe('/r/demo-favornoms/brooklyn');
    expect(movedStorefrontPath('/r/coastal-grill/brooklyn?t=abc', moved('demo-favornoms', 'brooklyn')))
      .toBe('/r/demo-favornoms/brooklyn?t=abc');
    expect(
      movedStorefrontPath(
        '/r/coastal-grill/brooklyn/orders/A-12?payment_intent=pi_1&redirect_status=succeeded',
        moved('demo-favornoms', 'brooklyn'),
      ),
    ).toBe('/r/demo-favornoms/brooklyn/orders/A-12?payment_intent=pi_1&redirect_status=succeeded');
    expect(movedStorefrontPath('/r/demo-favornoms/old-name/manifest.webmanifest', moved('demo-favornoms', 'hamburger')))
      .toBe('/r/demo-favornoms/hamburger/manifest.webmanifest');
  });

  it('sends the long form of a branch with a web address to the short form (spec §2)', () => {
    expect(movedStorefrontPath('/r/demo-favornoms/brooklyn/cart?t=abc', toShort(2))).toBe('/r/hamburger/cart?t=abc');
    expect(movedStorefrontPath('/r/demo-favornoms/brooklyn', toShort(2))).toBe('/r/hamburger');
    expect(movedStorefrontPath('/r/demo-favornoms/brooklyn/', toShort(2))).toBe('/r/hamburger/');
    // An old restaurant slug and an old branch slug land on the short form too.
    expect(movedStorefrontPath('/r/coastal-grill/brooklyn/orders/A-1?payment_intent=pi_1', toShort(2)))
      .toBe('/r/hamburger/orders/A-1?payment_intent=pi_1');
  });

  it('sends an old web address (one segment) to the current one, or to the long form', () => {
    expect(movedStorefrontPath('/r/old-burger/cart?t=1#top', toShort(1))).toBe('/r/hamburger/cart?t=1#top');
    expect(movedStorefrontPath('/r/old-burger', toShort(1))).toBe('/r/hamburger');
    expect(movedStorefrontPath('/r/old-burger?t=1', toShort(1))).toBe('/r/hamburger?t=1');
    expect(
      movedStorefrontPath('/r/old-burger/checkout', { ...moved('demo-favornoms', 'brooklyn'), segments: 1 }),
    ).toBe('/r/demo-favornoms/brooklyn/checkout');
  });

  it('sends other letter case to the address as it is spelled', () => {
    expect(movedStorefrontPath('/r/Demo-FavorNoms/Brooklyn/cart', moved('demo-favornoms', 'brooklyn')))
      .toBe('/r/demo-favornoms/brooklyn/cart');
    expect(movedStorefrontPath('/r/HAMBURGER/cart', toShort(1))).toBe('/r/hamburger/cart');
  });

  it('does nothing for a live or short pair, an unknown one, a non-storefront path, or a redirect to itself', () => {
    expect(movedStorefrontPath('/r/demo-favornoms/brooklyn', { ...moved('demo-favornoms', 'brooklyn'), status: 'live' })).toBeNull();
    expect(movedStorefrontPath('/r/hamburger/cart', short)).toBeNull();
    expect(movedStorefrontPath('/r/nobody/here', parseStorefrontPathResolution({ status: 'none' }))).toBeNull();
    expect(movedStorefrontPath('/r/coastal-grill/brooklyn', null)).toBeNull();
    expect(movedStorefrontPath('/checkout', moved('demo-favornoms', 'brooklyn'))).toBeNull();
    expect(movedStorefrontPath('/r/demo-favornoms/brooklyn?t=1', moved('demo-favornoms', 'brooklyn'))).toBeNull();
    expect(movedStorefrontPath('/r/hamburger/cart', toShort(1))).toBeNull();
    // Two segments asked of a one-segment path: not this answer's path.
    expect(movedStorefrontPath('/r/coastal-grill', moved('demo-favornoms', 'brooklyn'))).toBeNull();
    expect(movedStorefrontPath('/r/coastal-grill/brooklyn', { ...moved('demo-favornoms', 'brooklyn'), publicBase: null })).toBeNull();
  });
});

describe('shortStorefrontRewrite', () => {
  it('serves a short address from its long form, keeping the page and the whole query string', () => {
    expect(shortStorefrontRewrite('/r/hamburger', short)).toBe('/r/demo-favornoms/brooklyn');
    expect(shortStorefrontRewrite('/r/hamburger/', short)).toBe('/r/demo-favornoms/brooklyn/');
    expect(shortStorefrontRewrite('/r/hamburger?t=abc', short)).toBe('/r/demo-favornoms/brooklyn?t=abc');
    expect(shortStorefrontRewrite('/r/hamburger/cart?t=abc', short)).toBe('/r/demo-favornoms/brooklyn/cart?t=abc');
    expect(shortStorefrontRewrite('/r/hamburger/orders/A-12?payment_intent=pi_1&redirect_status=succeeded', short))
      .toBe('/r/demo-favornoms/brooklyn/orders/A-12?payment_intent=pi_1&redirect_status=succeeded');
    expect(shortStorefrontRewrite('/r/hamburger/manifest.webmanifest', short)).toBe('/r/demo-favornoms/brooklyn/manifest.webmanifest');
  });

  it('is null for any other answer or path', () => {
    expect(shortStorefrontRewrite('/r/hamburger/cart', toShort(1))).toBeNull();
    expect(shortStorefrontRewrite('/r/demo-favornoms/brooklyn', moved('demo-favornoms', 'brooklyn'))).toBeNull();
    expect(shortStorefrontRewrite('/r/hamburger', null)).toBeNull();
    expect(shortStorefrontRewrite('/checkout', short)).toBeNull();
  });
});

describe('the web address rules', () => {
  it('normalises what a person typed the way the database does', () => {
    expect(normalizePublicSlug('  Hamburger ')).toBe('hamburger');
    expect(normalizePublicSlug('')).toBe('');
  });

  it('refuses a reserved word first, then anything off the slug rule (the database order)', () => {
    expect(RESERVED_PUBLIC_SLUGS).toEqual(['r', 'api', 'auth', 'admin', 'app', 'www', 'help', 'privacy', 'terms', 'ccpa']);
    for (const word of RESERVED_PUBLIC_SLUGS) expect(publicSlugFormatError(word)).toBe('slug_reserved');
    for (const bad of ['a', '', 'bad slug', '-abc', 'abc-', 'a--b', 'ab_c', 'phở', 'Hamburger', 'a'.repeat(65)]) {
      expect(publicSlugFormatError(bad)).toBe('slug_invalid');
    }
    for (const good of ['hamburger', 'food-thai-thai', 'pho-ha-noi', 'a1', 'a'.repeat(64), 'apps', 'rr']) {
      expect(publicSlugFormatError(good)).toBeNull();
    }
  });

  it('suggests an address from an App name: lower case, accents stripped, hyphens between words', () => {
    expect(suggestPublicSlug('Hamburger')).toBe('hamburger');
    expect(suggestPublicSlug('Food Thai Thai')).toBe('food-thai-thai');
    expect(suggestPublicSlug('Phở Hà Nội')).toBe('pho-ha-noi');
    expect(suggestPublicSlug('Bánh Mì Đặc Biệt')).toBe('banh-mi-dac-biet');
    expect(suggestPublicSlug('Café Niño & Co.')).toBe('cafe-nino-co');
    expect(suggestPublicSlug('  --Joe’s   Pizza!!  ')).toBe('joe-s-pizza');
    expect(suggestPublicSlug('Straße 9')).toBe('strasse-9');
  });

  it('leaves the field empty when the name gives nothing usable (a Thai name)', () => {
    expect(suggestPublicSlug('ส้มตำแซ่บ')).toBe('');
    expect(suggestPublicSlug('A')).toBe('');
    expect(suggestPublicSlug('!!!')).toBe('');
    expect(suggestPublicSlug('ร้าน Pho 99')).toBe('pho-99');
  });

  it('cuts a long name to 64 characters without a trailing hyphen', () => {
    const slug = suggestPublicSlug(`${'a'.repeat(63)} b`);
    expect(slug).toBe('a'.repeat(63));
    expect(suggestPublicSlug('x'.repeat(80))).toHaveLength(64);
    expect(publicSlugFormatError(suggestPublicSlug('Phở '.repeat(30)))).toBeNull();
  });
});
