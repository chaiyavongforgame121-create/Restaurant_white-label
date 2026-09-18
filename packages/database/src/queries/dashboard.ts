import type { FavornomsClient } from '../client-type';
import { listLiveDeliveries, type LiveDelivery } from './delivery';

// Everything the branch dashboard reads, plus the branch-local calendar arithmetic that
// decides what "today" means. Both live here because the same two questions — "which of my
// rows fall in the branch's day" and "what still needs a human" — are asked by the
// dashboard and by the Orders list, and a second copy of either is how two screens start
// disagreeing about the same number.

// ---------------------------------------------------------------------------------------
// Branch-local days
// ---------------------------------------------------------------------------------------

/**
 * How far ahead of UTC the wall clock in `timeZone` is at instant `at`, in ms.
 * America/Chicago in September → 18_000_000 (5 h).
 */
export function tzOffsetMs(at: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const { type, value } of dtf.formatToParts(at)) parts[type] = value;
  // Some ICU builds render midnight as hour "24" under hour12:false.
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return at.getTime() - asUtc;
}

/** 'YYYY-MM-DD' of the branch's calendar day containing `at`. */
export function branchDayKey(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * The UTC instant at which the branch's local day `ymd` begins. The offset is measured
 * twice: on a DST edge the first measurement can land on the wrong side of the shift, and
 * the correction then reads the offset that actually applies at that local midnight.
 */
export function startOfBranchDayUtc(ymd: string, timeZone: string): Date {
  const guess = new Date(`${ymd}T00:00:00Z`);
  const corrected = new Date(guess.getTime() + tzOffsetMs(guess, timeZone));
  return new Date(guess.getTime() + tzOffsetMs(corrected, timeZone));
}

/**
 * `ymd` shifted by whole days. Stepped from noon UTC so a DST shift cannot push the date
 * across a boundary — an hour either way still lands on the same calendar date.
 */
export function shiftDayKey(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------------------

export interface DashboardTrendOrder {
  created_at: string;
  total: number;
  status: string;
}

export interface DashboardKitchenOrder {
  id: string;
  order_number: string;
  status: string;
  channel: string;
  created_at: string;
  scheduled_for: string | null;
  held: boolean;
  awaiting_payment: boolean;
  customer_name: string | null;
  /** jsonb; shape is not guaranteed, so the model narrows it rather than trusting it. */
  status_history: unknown;
}

export interface DashboardProof {
  payment_id: string;
  order_id: string;
  order_number: string;
  customer_name: string | null;
  amount: number;
  /** Stamped by confirm_payment_proof; falls back to the payment row's own age. */
  submitted_at: string | null;
  created_at: string;
}

export interface DashboardRefundable {
  id: string;
  order_number: string;
  total: number;
  created_at: string;
  customer_name: string | null;
  status_history: unknown;
}

export interface DashboardStockItem {
  id: string;
  name: string;
  stock_quantity: number | null;
  low_stock_threshold: number | null;
  is_sold_out: boolean;
}

export interface DashboardRiderQueueRow {
  id: string;
  driver_id: string | null;
  driver_name: string;
  applied_at: string | null;
  approval_status: string;
  kyc_status: string | null;
}

export interface DashboardWithdrawal {
  id: string;
  amount: number;
  created_at: string;
  driver_name: string;
}

export interface DashboardScheduledOrder {
  id: string;
  order_number: string;
  status: string;
  held: boolean;
  scheduled_for: string;
  customer_name: string | null;
}

/**
 * One read's worth of answer. `error` is deliberately distinct from an empty `rows`: a
 * screen whose job is "what needs you" must never render an RLS denial as "all clear".
 * `available: false` means the read was never issued — the role or the plan puts that
 * bucket out of scope — which is a third thing again, and renders as nothing at all.
 */
export interface DashboardBucket<T> {
  available: boolean;
  rows: T[];
  /** How many rows match in total; `rows` is capped. Equals rows.length when uncapped. */
  total: number;
  error: string | null;
}

function outOfScope<T>(): DashboardBucket<T> {
  return { available: false, rows: [], total: 0, error: null };
}

function bucketOf<T>(rows: T[], total: number | null, error: string | null): DashboardBucket<T> {
  return { available: true, rows, total: total ?? rows.length, error };
}

/** PostgREST returns a to-one embed as an object; older shapes as a one-element array. */
function firstOf<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// ---------------------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------------------

/** What the viewer's role and the branch's plan allow. Decided by the caller, not here. */
export interface DashboardScope {
  canViewPayments: boolean;
  canRefund: boolean;
  canManageInventory: boolean;
  canManageDrivers: boolean;
  /** The `delivery` add-on. Without it there is no delivery board to link to. */
  deliveryEnabled: boolean;
  /** now, injected so a render and its numbers agree on one instant. */
  now: number;
  /** How far ahead a booking counts as "approaching". */
  scheduledWithinMs: number;
}

export interface DashboardSnapshot {
  timezone: string;
  currency: string;
  settings: Record<string, unknown>;
  trend: DashboardBucket<DashboardTrendOrder>;
  kitchen: DashboardBucket<DashboardKitchenOrder>;
  deliveries: DashboardBucket<LiveDelivery>;
  proofs: DashboardBucket<DashboardProof>;
  refundable: DashboardBucket<DashboardRefundable>;
  lowStock: DashboardBucket<DashboardStockItem>;
  riderQueue: DashboardBucket<DashboardRiderQueueRow>;
  withdrawals: DashboardBucket<DashboardWithdrawal>;
  scheduled: DashboardBucket<DashboardScheduledOrder>;
}

/** Eight days, not seven: the branch's local day can start a day away from the server's. */
const TREND_WINDOW_DAYS = 8;
/** A cancelled order older than this is an accounting job, not something to chase today. */
const REFUND_WINDOW_DAYS = 30;
const ACTION_ROW_LIMIT = 5;
const STOCK_ROW_LIMIT = 8;
const KITCHEN_ROW_LIMIT = 300;
const TREND_ROW_LIMIT = 5000;
const RIDER_ROW_LIMIT = 200;
const REFUND_ROW_LIMIT = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every read the dashboard needs, issued together.
 *
 * They are independent, so they go out as one `Promise.all` over a single connection
 * rather than nine sequential awaits. None of them rejects — `listLiveDeliveries` throws
 * by design (a delivery board must not read "nothing in flight" when it could not ask), so
 * its rejection is caught here and carried as this bucket's `error` instead of taking the
 * whole page down with it.
 */
export async function loadBranchDashboard(
  supabase: FavornomsClient,
  branchId: string,
  scope: DashboardScope,
): Promise<DashboardSnapshot> {
  const { now } = scope;
  const nowIso = new Date(now).toISOString();
  const sinceTrend = new Date(now - TREND_WINDOW_DAYS * DAY_MS).toISOString();
  const sinceRefund = new Date(now - REFUND_WINDOW_DAYS * DAY_MS).toISOString();
  const soonIso = new Date(now + scope.scheduledWithinMs).toISOString();

  const [
    branchRow,
    trendRes,
    kitchenRes,
    deliveryRes,
    proofRes,
    refundRes,
    stockRes,
    riderRes,
    withdrawalRes,
    scheduledRes,
  ] = await Promise.all([
    supabase.from('branches').select('timezone, settings').eq('id', branchId).maybeSingle(),

    supabase
      .from('orders')
      .select('created_at, total, status')
      .eq('branch_id', branchId)
      .gte('created_at', sinceTrend)
      .order('created_at', { ascending: false })
      .limit(TREND_ROW_LIMIT),

    // One read serves both the Kitchen Queue tile and the "running late" rows: the lanes
    // and the ages are derived from the same rows the board itself would draw.
    supabase
      .from('orders')
      .select(
        'id, order_number, status, channel, created_at, scheduled_for, held, awaiting_payment, customer_name, status_history',
      )
      .eq('branch_id', branchId)
      .in('status', ['pending', 'confirmed', 'preparing', 'ready'])
      .order('created_at', { ascending: false })
      .limit(KITCHEN_ROW_LIMIT),

    scope.deliveryEnabled
      ? listLiveDeliveries(supabase, branchId).catch((e: unknown) => e as Error)
      : null,

    // The exact filter the Orders page approves from: a slip only counts once the diner
    // has pressed "I've paid", or the queue fills with half-finished uploads.
    scope.canViewPayments
      ? supabase
          .from('payments')
          .select(
            'id, order_id, amount, created_at, gateway_metadata, orders!inner(order_number, customer_name)',
            { count: 'exact' },
          )
          .eq('branch_id', branchId)
          .eq('method', 'transfer')
          .eq('status', 'pending')
          .not('proof_image_url', 'is', null)
          .not('gateway_metadata->customer_confirmed_at', 'is', null)
          .order('created_at', { ascending: true })
          .limit(ACTION_ROW_LIMIT)
      : null,

    // Money taken, order dead, nothing given back. There is no refunds table and
    // refund_order only sets status='refunded' on a FULL refund, so the durable signal is
    // the absence of a {"status":"refund"} entry in status_history — a jsonb containment
    // test that is done in JS below rather than as a PostgREST `not.cs` filter no other
    // read in this repo uses.
    scope.canRefund
      ? supabase
          .from('orders')
          .select(
            'id, order_number, total, created_at, customer_name, status_history, payments!inner(id, status)',
          )
          .eq('branch_id', branchId)
          .eq('status', 'cancelled')
          .eq('payments.status', 'completed')
          .gte('created_at', sinceRefund)
          .order('created_at', { ascending: false })
          .limit(REFUND_ROW_LIMIT)
      : null,

    // The same view, and so the same meaning of "sold out" and "low", as the inventory page this
    // card links to (20260918170000_stock_integrity): is_sold_out covers a kitchen 86 as well as
    // an empty shelf. The view lists active dishes only; the is_active filter stays as a belt for
    // a database that has not run that migration yet.
    scope.canManageInventory
      ? supabase
          .from('v_low_stock_items')
          .select('id, name, stock_quantity, low_stock_threshold, is_sold_out', {
            count: 'exact',
          })
          .eq('branch_id', branchId)
          .eq('is_active', true)
          .order('is_sold_out', { ascending: false })
          .order('stock_quantity', { ascending: true, nullsFirst: false })
          .limit(STOCK_ROW_LIMIT)
      : null,

    // Applications and document reviews come off one read: a branch's rider roster is
    // small, and the Drivers page already reads it unbounded.
    scope.deliveryEnabled && scope.canManageDrivers
      ? supabase
          .from('driver_approvals')
          .select('id, status, applied_at, driver:drivers(id, full_name, kyc_status)')
          .eq('branch_id', branchId)
          .order('applied_at', { ascending: true })
          .limit(RIDER_ROW_LIMIT)
      : null,

    scope.deliveryEnabled && scope.canManageDrivers
      ? supabase
          .from('driver_withdrawals')
          .select('id, amount, created_at, drivers(full_name)', { count: 'exact' })
          .eq('branch_id', branchId)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .limit(ACTION_ROW_LIMIT)
      : null,

    supabase
      .from('orders')
      .select('id, order_number, status, held, scheduled_for, customer_name', { count: 'exact' })
      .eq('branch_id', branchId)
      .not('scheduled_for', 'is', null)
      .gte('scheduled_for', nowIso)
      .lte('scheduled_for', soonIso)
      .in('status', ['pending', 'confirmed'])
      .order('scheduled_for', { ascending: true })
      .limit(ACTION_ROW_LIMIT),
  ]);

  const settings = (branchRow.data?.settings ?? {}) as Record<string, unknown>;

  const trend = bucketOf(
    ((trendRes.data ?? []) as unknown as DashboardTrendOrder[]).map((o) => ({
      created_at: String(o.created_at),
      total: Number(o.total ?? 0),
      status: String(o.status ?? ''),
    })),
    null,
    trendRes.error?.message ?? null,
  );

  const kitchen = bucketOf(
    ((kitchenRes.data ?? []) as unknown as DashboardKitchenOrder[]).map((o) => ({
      id: String(o.id),
      order_number: String(o.order_number ?? ''),
      status: String(o.status ?? ''),
      channel: String(o.channel ?? ''),
      created_at: String(o.created_at),
      scheduled_for: o.scheduled_for ?? null,
      held: !!o.held,
      awaiting_payment: !!o.awaiting_payment,
      customer_name: o.customer_name ?? null,
      status_history: o.status_history,
    })),
    null,
    kitchenRes.error?.message ?? null,
  );

  const deliveries: DashboardBucket<LiveDelivery> =
    deliveryRes == null
      ? outOfScope<LiveDelivery>()
      : deliveryRes instanceof Error
        ? bucketOf<LiveDelivery>([], 0, deliveryRes.message)
        : bucketOf(deliveryRes, deliveryRes.length, null);

  const proofs: DashboardBucket<DashboardProof> =
    proofRes == null
      ? outOfScope<DashboardProof>()
      : bucketOf(
          (
            (proofRes.data ?? []) as unknown as Array<{
              id: string;
              order_id: string;
              amount: number | string | null;
              created_at: string;
              gateway_metadata: unknown;
              orders: { order_number: string; customer_name: string | null } | null;
            }>
          ).map((p) => {
            const order = firstOf(p.orders);
            const meta = (p.gateway_metadata ?? {}) as Record<string, unknown>;
            const submitted = meta.proof_submitted_at;
            return {
              payment_id: p.id,
              order_id: p.order_id,
              order_number: order?.order_number ?? '—',
              customer_name: order?.customer_name ?? null,
              amount: Number(p.amount ?? 0),
              submitted_at: typeof submitted === 'string' ? submitted : null,
              created_at: p.created_at,
            };
          }),
          proofRes.count,
          proofRes.error?.message ?? null,
        );

  const refundable: DashboardBucket<DashboardRefundable> =
    refundRes == null
      ? outOfScope<DashboardRefundable>()
      : bucketOf(
          ((refundRes.data ?? []) as unknown as DashboardRefundable[])
            .map((o) => ({
              id: String(o.id),
              order_number: String(o.order_number ?? ''),
              total: Number(o.total ?? 0),
              created_at: String(o.created_at),
              customer_name: o.customer_name ?? null,
              status_history: o.status_history,
            }))
            .filter((o) => !hasRefundEntry(o.status_history)),
          null,
          refundRes.error?.message ?? null,
        );

  const lowStock: DashboardBucket<DashboardStockItem> =
    stockRes == null
      ? outOfScope<DashboardStockItem>()
      : bucketOf(
          (
            (stockRes.data ?? []) as unknown as Array<{
              id: string | null;
              name: string | null;
              stock_quantity: number | null;
              low_stock_threshold: number | null;
              is_sold_out: boolean | null;
            }>
          ).map((i) => ({
            id: i.id ?? '',
            name: i.name ?? 'Menu item',
            stock_quantity: i.stock_quantity,
            low_stock_threshold: i.low_stock_threshold,
            is_sold_out: !!i.is_sold_out,
          })),
          stockRes.count,
          stockRes.error?.message ?? null,
        );

  const riderQueue: DashboardBucket<DashboardRiderQueueRow> =
    riderRes == null
      ? outOfScope<DashboardRiderQueueRow>()
      : bucketOf(
          (
            (riderRes.data ?? []) as unknown as Array<{
              id: string;
              status: string;
              applied_at: string | null;
              driver: { id: string; full_name: string; kyc_status: string } | null;
            }>
          ).map((a) => {
            const driver = firstOf(a.driver);
            return {
              id: a.id,
              driver_id: driver?.id ?? null,
              driver_name: driver?.full_name ?? 'Rider',
              applied_at: a.applied_at,
              approval_status: a.status,
              kyc_status: driver?.kyc_status ?? null,
            };
          }),
          null,
          riderRes.error?.message ?? null,
        );

  const withdrawals: DashboardBucket<DashboardWithdrawal> =
    withdrawalRes == null
      ? outOfScope<DashboardWithdrawal>()
      : bucketOf(
          (
            (withdrawalRes.data ?? []) as unknown as Array<{
              id: string;
              amount: number | string | null;
              created_at: string;
              drivers: { full_name: string } | { full_name: string }[] | null;
            }>
          ).map((w) => ({
            id: w.id,
            amount: Number(w.amount ?? 0),
            created_at: w.created_at,
            driver_name: firstOf(w.drivers)?.full_name ?? 'Rider',
          })),
          withdrawalRes.count,
          withdrawalRes.error?.message ?? null,
        );

  const scheduled = bucketOf(
    ((scheduledRes.data ?? []) as unknown as DashboardScheduledOrder[]).map((o) => ({
      id: String(o.id),
      order_number: String(o.order_number ?? ''),
      status: String(o.status ?? ''),
      held: !!o.held,
      scheduled_for: String(o.scheduled_for),
      customer_name: o.customer_name ?? null,
    })),
    scheduledRes.count,
    scheduledRes.error?.message ?? null,
  );

  return {
    timezone: branchRow.data?.timezone ?? 'America/New_York',
    currency: typeof settings.currency === 'string' ? settings.currency : 'USD',
    settings,
    trend,
    kitchen,
    deliveries,
    proofs,
    refundable,
    lowStock,
    riderQueue,
    withdrawals,
    scheduled,
  };
}

/**
 * Whether refund_order has already run on this order. It appends
 * {"status":"refund", ...} to status_history and touches nothing else, so this entry is
 * the only durable record of a partial refund.
 */
export function hasRefundEntry(statusHistory: unknown): boolean {
  if (!Array.isArray(statusHistory)) return false;
  return statusHistory.some(
    (e) => !!e && typeof e === 'object' && (e as Record<string, unknown>).status === 'refund',
  );
}
