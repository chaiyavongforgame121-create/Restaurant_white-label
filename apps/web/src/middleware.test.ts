// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The middleware against a stand-in for public.resolve_storefront_path (20261026120000): what it
 * rewrites, what it 308s, what it remembers. Each test loads it afresh, so its per-instance cache
 * starts empty.
 */
const ORIGIN = 'https://app.favornoms.com';
const HAMBURGER = { restaurant_slug: 'demo-favornoms', branch_slug: 'brooklyn', public_slug: 'hamburger' };

function answer(first: string, second: string | null): Record<string, unknown> {
  if (first === 'hamburger') return { status: 'short', ...HAMBURGER, segments: 1 };
  if (first === 'old-burger') return { status: 'redirect', ...HAMBURGER, segments: 1 };
  if ((first === 'demo-favornoms' || first === 'coastal-grill') && second === 'brooklyn') {
    return { status: 'redirect', ...HAMBURGER, segments: 2 };
  }
  if (first === 'sample' && second === 'main') {
    return { status: 'live', restaurant_slug: 'sample', branch_slug: 'main', public_slug: null, segments: 2 };
  }
  return { status: 'none' };
}

const asked: Array<{ p_first: string; p_second: string | null }> = [];
/** When set, how the database answers instead: an error status, another answer, or a throw (a failed fetch). */
let instead: (() => Response) | null = null;

