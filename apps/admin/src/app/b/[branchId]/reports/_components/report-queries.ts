import type { BranchAccess } from '@/lib/capabilities';
import type { ReportRange } from './report-range';

// Shapes of the six section RPCs added by 20260908100000_branch_report_sections.sql.
// They live next to the screen that draws them rather than in @favornoms/database/queries
// because nothing else reads them, and they are hand-written rather than generated: the
// RPCs return jsonb, which the type generator can only ever describe as `Json`.

type ReportClient = BranchAccess['supabase'];

/** What went wrong, as a stable code the screen translates under `reports.errors`. */
export type SectionErrorCode =
  | 'forbidden'
  | 'rangeTooWide'
  | 'rangeRequired'
  | 'emptyResponse'
  | 'unknown';

export interface SectionError {
  code: SectionErrorCode;
  /** The database's own error code (42501, P0001, PGRST…), shown so support can match it to
   *  the server log. Never the database's text, which is English and not for merchants. */
  ref: string | null;
}

export interface SectionResult<T> {
  data: T | null;
  /** null when the RPC succeeded — even when the branch simply took no orders. */
  error: SectionError | null;
}

/** The six RPCs raise 42501 for a caller without reports.view and name their P0001s. */
export function sectionErrorCode(error: {
  code?: string | null;
  message?: string | null;
}): SectionErrorCode {
  if (error.code === '42501') return 'forbidden';
  if (error.message === 'range_too_wide') return 'rangeTooWide';
  if (error.message === 'range_required') return 'rangeRequired';
  return 'unknown';
}

interface SectionWindow {
  from: string;
  to: string;
  timezone: string;
}

export interface SalesReport extends SectionWindow {
  totals: {
    orders: number;
    /** sum(orders.subtotal) — menu price after modifiers, before any discount. */
    gross_sales: number;
    discounts: number;
    promo_discounts: number;
    /** Loyalty rewards and till discounts: discount_amount minus promo_discount. */
    other_discounts: number;
    /** From audit_logs, the only place a partial refund is recorded. */
    refunds: number;
    refund_count: number;
    net_sales: number;
    tax: number;
    delivery_fees: number;
    /** Card-only by construction — place-order charges it after the payment gate. */
    service_fees: number;
    tips: number;
    /** sum(orders.total): tax, fees and tips included. What the old KPI called Revenue. */
    gross_receipts: number;
    avg_order_value: number;
  };
  daily: {
    day: string;
    orders: number;
    gross_sales: number;
    discounts: number;
    refunds: number;
    gross_receipts: number;
  }[];
  refund_events: { day: string; amount: number }[];
}

export interface OrdersReport extends SectionWindow {
  totals: {
    orders: number;
    completed: number;
    cancelled: number;
    refunded: number;
    in_progress: number;
    cancel_rate_pct: number;
    completion_rate_pct: number;
    avg_order_value: number;
    avg_fulfil_min: number;
  };
  scheduled: { total: number; upcoming: number; fulfilled: number; cancelled: number };
  by_channel: { channel: string; orders: number; cancelled: number; revenue: number }[];
  by_source: { source: string; orders: number; revenue: number }[];
  by_status: { status: string; orders: number }[];
  by_hour: { hour: number; orders: number; revenue: number }[];
  hour_heatmap: { dow: string; hour: number; orders: number; revenue: number }[];
}

export interface MenuReport extends SectionWindow {
  totals: {
    items_sold: number;
    item_revenue: number;
    modifier_revenue: number;
    combo_revenue: number;
    distinct_items: number;
    promo_orders: number;
    promo_discount: number;
    promo_attributed_revenue: number;
  };
  by_item: {
    name: string;
    menu_item_id: string | null;
    quantity: number;
    revenue: number;
    orders: number;
  }[];
  by_category: {
    category: string;
    /** Set only on the two bands the report names itself ('Combos' / 'Uncategorised'); a
     *  category row with null band is the merchant's own name, whatever it says. */
    band?: 'combos' | 'uncategorised' | null;
    quantity: number;
    revenue: number;
  }[];
  by_combo: {
    combo_id: string | null;
    name: string;
    quantity: number;
    revenue: number;
    orders: number;
  }[];
  by_promo: { code: string; orders: number; gross_subtotal: number; discount: number }[];
}

export interface DeliveryReport extends SectionWindow {
  totals: {
    deliveries: number;
    completed: number;
    failed: number;
    cancelled: number;
    in_flight: number;
    avg_ride_min: number;
    avg_total_min: number;
    avg_accept_min: number;
    avg_distance_km: number;
    delivery_fees: number;
    tips_charged: number;
    tips_to_riders: number;
    tips_to_house: number;
    rider_payouts: number;
    rating_count: number;
    avg_stars: number;
  };
  star_distribution: { star: number; count: number }[];
  by_driver: {
    driver_id: string;
    name: string;
    /** False when name is the report's placeholder ('Rider'), not the rider's real name. */
    has_name?: boolean;
    delivered: number;
    avg_ride_min: number;
    tips: number;
    avg_stars: number;
  }[];
}

