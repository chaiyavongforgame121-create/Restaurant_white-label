import { CUSTOMER_SORT_COLUMNS, type CustomerListParams } from '@favornoms/shared';
import type { FavornomsClient } from '../client-type';

// Merchant-facing reads of public.customers. A row belongs to the branch it was
// created at, but its aggregates (total_orders / total_spent / last_order_at) are
// maintained restaurant-wide by a database trigger — so "customers at this branch"
// means "diners who first appeared here", not "diners who only order here".

/**
 * Saved addresses pulled back per customer. Six is enough to say "there are others"
 * honestly without turning a 50-row page into an address dump: the merchant sees the
 * top one and a count, and nobody on this branch has more than five.
 */
const SAVED_ADDRESS_EMBED_LIMIT = 6;

const joinAddressParts = (parts: unknown[]): string | null => {
  const clean = parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0);
  return clean.length > 0 ? clean.join(', ') : null;
};

export interface SavedAddressParts {
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

/** A public.customer_addresses row as one line. */
export function formatSavedAddress(address: SavedAddressParts | null | undefined): string | null {
  if (!address) return null;
  return joinAddressParts([
    address.address_line1,
    address.address_line2,
    address.city,
    address.state,
    address.postal_code,
  ]);
}

/**
 * An orders.delivery_address jsonb as one line. That snapshot uses `line1`/`line2`
 * where the address book uses `address_line1`/`address_line2`, which is why the two
 * cannot be one function. Same key list and same separator as formatReceiptAddress()
 * in the admin receipt builder, on purpose: a merchant reading a printed receipt and
 * the customers list must see one address, not two spellings of it. Drop-off extras
 * (notes, dropoff_pref, gate_code, room) are left out — they are instructions for a
 * single delivery, not where the diner lives.
 */
export function formatOrderAddress(json: unknown): string | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const address = json as Record<string, unknown>;
  return joinAddressParts([
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postal_code,
  ]);
}

export interface BranchCustomer {
  id: string;
  full_name: string | null;
  phone: string | null;
  total_orders: number;
  total_spent: number;
  last_order_at: string | null;
  created_at: string;
  /** One line, ready to render. Null when we know of no address at all. */
  address: string | null;
  /** 'delivered' = taken from the newest delivery order; 'saved' = from the address book. */
  address_source: 'delivered' | 'saved' | null;
  /** created_at of the order the address came from; null unless address_source is 'delivered'. */
  address_at: string | null;
  /** Saved addresses on file, capped by the embed, so the merchant knows there are others. */
  saved_address_count: number;
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

// PostgREST hands embedded relations back as arrays, but the loosened client type
// (SupabaseClient<Database, any, any>) cannot promise their shape, so the rows are
// re-described here rather than trusted.
interface EmbeddedAddress {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  is_default: boolean | null;
  created_at: string;
}

interface EmbeddedDeliveryOrder {
  delivery_address: unknown;
  created_at: string;
}

interface CustomerRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  total_orders: number | null;
  total_spent: number | null;
  last_order_at: string | null;
  created_at: string;
  customer_addresses?: unknown;
  orders?: unknown;
}

const asRows = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : value ? [value as T] : [];

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
 * The address rides along in the same request. Both relations are embedded rather
 * than fetched per row: PostgREST compiles an embedded order/limit into a LATERAL
 * join, so a page still costs ONE round trip however many customers are on it, and
 * the sorting and paging stay where they were — on `customers`.
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
    .select(
      'id, full_name, phone, total_orders, total_spent, last_order_at, created_at, ' +
        'customer_addresses(address_line1, address_line2, city, state, postal_code, is_default, created_at), ' +
        'orders(delivery_address, created_at)',
      { count: 'exact' },
    )
    .eq('branch_id', branchId)
    // Embedded filters without !inner: they trim the child rows and leave the parent
    // alone, so a customer who has never had a delivery still appears, with an empty
    // array. The channel filter is not optional — the checkout posts the typed address
    // on dine-in and pickup orders too, and "last delivered to" must not name a table.
    // orders.branch_id is pinned because orders_staff RLS is restaurant-wide: a manager
    // who staffs two branches would otherwise read a sister branch's delivery here.
    .eq('orders.branch_id', branchId)
    .eq('orders.channel', 'delivery')
    .not('orders.delivery_address', 'is', null)
    .order('created_at', { referencedTable: 'orders', ascending: false })
    .limit(1, { referencedTable: 'orders' })
    .order('is_default', { referencedTable: 'customer_addresses', ascending: false })
    .order('created_at', { referencedTable: 'customer_addresses', ascending: false })
    .limit(SAVED_ADDRESS_EMBED_LIMIT, { referencedTable: 'customer_addresses' })
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
  const customers: BranchCustomer[] = ((data ?? []) as unknown as CustomerRow[]).map((c) => {
    // Sorted again here. The server-side order is an optimisation; which address the
    // merchant is shown must not depend on PostgREST honouring an embedded ORDER BY.
    const saved = asRows<EmbeddedAddress>(c.customer_addresses)
      .slice()
      .sort(
        (a, b) =>
          Number(!!b.is_default) - Number(!!a.is_default) ||
          b.created_at.localeCompare(a.created_at),
      );
    const lastDelivery =
      asRows<EmbeddedDeliveryOrder>(c.orders)
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;

    // Where the food actually went beats where the diner said it should go. is_default
    // is written by the checkout only for a customer's FIRST saved address, so for a
    // diner who has since moved it points at a stale pin-drop while every recent order
    // went somewhere else. The address book is the fallback for someone who saved an
    // address but never had anything delivered to it, in the order their own account
    // screen shows it (default first, then newest).
    const delivered = formatOrderAddress(lastDelivery?.delivery_address);
    const book = formatSavedAddress(saved[0] ?? null);

    return {
      id: c.id,
      full_name: c.full_name,
      phone: c.phone,
      total_orders: Number(c.total_orders ?? 0),
      total_spent: Number(c.total_spent ?? 0),
      last_order_at: c.last_order_at,
      created_at: c.created_at,
      address: delivered ?? book,
      address_source: delivered ? 'delivered' : book ? 'saved' : null,
      address_at: delivered ? (lastDelivery?.created_at ?? null) : null,
      saved_address_count: saved.length,
    };
  });

  return { customers, total: count ?? customers.length, page, pageSize, error: null };
}
