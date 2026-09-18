import { CUSTOMER_SORT_COLUMNS, type CustomerListParams } from '@favornoms/shared';
import type { FavornomsClient } from '../client-type';

// Merchant-facing reads of public.customers. A customers row is ONE BRANCH's record of a diner:
// a person who orders at two branches has two rows (unique per branch and login), each with its
// own totals, address book, marketing consent and loyalty wallet. So "customers at this branch"
// is simply `branch_id = this branch`, and every aggregate on the row is this branch's alone.
// total_orders / total_spent count COMPLETED orders; last_order_at is the latest order that was
// not cancelled (public.customers_refresh_order_stats).

/**
 * Saved addresses pulled back per customer. Six is enough to say "there are others"
 * honestly without turning a 50-row page into an address dump: the merchant sees the
 * top one and a count, and nobody on this branch has more than five.
 */
const SAVED_ADDRESS_EMBED_LIMIT = 6;

/**
 * Recent orders pulled back per customer to name them when their profile has no name. A few,
 * not one: the latest can be a till placeholder ("Walk-in", "Table 4") that is nobody's name.
 */
const RECENT_ORDER_EMBED_LIMIT = 5;

/** The till's stand-in phone number. It identifies nobody. */
export const PLACEHOLDER_PHONE = '+10000000000';

const PLACEHOLDER_NAME = /^(walk[- ]?in|guest|customer|deleted user|table\s*\S+)$/i;
const SYNTHETIC_EMAIL = /@([a-z0-9-]+\.)*favornoms\.local$/i;

/**
 * True for the names the till writes when it does not know who it is serving. The same rule as
 * private.is_placeholder_customer_name in the database, so the list and the reports agree.
 */
export function isPlaceholderCustomerName(name: string | null | undefined): boolean {
  const trimmed = (name ?? '').trim();
  return trimmed === '' || PLACEHOLDER_NAME.test(trimmed);
}

/** True for a login email nobody chose (phone and rider sign-in mint *.favornoms.local ones). */
export function isSyntheticEmail(email: string | null | undefined): boolean {
  return !!email && SYNTHETIC_EMAIL.test(email.trim());
}

/** Where the name shown for a customer came from. */
export type CustomerNameSource = 'profile' | 'order' | 'email';

interface NameableOrder {
  customer_name: string | null;
  customer_phone?: string | null;
  created_at: string;
}

/**
 * The name and phone to show for a customer: their profile, else the latest real name and number
 * they gave on an order at this branch, else (for the name) their email. Null when nothing is known.
 */
export function customerDisplayIdentity(
  profile: { full_name: string | null; phone: string | null; email: string | null },
  recentOrders: NameableOrder[],
): {
  name: string | null;
  nameSource: CustomerNameSource | null;
  phone: string | null;
  phoneFromOrder: boolean;
  email: string | null;
} {
  const newestFirst = recentOrders
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const email = profile.email?.trim() && !isSyntheticEmail(profile.email) ? profile.email.trim() : null;

  const profileName = profile.full_name?.trim() || null;
  const orderName =
    newestFirst.find((o) => !isPlaceholderCustomerName(o.customer_name))?.customer_name?.trim() ??
    null;
  const name = profileName ?? orderName ?? email;
  const nameSource: CustomerNameSource | null = profileName
    ? 'profile'
    : orderName
      ? 'order'
      : email
        ? 'email'
        : null;

  const profilePhone = profile.phone?.trim() || null;
  const orderPhone =
    newestFirst
      .map((o) => o.customer_phone?.trim() ?? '')
      .find((p) => p !== '' && p !== PLACEHOLDER_PHONE) ?? null;

  return {
    name,
    nameSource,
    phone: profilePhone ?? orderPhone,
    phoneFromOrder: !profilePhone && !!orderPhone,
    email,
  };
}

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
  /** What to call them: profile name, else latest real order name here, else email. */
  name: string | null;
  name_source: CustomerNameSource | null;
  /** The profile's own name, untouched (null when blank). */
  full_name: string | null;
  /** Profile phone, else the latest real number they gave on an order here. */
  phone: string | null;
  phone_from_order: boolean;
  /** A real email (never a synthetic sign-in address). */
  email: string | null;
  /** Completed orders at this branch. */
  total_orders: number;
  /** Total of completed orders at this branch. */
  total_spent: number;
  /** Latest order here that was not cancelled. */
  last_order_at: string | null;
  created_at: string;
  /** This branch's loyalty wallet; null when they have never earned here. */
  points_balance: number | null;
  tier: string | null;
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
  /** Exact number of rows at this branch matching the search — not the length of this page. */
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

