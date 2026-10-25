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
function fakeClient(tables: Record<string, Row[]>, rpcs: Record<string, { data: unknown; error: unknown }> = {}) {
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
    rpc: async (fn: string) => rpcs[fn] ?? { data: null, error: { code: 'PGRST202', message: `no ${fn}` } },
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

function branch(settings: unknown): Row {
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
