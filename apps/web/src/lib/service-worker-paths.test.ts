import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * public/sw.js is a plain script the browser runs as a worker, so it exports nothing. Its two path
 * rules are pulled out by running it against a stub `self` and handing back the bindings.
 */
function loadServiceWorker(): { NO_STORE_NAV: RegExp; tenantRoot: (url: URL) => string | null } {
  const source = readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8');
  const self = { addEventListener: () => undefined, location: { origin: 'https://app.favornoms.com' } };
  return new Function('self', `${source}\nreturn { NO_STORE_NAV, tenantRoot };`)(self);
}

const { NO_STORE_NAV, tenantRoot } = loadServiceWorker();
const root = (p: string) => tenantRoot(new URL(p, 'https://app.favornoms.com'));

describe('sw.js: pages that are never written down', () => {
  it('covers the personal pages under a web address and under the long form', () => {
    for (const p of [
      '/r/hamburger/orders',
      '/r/hamburger/orders/A-12',
      '/r/hamburger/account/addresses',
      '/r/hamburger/checkout',
      '/r/hamburger/sign-in',
      '/r/demo-favornoms/brooklyn/orders/A-12',
      '/r/demo-favornoms/brooklyn/account',
      '/r/demo-favornoms/brooklyn/checkout',
      '/account',
      '/auth/callback',
    ]) {
      expect(NO_STORE_NAV.test(p), p).toBe(true);
    }
  });

  it('keeps the menu and the cart, in either form, and a store whose address is a page name', () => {
    for (const p of [
      '/r/hamburger',
      '/r/hamburger/cart',
      '/r/demo-favornoms/brooklyn',
      '/r/demo-favornoms/brooklyn/cart',
      '/r/orders',
      '/r/orders/cart',
      '/r/account/brooklyn',
      '/',
    ]) {
      expect(NO_STORE_NAV.test(p), p).toBe(false);
    }
  });
});

describe('sw.js: the storefront a path belongs to', () => {
  it('is the web address for a short address and its pages', () => {
    expect(root('/r/hamburger')).toBe('/r/hamburger');
    expect(root('/r/hamburger/cart')).toBe('/r/hamburger');
    expect(root('/r/hamburger/orders/A-12/receipt')).toBe('/r/hamburger');
    expect(root('/r/hamburger/manifest.webmanifest')).toBe('/r/hamburger');
    expect(root('/r/hamburger/app-icon/192')).toBe('/r/hamburger');
  });

  it('is the restaurant and branch for the long form', () => {
    expect(root('/r/demo-favornoms/brooklyn')).toBe('/r/demo-favornoms/brooklyn');
    expect(root('/r/demo-favornoms/brooklyn/cart')).toBe('/r/demo-favornoms/brooklyn');
    expect(root('/r/demo-favornoms/food-thai-thai/orders/B-3')).toBe('/r/demo-favornoms/food-thai-thai');
  });

  it('keeps two storefronts apart', () => {
    expect(root('/r/hamburger/cart')).not.toBe(root('/r/food-thai-thai/cart'));
    expect(root('/r/demo-favornoms/brooklyn')).not.toBe(root('/r/demo-favornoms/food-thai-thai'));
  });

  it('is null off a storefront', () => {
    expect(root('/')).toBeNull();
    expect(root('/privacy')).toBeNull();
  });
});