beforeEach(() => {
  vi.resetModules();
  asked.length = 0;
  instead = null;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { p_first: string; p_second: string | null };
      asked.push(body);
      if (instead) return instead();
      return new Response(JSON.stringify([answer(body.p_first, body.p_second)]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function load() {
  const { middleware } = await import('./middleware');
  return (path: string, headers?: Record<string, string>) =>
    middleware(new NextRequest(new URL(path, ORIGIN), { headers }));
}

/** A request header the middleware hands the app (NextResponse.next/rewrite({ request })). */
const forwarded = (res: Response, name: string) =>
  (res.headers.get('x-middleware-override-headers') ?? '').split(',').includes(name)
    ? res.headers.get(`x-middleware-request-${name}`)
    : null;

describe('a web address', () => {
  it('is served from the long form, the browser keeping its URL and its query string', async () => {
    const run = await load();
    const res = await run('/r/hamburger/cart?t=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/r/demo-favornoms/brooklyn/cart?t=abc`);
    expect(forwarded(res, 'x-favornoms-public-base')).toBe('/r/hamburger');
    expect(forwarded(res, 'x-favornoms-pathname')).toBe('/r/hamburger/cart');
    expect(forwarded(res, 'x-favornoms-search')).toBe('?t=abc');
  });

  it('is served at its menu, its manifest and its icons', async () => {
    const run = await load();
    expect((await run('/r/hamburger')).headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/r/demo-favornoms/brooklyn`);
    expect((await run('/r/hamburger/manifest.webmanifest')).headers.get('x-middleware-rewrite')).toBe(
      `${ORIGIN}/r/demo-favornoms/brooklyn/manifest.webmanifest`,
    );
    expect((await run('/r/hamburger/app-icon/192?v=1')).headers.get('x-middleware-rewrite')).toBe(
      `${ORIGIN}/r/demo-favornoms/brooklyn/app-icon/192?v=1`,
    );
  });

  it('is asked about once, whatever page follows it', async () => {
    const run = await load();
    await run('/r/hamburger');
    await run('/r/hamburger/cart');
    await run('/r/hamburger/orders/A-12');
    expect(asked).toEqual([{ p_first: 'hamburger', p_second: null }]);
  });

  it('ignores a public base a client sent itself', async () => {
    const run = await load();
    const res = await run('/r/nobody/here', { 'x-favornoms-public-base': '/r/hamburger' });
    expect(forwarded(res, 'x-favornoms-public-base')).toBeNull();
  });
});

describe('an address that moved', () => {
  it('308s the long form of a branch with a web address there, path and query kept, never cached', async () => {
    const run = await load();
    const res = await run('/r/demo-favornoms/brooklyn/cart?t=abc&x=1');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/r/hamburger/cart?t=abc&x=1`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await run('/r/demo-favornoms/brooklyn/cart');
    expect(asked).toHaveLength(2);
  });

  it('308s an old restaurant slug and an old web address to the short form', async () => {
    const run = await load();
    const restaurant = await run('/r/coastal-grill/brooklyn?payment_intent=pi_1&redirect_status=succeeded');
    expect(restaurant.headers.get('location')).toBe(
      `${ORIGIN}/r/hamburger?payment_intent=pi_1&redirect_status=succeeded`,
    );
    const web = await run('/r/old-burger/orders/A-12');
    expect(web.status).toBe(308);
    expect(web.headers.get('location')).toBe(`${ORIGIN}/r/hamburger/orders/A-12`);
  });
});

describe('everything else', () => {
  it('passes a live long form through with its base, and remembers it', async () => {
    const run = await load();
    const res = await run('/r/sample/main/cart');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(forwarded(res, 'x-favornoms-public-base')).toBe('/r/sample/main');
    await run('/r/sample/main');
    expect(asked).toEqual([{ p_first: 'sample', p_second: 'main' }]);
  });

  it('leaves an unknown address to the route, and remembers that too for a while', async () => {
    const run = await load();
    const res = await run('/r/nobody/here');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    await run('/r/nobody/here');
    expect(asked).toHaveLength(1);
  });

  it('asks nothing off the storefront', async () => {
    const run = await load();
    await run('/privacy');
    await run('/');
    expect(asked).toEqual([]);
  });
});

describe('when the database cannot answer', () => {
  const MINUTE = 60_000;
  const rewriteOf = (res: Response) => res.headers.get('x-middleware-rewrite');
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  /** Learns 'hamburger', then lets its five-minute entry run out. */
  async function knownThenExpired() {
    vi.useFakeTimers({ toFake: ['Date'] });
    const run = await load();
    await run('/r/hamburger');
    vi.setSystemTime(Date.now() + 6 * MINUTE);
    return run;
  }

  it('keeps serving a web address it knew through a 503, and does not stop asking', async () => {
    const run = await knownThenExpired();
    instead = () => json(503, { code: 'PGRST002', message: 'Could not query the database for the schema cache' });
    const res = await run('/r/hamburger/cart?t=abc');
    expect(rewriteOf(res)).toBe(`${ORIGIN}/r/demo-favornoms/brooklyn/cart?t=abc`);
    expect(forwarded(res, 'x-favornoms-public-base')).toBe('/r/hamburger');
    // No backoff: an address it never saw is still asked about, and the stale entry was not
    // re-armed, so the next request for it asks again too.
    instead = null;
    await run('/r/sample/main');
    await run('/r/hamburger');
    expect(asked.map((a) => a.p_first)).toEqual(['hamburger', 'hamburger', 'sample', 'hamburger']);
  });

  it('does not fall back on a web address the database has since said is gone', async () => {
    const run = await knownThenExpired();
    // The address was cleared and nothing answers to it any more; then the database blips.
    instead = () => json(200, [{ status: 'none' }]);
    expect(rewriteOf(await run('/r/hamburger'))).toBeNull();
    instead = () => json(503, {});
    expect(rewriteOf(await run('/r/hamburger/cart'))).toBeNull();
  });

  it.each([
    ['a 404', () => new Response('Not Found', { status: 404 })],
    ['PGRST202', () => json(400, { code: 'PGRST202', message: 'Could not find the function' })],
  ])('stops asking for a minute when the function is missing (%s), still serving what it knew', async (_name, missing) => {
    const run = await knownThenExpired();
    instead = missing;
    expect(rewriteOf(await run('/r/sample/main'))).toBeNull();
    expect(asked).toHaveLength(2);
    // The minute: nothing is asked, and the web address it knew is still served.
    instead = null;
    expect(rewriteOf(await run('/r/hamburger/cart'))).toBe(`${ORIGIN}/r/demo-favornoms/brooklyn/cart`);
    expect(rewriteOf(await run('/r/nobody/here'))).toBeNull();
    expect(asked).toHaveLength(2);
    // After it, it asks again.
    vi.setSystemTime(Date.now() + MINUTE + 1);
    await run('/r/hamburger');
    expect(asked).toHaveLength(3);
  });

  it('does not stop asking when a fetch throws, and serves what it knew meanwhile', async () => {
    const run = await knownThenExpired();
    instead = () => {
      throw new TypeError('fetch failed');
    };
    expect(rewriteOf(await run('/r/hamburger'))).toBe(`${ORIGIN}/r/demo-favornoms/brooklyn`);
    expect(rewriteOf(await run('/r/sample/main'))).toBeNull();
    instead = null;
    expect(forwarded(await run('/r/sample/main'), 'x-favornoms-public-base')).toBe('/r/sample/main');
    expect(asked).toHaveLength(4);
  });
});