export interface CustomersReport extends SectionWindow {
  totals: {
    total_customers: number;
    active_customers: number;
    new_customers: number;
    returning_customers: number;
    /** Orders with no customer_id. They can never be attributed, so they are shown
     *  rather than quietly making new + returning fail to add up. */
    guest_orders: number;
    repeat_customers: number;
    avg_orders_per_customer: number;
    avg_spend_per_customer: number;
    points_earned: number;
    points_redeemed: number;
    points_manual: number;
    coupon_uses: number;
    coupon_discount: number;
  };
  top_customers: {
    customer_id: string;
    name: string;
    /** False when name is the report's placeholder ('Guest'), not the customer's real name. */
    has_name?: boolean;
    orders: number;
    spend: number;
    last_at: string | null;
    lifetime_orders: number | null;
    lifetime_spent: number | null;
    tier: string | null;
  }[];
  by_coupon: { code: string; uses: number; discount: number; customers: number }[];
}

export interface PaymentsReport extends SectionWindow {
  /** Every method x status cell, including the empty ones. Render from these rows, not
   *  from a literal column list — payment_status can gain a label. */
  by_method_status: { method: string; status: string; count: number; amount: number }[];
  by_method: { method: string; count: number; amount: number; settled: number }[];
  totals: {
    payments: number;
    settled: number;
    pending: number;
    failed: number;
    /** 0.00 by construction: refund_order() never writes payments. */
    refunded_on_payments: number;
    voided_on_payments: number;
    /** The real refund figure, from audit_logs. */
    refunds: number;
    refund_count: number;
    service_fee_collected: number;
    unsettled_on_completed_orders: number;
    backfilled_settlements: number;
  };
  refunds_daily: { day: string; amount: number }[];
}

export interface ReportSections {
  sales: SectionResult<SalesReport>;
  orders: SectionResult<OrdersReport>;
  menu: SectionResult<MenuReport>;
  delivery: SectionResult<DeliveryReport>;
  customers: SectionResult<CustomersReport>;
  payments: SectionResult<PaymentsReport>;
}

/**
 * A failure is never collapsed into `null` here. A merchant staring at "No data" cannot
 * tell a broken session from a quiet week, so the caller gets a coded error plus the
 * database's code, and the database's own words go to the server log.
 */
async function callSection<T>(
  supabase: ReportClient,
  fn: string,
  branchId: string,
  range: ReportRange,
): Promise<SectionResult<T>> {
  // The generated types have not been regenerated since these RPCs landed, so the name and
  // args are cast — the established pattern in this repo rather than a hand-edited types.ts.
  const { data, error } = await supabase.rpc(fn as never, {
    p_branch_id: branchId,
    p_from: range.from,
    p_to: range.to,
  } as never);
  if (error) {
    const parts = [error.message, error.hint, error.details].filter(Boolean);
    console.error(`[reports] ${fn}: ${parts.join(' — ')}${error.code ? ` (${error.code})` : ''}`);
    return { data: null, error: { code: sectionErrorCode(error), ref: error.code || null } };
  }
  if (!data) {
    console.error(`[reports] ${fn}: empty response`);
    return { data: null, error: { code: 'emptyResponse', ref: null } };
  }
  return { data: data as unknown as T, error: null };
}

/**
 * All six at once. Safe as a Promise.all only because getBranchAccess() has already called
 * auth.getUser() and settled any token refresh: two RPCs racing the same refresh leave the
 * loser authenticated as `anon`, which holds no EXECUTE and reads as "no data".
 */
export async function getReportSections(
  supabase: ReportClient,
  branchId: string,
  range: ReportRange,
): Promise<ReportSections> {
  const [sales, orders, menu, delivery, customers, payments] = await Promise.all([
    callSection<SalesReport>(supabase, 'get_branch_sales_report', branchId, range),
    callSection<OrdersReport>(supabase, 'get_branch_orders_report', branchId, range),
    callSection<MenuReport>(supabase, 'get_branch_menu_report', branchId, range),
    callSection<DeliveryReport>(supabase, 'get_branch_delivery_report', branchId, range),
    callSection<CustomersReport>(supabase, 'get_branch_customers_report', branchId, range),
    callSection<PaymentsReport>(supabase, 'get_branch_payments_report', branchId, range),
  ]);
  return { sales, orders, menu, delivery, customers, payments };
}
