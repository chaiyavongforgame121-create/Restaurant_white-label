import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_SORT_COLUMNS,
  CUSTOMER_SORT_KEYS,
  customerSortQuery,
  parseCustomerSort,
} from './customer-sort';

describe('parseCustomerSort', () => {
  it('defaults to lifetime spend, descending, page 1', () => {
    expect(parseCustomerSort({})).toEqual({ sort: 'spent', dir: 'desc', page: 1 });
  });

  it('starts a name sort ascending', () => {
    expect(parseCustomerSort({ sort: 'name' })).toEqual({ sort: 'name', dir: 'asc', page: 1 });
  });

  // A hand-edited URL must never 400 or 500 the list.
  it('falls back on an unknown sort and direction', () => {
    expect(parseCustomerSort({ sort: 'drop table', dir: 'sideways' })).toEqual({
      sort: 'spent',
      dir: 'desc',
      page: 1,
    });
  });

  it.each([
    ['0', 1],
    ['-3', 1],
    ['abc', 1],
    ['', 1],
    ['2.9', 2],
  ])('clamps page %j to %i', (raw: string, expected: number) => {
    expect(parseCustomerSort({ page: raw }).page).toBe(expected);
  });

  it('keeps an explicit direction that is not the key default', () => {
    expect(parseCustomerSort({ sort: 'last_seen', dir: 'asc', page: '4' })).toEqual({
      sort: 'last_seen',
      dir: 'asc',
      page: 4,
    });
  });

  // A key with no column would silently order by whatever PostgREST defaults to.
  it('has a column for every key', () => {
    expect(Object.keys(CUSTOMER_SORT_COLUMNS).sort()).toEqual([...CUSTOMER_SORT_KEYS].sort());
  });
});

describe('customerSortQuery', () => {
  it('is empty for the defaults', () => {
    expect(customerSortQuery({ sort: 'spent', dir: 'desc', page: 1 })).toBe('');
  });

  it('omits a direction that is already the key default', () => {
    expect(customerSortQuery({ sort: 'name', dir: 'asc' })).toBe('?sort=name');
  });

  it('round-trips through parse', () => {
    const state = { sort: 'last_seen', dir: 'asc', page: 3 } as const;
    const url = new URLSearchParams(customerSortQuery(state));
    expect(
      parseCustomerSort({
        sort: url.get('sort') ?? undefined,
        dir: url.get('dir') ?? undefined,
        page: url.get('page') ?? undefined,
      }),
    ).toEqual(state);
  });
});
