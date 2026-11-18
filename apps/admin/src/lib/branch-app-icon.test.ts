import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerClient } from '@favornoms/database/server';
import { GET as getBranchIcon } from '@/app/api/branch-icon/[branchId]/[variant]/route';
import {
  branchIconsMetadata,
  branchTabIconSource,
  getBranchIconMetadata,
  isOwnBrandingFile,
  readBranchAppIcons,
  urlFingerprint,
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
// A UUID: the icon route answers nothing else.
const BRANCH = '6f1c2b0e-3d4a-4e5f-8a9b-0c1d2e3f4a5b';
const route = (variant: string, v?: string) =>
  `/api/branch-icon/${BRANCH}/${variant}${v === undefined ? '' : `?v=${v}`}`;

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

describe('branchIconsMetadata: same-origin tab icon links', () => {
  const set = (over: Partial<BranchAppIcons> = {}): BranchAppIcons => ({
    faviconUrl: file('favicon'),
    icon192Url: file('icon-192'),
    icon512Url: file('icon-512'),
    appleIconUrl: file('icon-apple-180'),
    ...over,
  });
  const iconList = (icons: BranchAppIcons) =>
    (branchIconsMetadata(BRANCH, icons, SB).icons as { icon: Array<{ url: string }> }).icon;

  it('offers the tab a same-origin 32x32 first, then the 192, both keyed to the 192 they come from', () => {
    const v = urlFingerprint(file('icon-192'));
    expect(branchIconsMetadata(BRANCH, set(), SB)).toEqual({
      icons: {
        icon: [
          { url: route('favicon-32', v), sizes: '32x32', type: 'image/png' },
          { url: route('192', v), sizes: '192x192', type: 'image/png' },
        ],
        apple: file('icon-apple-180'),
      },
    });
  });

  it('never links the tab to the storage host: the cross-origin PNGs are what Chrome showed as a globe', () => {
    for (const icons of [set(), set({ icon192Url: null }), set({ icon512Url: null })]) {
      const list = iconList(icons);
      expect(list.length).toBeGreaterThan(0);
      for (const { url } of list) expect(url.startsWith(`/api/branch-icon/${BRANCH}/`)).toBe(true);
    }
  });

  it('serves a legacy favicon as one link with no sizes: it has no known size to claim', () => {
    expect(branchIconsMetadata(BRANCH, set({ icon192Url: null, icon512Url: null, appleIconUrl: null }), SB)).toEqual({
      icons: {
        icon: [{ url: route('192', urlFingerprint(file('favicon'))), type: 'image/png' }],
        apple: file('favicon'),
      },
    });
  });

  it('changes the ?v= exactly when the source file changes', () => {
    const v = (icons: BranchAppIcons) =>
      new URL(iconList(icons)[0]!.url, 'https://admin.test').searchParams.get('v');
    expect(v(set())).toBe(v(set({ icon512Url: null, faviconUrl: null, appleIconUrl: null })));
    expect(v(set({ icon192Url: file('icon-192-new-upload') }))).not.toBe(v(set()));
  });

  it("keeps the iPhone icon on the merchant's own file: the opaque apple icon, else the 192, else the favicon", () => {
    const apple = (icons: BranchAppIcons) =>
      (branchIconsMetadata(BRANCH, icons, SB).icons as { apple?: unknown } | undefined)?.apple;
    expect(apple(set())).toBe(file('icon-apple-180'));
    expect(apple(set({ appleIconUrl: null }))).toBe(file('icon-192'));
    expect(apple(set({ appleIconUrl: null, icon192Url: null }))).toBe(file('favicon'));
  });

  it('returns nothing to override when there is no tab icon, so the FavorNoms icons stay', () => {
    expect(branchIconsMetadata(BRANCH, null, SB)).toEqual({});
    expect(
      branchIconsMetadata(BRANCH, { faviconUrl: null, icon192Url: null, icon512Url: null, appleIconUrl: null }, SB),
    ).toEqual({});
    // A 512 alone is no tab icon on the storefront either.
    expect(branchIconsMetadata(BRANCH, set({ faviconUrl: null, icon192Url: null }), SB)).toEqual({});
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

    const v = urlFingerprint(file('icon-192'));
    expect(branchIconsMetadata(BRANCH, set({ appleIconUrl: elsewhere }), SB)).toEqual({
      icons: {
        icon: [
          { url: route('favicon-32', v), sizes: '32x32', type: 'image/png' },
          { url: route('192', v), sizes: '192x192', type: 'image/png' },
        ],
        apple: file('icon-192'),
      },
    });
    // A foreign 192 falls through to the own favicon, never to the foreign file.
    expect(branchTabIconSource(set({ icon192Url: otherProject }), SB)).toEqual({ url: file('favicon'), sized: false });
    expect(
      branchIconsMetadata(
        BRANCH,
        { faviconUrl: elsewhere, icon192Url: otherProject, icon512Url: otherBucket, appleIconUrl: null },
        SB,
      ),
    ).toEqual({});
    expect(branchIconsMetadata(BRANCH, set(), undefined)).toEqual({});
  });
});

describe('urlFingerprint', () => {
  it("is FNV-1a 32-bit hex, the storefront's urlFingerprint (apps/web/src/lib/app-identity.ts)", () => {
    // The published FNV-1a 32-bit test vectors.
    expect(urlFingerprint('')).toBe('811c9dc5');
    expect(urlFingerprint('a')).toBe('e40c292c');
    expect(urlFingerprint('foobar')).toBe('bf9cf968');
    expect(urlFingerprint(file('icon-192'))).toMatch(/^[0-9a-f]{8}$/);
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
    const v = urlFingerprint(file('icon-192-b1'));
    expect(await getBranchIconMetadata(BRANCH)).toEqual({
      icons: {
        icon: [
          { url: route('favicon-32', v), sizes: '32x32', type: 'image/png' },
          { url: route('192', v), sizes: '192x192', type: 'image/png' },
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

describe('GET /api/branch-icon/<branchId>/<variant>', () => {
  const ADMIN = 'https://admin.favornoms.test';
  // The admin's own 192x192 FavorNoms PNG stands in for a merchant's upload.
  const PNG_192 = fs.readFileSync(path.resolve(__dirname, '../../public/icon-192.png'));
  type Upstream = (url: string) => Response | Promise<Response>;
  const pngUpstream: Upstream = () => new Response(PNG_192, { headers: { 'content-type': 'image/png' } });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** Signs in a reader of `tables` and answers the storage fetch with `upstream`. */
  function serve(tables: Record<string, Row[]>, upstream: Upstream = pngUpstream) {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SB);
    const fake = fakeClient(tables);
    vi.mocked(getServerClient).mockResolvedValue(fake.client as never);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => upstream(String(input)));
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, reads: fake.reads };
  }

  const get = (variant: string, opts: { v?: string; branchId?: string } = {}) => {
    const branchId = opts.branchId ?? BRANCH;
    const qs = opts.v === undefined ? '' : `?v=${opts.v}`;
    return getBranchIcon(new Request(`${ADMIN}/api/branch-icon/${branchId}/${variant}${qs}`), {
      params: Promise.resolve({ branchId, variant }),
    });
  };

  const pngSize = async (res: Response) => {
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  };

  it("proxies the merchant's 192 same-origin, read with the signed-in user's RLS and fetched uncached", async () => {
    const { fetchMock, reads } = serve({ branches: [branchRow(OWN_SET)], brands: [] });
    const res = await get('192', { v: urlFingerprint(file('icon-192-b1')) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_192)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(file('icon-192-b1'), { cache: 'no-store' });
    expect(reads[0]).toEqual({ table: 'branches', filters: [['id', BRANCH]] });
  });

  it('renders the favicon-32 as a real 32x32 PNG from the 192', async () => {
    serve({ branches: [branchRow(OWN_SET)], brands: [] });
    const res = await get('favicon-32', { v: urlFingerprint(file('icon-192-b1')) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await pngSize(res)).toEqual([32, 32]);
  });

  it('pins the bytes only for the fingerprint of the current file, and never in a shared cache', async () => {
    const tables = { branches: [branchRow(OWN_SET)], brands: [] };
    const current = urlFingerprint(file('icon-192-b1'));
    for (const variant of ['192', 'favicon-32']) {
      serve(tables);
      expect((await get(variant, { v: current })).headers.get('cache-control')).toBe(
        'private, max-age=31536000, immutable',
      );
      serve(tables);
      expect((await get(variant, { v: 'deadbeef' })).headers.get('cache-control')).toBe('private, no-cache');
      serve(tables);
      expect((await get(variant)).headers.get('cache-control')).toBe('private, no-cache');
    }
  });

  it('serves a set with no 192 from its own legacy favicon', async () => {
    const { fetchMock } = serve({
      branches: [branchRow()],
      brands: [brandRow({ favicon_url: file('favicon-brand') })],
    });
    const res = await get('192', { v: urlFingerprint(file('favicon-brand')) });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(fetchMock).toHaveBeenCalledWith(file('favicon-brand'), { cache: 'no-store' });
  });

  it.each([
    ['an unknown variant', '512', BRANCH],
    ['a path-like variant', '..', BRANCH],
    ['a branch id that is not a UUID', '192', 'b1'],
  ])('answers 404 to %s without reading anything', async (_label, variant, branchId) => {
    const { fetchMock, reads } = serve({ branches: [branchRow(OWN_SET)], brands: [] });
    expect((await get(variant, { branchId })).status).toBe(404);
    expect(reads).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const fallbacks: Array<[string, Record<string, Row[]>, Upstream?]> = [
    ['there is no set (or RLS hides the branch)', { branches: [], brands: [] }],
    [
      'the file is outside the branding bucket',
      { branches: [branchRow({ icon_192_url: 'https://tracker.example/pixel.png' })], brands: [] },
    ],
    [
      'the fetch fails',
      { branches: [branchRow(OWN_SET)], brands: [] },
      () => Promise.reject(new TypeError('fetch failed')),
    ],
    ['storage answers 404', { branches: [branchRow(OWN_SET)], brands: [] }, () => new Response('nope', { status: 404 })],
    [
      'the file is not a PNG',
      { branches: [branchRow(OWN_SET)], brands: [] },
      () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    ],
  ];

  it.each(fallbacks)("redirects to the admin's own FavorNoms icon when %s", async (_label, tables, upstream) => {
    for (const [variant, own] of [
      ['favicon-32', '/favicon-32.png'],
      ['192', '/icon-192.png'],
    ] as const) {
      const { fetchMock } = serve(tables, upstream);
      const res = await get(variant, { v: urlFingerprint(file('icon-192-b1')) });
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(`${ADMIN}${own}`);
      expect(res.headers.get('cache-control')).toBe('private, no-cache');
      // Nothing outside the branding bucket is ever fetched.
      for (const [url] of fetchMock.mock.calls) expect(isOwnBrandingFile(String(url), SB)).toBe(true);
    }
  });

  it('redirects the favicon-32 when the PNG cannot be rendered, instead of a broken 200', async () => {
    serve({ branches: [branchRow(OWN_SET)], brands: [] }, () =>
      new Response(Buffer.from('not really a png'), { headers: { 'content-type': 'image/png' } }),
    );
    const res = await get('favicon-32');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ADMIN}/favicon-32.png`);
  });
});

describe('the layouts that wear it', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  it.each(['app/b/[branchId]/layout.tsx', 'app/counter/[branchId]/layout.tsx', 'app/kitchen/[branchId]/layout.tsx'])(
    '%s clears the inherited icons in metadata and renders its own on every screen',
    (rel) => {
      const src = read(rel);
      const fn = /export async function generateMetadata\([^)]*\)[^{]*\{([\s\S]*?)\r?\n\}/.exec(src);
      expect(fn, `${rel} has no generateMetadata`).not.toBeNull();
      expect(fn?.[1]).toMatch(/return branchTabIconsMetadata\(branchId\);/);
      expect(fn?.[1]).not.toMatch(/manifest|title|applicationName/);
      // Beside the access watcher, which every screen of the layout renders (denied included).
      expect(src.match(/<BranchTabIcons branchId=\{branchId\} \/>/g)?.length).toBe(src.match(/\{watcher\}/g)?.length);
    },
  );

  it('leaves the FavorNoms icons and manifest on the root layout for every other admin page', () => {
    const root = read('app/layout.tsx');
    expect(root).toContain("manifest: '/manifest.webmanifest'");
    expect(root).toContain("apple: '/apple-touch-icon.png'");
  });
});
