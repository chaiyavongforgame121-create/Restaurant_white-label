import { describe, expect, it } from 'vitest';
import { movedStorefrontPath, parseStorefrontPathResolution, storefrontPathSlugs } from './storefront-path';

const moved = (restaurantSlug: string, branchSlug: string) =>
  ({ status: 'redirect', restaurantSlug, branchSlug }) as const;

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

describe('parseStorefrontPathResolution', () => {
  it('reads the first row PostgREST returns, or a single object', () => {
    expect(parseStorefrontPathResolution([{ status: 'redirect', restaurant_slug: 'demo-favornoms', branch_slug: 'brooklyn' }]))
      .toEqual({ status: 'redirect', restaurantSlug: 'demo-favornoms', branchSlug: 'brooklyn' });
    expect(parseStorefrontPathResolution({ status: 'none', restaurant_slug: null, branch_slug: null }))
      .toEqual({ status: 'none', restaurantSlug: null, branchSlug: null });
  });

  it('is null for anything else, so a caller never redirects on it', () => {
    expect(parseStorefrontPathResolution([])).toBeNull();
    expect(parseStorefrontPathResolution(null)).toBeNull();
    expect(parseStorefrontPathResolution('redirect')).toBeNull();
    expect(parseStorefrontPathResolution([{ status: 'moved', restaurant_slug: 'a', branch_slug: 'b' }])).toBeNull();
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

  it('sends other letter case to the address as it is spelled', () => {
    expect(movedStorefrontPath('/r/Demo-FavorNoms/Brooklyn/cart', moved('demo-favornoms', 'brooklyn')))
      .toBe('/r/demo-favornoms/brooklyn/cart');
  });

  it('does nothing for a live pair, an unknown one, a non-storefront path, or a redirect to itself', () => {
    expect(movedStorefrontPath('/r/demo-favornoms/brooklyn', { status: 'live', restaurantSlug: 'demo-favornoms', branchSlug: 'brooklyn' })).toBeNull();
    expect(movedStorefrontPath('/r/nobody/here', { status: 'none', restaurantSlug: null, branchSlug: null })).toBeNull();
    expect(movedStorefrontPath('/r/coastal-grill/brooklyn', null)).toBeNull();
    expect(movedStorefrontPath('/checkout', moved('demo-favornoms', 'brooklyn'))).toBeNull();
    expect(movedStorefrontPath('/r/demo-favornoms/brooklyn?t=1', moved('demo-favornoms', 'brooklyn'))).toBeNull();
    expect(movedStorefrontPath('/r/coastal-grill/brooklyn', { status: 'redirect', restaurantSlug: null, branchSlug: 'brooklyn' })).toBeNull();
  });
});