interface EmbeddedWallet {
  points_balance: number | null;
  tier: string | null;
}

interface CustomerRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  total_orders: number | null;
  total_spent: number | null;
  last_order_at: string | null;
  created_at: string;
  customer_addresses?: unknown;
  delivered?: unknown;
  recent?: unknown;
  loyalty_points?: unknown;
}

const asRows = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : value ? [value as T] : [];

/**
 * The PostgREST `or` filter for a search term: name, email or phone contain it. Characters that
 * are syntax inside that filter (quotes, backslashes, commas, parentheses) and LIKE wildcards
 * are dropped from the term rather than escaped, and each value is double-quoted.
 *
 * Phones are stored in E.164 (+66815929554) while a merchant types them the way the country
 * writes them locally, spaced and with a trunk 0 (081 592 9554). So a term with three or more
 * digits also matches the phone on its digits alone ("+66 81 592" finds it), and when those
 * digits start with the trunk 0, on the digits after it too: "081 592" and "0815929554" both find
 * "+66815929554", which holds "81592" but no "081592".
 */
export function customerSearchFilter(term: string): string | null {
  const clean = term.replace(/["\\,()%_*]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const clauses = [
    `full_name.ilike."%${clean}%"`,
    `email.ilike."%${clean}%"`,
    `phone.ilike."%${clean}%"`,
  ];
  const digits = clean.replace(/\D/g, '');
  if (digits.length >= 3) {
    if (digits !== clean) clauses.push(`phone.ilike."%${digits}%"`);
    const national = digits.replace(/^0/, '');
    if (national !== digits && national.length >= 3) clauses.push(`phone.ilike."%${national}%"`);
  }
  return clauses.join(',');
}

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
 * The address, the recent order names and this branch's wallet ride along in the same
 * request. Relations are embedded rather than fetched per row: PostgREST compiles an
 * embedded order/limit into a LATERAL join, so a page still costs ONE round trip however
 * many customers are on it, and the sorting and paging stay where they were — on `customers`.
 *
 * Errors are returned rather than swallowed: an RLS denial (no `customers.view`)
 * must not read as an empty branch.
 */
export async function listBranchCustomers(
  supabase: FavornomsClient,
  branchId: string,
  { sort, dir, page, q }: CustomerListParams,
  pageSize = CUSTOMERS_PAGE_SIZE,
): Promise<BranchCustomersResult> {
  const from = (page - 1) * pageSize;
  let query = supabase
    .from('customers')
    .select(
      'id, full_name, phone, email, total_orders, total_spent, last_order_at, created_at, ' +
        'customer_addresses(address_line1, address_line2, city, state, postal_code, is_default, created_at), ' +
        'delivered:orders(delivery_address, created_at), ' +
        'recent:orders(customer_name, customer_phone, created_at), ' +
        'loyalty_points(points_balance, tier)',
      { count: 'exact' },
    )
    .eq('branch_id', branchId)
    // Embedded filters without !inner: they trim the child rows and leave the parent
    // alone, so a customer who has never had a delivery still appears, with an empty
    // array. The channel filter is not optional — the checkout posts the typed address
    // on dine-in and pickup orders too, and "last delivered to" must not name a table.
    // The branch pins are belt and braces: a row's orders are all at its own branch
    // (a trigger on orders enforces it), and its wallet is keyed by (branch, customer).
    .eq('delivered.branch_id', branchId)
    .eq('delivered.channel', 'delivery')
    .not('delivered.delivery_address', 'is', null)
    .order('created_at', { referencedTable: 'delivered', ascending: false })
    .limit(1, { referencedTable: 'delivered' })
    .eq('recent.branch_id', branchId)
    .order('created_at', { referencedTable: 'recent', ascending: false })
    .limit(RECENT_ORDER_EMBED_LIMIT, { referencedTable: 'recent' })
    .eq('loyalty_points.branch_id', branchId)
    .order('is_default', { referencedTable: 'customer_addresses', ascending: false })
    .order('created_at', { referencedTable: 'customer_addresses', ascending: false })
    .limit(SAVED_ADDRESS_EMBED_LIMIT, { referencedTable: 'customer_addresses' });

  const search = q ? customerSearchFilter(q) : null;
  if (search) query = query.or(search);

  const { data, count, error } = await query
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
      asRows<EmbeddedDeliveryOrder>(c.delivered)
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
    const wallet = asRows<EmbeddedWallet>(c.loyalty_points)[0] ?? null;
    const identity = customerDisplayIdentity(
      { full_name: c.full_name, phone: c.phone, email: c.email },
      asRows<NameableOrder>(c.recent),
    );

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
      name: identity.name,
      name_source: identity.nameSource,
      full_name: c.full_name?.trim() || null,
      phone: identity.phone,
      phone_from_order: identity.phoneFromOrder,
      email: identity.email,
      total_orders: Number(c.total_orders ?? 0),
      total_spent: Number(c.total_spent ?? 0),
      last_order_at: c.last_order_at,
      created_at: c.created_at,
      points_balance: wallet ? Number(wallet.points_balance ?? 0) : null,
      tier: wallet?.tier ?? null,
      address: delivered ?? book,
      address_source: delivered ? 'delivered' : book ? 'saved' : null,
      address_at: delivered ? (lastDelivery?.created_at ?? null) : null,
      saved_address_count: saved.length,
    };
  });

  return { customers, total: count ?? customers.length, page, pageSize, error: null };
}

