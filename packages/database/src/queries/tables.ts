import type { FavornomsClient } from '../client-type';

// Dine-in tables and the sittings that happen at them.
//
// A "session" used to be a localStorage key on one phone with a four-hour clock. It is now
// a row: one open sitting per table (a partial unique index guarantees it), every round of
// the meal is an order pointing at it, and settling the bill closes it so the table's QR
// cannot order again until the next party is seated. Everything privileged goes through the
// security-definer RPCs below rather than through table writes, because the token on a
// table tent is effectively public — see the migration header for the full argument.
//
// None of these RPCs are in the generated types yet, so their args are cast `as never`, the
// same escape the rest of the repo uses for new functions.

/** The kinds of table a floor can have. `shape` stays the floor-plan glyph. */
export const TABLE_TYPES = [
  'standard',
  'booth',
  'bar',
  'high_top',
  'private_room',
  'outdoor',
  'counter',
] as const;
export type TableType = (typeof TABLE_TYPES)[number];

/** Plain English for a `tables.table_type` value. */
export function tableTypeLabel(value: string | null | undefined): string {
  switch (value) {
    case 'booth':
      return 'Booth';
    case 'bar':
      return 'Bar';
    case 'high_top':
      return 'High top';
    case 'private_room':
      return 'Private room';
    case 'outdoor':
      return 'Outdoor';
    case 'counter':
      return 'Counter';
    default:
      return 'Standard';
  }
}

export type TableSessionStatus = 'open' | 'locked' | 'closed';

export interface FloorTable {
  id: string;
  table_number: string;
  display_name: string | null;
  capacity: number | null;
  zone: string | null;
  table_type: string;
  sort_order: number;
  /** 'open' | 'occupied' | 'dirty' | 'reserved'. Dormant until sessions started writing it. */
  status: string | null;
  is_active: boolean;
  qr_code_token: string | null;
}

export interface FloorSessionOrder {
  id: string;
  order_number: string;
  status: string;
  total: number | string;
  session_seq: number | null;
  created_at: string;
}

export interface FloorSession {
  id: string;
  table_id: string;
  status: TableSessionStatus;
  opened_at: string;
  expires_at: string;
  bill_requested_at: string | null;
  party_size: number | null;
  session_code: string;
  orders: FloorSessionOrder[];
}

export interface TableSessionBillOrder {
  order_id: string;
  order_number: string;
  round: number | null;
  status: string;
  created_at: string;
  subtotal: number;
  tax_amount: number;
  service_fee: number;
  tip_amount: number;
  discount_amount: number;
  total: number;
  /** This order was placed by the caller, not by someone else at the table. */
  mine: boolean;
  paid: boolean;
  /** Staff only — the bill RPC redacts it for diners, and never returns a phone number. */
  customer_name?: string;
  items: Array<{
    name: string;
    quantity: number;
    unit_price: number;
    subtotal: number;
    notes: string | null;
  }>;
}

export interface TableSessionBill {
  session_id: string;
  status: TableSessionStatus;
  table_id: string;
  table_label: string;
  opened_at: string;
  closed_at: string | null;
  closed_reason: string | null;
  bill_requested_at: string | null;
  party_size: number | null;
  is_staff: boolean;
  order_count: number;
  running_total: number;
  outstanding: number;
  /** Null unless the caller is staff or has joined this sitting. */
  session_code: string | null;
  orders: TableSessionBillOrder[];
}

export interface JoinedTableSession {
  session_id: string;
  status: TableSessionStatus;
  branch_id: string;
  table_id: string;
  table_number: string;
  table_label: string;
  opened_at: string;
  expires_at: string;
  session_code: string;
}

export interface SettleTableSessionResult {
  session_id: string;
  orders_settled: number;
  total: number;
  /** Rounds the till could not settle itself — a QR transfer still waiting on its slip. */
  skipped: Array<{ order_number: string; reason: string }>;
  already_closed?: boolean;
}

/**
 * Join (or, when the branch lets a scan seat itself, open) the sitting at a scanned table.
 *
 * Throws the RPC's own reason so the caller can branch on it: `not_signed_in`,
 * `table_not_found`, `table_not_seated`, `join_code_required`, `table_session_locked`.
 */
