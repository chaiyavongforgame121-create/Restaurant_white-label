import { beforeEach, describe, expect, it, vi } from 'vitest';

// next/* and the server clients have runtimes of their own; the code under test only needs what
// they hand back. redirect() and notFound() throw, as the real ones do, so nothing runs after them.
const nav = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
const request = vi.hoisted(() => ({ headers: new Headers() }));
const db = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('next/navigation', () => nav);
vi.mock('next/headers', () => ({ headers: async () => request.headers }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('@favornoms/database/middleware', () => ({
  PATHNAME_HEADER: 'x-favornoms-pathname',
  SEARCH_HEADER: 'x-favornoms-search',
  PUBLIC_BASE_HEADER: 'x-favornoms-public-base',
}));
vi.mock('@favornoms/database/server', () => ({
  getAnonServerClient: () => db.client,
  getServerClient: async () => db.client,
}));

import { resolveTenantBySlug, type ResolvedTenant } from '@favornoms/database/queries';
import { resolveTenant, storefrontNames } from './tenant';

type Row = Record<string, unknown>;
type Client = Parameters<typeof resolveTenantBySlug>[0];

/**
 * Just enough of a Supabase client for resolveTenantBySlug and the RPCs: `.eq()` filters really
 * filter, so the branch is found by restaurant, slug and is_active as it is in the database.
 */
type RpcAnswer = { data: unknown; error: unknown };

function fakeClient(
  tables: Record<string, Row[]>,
  rpcs: Record<string, RpcAnswer | ((args: Record<string, unknown>) => RpcAnswer)> = {},
) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every(([col, value]) => r[col] === value));
      const builder = {
        select: () => builder,
        eq: (col: string, value: unknown) => {
          filters.push([col, value]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
      };
      return builder;
    },
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      const answer = rpcs[fn];
      if (typeof answer === 'function') return answer(args);
      return answer ?? { data: null, error: { code: 'PGRST202', message: `no ${fn}` } };
    },
  };
}

const RESTAURANT = {
  id: '33333333-3333-3333-3333-333333333333',
  slug: 'demo-favornoms',
  name: 'Demo-FavorNoms',
  brand_settings: {},
  owner_user_id: 'u1',
  storefront: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};
const BRAND = {
  id: 'brand-1',
  restaurant_id: RESTAURANT.id,
  name: 'Demo-FavorNoms',
  theme: {},
  logo_url: null,
  favicon_url: null,
  icon_192_url: null,
  icon_512_url: null,
  icon_maskable_512_url: null,
  is_default: true,
};

function branch(settings: unknown, extra: Row = {}): Row {
  return {
    id: '44444444-4444-4444-4444-444444444444',
    restaurant_id: RESTAURANT.id,
    slug: 'brooklyn',
    name: 'Hamburger',
    address: '1 Main St',
    timezone: 'America/New_York',
    theme_override: {},
    settings,
    is_active: true,
    brand_id: null,
    geo_lat: 40.7,
    geo_lng: -73.9,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    logo_url: null,
    favicon_url: null,
    icon_192_url: null,
    icon_512_url: null,
    icon_maskable_512_url: null,
    app_icon: null,
    ...extra,
  };
}

async function tenantWith(settings: unknown): Promise<ResolvedTenant> {
  const client = fakeClient({ restaurants: [RESTAURANT], branches: [branch(settings)], brands: [BRAND] });
  const tenant = await resolveTenantBySlug(client as unknown as Client, 'demo-favornoms', 'brooklyn');
  if (!tenant) throw new Error('fixture did not resolve');
  return tenant;
}