export interface BranchCustomerOrder {
  id: string;
  order_number: string;
  status: string;
  channel: string;
  total: number;
  created_at: string;
}

export interface BranchCustomerAddress {
  id: string;
  label: string | null;
  line: string;
  is_default: boolean;
}

export interface BranchCustomerLedgerRow {
  id: string;
  type: string;
  points: number;
  balance_after: number | null;
  description: string | null;
  created_at: string;
}

export interface BranchCustomerDetail {
  id: string;
  name: string | null;
  name_source: CustomerNameSource | null;
  phone: string | null;
  phone_from_order: boolean;
  email: string | null;
  marketing_consent: boolean;
  birthday: string | null;
  /** True when the record belongs to a signed-in account, false for a walk-in/guest record. */
  has_account: boolean;
  total_orders: number;
  total_spent: number;
  last_order_at: string | null;
  created_at: string;
  /** Every order at this branch, cancelled ones included (the list shows the newest). */
  order_count: number;
  orders: BranchCustomerOrder[];
  addresses: BranchCustomerAddress[];
  wallet: {
    points_balance: number;
    lifetime_earned: number;
    lifetime_spent: number;
    tier: string | null;
  } | null;
  ledger: BranchCustomerLedgerRow[];
}

export const CUSTOMER_DETAIL_ORDER_LIMIT = 20;
export const CUSTOMER_DETAIL_LEDGER_LIMIT = 20;

/**
 * One customer as this branch knows them: profile, this branch's orders, their address book,
 * and this branch's loyalty wallet and ledger. Null when the id is not a customer of THIS branch
 * (or RLS hides it), so a pasted id from another branch opens nothing.
 */
