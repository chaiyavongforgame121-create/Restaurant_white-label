import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerClient } from '@favornoms/database/server';
import {
  branchIconsMetadata,
  getBranchIconMetadata,
  isOwnBrandingFile,
  readBranchAppIcons,
  type BranchAppIcons,
} from './branch-app-icon';

/**
 * The back office's tab icon: the branch's own App icon, else its brand's, else the FavorNoms
 * icons the root layout gives every admin page. The ladder is the storefront's
 * (resolveTenantBySlug), so a merchant sees the same icon in their tab and on their storefront.
 */

vi.mock('server-only', () => ({}));
vi.mock('@favornoms/database/server', () => ({ getServerClient: vi.fn() }));

type Client = Parameters<typeof readBranchAppIcons>[0];
type Row = Record<string, unknown>;

const SB = 'https://abc.supabase.co';
const file = (name: string) => `${SB}/storage/v1/object/public/branding/r1/${name}.png`;

const R1 = 'r1';
const R2 = 'r2';
const BRANCH = 'b1';

/**
 * A stand-in for the signed-in client: eq filters, order and limit over in-memory rows, the
 * shapes readBranchAppIcons uses (maybeSingle, or awaiting the builder for a list). `errors`
 * answers a table with a PostgREST error, `throws` makes its read reject.
 */
