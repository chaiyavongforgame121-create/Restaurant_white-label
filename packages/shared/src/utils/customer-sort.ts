// Sort vocabulary for the merchant Customers list. It lives here because three
// places have to agree on it: the database helper that builds the ORDER BY, the
// page that draws the header carets, and the client control that writes the URL.

export const CUSTOMER_SORT_KEYS = ['spent', 'orders', 'last_seen', 'name', 'joined'] as const;
export type CustomerSortKey = (typeof CUSTOMER_SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export interface CustomerSort {
  sort: CustomerSortKey;
  dir: SortDir;
}

export interface CustomerListParams extends CustomerSort {
  page: number;
}

export const DEFAULT_CUSTOMER_SORT: CustomerSortKey = 'spent';

/** The public.customers column each key orders by. */
export const CUSTOMER_SORT_COLUMNS = {
  spent: 'total_spent',
  orders: 'total_orders',
  last_seen: 'last_order_at',
  name: 'full_name',
  joined: 'created_at',
} as const satisfies Record<CustomerSortKey, string>;

export const CUSTOMER_SORT_OPTIONS: ReadonlyArray<{ value: CustomerSortKey; label: string }> = [
  { value: 'spent', label: 'Spend' },
  { value: 'orders', label: 'Orders' },
  { value: 'last_seen', label: 'Last seen' },
  { value: 'name', label: 'Name' },
  { value: 'joined', label: 'Joined' },
];

/** Names read A→Z; every number and date reads biggest or newest first. */
export function defaultDirFor(key: CustomerSortKey): SortDir {
  return key === 'name' ? 'asc' : 'desc';
}

/**
 * Tolerant read of raw search params: a hand-edited, stale or truncated URL
 * degrades to the default order instead of throwing at a merchant mid-service.
 */
export function parseCustomerSort(input: {
  sort?: string;
  dir?: string;
  page?: string;
}): CustomerListParams {
  const sort = (CUSTOMER_SORT_KEYS as readonly string[]).includes(input.sort ?? '')
    ? (input.sort as CustomerSortKey)
    : DEFAULT_CUSTOMER_SORT;
  const dir: SortDir = input.dir === 'asc' || input.dir === 'desc' ? input.dir : defaultDirFor(sort);
  const page = Math.max(1, Math.floor(Number(input.page) || 1));
  return { sort, dir, page };
}

/**
 * Query string for a sort state, with the defaults omitted so the canonical URL
 * of the list stays bare and only a deliberate choice survives into a shared link.
 */
export function customerSortQuery(state: CustomerSort & { page?: number }): string {
  const sp = new URLSearchParams();
  if (state.sort !== DEFAULT_CUSTOMER_SORT) sp.set('sort', state.sort);
  if (state.dir !== defaultDirFor(state.sort)) sp.set('dir', state.dir);
  if (state.page && state.page > 1) sp.set('page', String(state.page));
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}
