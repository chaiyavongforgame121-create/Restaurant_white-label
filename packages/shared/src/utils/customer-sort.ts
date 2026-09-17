// Sort vocabulary for the merchant Customers list. It lives here because three
// places have to agree on it: the database helper that builds the ORDER BY, the
// page that draws the header carets, and the client control that writes the URL.

import { DEFAULT_UI_LOCALE, isUiLocale, type UiLocale } from '../i18n';

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

const CUSTOMER_SORT_LABELS: Record<UiLocale, Record<CustomerSortKey, string>> = {
  en: { spent: 'Spend', orders: 'Orders', last_seen: 'Last seen', name: 'Name', joined: 'Joined' },
  es: { spent: 'Gasto', orders: 'Pedidos', last_seen: 'Última visita', name: 'Nombre', joined: 'Registro' },
  vi: { spent: 'Chi tiêu', orders: 'Đơn hàng', last_seen: 'Ghé gần nhất', name: 'Tên', joined: 'Ngày tham gia' },
  th: { spent: 'ยอดใช้จ่าย', orders: 'ออร์เดอร์', last_seen: 'มาล่าสุด', name: 'ชื่อ', joined: 'วันที่สมัคร' },
};

/** The column header / picker label for a sort key, in `locale` (English when omitted). */
export function customerSortLabel(key: CustomerSortKey, locale: UiLocale = DEFAULT_UI_LOCALE): string {
  const loc = isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE;
  return CUSTOMER_SORT_LABELS[loc][key] ?? CUSTOMER_SORT_LABELS.en[key] ?? key;
}

/** The sort picker's options, labelled in `locale` (English when omitted). */
export function customerSortOptions(
  locale: UiLocale = DEFAULT_UI_LOCALE,
): ReadonlyArray<{ value: CustomerSortKey; label: string }> {
  return CUSTOMER_SORT_KEYS.map((value) => ({ value, label: customerSortLabel(value, locale) }));
}

/** English labels. Prefer customerSortOptions(locale) on screen. */
export const CUSTOMER_SORT_OPTIONS: ReadonlyArray<{ value: CustomerSortKey; label: string }> =
  customerSortOptions(DEFAULT_UI_LOCALE);

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