function fakeClient(tables: Record<string, Row[]>, opts: { errors?: string[]; throws?: string[] } = {}) {
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const orders: Array<[string, boolean]> = [];
    let limit = Infinity;
    reads.push({ table, filters });
    const run = () => {
      if (opts.throws?.includes(table)) throw new Error('fetch failed');
      if (opts.errors?.includes(table)) return { data: null, error: { code: '42501', message: 'denied' } };
      let rows = (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
      rows = [...rows].sort((a, b) => {
        for (const [k, asc] of orders) {
          const x = a[k] as string | boolean;
          const y = b[k] as string | boolean;
          if (x === y) continue;
          return (x < y ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
      return { data: rows.slice(0, limit), error: null };
    };
    const builder = {
      select: () => builder,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return builder;
      },
      order: (k: string, o?: { ascending?: boolean }) => {
        orders.push([k, o?.ascending !== false]);
        return builder;
      },
      limit: (n: number) => {
        limit = n;
        return builder;
      },
      maybeSingle: async () => {
        const r = run();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve().then(run).then(ok, fail),
    };
    return builder;
  };
  return { client: { from } as unknown as Client, reads };
}

function branchRow(over: Row = {}): Row {
  return {
    id: BRANCH,
    restaurant_id: R1,
    brand_id: null,
    favicon_url: null,
    icon_192_url: null,
    icon_512_url: null,
    app_icon: null,
    ...over,
  };
}

function brandRow(over: Row = {}): Row {
  return {
    id: 'brand-default',
    restaurant_id: R1,
    is_default: true,
    created_at: '2026-01-01T00:00:00Z',
    theme: {},
    favicon_url: null,
    icon_192_url: null,
    icon_512_url: null,
    ...over,
  };
}

const OWN_SET = {
  favicon_url: file('favicon-b1'),
  icon_192_url: file('icon-192-b1'),
  icon_512_url: file('icon-512-b1'),
  app_icon: { fit: 'fill', zoom: 1, background: '#FFFFFF', appleUrl: file('icon-apple-180-b1') },
};

const BRAND_SET = {
  favicon_url: file('favicon-brand'),
  icon_192_url: file('icon-192-brand'),
  icon_512_url: file('icon-512-brand'),
  theme: { primaryColor: '#B1320C', appIcon: { appleUrl: file('icon-apple-180-brand') } },
};

describe('readBranchAppIcons: which set the tab wears', () => {
  it("takes the branch's own set whole once it has an installed-app icon, and never asks the brand", async () => {
    const { client, reads } = fakeClient({
      branches: [branchRow(OWN_SET)],
      brands: [brandRow(BRAND_SET)],
    });
    expect(await readBranchAppIcons(client, BRANCH)).toEqual<BranchAppIcons>({
      faviconUrl: file('favicon-b1'),
      icon192Url: file('icon-192-b1'),
      icon512Url: file('icon-512-b1'),
      appleIconUrl: file('icon-apple-180-b1'),
    });
    expect(reads.map((r) => r.table)).toEqual(['branches']);
  });

  it('counts a branch with only a 512 as owning its set (the storefront rule)', async () => {
    const { client } = fakeClient({
      branches: [branchRow({ icon_512_url: file('icon-512-b1') })],
      brands: [brandRow(BRAND_SET)],
    });
    expect(await readBranchAppIcons(client, BRANCH)).toEqual<BranchAppIcons>({
      faviconUrl: null,
      icon192Url: null,
      icon512Url: file('icon-512-b1'),
      appleIconUrl: null,
    });
  });

  it("falls back to the restaurant's default brand, whole, when the branch has no app icon of its own", async () => {
    const { client } = fakeClient({
      // A lone legacy favicon is not an installed-app icon: the brand's set wins, favicon included.
      branches: [branchRow({ favicon_url: file('favicon-b1') })],
      brands: [
        brandRow({ id: 'older-not-default', is_default: false, created_at: '2025-01-01T00:00:00Z' }),
        brandRow(BRAND_SET),
      ],
    });
    expect(await readBranchAppIcons(client, BRANCH)).toEqual<BranchAppIcons>({
      faviconUrl: file('favicon-brand'),
      icon192Url: file('icon-192-brand'),
      icon512Url: file('icon-512-brand'),
      appleIconUrl: file('icon-apple-180-brand'),
    });
  });

  it("prefers the linked brand when it is this restaurant's", async () => {
    const { client } = fakeClient({
      branches: [branchRow({ brand_id: 'linked' })],
      brands: [
        brandRow(BRAND_SET),
        brandRow({ id: 'linked', is_default: false, icon_192_url: file('icon-192-linked'), theme: {} }),
      ],
    });
    expect(await readBranchAppIcons(client, BRANCH)).toEqual<BranchAppIcons>({
      faviconUrl: null,
      icon192Url: file('icon-192-linked'),
      icon512Url: null,
      appleIconUrl: null,
    });
  });

  it("treats a link to another restaurant's brand exactly like no link", async () => {
    const { client, reads } = fakeClient({
      branches: [branchRow({ brand_id: 'foreign' })],
      brands: [
        brandRow(BRAND_SET),
        brandRow({ id: 'foreign', restaurant_id: R2, icon_192_url: file('icon-192-foreign') }),
      ],
    });
    expect((await readBranchAppIcons(client, BRANCH))?.icon192Url).toBe(file('icon-192-brand'));
    const linkedRead = reads.find((r) => r.table === 'brands' && r.filters.some(([k]) => k === 'id'));
    expect(linkedRead?.filters).toContainEqual(['restaurant_id', R1]);
  });

  it('has no set when neither the branch nor a brand can be read for one', async () => {
    expect(await readBranchAppIcons(fakeClient({ branches: [], brands: [] }).client, BRANCH)).toBeNull();
    expect(
      await readBranchAppIcons(fakeClient({ branches: [branchRow()], brands: [] }).client, BRANCH),
    ).toBeNull();
  });

  it('fails quietly on any read error, so the tab keeps the FavorNoms icons', async () => {
    const tables = { branches: [branchRow({ brand_id: 'linked' })], brands: [brandRow(BRAND_SET)] };
    expect(await readBranchAppIcons(fakeClient(tables, { errors: ['branches'] }).client, BRANCH)).toBeNull();
    expect(await readBranchAppIcons(fakeClient(tables, { errors: ['brands'] }).client, BRANCH)).toBeNull();
    expect(await readBranchAppIcons(fakeClient(tables, { throws: ['branches'] }).client, BRANCH)).toBeNull();
    expect(await readBranchAppIcons(fakeClient(tables, { throws: ['brands'] }).client, BRANCH)).toBeNull();
  });
});

describe('branchIconsMetadata: the icons metadata, as the storefront writes it', () => {
  const set = (over: Partial<BranchAppIcons> = {}): BranchAppIcons => ({
    faviconUrl: file('favicon'),
    icon192Url: file('icon-192'),
    icon512Url: file('icon-512'),
    appleIconUrl: file('icon-apple-180'),
    ...over,
  });

  it('declares sizes only for the normalised PNGs and lists the legacy favicon only without a 192', () => {
    expect(branchIconsMetadata(set(), SB)).toEqual({
      icons: {
        icon: [
          { url: file('icon-192'), sizes: '192x192', type: 'image/png' },
          { url: file('icon-512'), sizes: '512x512', type: 'image/png' },
        ],
        apple: file('icon-apple-180'),
      },
    });
    expect(branchIconsMetadata(set({ icon192Url: null, icon512Url: null, appleIconUrl: null }), SB)).toEqual({
      icons: { icon: [{ url: file('favicon') }], apple: file('favicon') },
    });
  });

  it('gives iPhones the opaque apple icon, else the 192, else the favicon', () => {
    const apple = (icons: BranchAppIcons) =>
      (branchIconsMetadata(icons, SB).icons as { apple?: unknown } | undefined)?.apple;
    expect(apple(set())).toBe(file('icon-apple-180'));
    expect(apple(set({ appleIconUrl: null }))).toBe(file('icon-192'));
    expect(apple(set({ appleIconUrl: null, icon192Url: null }))).toBe(file('favicon'));
  });

  it('returns nothing to override when there is no tab icon, so the FavorNoms icons stay', () => {
    expect(branchIconsMetadata(null, SB)).toEqual({});
    expect(
      branchIconsMetadata({ faviconUrl: null, icon192Url: null, icon512Url: null, appleIconUrl: null }, SB),
    ).toEqual({});
    // A 512 alone is no tab icon on the storefront either.
    expect(branchIconsMetadata(set({ faviconUrl: null, icon192Url: null }), SB)).toEqual({});
  });

  it("uses only files in this project's branding bucket", () => {
    const elsewhere = 'https://tracker.example/pixel.png';
    const otherBucket = `${SB}/storage/v1/object/public/menu/r1/x.png`;
    const otherProject = 'https://xyz.supabase.co/storage/v1/object/public/branding/r1/x.png';
    expect(isOwnBrandingFile(file('icon-192'), SB)).toBe(true);
    for (const url of [elsewhere, otherBucket, otherProject, 'not a url', '']) {
      expect(isOwnBrandingFile(url, SB)).toBe(false);
    }
    expect(isOwnBrandingFile(file('icon-192'), undefined)).toBe(false);

    expect(branchIconsMetadata(set({ appleIconUrl: elsewhere }), SB)).toEqual({
      icons: {
        icon: [
          { url: file('icon-192'), sizes: '192x192', type: 'image/png' },
          { url: file('icon-512'), sizes: '512x512', type: 'image/png' },
        ],
        apple: file('icon-192'),
      },
    });
    expect(
      branchIconsMetadata({ faviconUrl: elsewhere, icon192Url: otherProject, icon512Url: otherBucket, appleIconUrl: null }, SB),
    ).toEqual({});
    expect(branchIconsMetadata(set(), undefined)).toEqual({});
  });
});

describe('getBranchIconMetadata', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads through the signed-in client and hands the layouts the branch's icons", async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SB);
    const { client } = fakeClient({ branches: [branchRow(OWN_SET)], brands: [] });
    vi.mocked(getServerClient).mockResolvedValue(client as never);
    expect(await getBranchIconMetadata(BRANCH)).toEqual({
      icons: {
        icon: [
          { url: file('icon-192-b1'), sizes: '192x192', type: 'image/png' },
          { url: file('icon-512-b1'), sizes: '512x512', type: 'image/png' },
        ],
        apple: file('icon-apple-180-b1'),
      },
    });
  });

  it('returns {} on a failed read', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SB);
    const { client } = fakeClient({ branches: [branchRow(OWN_SET)] }, { errors: ['branches'] });
    vi.mocked(getServerClient).mockResolvedValue(client as never);
    expect(await getBranchIconMetadata('b-error')).toEqual({});
  });
});

describe('the layouts that wear it', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  it.each(['app/b/[branchId]/layout.tsx', 'app/counter/[branchId]/layout.tsx', 'app/kitchen/[branchId]/layout.tsx'])(
    '%s returns the branch icon metadata and nothing else',
    (rel) => {
      const src = read(rel);
      const fn = /export async function generateMetadata\([^)]*\)[^{]*\{([\s\S]*?)\r?\n\}/.exec(src);
      expect(fn, `${rel} has no generateMetadata`).not.toBeNull();
      expect(fn?.[1]).toMatch(/return getBranchIconMetadata\(branchId\);/);
      expect(fn?.[1]).not.toMatch(/manifest|title|applicationName/);
    },
  );

  it('leaves the FavorNoms icons and manifest on the root layout for every other admin page', () => {
    const root = read('app/layout.tsx');
    expect(root).toContain("manifest: '/manifest.webmanifest'");
    expect(root).toContain("apple: '/apple-touch-icon.png'");
  });
});