describe('the App name, from the database row to every storefront surface', () => {
  it('is the storefront’s name when the branch has one (the live Hamburger case)', async () => {
    // 2026-10-26: settings.app_name = "Hamburger" was saved, and the header, tab, manifest and
    // home-screen label all still said "Demo-FavorNoms - Hamburger".
    const names = storefrontNames(await tenantWith({ app_name: 'Hamburger', currency: 'USD' }));
    expect(names).toMatchObject({ full: 'Hamburger', app: 'Hamburger', short: 'Hamburger', brand: 'Demo-FavorNoms' });
  });

  it('wins over "<brand> - <branch>" even when it names neither', async () => {
    const names = storefrontNames(await tenantWith({ app_name: 'Burger Joint' }));
    expect(names.full).toBe('Burger Joint');
  });

  it('is trimmed and capped, as the admin preview promises', async () => {
    expect(storefrontNames(await tenantWith({ app_name: '  Food Thai Thai  ' })).full).toBe('Food Thai Thai');
    expect(storefrontNames(await tenantWith({ app_name: 'x'.repeat(80) })).full).toHaveLength(60);
  });

  it('falls back to "<brand> - <branch>" when missing, blank or not text', async () => {
    for (const settings of [{}, { app_name: '   ' }, { app_name: 42 }, null]) {
      expect(storefrontNames(await tenantWith(settings)).full).toBe('Demo-FavorNoms - Hamburger');
    }
  });

  it('travels on ResolvedTenant.appName, because the parsed branch settings drop unknown keys', async () => {
    const tenant = await tenantWith({ app_name: 'Hamburger' });
    expect(tenant.appName).toBe('Hamburger');
    expect(tenant.branch.settings).not.toHaveProperty('app_name');
  });
});

