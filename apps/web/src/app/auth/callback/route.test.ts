// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The OAuth landing pad with `next` at either form of a storefront's address
 * (docs/SHORT-STOREFRONT-URLS-2026-10-26.md): where the diner is sent, where a failure bounces,
 * and which branch the customer row is made at.
 */
const ORIGIN = 'https://app.favornoms.com';
const HAMBURGER = { restaurant_slug: 'demo-favornoms', branch_slug: 'brooklyn', public_slug: 'hamburger' };

const state = vi.hoisted(() => ({
  resolve: null as null | ((args: Record<string, unknown>) => { data: unknown; error: unknown }),
  exchangeError: null as unknown,
  provisioned: [] as string[],
  tenantsAsked: [] as string[],
}));

vi.mock('@favornoms/database/server', () => ({
  getServerClient: async () => ({
    auth: { exchangeCodeForSession: async () => ({ error: state.exchangeError }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'resolve_storefront_path') {
        return state.resolve ? state.resolve(args) : { data: null, error: { message: 'no function' } };
      }
      if (fn === 'provision_customer_for_branch') state.provisioned.push(String(args.p_branch_id));
      return { data: null, error: null };
    },
  }),
}));

vi.mock('@favornoms/database/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@favornoms/database/queries')>();
  return {
    ...actual,
    // The long form names the branch; the test only needs to know which pair was read.
    resolveTenantBySlug: async (_sb: unknown, restaurant: string, branch: string) => {
      state.tenantsAsked.push(`${restaurant}/${branch}`);
      return restaurant === 'demo-favornoms' && branch === 'brooklyn' ? { branch: { id: 'branch-44' } } : null;
    },
  };
});

import { GET } from './route';

const callback = (query: Record<string, string>) => {
  const url = new URL('/auth/callback', ORIGIN);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return GET(new NextRequest(url));
};

beforeEach(() => {
  state.resolve = null;
  state.exchangeError = null;
  state.provisioned = [];
  state.tenantsAsked = [];
});

describe('the OAuth callback and a short address', () => {
  it('provisions at the branch behind a web address and lands the diner back on it', async () => {
    state.resolve = () => ({ data: [{ status: 'short', ...HAMBURGER, segments: 1 }], error: null });
    const res = await callback({ code: 'c', next: '/r/hamburger/checkout' });
    expect(res.headers.get('location')).toBe(`${ORIGIN}/r/hamburger/checkout`);
    expect(state.tenantsAsked).toEqual(['demo-favornoms/brooklyn']);
    expect(state.provisioned).toEqual(['branch-44']);
  });

  it('asks about the head of `next`, never its query string', async () => {
    const asked: unknown[] = [];
    state.resolve = (args) => {
      asked.push(args);
      return { data: [{ status: 'short', ...HAMBURGER, segments: 1 }], error: null };
    };
    await callback({ code: 'c', next: '/r/hamburger?t=abc' });
    expect(asked).toEqual([{ p_first: 'hamburger', p_second: null }]);
  });

  it('sends a sign-in started at the long form straight to the short one, query kept', async () => {
    state.resolve = () => ({ data: [{ status: 'redirect', ...HAMBURGER, segments: 2 }], error: null });
    const res = await callback({ code: 'c', next: '/r/demo-favornoms/brooklyn/checkout?t=abc' });
    expect(res.headers.get('location')).toBe(`${ORIGIN}/r/hamburger/checkout?t=abc`);
    expect(state.provisioned).toEqual(['branch-44']);
  });

  it('bounces a failure to the sign-in page at the public base, carrying `next`', async () => {
    state.resolve = () => ({ data: [{ status: 'short', ...HAMBURGER, segments: 1 }], error: null });
    const res = await callback({ next: '/r/hamburger/checkout' });
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/r/hamburger/sign-in');
    expect(location.searchParams.get('error')).toBe('missing_code');
    expect(location.searchParams.get('next')).toBe('/r/hamburger/checkout');
    expect(state.provisioned).toEqual([]);
  });

  it('reads a long-form pair as it stands when the database cannot say', async () => {
    const res = await callback({ code: 'c', next: '/r/demo-favornoms/brooklyn/cart' });
    expect(res.headers.get('location')).toBe(`${ORIGIN}/r/demo-favornoms/brooklyn/cart`);
    expect(state.provisioned).toEqual(['branch-44']);
  });

  it('provisions nothing for an address nothing answers to, and still lands on `next`', async () => {
    state.resolve = () => ({ data: [{ status: 'none' }], error: null });
    const res = await callback({ code: 'c', next: '/r/nobody/here' });
    expect(res.headers.get('location')).toBe(`${ORIGIN}/r/nobody/here`);
    expect(state.tenantsAsked).toEqual([]);
    expect(state.provisioned).toEqual([]);
  });
});
