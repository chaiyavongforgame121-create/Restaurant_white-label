import { CUSTOMER_SORT_COLUMNS, type CustomerListParams } from '@favornoms/shared';
import type { FavornomsClient } from '../client-type';

// Merchant-facing reads of public.customers. A row belongs to the branch it was
// created at, but its aggregates (total_orders / total_spent / last_order_at) are
// maintained restaurant-wide by a database trigger — so "customers at this branch"
// means "diners who first appeared here", not "diners who only order here".

export interface BranchCustomer {
  id: string;
  full_name: string | null;
  phone: string | null;
  total_orders: number;
  total_spent: number;
  last_order_at: string | null;
  created_at: string;
}

export interface BranchCustomersResult {
  customers: BranchCustomer[];
  /** Exact number of rows at this branch — not the length of this page. */
  total: number;
  page: number;
  pageSize: number;
  error: string | null;
}

export const CUSTOMERS_PAGE_SIZE = 50;

/**
 * One page of a branch's customers, ordered and paged in the database.
 *
 * Ordering has to happen server-side or it is a lie: sorting a capped slice would
 * show the alphabetically-first names *among the biggest spenders* rather than the
 * true first page A→Z. `nullsFirst: false` on every key because Postgres puts NULLs
 * first on DESC, which parked never-ordered customers above the best ones; unnamed
 * rows and "Never" rows belong at the bottom whichever way the list is read. `id` is
 * the tiebreak so pages stay stable when many rows share a value — every customer
 * starts life with total_spent = 0.
 *
 * Errors are returned rather than swallowed: an RLS denial (no `customers.view`)
 * must not read as an empty branch.
 */
export async function listBranchCustomers(
  supabase: FavornomsClient,
  branchId: string,
  { sort, dir, page }: CustomerListParams,
  pageSize = CUSTOMERS_PAGE_SIZE,
): Promise<BranchCustomersResult> {
  const from = (page - 1) * pageSize;
  const { data, count, error } = await supabase
    .from('customers')
    .select('id, full_name, phone, total_orders, total_spent, last_order_at, created_at', {
      count: 'exact',
    })
    .eq('branch_id', branchId)
    .order(CUSTOMER_SORT_COLUMNS[sort], { ascending: dir === 'asc', nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, from + pageSize - 1);

  if (error) {
    return {
      customers: [],
      total: 0,
      page,
      pageSize,
      error: `${error.message}${error.code ? ` (${error.code})` : ''}`,
    };
  }

  // total_orders / total_spent are NOT NULL with a default today, but rows written
  // before the aggregate trigger existed can still carry nulls.
  const customers: BranchCustomer[] = (data ?? []).map((c) => ({
    id: c.id,
    full_name: c.full_name,
    phone: c.phone,
    total_orders: Number(c.total_orders ?? 0),
    total_spent: Number(c.total_spent ?? 0),
    last_order_at: c.last_order_at,
    created_at: c.created_at,
  }));

  return { customers, total: count ?? customers.length, page, pageSize, error: null };
}