export async function joinTableSession(
  supabase: FavornomsClient,
  token: string,
  code?: string,
): Promise<JoinedTableSession> {
  const { data, error } = await supabase.rpc('join_table_session', {
    p_token: token,
    p_code: code ?? null,
  } as never);
  if (error) throw new Error(error.message);
  return data as unknown as JoinedTableSession;
}

/** The whole sitting's bill, round by round. Participants and branch staff only. */
export async function getTableSessionBill(
  supabase: FavornomsClient,
  sessionId: string,
): Promise<TableSessionBill> {
  const { data, error } = await supabase.rpc('get_table_session_bill', {
    p_session_id: sessionId,
  } as never);
  if (error) throw new Error(error.message);
  return data as unknown as TableSessionBill;
}

/** Seat a table. Idempotent — seating a seated table returns the sitting it already has. */
export async function openTableSession(
  supabase: FavornomsClient,
  tableId: string,
  partySize?: number,
): Promise<string> {
  const { data, error } = await supabase.rpc('open_table_session', {
    p_table_id: tableId,
    p_party_size: partySize ?? null,
  } as never);
  if (error) throw new Error(error.message);
  return data as unknown as string;
}

/**
 * Lock a sitting ("we're ready for the bill") or unlock it again.
 *
 * A diner at the table may lock; only staff may unlock, or a table-mate could re-open a
 * bill the party had just closed.
 */
export async function setTableSessionStatus(
  supabase: FavornomsClient,
  sessionId: string,
  status: 'open' | 'locked',
): Promise<void> {
  const { error } = await supabase.rpc('set_table_session_status', {
    p_session_id: sessionId,
    p_status: status,
  } as never);
  if (error) throw new Error(error.message);
}

/**
 * Take payment for every round of the sitting and close it.
 *
 * Each round settles through record_counter_payment, which refuses a QR transfer — those
 * are approved against a photographed slip. Refusals come back in `skipped` instead of
 * being swallowed, so the floor can be told the table is not fully paid.
 */
export async function settleTableSession(
  supabase: FavornomsClient,
  sessionId: string,
  tendered?: number,
): Promise<SettleTableSessionResult> {
  const { data, error } = await supabase.rpc('settle_table_session', {
    p_session_id: sessionId,
    p_tendered: tendered ?? null,
  } as never);
  if (error) throw new Error(error.message);
  return data as unknown as SettleTableSessionResult;
}

/**
 * End a sitting without taking money. `unpaid_needs_manager` comes back when there is an
 * outstanding balance and the caller only holds counter.access.
 */
export async function closeTableSession(
  supabase: FavornomsClient,
  sessionId: string,
  reason: 'staff_closed' | 'voided' = 'staff_closed',
  note?: string,
): Promise<void> {
  const { error } = await supabase.rpc('close_table_session', {
    p_session_id: sessionId,
    p_reason: reason,
    p_note: note ?? null,
  } as never);
  if (error) throw new Error(error.message);
}

const FLOOR_TABLE_SELECT =
  'id, table_number, display_name, capacity, zone, table_type, status, is_active, sort_order, qr_code_token';

const FLOOR_SESSION_SELECT =
  'id, table_id, status, opened_at, expires_at, bill_requested_at, party_size, session_code, ' +
  'orders(id, order_number, status, total, session_seq, created_at)';

/**
 * Everything the floor board draws: the branch's tables, and whatever is sitting at them.
 *
 * Two reads rather than one embed. `tables` has no FK to `table_sessions` (the arrow points
 * the other way), so PostgREST cannot embed the sitting on the table; the sittings are read
 * separately and zipped by table_id. The orders embed on the second read does work, because
 * orders.session_id -> table_sessions.id is a real foreign key.
 */
export async function listTableStates(
  supabase: FavornomsClient,
  branchId: string,
): Promise<{ tables: FloorTable[]; sessions: FloorSession[] }> {
  const [tablesRes, sessionsRes] = await Promise.all([
    supabase
      .from('tables')
      .select(FLOOR_TABLE_SELECT)
      .eq('branch_id', branchId)
      // sort_order first: table_number is text, so on its own '10' sorts before '2'.
      .order('sort_order')
      .order('table_number'),
    supabase
      .from('table_sessions')
      .select(FLOOR_SESSION_SELECT)
      .eq('branch_id', branchId)
      .neq('status', 'closed'),
  ]);

  return {
    tables: (tablesRes.data ?? []) as unknown as FloorTable[],
    sessions: (sessionsRes.data ?? []) as unknown as FloorSession[],
  };
}
