// The web address queries (docs/SHORT-STOREFRONT-URLS-2026-10-26.md §1): what each one sends and how
// it reads the answer. A hand-rolled client stands in for supabase-js; the SQL itself is pinned by
// supabase/tests/branch_public_slugs.sql.
import { describe, expect, it } from 'vitest';
import type { FavornomsClient } from '../client-type';
import { checkPublicSlug, parsePublicSlugCheck, publicSlugRefusal, setBranchPublicSlug } from './public-slug';

const BRANCH = '44444444-4444-4444-4444-444444444444';

type Answer = { data: unknown; error: { message: string; code?: string } | null };

function fakeClient(answer: Answer) {
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return answer;
    },
  };
  return { client: client as unknown as FavornomsClient, rpcs };
}

describe('publicSlugRefusal', () => {
  it('names each refusal the two RPCs answer with', () => {
    for (const code of ['slug_invalid', 'slug_reserved', 'slug_taken', 'not_authorized', 'sign_in_required', 'branch_not_found']) {
      expect(publicSlugRefusal({ message: code })).toBe(code);
    }
  });

  it('is null for anything else', () => {
    expect(publicSlugRefusal({ message: 'duplicate key value violates unique constraint "branches_public_slug_uidx"' })).toBeNull();
    expect(publicSlugRefusal({ message: 'branch_privileged_column_forbidden' })).toBeNull();
    expect(publicSlugRefusal(null)).toBeNull();
    expect(publicSlugRefusal({})).toBeNull();
  });
});

describe('parsePublicSlugCheck', () => {
  it('reads an available address, a refused one, and "no web address"', () => {
    expect(parsePublicSlugCheck({ slug: 'hamburger', available: true, error: null, current: false }))
      .toEqual({ slug: 'hamburger', available: true, error: null, current: false });
    expect(parsePublicSlugCheck({ slug: 'demo-favornoms', available: false, error: 'slug_taken', current: false }))
      .toEqual({ slug: 'demo-favornoms', available: false, error: 'slug_taken', current: false });
    expect(parsePublicSlugCheck({ slug: null, available: true, error: null, current: true }))
      .toEqual({ slug: null, available: true, error: null, current: true });
  });

  it('is null for anything that is not that answer', () => {
    expect(parsePublicSlugCheck(null)).toBeNull();
    expect(parsePublicSlugCheck([])).toBeNull();
    expect(parsePublicSlugCheck({ slug: 'x', available: 'yes', current: false })).toBeNull();
    expect(parsePublicSlugCheck({ slug: 'x', available: false, error: 'nope', current: false })).toBeNull();
  });
});

describe('checkPublicSlug', () => {
  it('asks about what was typed, and about "no web address" with a blank', async () => {
    const { client, rpcs } = fakeClient({ data: { slug: 'pho-ha-noi', available: true, error: null, current: false }, error: null });
    await expect(checkPublicSlug(client, BRANCH, 'Pho-Ha-Noi')).resolves.toEqual({
      slug: 'pho-ha-noi',
      available: true,
      error: null,
      current: false,
    });
    await checkPublicSlug(client, BRANCH, null);
    expect(rpcs).toEqual([
      { fn: 'check_public_slug', args: { p_branch_id: BRANCH, p_slug: 'Pho-Ha-Noi' } },
      { fn: 'check_public_slug', args: { p_branch_id: BRANCH, p_slug: '' } },
    ]);
  });

  it('throws a refusal as the database error', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'not_authorized', code: '42501' } });
    await expect(checkPublicSlug(client, BRANCH, 'x')).rejects.toMatchObject({ message: 'not_authorized' });
  });
});

describe('setBranchPublicSlug', () => {
  it('saves and answers the address and the public base', async () => {
    const { client, rpcs } = fakeClient({ data: { public_slug: 'hamburger', path: '/r/hamburger' }, error: null });
    await expect(setBranchPublicSlug(client, BRANCH, 'hamburger')).resolves.toEqual({ publicSlug: 'hamburger', path: '/r/hamburger' });
    expect(rpcs).toEqual([{ fn: 'set_branch_public_slug', args: { p_branch_id: BRANCH, p_slug: 'hamburger' } }]);
  });

  it('clears with null (sent as a blank) and answers the long form', async () => {
    const { client, rpcs } = fakeClient({ data: { public_slug: null, path: '/r/demo-favornoms/brooklyn' }, error: null });
    await expect(setBranchPublicSlug(client, BRANCH, null)).resolves.toEqual({ publicSlug: null, path: '/r/demo-favornoms/brooklyn' });
    expect(rpcs[0]?.args).toEqual({ p_branch_id: BRANCH, p_slug: '' });
  });

  it('throws each refusal as the database error, readable by publicSlugRefusal', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'slug_taken', code: '23505' } });
    const error = await setBranchPublicSlug(client, BRANCH, 'demo-favornoms').catch((e: unknown) => e);
    expect(publicSlugRefusal(error as { message: string })).toBe('slug_taken');
  });

  it('throws on an answer it cannot read', async () => {
    const { client } = fakeClient({ data: { public_slug: 'x', path: 'https://evil.example' }, error: null });
    await expect(setBranchPublicSlug(client, BRANCH, 'x')).rejects.toThrow('unexpected answer');
  });
});
