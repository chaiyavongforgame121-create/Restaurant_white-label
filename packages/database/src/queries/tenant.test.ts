// resolveTenantBySlug carries the branch's web address (branches.public_slug, 20261026120000), and
// storefrontBase builds every customer link from it. A hand-rolled client stands in for supabase-js.
import { describe, expect, it } from 'vitest';
import type { FavornomsClient } from '../client-type';
import { storefrontBase } from '../storefront-path';
import { resolveTenantBySlug } from './tenant';

type Row = Record<string, unknown>;

/** `.eq()` really filters; every `select()` list is recorded per table. */
function fakeClient(tables: Record<string, Row[]>) {
  const selects: Record<string, string[]> = {};
  const client = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every(([col, value]) => r[col] === value));
      const builder = {
        select: (columns: string) => {
          (selects[table] ??= []).push(columns);
          return builder;
        },
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
  };
  return { client: client as unknown as FavornomsClient, selects };
}

const RESTAURANT = { id: 'r1', slug: 'demo-favornoms', name: 'Demo-FavorNoms', brand_settings: {}, storefront: null };
const branch = (publicSlug: unknown): Row => ({
  id: 'b1',
  restaurant_id: 'r1',
  slug: 'brooklyn',
  name: 'Hamburger',
  settings: { app_name: 'Hamburger' },
  theme_override: {},
  is_active: true,
  brand_id: null,
  public_slug: publicSlug,
});

async function resolve(publicSlug: unknown) {
  const { client, selects } = fakeClient({ restaurants: [RESTAURANT], branches: [branch(publicSlug)], brands: [] });
  const tenant = await resolveTenantBySlug(client, 'demo-favornoms', 'brooklyn');
  return { tenant, selects };
}

describe('ResolvedTenant.publicSlug', () => {
  it('reads branches.public_slug, so links follow the web address (/r/hamburger)', async () => {
    const { tenant, selects } = await resolve('hamburger');
    expect(selects.branches?.[0]).toMatch(/(^|, )public_slug(,|$)/);
    expect(tenant?.publicSlug).toBe('hamburger');
    expect(storefrontBase(tenant!)).toBe('/r/hamburger');
  });

  it('is null without one, and links stay on the long form', async () => {
    for (const value of [null, '', undefined]) {
      const { tenant } = await resolve(value);
      expect(tenant?.publicSlug).toBeNull();
      expect(storefrontBase(tenant!)).toBe('/r/demo-favornoms/brooklyn');
    }
  });
});
