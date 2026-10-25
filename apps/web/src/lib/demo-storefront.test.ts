import { describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('@favornoms/database/server', () => ({ getAnonServerClient: () => null }));

import { parseStorefrontPathResolution } from '@favornoms/database/queries';
import { DEMO_STOREFRONT_LONG_PATH, demoStorefrontHref } from './demo-storefront';

describe('the landing and 404 demo link', () => {
  it('is the web address once the showcase branch has one', () => {
    const answer = parseStorefrontPathResolution([
      {
        status: 'redirect',
        restaurant_slug: 'demo-favornoms',
        branch_slug: 'brooklyn',
        public_slug: 'hamburger',
        segments: 2,
      },
    ]);
    expect(demoStorefrontHref(answer)).toBe('/r/hamburger');
  });

  it('stays the long form while the branch has none, or when the database cannot say', () => {
    const live = parseStorefrontPathResolution([
      { status: 'live', restaurant_slug: 'demo-favornoms', branch_slug: 'brooklyn', public_slug: null, segments: 2 },
    ]);
    expect(demoStorefrontHref(live)).toBe(DEMO_STOREFRONT_LONG_PATH);
    expect(demoStorefrontHref(parseStorefrontPathResolution([{ status: 'none' }]))).toBe(DEMO_STOREFRONT_LONG_PATH);
    expect(demoStorefrontHref(null)).toBe('/r/demo-favornoms/brooklyn');
  });
});