export async function getBranchCustomerDetail(
  supabase: FavornomsClient,
  branchId: string,
  customerId: string,
): Promise<{ customer: BranchCustomerDetail | null; error: string | null }> {
  const { data: row, error } = await supabase
    .from('customers')
    .select(
      'id, user_id, full_name, phone, email, marketing_consent, birthday, total_orders, total_spent, last_order_at, created_at',
    )
    .eq('id', customerId)
    .eq('branch_id', branchId)
    .maybeSingle();
  if (error) return { customer: null, error: `${error.message}${error.code ? ` (${error.code})` : ''}` };
  if (!row) return { customer: null, error: null };

  const [orders, addresses, wallet, ledger] = await Promise.all([
    supabase
      .from('orders')
      .select('id, order_number, status, channel, total, created_at, customer_name, customer_phone', {
        count: 'exact',
      })
      .eq('customer_id', customerId)
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(CUSTOMER_DETAIL_ORDER_LIMIT),
    supabase
      .from('customer_addresses')
      .select('id, label, address_line1, address_line2, city, state, postal_code, is_default, created_at')
      .eq('customer_id', customerId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('loyalty_points')
      .select('points_balance, lifetime_earned, lifetime_spent, tier')
      .eq('customer_id', customerId)
      .eq('branch_id', branchId)
      .limit(1),
    supabase
      .from('loyalty_transactions')
      .select('id, type, points, balance_after, description, created_at')
      .eq('customer_id', customerId)
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(CUSTOMER_DETAIL_LEDGER_LIMIT),
  ]);
  const firstError = orders.error ?? addresses.error ?? wallet.error ?? ledger.error;
  if (firstError) {
    return {
      customer: null,
      error: `${firstError.message}${firstError.code ? ` (${firstError.code})` : ''}`,
    };
  }

  const orderRows = (orders.data ?? []) as Array<{
    id: string;
    order_number: string;
    status: string;
    channel: string;
    total: number | null;
    created_at: string;
    customer_name: string | null;
    customer_phone: string | null;
  }>;
  const identity = customerDisplayIdentity(
    { full_name: row.full_name, phone: row.phone, email: row.email },
    orderRows,
  );
  const walletRow = (wallet.data ?? [])[0] as
    | { points_balance: number | null; lifetime_earned: number | null; lifetime_spent: number | null; tier: string | null }
    | undefined;

  return {
    customer: {
      id: row.id,
      name: identity.name,
      name_source: identity.nameSource,
      phone: identity.phone,
      phone_from_order: identity.phoneFromOrder,
      email: identity.email,
      marketing_consent: !!row.marketing_consent,
      birthday: row.birthday ?? null,
      has_account: !!row.user_id,
      total_orders: Number(row.total_orders ?? 0),
      total_spent: Number(row.total_spent ?? 0),
      last_order_at: row.last_order_at,
      created_at: row.created_at,
      order_count: orders.count ?? orderRows.length,
      orders: orderRows.map((o) => ({
        id: o.id,
        order_number: o.order_number,
        status: String(o.status),
        channel: String(o.channel),
        total: Number(o.total ?? 0),
        created_at: o.created_at,
      })),
      addresses: ((addresses.data ?? []) as Array<SavedAddressParts & {
        id: string;
        label: string | null;
        is_default: boolean | null;
      }>)
        .map((a) => ({
          id: a.id,
          label: a.label?.trim() || null,
          line: formatSavedAddress(a) ?? '',
          is_default: !!a.is_default,
        }))
        .filter((a) => a.line !== ''),
      wallet: walletRow
        ? {
            points_balance: Number(walletRow.points_balance ?? 0),
            lifetime_earned: Number(walletRow.lifetime_earned ?? 0),
            lifetime_spent: Number(walletRow.lifetime_spent ?? 0),
            tier: walletRow.tier ?? null,
          }
        : null,
      ledger: ((ledger.data ?? []) as Array<{
        id: string;
        type: string;
        points: number | null;
        balance_after: number | null;
        description: string | null;
        created_at: string;
      }>).map((l) => ({
        id: l.id,
        type: String(l.type),
        points: Number(l.points ?? 0),
        balance_after: l.balance_after == null ? null : Number(l.balance_after),
        description: l.description,
        created_at: l.created_at,
      })),
    },
    error: null,
  };
}