describe('resolveTenant at an address the storefront moved from', () => {
  const movedTo = (restaurant_slug: string, branch_slug: string) => ({
    data: [{ status: 'redirect', restaurant_slug, branch_slug }],
    error: null,
  });

  beforeEach(() => {
    nav.redirect.mockClear();
    nav.notFound.mockClear();
    request.headers = new Headers();
  });

  it('redirects to the new address, keeping the rest of the path and the whole query string', async () => {
    db.client = fakeClient({ restaurants: [RESTAURANT], branches: [branch({})], brands: [BRAND] }, {
      resolve_storefront_path: movedTo('demo-favornoms', 'brooklyn'),
    });
    request.headers = new Headers({
      'x-favornoms-pathname': '/r/coastal-grill/brooklyn/checkout',
      'x-favornoms-search': '?payment_intent=pi_1&redirect_status=succeeded',
    });
    await expect(resolveTenant('coastal-grill', 'brooklyn')).rejects.toThrow('NEXT_REDIRECT');
    expect(nav.redirect).toHaveBeenCalledWith(
      '/r/demo-favornoms/brooklyn/checkout?payment_intent=pi_1&redirect_status=succeeded',
    );
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it('falls back to the branch menu when the request path is unknown', async () => {
    db.client = fakeClient({}, { resolve_storefront_path: movedTo('demo-favornoms', 'brooklyn') });
    await expect(resolveTenant('coastal-grill', 'brooklyn')).rejects.toThrow('NEXT_REDIRECT');
    expect(nav.redirect).toHaveBeenCalledWith('/r/demo-favornoms/brooklyn');
  });

  it('is the not-found page when nothing answers, or the database cannot say', async () => {
    db.client = fakeClient({}, { resolve_storefront_path: { data: [{ status: 'none', restaurant_slug: null, branch_slug: null }], error: null } });
    await expect(resolveTenant('nobody', 'here')).rejects.toThrow('NEXT_NOT_FOUND');
    db.client = fakeClient({});
    await expect(resolveTenant('coastal-grill', 'brooklyn')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it('serves a live storefront without asking where it moved', async () => {
    const rpc = vi.fn();
    const client = fakeClient({ restaurants: [RESTAURANT], branches: [branch({ app_name: 'Hamburger' })], brands: [BRAND] });
    db.client = { ...client, rpc: async (fn: string) => (rpc(fn), client.rpc(fn)) };
    const tenant = await resolveTenant('demo-favornoms', 'brooklyn');
    expect(storefrontNames(tenant).full).toBe('Hamburger');
    expect(rpc).not.toHaveBeenCalledWith('resolve_storefront_path');
  });
});

describe('resolveTenant and the short address (docs/SHORT-STOREFRONT-URLS-2026-10-26.md)', () => {
  const asked: Array<Record<string, unknown>> = [];
  /** resolve_storefront_path as 20261026120000 answers it, recording what it was asked. */
  const answering = (row: Record<string, unknown>) => (args: Record<string, unknown>) => {
    asked.push(args);
    return { data: [row], error: null };
  };
  const withWebAddress = (publicSlug: string | null) =>
    ({ restaurants: [RESTAURANT], branches: [branch({}, { public_slug: publicSlug })], brands: [BRAND] });

  beforeEach(() => {
    nav.redirect.mockClear();
    nav.notFound.mockClear();
    asked.length = 0;
    request.headers = new Headers();
  });

  it('carries the web address on ResolvedTenant.publicSlug', async () => {
    const client = fakeClient(withWebAddress('hamburger'));
    const tenant = await resolveTenantBySlug(client as unknown as Client, 'demo-favornoms', 'brooklyn');
    expect(tenant?.publicSlug).toBe('hamburger');
  });

  it('serves a short address the middleware rewrote without asking again', async () => {
    db.client = fakeClient(withWebAddress('hamburger'), {
      resolve_storefront_path: answering({ status: 'none' }),
    });
    request.headers = new Headers({
      'x-favornoms-pathname': '/r/hamburger/cart',
      'x-favornoms-public-base': '/r/hamburger',
    });
    const tenant = await resolveTenant('demo-favornoms', 'brooklyn');
    expect(tenant.publicSlug).toBe('hamburger');
    expect(asked).toEqual([]);
  });

  it('sends a long form the middleware still had as live to the web address, path and query kept', async () => {
    db.client = fakeClient(withWebAddress('hamburger'), {
      resolve_storefront_path: answering({
        status: 'redirect',
        restaurant_slug: 'demo-favornoms',
        branch_slug: 'brooklyn',
        public_slug: 'hamburger',
        segments: 2,
      }),
    });
    request.headers = new Headers({
      'x-favornoms-pathname': '/r/demo-favornoms/brooklyn/cart',
      'x-favornoms-search': '?t=abc',
      'x-favornoms-public-base': '/r/demo-favornoms/brooklyn',
    });
    await expect(resolveTenant('demo-favornoms', 'brooklyn')).rejects.toThrow('NEXT_REDIRECT');
    expect(nav.redirect).toHaveBeenCalledWith('/r/hamburger/cart?t=abc');
    expect(asked).toEqual([{ p_first: 'demo-favornoms', p_second: 'brooklyn' }]);
  });

  it('sends a web address that was cleared to the long form, asking about the browser path, not the params', async () => {
    db.client = fakeClient(withWebAddress(null), {
      resolve_storefront_path: answering({
        status: 'redirect',
        restaurant_slug: 'demo-favornoms',
        branch_slug: 'brooklyn',
        public_slug: null,
        segments: 1,
      }),
    });
    request.headers = new Headers({
      'x-favornoms-pathname': '/r/hamburger/orders/A-12',
      'x-favornoms-public-base': '/r/hamburger',
    });
    await expect(resolveTenant('demo-favornoms', 'brooklyn')).rejects.toThrow('NEXT_REDIRECT');
    expect(nav.redirect).toHaveBeenCalledWith('/r/demo-favornoms/brooklyn/orders/A-12');
    expect(asked).toEqual([{ p_first: 'hamburger', p_second: 'orders' }]);
  });

  it('serves the page when the fresh answer agrees with the address the browser is on', async () => {
    // The tenant read is behind (its version could not be read): the middleware served the short
    // address, the database says it is live, so nothing redirects and nothing can loop.
    db.client = fakeClient(withWebAddress(null), {
      resolve_storefront_path: answering({
        status: 'short',
        restaurant_slug: 'demo-favornoms',
        branch_slug: 'brooklyn',
        public_slug: 'hamburger',
        segments: 1,
      }),
    });
    request.headers = new Headers({
      'x-favornoms-pathname': '/r/hamburger',
      'x-favornoms-public-base': '/r/hamburger',
    });
    const tenant = await resolveTenant('demo-favornoms', 'brooklyn');
    expect(tenant.branch.slug).toBe('brooklyn');
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it('serves the branch a web address names now when a cached rewrite still pointed at its old long form', async () => {
    db.client = fakeClient(withWebAddress('hamburger'), {
      resolve_storefront_path: answering({
        status: 'short',
        restaurant_slug: 'demo-favornoms',
        branch_slug: 'brooklyn',
        public_slug: 'hamburger',
        segments: 1,
      }),
    });
    request.headers = new Headers({
      'x-favornoms-pathname': '/r/hamburger/cart',
      'x-favornoms-public-base': '/r/hamburger',
    });
    const tenant = await resolveTenant('coastal-grill', 'brooklyn');
    expect(tenant.restaurant.slug).toBe('demo-favornoms');
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it('serves the branch that took a web address over when a cached rewrite still pointed at the one that gave it up', async () => {
    const pho = { ...RESTAURANT, id: '55555555-5555-5555-5555-555555555555', slug: 'pho-place', name: 'Pho Place' };
    const phoBranch = branch({}, {
      id: '66666666-6666-6666-6666-666666666666',
      restaurant_id: pho.id,
      slug: 'main',
      name: 'Pho Place',
      public_slug: 'hamburger',
    });
    db.client = fakeClient(
      {
        restaurants: [RESTAURANT, pho],
        branches: [branch({}, { public_slug: 'burger2' }), phoBranch],
        brands: [BRAND, { ...BRAND, id: 'brand-2', restaurant_id: pho.id, name: 'Pho Place' }],
      },
      {
        resolve_storefront_path: answering({
          status: 'short',
          restaurant_slug: 'pho-place',
          branch_slug: 'main',
          public_slug: 'hamburger',
          segments: 1,
        }),
      },
    );
    request.headers = new Headers({
      'x-favornoms-pathname': '/r/hamburger/cart',
      'x-favornoms-public-base': '/r/hamburger',
    });
    const tenant = await resolveTenant('demo-favornoms', 'brooklyn');
    expect(tenant.restaurant.slug).toBe('pho-place');
    expect(tenant.branch.id).toBe(phoBranch.id);
    expect(asked).toEqual([{ p_first: 'hamburger', p_second: 'cart' }]);
    expect(nav.redirect).not.toHaveBeenCalled();
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it('serves a long form in place when the middleware had no answer, rather than sending it to the web address', async () => {
    // No PUBLIC_BASE_HEADER: the middleware could not ask the database, so it could not rewrite
    // /r/hamburger either. Sending the diner there would be a 404.
    db.client = fakeClient(withWebAddress('hamburger'), {
      resolve_storefront_path: answering({
        status: 'redirect',
        restaurant_slug: 'demo-favornoms',
        branch_slug: 'brooklyn',
        public_slug: 'hamburger',
        segments: 2,
      }),
    });
    request.headers = new Headers({ 'x-favornoms-pathname': '/r/demo-favornoms/brooklyn/cart', 'x-favornoms-search': '?t=abc' });
    const tenant = await resolveTenant('demo-favornoms', 'brooklyn');
    expect(tenant.publicSlug).toBe('hamburger');
    expect(asked).toEqual([]);
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it('never renders the menu at a web address page the middleware did not rewrite', async () => {
    // /r/hamburger/cart with no rewrite routes as restaurant "hamburger", branch "cart".
    db.client = fakeClient(withWebAddress('hamburger'), {
      resolve_storefront_path: answering({
        status: 'short',
        restaurant_slug: 'demo-favornoms',
        branch_slug: 'brooklyn',
        public_slug: 'hamburger',
        segments: 1,
      }),
    });
    request.headers = new Headers({ 'x-favornoms-pathname': '/r/hamburger/cart' });
    await expect(resolveTenant('hamburger', 'cart')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(nav.redirect).not.toHaveBeenCalled();
  });
});
