// Platform billing through Stripe: restaurants paying the platform for their package
// (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md). Shared by the `stripe-billing` function (start,
// confirm, portal, status, set_enabled) and the platform webhook `stripe-webhook`.
//
// This is NOT Stripe Connect. Diners paying restaurants lives in ./stripe-connect.ts; the two share
// the platform's keys and nothing else (no code path, no endpoint, no table row).
//
// PURE ON PURPOSE. Nothing here imports, reads Deno.env, calls fetch or touches a database, so the
// admin app's vitest pins every request body Stripe receives and every rule applied to what Stripe
// answers (apps/admin/src/lib/stripe-billing-edge.test.ts). The functions do the I/O and call these.
//
// NOTE ON DEPLOYMENT: as with _shared/stripe-connect.ts, the Supabase CLI uploads the whole
// `supabase/functions` tree, so `../_shared/stripe-billing.ts` resolves. Through the Management API
// / MCP, pass this file as `_shared/stripe-billing.ts` next to `<fn>/index.ts`.
//
// Every builder returns a FLAT record ('line_items[0][price]' -> 'price_...'): it is what goes on
// the wire, key by key, so a test can compare it exactly and a reader can see what Stripe is told.

/**
 * Pinned on every v1 call. The same value as STRIPE_API_VERSION in ./stripe-connect.ts, duplicated
 * so this module imports nothing; a test fails if the two ever differ.
 */
export const STRIPE_API_VERSION = '2025-08-27.basil';

/**
 * The version the platform webhook endpoint was created with in the Dashboard, i.e. the shape its
 * events arrive in. Only ids are taken from an event; every object is re-read on STRIPE_API_VERSION.
 */
export const EVENT_API_VERSION = '2026-08-26.dahlia';

export const CURRENCY = 'usd';

// ---------------------------------------------------------------------------------------------
// Catalog identity (stable forever)
// ---------------------------------------------------------------------------------------------

/** The billing_products codes Stripe bills monthly, in the order lines are sent. */
export const MONTHLY_CODES = ['base', 'extra_branch', 'delivery'] as const;
export type MonthlyCode = (typeof MONTHLY_CODES)[number];

export function isMonthlyCode(value: unknown): value is MonthlyCode {
  return typeof value === 'string' && (MONTHLY_CODES as readonly string[]).includes(value);
}

/**
 * Products are created with these explicit ids, so a second create fails harmlessly instead of
 * making a duplicate, and an id on an invoice line maps back to a catalog code without a lookup.
 */
export const MONTHLY_PRODUCT_IDS: Readonly<Record<MonthlyCode, string>> = Object.freeze({
  base: 'favornoms_base',
  extra_branch: 'favornoms_extra_branch',
  delivery: 'favornoms_delivery',
});

/** One-time fees are charged as `price_data` on these products: never a stored Stripe price. */
export const SETUP_PRODUCT_IDS: Readonly<Record<MonthlyCode, string>> = Object.freeze({
  base: 'favornoms_base_setup',
  extra_branch: 'favornoms_extra_branch_setup',
  delivery: 'favornoms_delivery_setup',
});

/** What Checkout, invoices and the portal show the merchant for each product. */
export const PRODUCT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  favornoms_base: 'Favornoms package (first branch), monthly',
  favornoms_extra_branch: 'Additional branch, monthly',
  favornoms_delivery: 'Delivery for a branch, monthly',
  favornoms_base_setup: 'Favornoms package, one-time setup',
  favornoms_extra_branch_setup: 'Additional branch, one-time setup',
  favornoms_delivery_setup: 'Delivery for a branch, one-time setup',
});

export function monthlyProductId(code: MonthlyCode): string {
  return MONTHLY_PRODUCT_IDS[code];
}

export function setupProductId(code: MonthlyCode): string {
  return SETUP_PRODUCT_IDS[code];
}

/** A Stripe reference is either the id or the expanded object; this is the id either way. */
export function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' && id ? id : null;
  }
  return null;
}

/** Whether a product id is one of the monthly or the one-time products, or neither. */
export function productKindOf(product: unknown): 'monthly' | 'setup' | null {
  const id = idOf(product);
  if (!id) return null;
  if ((Object.values(MONTHLY_PRODUCT_IDS) as string[]).includes(id)) return 'monthly';
  if ((Object.values(SETUP_PRODUCT_IDS) as string[]).includes(id)) return 'setup';
  return null;
}

/** The billing_products code a product id stands for (monthly or one-time), or null. */
export function productCodeOf(product: unknown): MonthlyCode | null {
  const id = idOf(product);
  if (!id) return null;
  for (const code of MONTHLY_CODES) {
    if (MONTHLY_PRODUCT_IDS[code] === id || SETUP_PRODUCT_IDS[code] === id) return code;
  }
  return null;
}

/**
 * The recurring price's lookup key. The amount is IN the key, so a new price in billing_products
 * makes a new Stripe price and never edits an old one: existing subscribers keep the price their
 * items point at until their items are changed (a later decision for the owner).
 */
export function priceLookupKey(code: MonthlyCode, unitCents: number): string {
  return `favornoms_${code}_monthly_${unitCents}`;
}

export function parseLookupKey(key: unknown): { code: MonthlyCode; cents: number } | null {
  if (typeof key !== 'string') return null;
  const m = /^favornoms_(base|extra_branch|delivery)_monthly_(\d{1,9})$/.exec(key);
  if (!m) return null;
  const code = m[1];
  const cents = Number(m[2]);
  return isMonthlyCode(code) && Number.isSafeInteger(cents) ? { code, cents } : null;
}

/** POST /v1/products for one catalog product, created with its explicit id. */
export function productParams(productId: string): Record<string, string> {
  const code = productCodeOf(productId);
  const kind = productKindOf(productId);
  if (!code || !kind) throw new BillingParamsError('unknown_product');
  return {
    id: productId,
    name: PRODUCT_NAMES[productId] ?? productId,
    'metadata[product_code]': code,
    'metadata[kind]': kind,
    'metadata[purpose]': 'platform_billing',
  };
}

/**
 * POST /v1/prices for a monthly product at a catalog amount. transfer_lookup_key moves the key
 * from an archived or hand-made price to this one, so the lookup always finds exactly one.
 */
export function priceParams(code: MonthlyCode, unitCents: number): Record<string, string> {
  if (!isCents(unitCents) || unitCents <= 0) throw new BillingParamsError('bad_amount');
  return {
    product: monthlyProductId(code),
    currency: CURRENCY,
    unit_amount: String(unitCents),
    'recurring[interval]': 'month',
    lookup_key: priceLookupKey(code, unitCents),
    transfer_lookup_key: 'true',
    'metadata[product_code]': code,
  };
}

/** A price found by lookup key is used only if it is exactly what the key says. */
export function priceMatches(price: unknown, code: MonthlyCode, unitCents: number): boolean {
  if (!price || typeof price !== 'object') return false;
  const p = price as Record<string, unknown>;
  const recurring = (p.recurring ?? null) as {
    interval?: unknown;
    interval_count?: unknown;
  } | null;
  return (
    typeof p.id === 'string' &&
    p.active === true &&
    p.currency === CURRENCY &&
    p.unit_amount === unitCents &&
    p.lookup_key === priceLookupKey(code, unitCents) &&
    idOf(p.product) === monthlyProductId(code) &&
    recurring !== null &&
    recurring.interval === 'month' &&
    (recurring.interval_count === undefined ||
      recurring.interval_count === null ||
      recurring.interval_count === 1)
  );
}

/**
 * billing_products rows (code, monthly_price, is_active) -> the three monthly amounts in cents.
 * Null unless all three are active and priced: prices are not prepared from half a catalog.
 */
export function catalogMonthlyCents(
  rows: unknown,
): Array<{ code: MonthlyCode; cents: number }> | null {
  if (!Array.isArray(rows)) return null;
  const out: Array<{ code: MonthlyCode; cents: number }> = [];
  for (const code of MONTHLY_CODES) {
    const row = rows.find(
      (r) => r && typeof r === 'object' && (r as { code?: unknown }).code === code,
    ) as { monthly_price?: unknown; is_active?: unknown } | undefined;
    if (!row || row.is_active !== true) return null;
    const c = cents(row.monthly_price);
    if (!isCents(c) || c <= 0) return null;
    out.push({ code, cents: c });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

/**
 * Dollars (a number or the string Postgres numeric arrives as) to integer cents. NaN for anything
 * that is not a finite, non-negative amount, so a builder refuses it rather than charging 0.
 */
export function cents(value: unknown): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n < 0) return NaN;
  // numeric(10,2) has two decimals; the rounding only removes binary noise (0.29 * 100 = 28.999…).
  return Math.round(n * 100);
}

export function dollars(centsValue: number): number {
  return Math.round(centsValue) / 100;
}

export function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export class BillingParamsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BillingParamsError';
  }
}

// ---------------------------------------------------------------------------------------------
// The request being paid (public.billing_checkout_context)
// ---------------------------------------------------------------------------------------------

export interface ContextCharge {
  id: string;
  code: MonthlyCode;
  branch_id: string | null;
  /** billing_charges.net_amount in cents: after the platform's discount code, what is charged. */
  net_cents: number;
}

export interface ContextMonthlyLine {
  code: MonthlyCode;
  quantity: number;
  unit_amount_cents: number;
}

export interface ContextSubscription {
  status: string;
  plan_code: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
}

export interface CheckoutContext {
  request: {
    id: string;
    status: string;
    rail: string | null;
    stripe_checkout_session_id: string | null;
    /**
     * The invoice a change is already being paid through (3-D Secure, a declined card, or a paid
     * invoice whose settle did not finish). A request that has one is resolved from it and never
     * charged a second time (spec §9.4).
     */
    stripe_invoice_id: string | null;
  };
  restaurant: {
    id: string;
    name: string;
    slug: string | null;
    stripe_customer_id: string | null;
    owner_email: string | null;
  };
  charges: ContextCharge[];
  monthly_lines: ContextMonthlyLine[];
  subscription: ContextSubscription | null;
  stripe_managed: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** A Stripe id with the expected prefix that may go into a URL path, or null. */
function stripeIdOrNull(v: unknown, prefix: string): string | null {
  return typeof v === 'string' && v.startsWith(prefix) && /^[A-Za-z0-9_]{3,255}$/.test(v)
    ? v
    : null;
}

/**
 * The context as the edge function may act on it, or why not. Fails closed: a code Stripe has no
 * product for, a quantity or amount that is not a whole non-negative number, a duplicated monthly
 * line or a base line that is not exactly 1 is refused rather than sent to Stripe as something else.
 */
export function parseCheckoutContext(
  raw: unknown,
): { ok: true; ctx: CheckoutContext } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, error: 'bad_context' };
  const r = raw as Record<string, unknown>;
  if (r.ok !== true)
    return { ok: false, error: typeof r.error === 'string' && r.error ? r.error : 'forbidden' };

  const req = (r.request ?? null) as Record<string, unknown> | null;
  const rest = (r.restaurant ?? null) as Record<string, unknown> | null;
  const requestId = uuidOrNull(req?.id);
  const restaurantId = uuidOrNull(rest?.id);
  if (!req || !rest || !requestId || !restaurantId) return { ok: false, error: 'bad_context' };

  const charges: ContextCharge[] = [];
  for (const c of Array.isArray(r.charges) ? r.charges : []) {
    const row = (c ?? {}) as Record<string, unknown>;
    const id = uuidOrNull(row.id);
    const net = cents(row.net_amount);
    if (!id || !isMonthlyCode(row.code) || !isCents(net)) return { ok: false, error: 'bad_charge' };
    charges.push({ id, code: row.code, branch_id: uuidOrNull(row.branch_id), net_cents: net });
  }

  const lines: ContextMonthlyLine[] = [];
  for (const l of Array.isArray(r.monthly_lines) ? r.monthly_lines : []) {
    const row = (l ?? {}) as Record<string, unknown>;
    const quantity = Number(row.quantity);
    const unit = Number(row.unit_amount_cents);
    if (!isMonthlyCode(row.code) || !isCents(quantity) || !isCents(unit))
      return { ok: false, error: 'bad_monthly_line' };
    if (lines.some((x) => x.code === row.code)) return { ok: false, error: 'bad_monthly_line' };
    lines.push({ code: row.code, quantity, unit_amount_cents: unit });
  }
  const base = lines.find((l) => l.code === 'base');
  if (!base || base.quantity !== 1 || base.unit_amount_cents <= 0)
    return { ok: false, error: 'bad_monthly_line' };
  if (lines.some((l) => l.quantity > 0 && l.unit_amount_cents <= 0))
    return { ok: false, error: 'bad_monthly_line' };

  let subscription: ContextSubscription | null = null;
  if (r.subscription && typeof r.subscription === 'object') {
    const s = r.subscription as Record<string, unknown>;
    subscription = {
      status: typeof s.status === 'string' ? s.status : 'none',
      plan_code: strOrNull(s.plan_code),
      stripe_subscription_id: strOrNull(s.stripe_subscription_id),
      stripe_customer_id: strOrNull(s.stripe_customer_id),
      current_period_end: strOrNull(s.current_period_end),
      trial_ends_at: strOrNull(s.trial_ends_at),
    };
  }

  return {
    ok: true,
    ctx: {
      request: {
        id: requestId,
        status: typeof req.status === 'string' ? req.status : '',
        rail: strOrNull(req.rail),
        stripe_checkout_session_id: strOrNull(req.stripe_checkout_session_id),
        stripe_invoice_id: stripeIdOrNull(req.stripe_invoice_id, 'in_'),
      },
      restaurant: {
        id: restaurantId,
        name: typeof rest.name === 'string' ? rest.name : '',
        slug: strOrNull(rest.slug),
        stripe_customer_id: strOrNull(rest.stripe_customer_id),
        owner_email: strOrNull(rest.owner_email),
      },
      charges,
      monthly_lines: lines,
      subscription,
      stripe_managed: r.stripe_managed === true,
    },
  };
}

/** What the change charges once, in cents (after discounts). */
export function oneTimeTotalCents(ctx: CheckoutContext): number {
  return ctx.charges.reduce((sum, c) => sum + c.net_cents, 0);
}

interface OneTimeGroup {
  code: MonthlyCode;
  unit_cents: number;
  charge_ids: string[];
}

/**
 * Checkout and add_invoice_items each take at most 20 one-time lines, and a restaurant may add many
 * branches at once, so charges of the same product at the same net amount become one line with a
 * quantity. A $0 charge (a 100 % code, a free unlock) is not a line at all.
 */
function oneTimeGroups(charges: ContextCharge[]): OneTimeGroup[] {
  const groups: OneTimeGroup[] = [];
  for (const code of MONTHLY_CODES) {
    const byAmount = new Map<number, string[]>();
    for (const c of charges) {
      if (c.code !== code || c.net_cents <= 0) continue;
      const ids = byAmount.get(c.net_cents) ?? [];
      ids.push(c.id);
      byAmount.set(c.net_cents, ids);
    }
    for (const unit of [...byAmount.keys()].sort((a, b) => b - a)) {
      groups.push({ code, unit_cents: unit, charge_ids: byAmount.get(unit) ?? [] });
    }
  }
  if (groups.length > 20) throw new BillingParamsError('too_many_one_time_lines');
  return groups;
}

export type PriceIds = Partial<Record<MonthlyCode, string>>;

// ---------------------------------------------------------------------------------------------
// First purchase: Stripe Checkout in subscription mode (D4, D5)
// ---------------------------------------------------------------------------------------------

export interface CheckoutUrls {
  success_url: string;
  cancel_url: string;
}

/**
 * Back to the branch's plan page. {CHECKOUT_SESSION_ID} is Stripe's template, filled in by Stripe,
 * so the page can confirm the session without waiting for the webhook.
 */
export function checkoutUrls(origin: string, branchId: string): CheckoutUrls {
  const base = `${origin}/b/${encodeURIComponent(branchId)}/settings/plan`;
  return {
    success_url: `${base}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}?checkout=cancelled`,
  };
}

export function portalReturnUrl(origin: string, branchId: string): string {
  return `${origin}/b/${encodeURIComponent(branchId)}/settings/plan?portal=return`;
}

/**
 * POST /v1/checkout/sessions for the restaurant's first card purchase.
 *
 *   - the monthly lines are the catalog's recurring prices at the request's quantities; a line at
 *     quantity 0 is left out (Stripe refuses it, and it bills nothing);
 *   - each one-time charge is a one-time line PRICED AT ITS NET AMOUNT (price_data), so Stripe
 *     charges exactly billing_charges.net_amount and the platform's discount codes stay one-time;
 *   - no allow_promotion_codes: a Stripe promotion code could discount the monthly price;
 *   - card only, and a card is collected even when nothing is due today (renewals need it);
 *   - trialEnd (billingAnchor) defers the first MONTHLY charge to a date already covered; the
 *     one-time lines are charged now either way.
 * metadata.billing_request_id on the session and on the subscription is how the webhook finds the
 * request it settles.
 */
export function checkoutSessionParams(
  ctx: CheckoutContext,
  customerId: string,
  prices: PriceIds,
  urls: CheckoutUrls,
  trialEnd: number | null,
): Record<string, string> {
  const p: Record<string, string> = {
    mode: 'subscription',
    customer: customerId,
    client_reference_id: ctx.restaurant.id,
    success_url: urls.success_url,
    cancel_url: urls.cancel_url,
    'payment_method_types[0]': 'card',
    payment_method_collection: 'always',
    'metadata[billing_request_id]': ctx.request.id,
    'metadata[restaurant_id]': ctx.restaurant.id,
    'subscription_data[metadata][billing_request_id]': ctx.request.id,
    'subscription_data[metadata][restaurant_id]': ctx.restaurant.id,
  };
  if (trialEnd !== null) p['subscription_data[trial_end]'] = String(trialEnd);

  let i = 0;
  for (const code of MONTHLY_CODES) {
    const line = ctx.monthly_lines.find((l) => l.code === code);
    if (!line || line.quantity <= 0) continue;
    const price = prices[code];
    if (!price) throw new BillingParamsError(`missing_price:${code}`);
    p[`line_items[${i}][price]`] = price;
    p[`line_items[${i}][quantity]`] = String(line.quantity);
    i++;
  }
  if (i === 0) throw new BillingParamsError('no_monthly_line');
  for (const g of oneTimeGroups(ctx.charges)) {
    p[`line_items[${i}][price_data][currency]`] = CURRENCY;
    p[`line_items[${i}][price_data][product]`] = setupProductId(g.code);
    p[`line_items[${i}][price_data][unit_amount]`] = String(g.unit_cents);
    p[`line_items[${i}][quantity]`] = String(g.charge_ids.length);
    i++;
  }
  return p;
}

/** Checkout reported the money in (card payments are synchronous; nothing due counts too). */
export function sessionIsPaid(session: unknown): boolean {
  if (!session || typeof session !== 'object') return false;
  const s = session as Record<string, unknown>;
  return (
    s.mode === 'subscription' &&
    s.status === 'complete' &&
    (s.payment_status === 'paid' || s.payment_status === 'no_payment_required')
  );
}

// ---------------------------------------------------------------------------------------------
// When the monthly charge starts (D5)
// ---------------------------------------------------------------------------------------------

/** Checkout refuses a trial_end less than 48 hours out. */
export const STRIPE_MIN_TRIAL_LEAD_MS = 48 * 3600 * 1000;
/**
 * Margin on top of Stripe's 48 h, so a date just past the limit here is not just short of it by
 * the time the request reaches Stripe (and the session is not refused at the merchant's click).
 */
export const ANCHOR_SAFETY_MS = 10 * 60 * 1000;
/** Stripe keeps trials under two years; a date further out is clamped rather than refused. */
export const ANCHOR_MAX_LEAD_MS = 729 * 24 * 3600 * 1000;

function msOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The first monthly charge date for a first purchase, in unix seconds, or null for "charge now".
 *
 * Time already covered is not charged twice: during the free trial that is the trial's end, and on
 * the manual rail (active, or cancelled but still paid) it is the paid-through date. It is used
 * only when more than 48 hours remain (Stripe's minimum for a Checkout trial_end, plus a margin);
 * otherwise billing starts now and the few hours left are not worth a refused Checkout. past_due
 * and expired have nothing covered.
 */
export function billingAnchor(
  nowMs: number,
  trialEndsAt: string | null | undefined,
  currentPeriodEnd: string | null | undefined,
  status: string | null | undefined,
): number | null {
  const trial = msOf(trialEndsAt);
  const period = msOf(currentPeriodEnd);
  let covered: number | null = null;
  if (status === 'trialing') {
    covered = trial !== null && period !== null ? Math.max(trial, period) : (trial ?? period);
  } else if (status === 'active' || status === 'cancelled') {
    covered = period;
  }
  if (covered === null) return null;
  if (covered - nowMs <= STRIPE_MIN_TRIAL_LEAD_MS + ANCHOR_SAFETY_MS) return null;
  return Math.floor(Math.min(covered, nowMs + ANCHOR_MAX_LEAD_MS) / 1000);
}

// ---------------------------------------------------------------------------------------------
// Changing a paying restaurant's package: one subscription, updated in place (D7)
// ---------------------------------------------------------------------------------------------

export type CurrentItems = Partial<Record<MonthlyCode, { id: string; quantity: number }>>;

interface StripeItemLike {
  id?: unknown;
  quantity?: unknown;
  current_period_end?: unknown;
  price?: {
    id?: unknown;
    product?: unknown;
    unit_amount?: unknown;
    recurring?: unknown;
    type?: unknown;
  } | null;
}

function itemsOf(sub: unknown): StripeItemLike[] {
  const data = (sub as { items?: { data?: unknown } } | null)?.items?.data;
  return Array.isArray(data) ? (data as StripeItemLike[]) : [];
}

/**
 * The subscription's items by catalog code, read from Stripe (not from our rows, which can lag).
 * Refused when an item is not one of the monthly products or a product appears twice: a
 * subscription edited by hand is not changed by code that would misread it.
 */
export function subscriptionItemsByCode(
  sub: unknown,
): { ok: true; items: CurrentItems } | { ok: false; error: string } {
  const items: CurrentItems = {};
  for (const item of itemsOf(sub)) {
    const product = item.price?.product;
    const code = productKindOf(product) === 'monthly' ? productCodeOf(product) : null;
    const id = typeof item.id === 'string' ? item.id : null;
    if (!code || !id) return { ok: false, error: 'unknown_item' };
    if (items[code]) return { ok: false, error: 'duplicate_item' };
    const q = Number(item.quantity ?? 1);
    items[code] = { id, quantity: Number.isSafeInteger(q) && q >= 0 ? q : 0 };
  }
  return { ok: true, items };
}

/** [{product_code, stripe_subscription_item_id}] for billing_settle_stripe_request. */
export function settleItems(
  sub: unknown,
): Array<{ product_code: MonthlyCode; stripe_subscription_item_id: string }> {
  const out: Array<{ product_code: MonthlyCode; stripe_subscription_item_id: string }> = [];
  for (const item of itemsOf(sub)) {
    const product = item.price?.product;
    const code = productKindOf(product) === 'monthly' ? productCodeOf(product) : null;
    if (code && typeof item.id === 'string' && item.id)
      out.push({ product_code: code, stripe_subscription_item_id: item.id });
  }
  return out;
}

/** How many of each monthly product a package bills: every code, 0 for one it does not have. */
export type TargetQuantities = Record<MonthlyCode, number>;

/** The quantities the request's package bills each month (billing_checkout_context.monthly_lines). */
export function targetQuantities(ctx: CheckoutContext): TargetQuantities {
  const out = { base: 0, extra_branch: 0, delivery: 0 } as TargetQuantities;
  for (const line of ctx.monthly_lines) out[line.code] = Math.max(0, line.quantity);
  return out;
}

/** Whether Stripe's items already bill exactly these quantities (a missing item counts as 0). */
export function itemsMatch(target: TargetQuantities, current: CurrentItems): boolean {
  return MONTHLY_CODES.every((code) => (current[code]?.quantity ?? 0) === target[code]);
}

/**
 * The `items[...]` of an update that makes the subscription bill exactly `target`: EVERY item,
 * unchanged ones included, with its target quantity; an item going to 0 is deleted; a product the
 * subscription lacks is added at `prices[code]`. The whole target (not a diff) is sent so that a
 * retry under the same idempotency key is the same request: had only the difference been sent, a
 * retry after the first call applied would send nothing but the fees, a new body, and charge them
 * again (SP-2).
 */
export function targetItemParams(
  target: TargetQuantities,
  current: CurrentItems,
  prices: PriceIds,
): Record<string, string> {
  if (target.base !== 1) throw new BillingParamsError('base_removed');
  const p: Record<string, string> = {};
  let i = 0;
  for (const code of MONTHLY_CODES) {
    const want = target[code];
    const have = current[code];
    if (have) {
      p[`items[${i}][id]`] = have.id;
      if (want <= 0) p[`items[${i}][deleted]`] = 'true';
      else p[`items[${i}][quantity]`] = String(want);
      i++;
    } else if (want > 0) {
      const price = prices[code];
      if (!price) throw new BillingParamsError(`missing_price:${code}`);
      p[`items[${i}][price]`] = price;
      p[`items[${i}][quantity]`] = String(want);
      i++;
    }
  }
  return p;
}

/**
 * POST /v1/subscriptions/{id} for a paying restaurant's change.
 *
 *   - the full target (targetItemParams): every item with its target quantity, deleted at 0, a
 *     product the subscription lacks added at the catalog's recurring price;
 *   - the new one-time fees ride along as add_invoice_items at their NET amount;
 *   - proration_behavior=always_invoice charges the difference NOW (and credits a removed branch
 *     or delivery for its unused days);
 *   - payment_behavior=pending_if_incomplete applies the change only if that invoice is paid;
 *     otherwise the subscription carries a pending_update and the merchant pays on Stripe's page;
 *   - latest_invoice is expanded to tell which of the two happened.
 * Sent under changeIdempotencyKey(request): one key per request, no fingerprint, so a retry replays
 * Stripe's first answer instead of charging again.
 * The subscription's own metadata is NOT sent: on the pinned basil version Stripe refuses
 * `metadata` together with pending_if_incomplete (allowed only from 2026-05-27.dahlia). The request
 * is found from the invoice instead (billing_mark_request_stripe stores its id), and each one-time
 * line carries the request id in its own metadata (add_invoice_items metadata exists on basil).
 */
export function subscriptionUpdateParams(
  ctx: CheckoutContext,
  current: CurrentItems,
  prices: PriceIds,
): Record<string, string> {
  const p: Record<string, string> = targetItemParams(targetQuantities(ctx), current, prices);
  let j = 0;
  for (const g of oneTimeGroups(ctx.charges)) {
    p[`add_invoice_items[${j}][price_data][currency]`] = CURRENCY;
    p[`add_invoice_items[${j}][price_data][product]`] = setupProductId(g.code);
    p[`add_invoice_items[${j}][price_data][unit_amount]`] = String(g.unit_cents);
    p[`add_invoice_items[${j}][quantity]`] = String(g.charge_ids.length);
    p[`add_invoice_items[${j}][metadata][billing_request_id]`] = ctx.request.id;
    p[`add_invoice_items[${j}][metadata][product_code]`] = g.code;
    const only = g.charge_ids.length === 1 ? g.charge_ids[0] : undefined;
    if (only) p[`add_invoice_items[${j}][metadata][billing_charge_id]`] = only;
    j++;
  }
  p.proration_behavior = 'always_invoice';
  p.payment_behavior = 'pending_if_incomplete';
  p['expand[0]'] = 'latest_invoice';
  return p;
}

/** Whether an update built above adds one-time fees. */
export function updateAddsOneTimeFees(params: Record<string, string>): boolean {
  return Object.keys(params).some((k) => k.startsWith('add_invoice_items['));
}

/**
 * POST /v1/invoices for a change's one-time fees when no proration invoice carries them (a fee
 * with no quantity change: delivery moved from one branch to another; or a change during a trial).
 * money-rr-5: the invoice is made FIRST, empty (pending_invoice_items_behavior=exclude), and the
 * fees are then created ON it (feeInvoiceItemParams with invoice=<id>), so a fee never waits as a
 * pending invoice item that the next renewal would sweep up if this flow stopped half way.
 * auto_advance=false: it is finalized and charged here, and Stripe never emails or retries it.
 * Sent once per request (changeInvoiceIdempotencyKey); the body must stay the same for that.
 */
export function feeInvoiceParams(
  ctx: CheckoutContext,
  customerId: string,
  subscriptionId: string,
): Record<string, string> {
  return {
    customer: customerId,
    subscription: subscriptionId,
    pending_invoice_items_behavior: 'exclude',
    auto_advance: 'false',
    'metadata[billing_request_id]': ctx.request.id,
    'metadata[restaurant_id]': ctx.restaurant.id,
  };
}

/**
 * POST /v1/invoiceitems, one per group of identical fees, each created ON the fee invoice. Every
 * item carries the request (and its charge when it is one), like add_invoice_items on an update,
 * so the fees can always be traced back to the request that bought them.
 */
export function feeInvoiceItemParams(
  ctx: CheckoutContext,
  customerId: string,
  invoiceId: string,
): Array<Record<string, string>> {
  return oneTimeGroups(ctx.charges).map((g) => {
    const p: Record<string, string> = {
      customer: customerId,
      invoice: invoiceId,
      'price_data[currency]': CURRENCY,
      'price_data[product]': setupProductId(g.code),
      'price_data[unit_amount]': String(g.unit_cents),
      quantity: String(g.charge_ids.length),
      'metadata[billing_request_id]': ctx.request.id,
      'metadata[product_code]': g.code,
    };
    const only = g.charge_ids.length === 1 ? g.charge_ids[0] : undefined;
    if (only) p['metadata[billing_charge_id]'] = only;
    return p;
  });
}

/**
 * The invoice items (GET /v1/invoiceitems?customer=…) that belong to this request, by their own
 * metadata: those already on an invoice (the invoice the fees were charged or are waiting on) and
 * those still pending (fees an update added that no invoice has taken yet, which must be removed
 * before the fees are invoiced on their own, or the next renewal would charge them again).
 */
export function requestInvoiceItems(
  list: unknown,
  requestId: string,
): { invoiceIds: string[]; pendingIds: string[] } {
  const invoiceIds: string[] = [];
  const pendingIds: string[] = [];
  const data = (list as { data?: unknown } | null)?.data;
  for (const row of Array.isArray(data) ? data : []) {
    const item = (row ?? {}) as { id?: unknown; invoice?: unknown; metadata?: unknown };
    const meta = (item.metadata ?? null) as { billing_request_id?: unknown } | null;
    if (!UUID_RE.test(requestId) || meta?.billing_request_id !== requestId) continue;
    const invoice = idOf(item.invoice);
    if (invoice) {
      if (!invoiceIds.includes(invoice)) invoiceIds.push(invoice);
    } else if (typeof item.id === 'string' && item.id.startsWith('ii_')) {
      pendingIds.push(item.id);
    }
  }
  return { invoiceIds, pendingIds };
}

/**
 * POST /v1/subscriptions/{id} that puts the items back to what the database granted, after a
 * change was paid for but could not be applied (the request was replaced or refused, or the settle
 * failed). proration_behavior=none: the money for the change is refunded separately, so nothing is
 * charged or credited for putting it back.
 */
export function revertParams(
  granted: TargetQuantities,
  current: CurrentItems,
  prices: PriceIds,
): Record<string, string> {
  return { ...targetItemParams(granted, current, prices), proration_behavior: 'none' };
}

/**
 * The package the database has granted, as Stripe quantities, from the restaurant's
 * subscription_items rows ({product_code, quantity, unit_price}): the lines Stripe should be
 * billing if nothing had drifted. The delivery line is kept at quantity 1 priced 0 when no branch
 * delivers (billing_compute), so a line priced 0 counts as 0. Null when the rows cannot be read as
 * a package (no base line), so a revert is never sent from half a picture.
 */
export function grantedLines(
  rows: unknown,
): { quantities: TargetQuantities; cents: Partial<Record<MonthlyCode, number>> } | null {
  if (!Array.isArray(rows)) return null;
  const quantities = { base: 0, extra_branch: 0, delivery: 0 } as TargetQuantities;
  const unit: Partial<Record<MonthlyCode, number>> = {};
  for (const r of rows) {
    const row = (r ?? {}) as { product_code?: unknown; quantity?: unknown; unit_price?: unknown };
    if (!isMonthlyCode(row.product_code)) continue;
    const q = Number(row.quantity);
    const c = cents(row.unit_price);
    if (!Number.isSafeInteger(q) || q < 0 || !isCents(c)) return null;
    quantities[row.product_code] = c > 0 ? q : 0;
    if (c > 0) unit[row.product_code] = c;
  }
  if (quantities.base !== 1) return null;
  return { quantities, cents: unit };
}

/**
 * Stripe's recurring total per month, in DOLLARS (subscriptions.stripe_monthly_amount, spec §9.6):
 * the sum of unit_amount x quantity over the subscription's items, read from the subscription as
 * Stripe has it. Null when any item's price is not a readable recurring amount, so a wrong
 * figure is never stored.
 */
export function subscriptionMonthlyAmount(sub: unknown): number | null {
  const items = itemsOf(sub);
  if (items.length === 0) return null;
  let total = 0;
  for (const item of items) {
    const price = item.price ?? null;
    if (!price || (price.recurring == null && price.type !== 'recurring')) return null;
    const unitAmount = price.unit_amount;
    const q = Number(item.quantity ?? 1);
    if (!isCents(unitAmount) || !Number.isSafeInteger(q) || q < 0) return null;
    total += unitAmount * q;
  }
  return Number.isSafeInteger(total) ? dollars(total) : null;
}

// ---------------------------------------------------------------------------------------------
// Reading what Stripe says (subscriptions, invoices, cards)
// ---------------------------------------------------------------------------------------------

function unix(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

export function isoFromUnix(seconds: number | null | undefined): string | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : null;
}

/**
 * The date a subscription is paid through, in unix seconds. On basil the period lives on the items
 * (subscription.current_period_end no longer exists; reading it is what granted a free month per
 * event), so it is the latest item period end; while trialing it is the trial's end, which is the
 * first monthly charge date (D5).
 */
export function subscriptionPaidThrough(sub: unknown): number | null {
  if (!sub || typeof sub !== 'object') return null;
  const s = sub as { status?: unknown; trial_end?: unknown };
  const trialEnd = unix(s.trial_end);
  if (s.status === 'trialing' && trialEnd !== null) return trialEnd;
  let max: number | null = null;
  for (const item of itemsOf(sub)) {
    const end = unix(item.current_period_end);
    if (end !== null && (max === null || end > max)) max = end;
  }
  return max;
}

/** When Stripe will charge next, or null when it will not (cancelling, cancelled, ended). */
export function nextChargeAt(sub: unknown): number | null {
  if (!sub || typeof sub !== 'object') return null;
  const s = sub as { status?: unknown; cancel_at_period_end?: unknown; cancel_at?: unknown };
  if (!isStripeManagedStatus(s.status)) return null;
  if (s.cancel_at_period_end === true) return null;
  const next = subscriptionPaidThrough(sub);
  const cancelAt = unix(s.cancel_at);
  if (next !== null && cancelAt !== null && cancelAt <= next) return null;
  return next;
}

/** Stripe statuses of a live subscription the restaurant is billed through. */
export function isStripeManagedStatus(status: unknown): boolean {
  return status === 'trialing' || status === 'active' || status === 'past_due';
}

/**
 * The subscription an invoice belongs to: basil's parent.subscription_details.subscription, or the
 * legacy top-level `subscription` of older shapes. Either may be an id or an expanded object.
 */
export function invoiceSubscriptionId(inv: unknown): string | null {
  if (!inv || typeof inv !== 'object') return null;
  const i = inv as {
    parent?: { subscription_details?: { subscription?: unknown } | null } | null;
    subscription?: unknown;
  };
  return idOf(i.parent?.subscription_details?.subscription) ?? idOf(i.subscription);
}

/**
 * The service period an invoice bills, from its subscription-item lines (basil:
 * parent.type = subscription_item_details). The invoice's own period_start/period_end are the
 * PREVIOUS period on a renewal, so they are only the fallback.
 */
export function invoiceServicePeriod(inv: unknown): { start: number | null; end: number | null } {
  const i = (inv ?? {}) as {
    lines?: { data?: unknown };
    period_start?: unknown;
    period_end?: unknown;
  };
  let start: number | null = null;
  let end: number | null = null;
  const lines = Array.isArray(i.lines?.data)
    ? (i.lines?.data as Array<Record<string, unknown>>)
    : [];
  for (const line of lines) {
    const parentType = (line.parent as { type?: unknown } | null | undefined)?.type;
    if (parentType !== 'subscription_item_details' && line.type !== 'subscription') continue;
    const period = (line.period ?? {}) as { start?: unknown; end?: unknown };
    const s = unix(period.start);
    const e = unix(period.end);
    if (s !== null && (start === null || s < start)) start = s;
    if (e !== null && (end === null || e > end)) end = e;
  }
  if (start === null && end === null)
    return { start: unix(i.period_start), end: unix(i.period_end) };
  return { start, end };
}

/**
 * How far a PAID invoice pays the restaurant through, in unix seconds, or null when it pays for no
 * period (D8: only money for a period moves the date).
 *
 *   - Only the first invoice (subscription_create) and renewals (subscription_cycle) pay for a
 *     period. A change's proration invoice or a one-off invoice does not: paying $70 for a new
 *     branch while a renewal is still unpaid must not extend access over that unpaid month.
 *   - The date is the end of the period the invoice's own subscription lines bill, capped at the
 *     subscription's current paid-through (subscriptionPaidThrough). So a renewal retried and paid
 *     late, after the next period has already started, pays through ITS period and no further.
 *     When the lines are not in the answer (Stripe returns the first ten), the subscription's date
 *     is used, as the spec's first cut did.
 */
export function invoicePaidThrough(inv: unknown, sub: unknown): number | null {
  if (!inv || typeof inv !== 'object') return null;
  const reason = (inv as { billing_reason?: unknown }).billing_reason;
  if (reason !== 'subscription_create' && reason !== 'subscription_cycle') return null;
  const subEnd = subscriptionPaidThrough(sub);
  let linesEnd: number | null = null;
  const lines = (inv as { lines?: { data?: unknown } }).lines?.data;
  for (const line of Array.isArray(lines) ? (lines as Array<Record<string, unknown>>) : []) {
    const parentType = (line.parent as { type?: unknown } | null | undefined)?.type;
    if (parentType !== 'subscription_item_details' && line.type !== 'subscription') continue;
    const end = unix((line.period as { end?: unknown } | null | undefined)?.end);
    if (end !== null && (linesEnd === null || end > linesEnd)) linesEnd = end;
  }
  if (linesEnd === null) return subEnd;
  return subEnd === null ? linesEnd : Math.min(linesEnd, subEnd);
}

export interface InvoiceRecord {
  id: string;
  subscription: string | null;
  customer: string | null;
  billing_reason: string | null;
  status: string;
  /** Cents, as Stripe states them (billing_json_dollars in the SQL makes them dollars). */
  amount_due: number;
  amount_paid: number;
  currency: string;
  /** ISO timestamps. */
  period_start: string | null;
  period_end: string | null;
  hosted_invoice_url: string | null;
  paid_at: string | null;
  attempt_count: number;
}

/**
 * The p_invoice payload of billing_record_stripe_invoice(_failed), from a re-read invoice: Stripe's
 * own fields and units (amounts in cents), trimmed to what the SQL reads, with the subscription at
 * the top level whatever the version, and the period taken from the subscription lines.
 */
export function invoiceRecord(inv: unknown): InvoiceRecord | null {
  if (!inv || typeof inv !== 'object') return null;
  const i = inv as Record<string, unknown>;
  const id = typeof i.id === 'string' && i.id ? i.id : null;
  if (!id) return null;
  const period = invoiceServicePeriod(inv);
  const transitions = (i.status_transitions ?? {}) as { paid_at?: unknown };
  const due = Number(i.amount_due);
  const paid = Number(i.amount_paid);
  const attempts = Number(i.attempt_count);
  return {
    id,
    subscription: invoiceSubscriptionId(inv),
    customer: idOf(i.customer),
    billing_reason: strOrNull(i.billing_reason),
    status: typeof i.status === 'string' ? i.status : 'open',
    amount_due: Number.isSafeInteger(due) ? due : 0,
    amount_paid: Number.isSafeInteger(paid) ? paid : 0,
    currency: typeof i.currency === 'string' && i.currency ? i.currency : CURRENCY,
    period_start: isoFromUnix(period.start),
    period_end: isoFromUnix(period.end),
    hosted_invoice_url: strOrNull(i.hosted_invoice_url),
    paid_at: isoFromUnix(unix(transitions.paid_at)),
    attempt_count: Number.isSafeInteger(attempts) && attempts >= 0 ? attempts : 0,
  };
}

export interface CardSummary {
  brand: string;
  last4: string;
  exp_month: number | null;
  exp_year: number | null;
}

/** An expanded card PaymentMethod to what the billing card shows; null for anything else. */
export function mapCard(pm: unknown): CardSummary | null {
  if (!pm || typeof pm !== 'object') return null;
  const m = pm as { type?: unknown; card?: unknown };
  if (m.type !== undefined && m.type !== 'card') return null;
  const card = (m.card ?? null) as {
    brand?: unknown;
    last4?: unknown;
    exp_month?: unknown;
    exp_year?: unknown;
  } | null;
  if (!card || typeof card.brand !== 'string' || !card.brand) return null;
  if (typeof card.last4 !== 'string' || !/^\d{4}$/.test(card.last4)) return null;
  const month = Number(card.exp_month);
  const year = Number(card.exp_year);
  return {
    brand: card.brand,
    last4: card.last4,
    exp_month: Number.isSafeInteger(month) && month >= 1 && month <= 12 ? month : null,
    exp_year: Number.isSafeInteger(year) && year > 0 ? year : null,
  };
}

/**
 * The card renewals are charged to: the subscription's own default first (what Stripe tries first),
 * then the customer's invoice default (where the portal writes a new card). Both must be expanded.
 */
export function cardOf(sub: unknown): CardSummary | null {
  if (!sub || typeof sub !== 'object') return null;
  const s = sub as { default_payment_method?: unknown; customer?: unknown };
  const own = mapCard(s.default_payment_method);
  if (own) return own;
  const customer = (s.customer ?? null) as {
    invoice_settings?: { default_payment_method?: unknown } | null;
  } | null;
  return customer && typeof customer === 'object'
    ? mapCard(customer.invoice_settings?.default_payment_method)
    : null;
}

/** Arguments of billing_sync_stripe_status from a re-read subscription (and an optional card). */
export function syncStatusArgs(
  sub: unknown,
  card: CardSummary | null,
): Record<string, unknown> | null {
  if (!sub || typeof sub !== 'object') return null;
  const s = sub as {
    id?: unknown;
    status?: unknown;
    cancel_at_period_end?: unknown;
    cancel_at?: unknown;
  };
  if (typeof s.id !== 'string' || !s.id || typeof s.status !== 'string') return null;
  return {
    p_stripe_subscription_id: s.id,
    p_status: s.status,
    p_cancel_at_period_end: s.cancel_at_period_end === true,
    p_cancel_at: isoFromUnix(unix(s.cancel_at)),
    p_next_billing_at: isoFromUnix(nextChargeAt(sub)),
    p_card: card,
    p_monthly_amount: subscriptionMonthlyAmount(sub),
  };
}

/**
 * billing_sync_stripe_status for a card change only (customer.updated): p_status null updates just
 * what is given, so a subscription event read here can never relabel the restaurant's status or
 * move a date (WH-8).
 */
export function cardOnlySyncArgs(
  subscriptionId: string,
  card: CardSummary | null,
  monthlyAmount: number | null,
): Record<string, unknown> {
  return {
    p_stripe_subscription_id: subscriptionId,
    p_status: null,
    p_cancel_at_period_end: null,
    p_cancel_at: null,
    p_next_billing_at: null,
    p_card: card,
    p_monthly_amount: monthlyAmount,
  };
}

/**
 * Arguments of billing_settle_stripe_request for a completed Checkout session and its (expanded
 * or re-read) subscription. Null when the session names no subscription or customer.
 */
export function checkoutSettleArgs(
  session: unknown,
  sub: unknown,
  requestId: string,
): Record<string, unknown> | null {
  if (!session || typeof session !== 'object' || !sub || typeof sub !== 'object') return null;
  const s = session as { customer?: unknown; invoice?: unknown };
  const subscription = sub as { id?: unknown; customer?: unknown; latest_invoice?: unknown };
  const subId = typeof subscription.id === 'string' && subscription.id ? subscription.id : null;
  const customer = idOf(s.customer) ?? idOf(subscription.customer);
  if (!subId || !customer || !UUID_RE.test(requestId)) return null;
  return {
    p_request_id: requestId,
    p_stripe_customer_id: customer,
    p_stripe_subscription_id: subId,
    p_invoice_id: idOf(s.invoice) ?? idOf(subscription.latest_invoice),
    p_paid_through: isoFromUnix(subscriptionPaidThrough(sub)),
    p_items: settleItems(sub),
    p_card: cardOf(sub),
    p_monthly_amount: subscriptionMonthlyAmount(sub),
  };
}

/**
 * Arguments of billing_settle_stripe_request for a paid (or free) subscription CHANGE, from the
 * subscription re-read after the change: its items, its card and Stripe's new monthly total. The
 * paid-through date is Stripe's; the SQL keeps the current period for a change.
 */
export function changeSettleArgs(
  requestId: string,
  customerId: string,
  sub: unknown,
  invoiceId: string | null,
): Record<string, unknown> | null {
  const subId = idOf(sub);
  if (!subId || !customerId || !UUID_RE.test(requestId)) return null;
  return {
    p_request_id: requestId,
    p_stripe_customer_id: customerId,
    p_stripe_subscription_id: subId,
    p_invoice_id: invoiceId,
    p_paid_through: isoFromUnix(subscriptionPaidThrough(sub)),
    p_items: settleItems(sub),
    p_card: cardOf(sub),
    p_monthly_amount: subscriptionMonthlyAmount(sub),
  };
}

/**
 * What a paid invoice can be refunded through (GET /v1/invoice_payments?invoice=…&status=paid):
 * on basil an invoice no longer names its payment_intent; its InvoicePayments do.
 */
export function invoicePaymentTargets(
  list: unknown,
): Array<{ payment_intent: string } | { charge: string }> {
  const data = (list as { data?: unknown } | null)?.data;
  const out: Array<{ payment_intent: string } | { charge: string }> = [];
  for (const row of Array.isArray(data) ? data : []) {
    const r = (row ?? {}) as {
      status?: unknown;
      payment?: { type?: unknown; payment_intent?: unknown; charge?: unknown } | null;
    };
    if (r.status !== 'paid' || !r.payment) continue;
    const pi = idOf(r.payment.payment_intent);
    const ch = idOf(r.payment.charge);
    if (r.payment.type === 'payment_intent' && pi) out.push({ payment_intent: pi });
    else if (r.payment.type === 'charge' && ch) out.push({ charge: ch });
  }
  return out;
}

/**
 * POST /v1/refunds for a payment that bought nothing: a stale Checkout tab paid after the merchant
 * changed their mind (D12), or a paid purchase or change the database could not apply (§9.5).
 * Always the full payment.
 *
 * The body names neither WHY nor for WHICH request, on purpose: the edge function and the webhook
 * can both refund the same payment (the merchant's tab and invoice.paid race; a change invoice of a
 * subscription that is no longer the restaurant's, refunded with or without its request), under the
 * same refundIdempotencyKey, and Stripe refuses a reused key whose body differs. The why and the
 * request are in the billing log; the payment itself leads to its invoice.
 */
export function refundParams(
  target: { payment_intent: string } | { charge: string },
): Record<string, string> {
  return {
    ...('payment_intent' in target
      ? { payment_intent: target.payment_intent }
      : { charge: target.charge }),
    reason: 'requested_by_customer',
    'metadata[purpose]': 'platform_billing_refund',
  };
}

export function refundTargetId(target: { payment_intent: string } | { charge: string }): string {
  return 'payment_intent' in target ? target.payment_intent : target.charge;
}

/** A refund Stripe refuses because the payment is already refunded: the state wanted. */
export function isAlreadyRefunded(error: unknown): boolean {
  const code = (error as { error?: { code?: unknown } } | null)?.error?.code;
  return code === 'charge_already_refunded';
}

export type RefundOutcome = 'refunded' | 'nothing_to_refund' | 'partly_refunded' | 'not_refunded';

/**
 * What a refund attempt really did, for the log (WH-7: a subscription cancelled while the money was
 * kept must not be logged as "refunded"). `amountPaidCents` is the invoice's amount_paid; `read` is
 * whether its payments could be listed; `refunded` / `failed` count the refund calls.
 */
export function refundOutcome(s: {
  amountPaidCents: number;
  read: boolean;
  refunded: number;
  failed: number;
}): { outcome: RefundOutcome; complete: boolean } {
  if (s.amountPaidCents <= 0 && s.failed === 0 && s.refunded === 0)
    return { outcome: 'nothing_to_refund', complete: true };
  if (!s.read || s.refunded === 0) return { outcome: 'not_refunded', complete: false };
  if (s.failed > 0) return { outcome: 'partly_refunded', complete: false };
  return { outcome: 'refunded', complete: true };
}

/**
 * The code the merchant is answered with when a change Stripe applied could not be applied here
 * (§9.5, §10.9), saying exactly what happened to their money:
 *   - `charged_refunded`: the card was charged and ALL of it is being refunded;
 *   - `charged_not_applied`: the card was charged and the refund did not (fully) go through, so a
 *     person follows it up (never "nothing was charged", never "it is coming back");
 *   - `change_not_applied`: nothing was charged to the card (a downgrade's credit, a $0 invoice).
 * The settle's own reason goes in the answer's body next to it.
 */
export function changeFailureCode(amountPaidCents: number, refundComplete: boolean): string {
  if (amountPaidCents <= 0) return 'change_not_applied';
  return refundComplete ? 'charged_refunded' : 'charged_not_applied';
}

/**
 * Stripe's answer to a reused Idempotency-Key whose body differs from the first request's: a 400
 * of type idempotency_error. Only then is what the first request did read back from Stripe.
 */
export function isIdempotencyError(status: number, error: unknown): boolean {
  return (
    status === 400 &&
    (error as { error?: { type?: unknown } } | null)?.error?.type === 'idempotency_error'
  );
}

/**
 * The same key is still being processed by another request (a double click, a reload while the
 * first call is running): Stripe answers 409 idempotency_key_in_use. Nothing is known yet about
 * what the first request will do, so this is "busy, try again" (payment_in_progress), never a
 * conflict to resolve (edge-rr-3).
 */
export function isIdempotencyInUse(status: number, error: unknown): boolean {
  return (
    status === 409 ||
    (error as { error?: { code?: unknown } } | null)?.error?.code === 'idempotency_key_in_use'
  );
}

/**
 * Whether an invoice is this request's: the standalone fee invoice carries metadata
 * billing_request_id, and each one-time fee line of a change carries it too (subscription metadata
 * cannot be sent on basil with pending_if_incomplete, so a quantity-only change's proration invoice
 * carries nothing and is not recognised here).
 */
export function invoiceTiedToRequest(inv: unknown, requestId: string): boolean {
  if (!inv || typeof inv !== 'object' || !UUID_RE.test(requestId)) return false;
  const i = inv as {
    metadata?: { billing_request_id?: unknown } | null;
    lines?: { data?: unknown };
  };
  if (i.metadata?.billing_request_id === requestId) return true;
  const lines = Array.isArray(i.lines?.data)
    ? (i.lines?.data as Array<Record<string, unknown>>)
    : [];
  return lines.some(
    (l) =>
      (l.metadata as { billing_request_id?: unknown } | null | undefined)?.billing_request_id ===
      requestId,
  );
}

/**
 * The request a change's invoice was raised for, read from the invoice itself when the request
 * never had it stored (money-rr-4: the function stopped between the charge and the mark): the fee
 * invoice's own metadata, or the request id on its fee lines. Only for a change's invoice
 * (subscription_update, or the standalone fee invoice, `manual`): a renewal can never be taken for
 * a request's payment. Null when nothing names one, or when two different requests are named.
 */
export function invoiceRequestId(inv: unknown): string | null {
  if (!inv || typeof inv !== 'object') return null;
  const i = inv as {
    billing_reason?: unknown;
    metadata?: { billing_request_id?: unknown } | null;
    lines?: { data?: unknown };
  };
  if (i.billing_reason !== 'subscription_update' && i.billing_reason !== 'manual') return null;
  const found = new Set<string>();
  const own = uuidOrNull(i.metadata?.billing_request_id);
  if (own) found.add(own);
  const lines = Array.isArray(i.lines?.data)
    ? (i.lines?.data as Array<Record<string, unknown>>)
    : [];
  for (const l of lines) {
    const id = uuidOrNull(
      (l.metadata as { billing_request_id?: unknown } | null | undefined)?.billing_request_id,
    );
    if (id) found.add(id);
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

/**
 * How much a finalized invoice moved the customer's credit balance, in cents: positive when the
 * customer owes more afterwards (credit used up, or a too-small amount carried forward), negative
 * when it was credited (a downgrade's proration). ending_balance - starting_balance; 0 when the
 * invoice is not finalized (ending_balance null) or the fields are unreadable.
 */
export function invoiceBalanceMovement(inv: unknown): number {
  if (!inv || typeof inv !== 'object') return 0;
  const i = inv as { starting_balance?: unknown; ending_balance?: unknown };
  const start = i.starting_balance;
  const end = i.ending_balance;
  if (typeof start !== 'number' || typeof end !== 'number') return 0;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 0;
  return end - start;
}

/**
 * POST /v1/customers/{customer}/balance_transactions that undoes what a change invoice did to the
 * customer's credit balance, when the change it paid for is put back (money-rr-8, edge-rr-2): a
 * downgrade's credit is taken back (a debit), credit spent on an upgrade is given back (a credit).
 * Negative amounts credit the customer, positive amounts debit them. The same body from the edge
 * function and the webhook (balanceUndoIdempotencyKey), so only one of them moves the balance.
 * Null when the invoice moved nothing.
 */
export function balanceUndoParams(
  requestId: string,
  invoiceId: string,
  movementCents: number,
): Record<string, string> | null {
  if (!Number.isSafeInteger(movementCents) || movementCents === 0) return null;
  return {
    amount: String(-movementCents),
    currency: CURRENCY,
    description: 'Package change not applied: balance movement of its invoice reversed',
    'metadata[billing_request_id]': requestId,
    'metadata[invoice]': invoiceId,
    'metadata[purpose]': 'platform_billing_balance_undo',
  };
}

/**
 * Invoices of a subscription the restaurant no longer has that are refunded when paid (money-rr-2):
 * a renewal or a change charged by a subscription the manual rail detached while Stripe was still
 * retrying it. The first invoice (subscription_create) is Checkout's, and checkout.session.completed
 * decides about it.
 */
export function isStaleRefundableReason(billingReason: unknown): boolean {
  return billingReason === 'subscription_cycle' || billingReason === 'subscription_update';
}

/**
 * The restaurant a subscription was made for, when it is provably ours: its own
 * metadata.restaurant_id AND its (expanded) customer's metadata.restaurant_id name the same
 * restaurant. Null otherwise, so a subscription someone made by hand is never refunded or cancelled.
 */
export function subscriptionOwner(sub: unknown): string | null {
  if (!sub || typeof sub !== 'object') return null;
  const s = sub as { metadata?: { restaurant_id?: unknown } | null; customer?: unknown };
  const restaurantId = uuidOrNull(s.metadata?.restaurant_id);
  if (!restaurantId) return null;
  return customerBelongsTo(s.customer, restaurantId) ? restaurantId : null;
}

export type EventClaim = 'claimed' | 'handled' | 'in_flight';

/**
 * What stripe_event_claim answered (SEC-R2-2): 'claimed' (this delivery handles the event),
 * 'handled' (done before: answer 200 duplicate) or 'in_flight' (another delivery holds a live
 * lease: answer non-2xx, so Stripe retries after the lease instead of counting it delivered).
 * Anything unreadable is in flight: retrying is the safe direction.
 */
export function eventClaimState(raw: unknown): EventClaim {
  if (raw === 'claimed' || raw === 'handled' || raw === 'in_flight') return raw;
  return 'in_flight';
}

/**
 * How long a change may wait on its invoice (spec §10.1). Stripe discards a pending update after
 * about 23 hours; the standalone fee invoice (a one-time fee with no quantity change) never expires
 * by itself. Both get this window: after it the invoice is voided and the request cancelled, and the
 * SQL's payment_in_progress lock counts as released, so a restaurant is never held forever by a
 * change it decided not to pay.
 */
export const CHANGE_INVOICE_TTL_MS = 23 * 3600 * 1000;

export type ChangeInvoiceState = 'paid' | 'open' | 'draft' | 'void' | 'expired';

/**
 * What a change's invoice, re-read from Stripe, means for its request:
 *   - paid: settle it;
 *   - open: the merchant pays on its page;
 *   - draft: finish it and charge it (the fee invoice is built as a draft first);
 *   - expired: it can still be paid but must not be (open or draft past CHANGE_INVOICE_TTL_MS, or
 *     uncollectible, which Stripe still accepts payment for): void it, then cancel the request;
 *   - void: it will never be paid (void, gone): cancel the request.
 */
export function changeInvoiceState(inv: unknown, nowMs: number): ChangeInvoiceState {
  if (!inv || typeof inv !== 'object') return 'void';
  const i = inv as { status?: unknown; created?: unknown };
  if (i.status === 'paid') return 'paid';
  if (i.status === 'uncollectible') return 'expired';
  if (i.status !== 'open' && i.status !== 'draft') return 'void';
  const created = unix(i.created);
  if (created !== null && nowMs - created * 1000 > CHANGE_INVOICE_TTL_MS) return 'expired';
  return i.status;
}

/**
 * Whether a Stripe subscription still stored on a restaurant that is NOT on the Stripe rail must be
 * cancelled before a new Checkout opens (spec §9.2): Stripe may still be retrying it (the grace can
 * end before Stripe gives up), and a second subscription would then bill the new card too. Only
 * one of ours for this restaurant, and only while Stripe has not ended it.
 */
export function shouldCancelOldSubscription(sub: unknown, restaurantId: string): boolean {
  if (!sub || typeof sub !== 'object') return false;
  const s = sub as {
    id?: unknown;
    status?: unknown;
    metadata?: { restaurant_id?: unknown } | null;
  };
  return (
    typeof s.id === 'string' &&
    s.status !== 'canceled' &&
    s.status !== 'incomplete_expired' &&
    s.metadata?.restaurant_id === restaurantId
  );
}

/**
 * Whether the subscription's own default card must follow the customer's new default (a card
 * replaced in the portal writes the customer's invoice default; Stripe charges the subscription's
 * own default first). Only when the subscription has one of its own that differs: a non-empty id is
 * always accepted by Stripe, unlike clearing the field (SP-1).
 */
export function subscriptionCardNeedsSync(sub: unknown, customerDefaultPm: string | null): boolean {
  if (!customerDefaultPm || !sub || typeof sub !== 'object') return false;
  const own = idOf((sub as { default_payment_method?: unknown }).default_payment_method);
  return own !== null && own !== customerDefaultPm;
}

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------

/** Domains no mailbox can exist under (as in ./stripe-connect.ts): seeded and demo owners use them. */
const UNDELIVERABLE_EMAIL_DOMAIN =
  /(^|\.)(test|example|invalid|localhost|local)$|(^|\.)example\.(com|net|org)$/i;

/** The owner's email if Stripe can send invoices and receipts to it, else null. */
export function customerEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return UNDELIVERABLE_EMAIL_DOMAIN.test(email.slice(email.lastIndexOf('@') + 1)) ? null : email;
}

/**
 * POST /v1/customers for a restaurant. metadata.restaurant_id is also the proof, checked before a
 * stored customer id is used, that the customer is this restaurant's: the id is kept on a row its
 * owner can write, and a customer id is the key to someone's card and invoices in the portal.
 */
export function customerParams(restaurant: {
  id: string;
  name: string;
  slug: string | null;
  owner_email: string | null;
}): Record<string, string> {
  const p: Record<string, string> = {
    'metadata[restaurant_id]': restaurant.id,
    'metadata[purpose]': 'platform_billing',
  };
  const name = restaurant.name.replace(/\s+/g, ' ').trim().slice(0, 256);
  if (name) p.name = name;
  const email = customerEmail(restaurant.owner_email);
  if (email) p.email = email;
  if (restaurant.slug) p['metadata[restaurant_slug]'] = restaurant.slug;
  return p;
}

/** The Stripe customer really is this restaurant's (see customerParams). */
export function customerBelongsTo(customer: unknown, restaurantId: string): boolean {
  if (!customer || typeof customer !== 'object') return false;
  const c = customer as { deleted?: unknown; metadata?: { restaurant_id?: unknown } | null };
  return c.deleted !== true && c.metadata?.restaurant_id === restaurantId;
}

// ---------------------------------------------------------------------------------------------
// Customer portal (D10)
// ---------------------------------------------------------------------------------------------

/**
 * POST /v1/billing_portal/configurations: update the card, see and pay invoices, edit billing
 * details, cancel at the END of the paid period; no plan switching (plans change on our page,
 * where the server prices them). Marked with metadata so a configuration of ours is recognisable.
 */
export function portalConfigurationParams(): Record<string, string> {
  return {
    'business_profile[headline]': 'Favornoms: your package, card and invoices',
    'features[payment_method_update][enabled]': 'true',
    'features[invoice_history][enabled]': 'true',
    'features[customer_update][enabled]': 'true',
    'features[customer_update][allowed_updates][0]': 'email',
    'features[customer_update][allowed_updates][1]': 'name',
    'features[customer_update][allowed_updates][2]': 'address',
    'features[customer_update][allowed_updates][3]': 'phone',
    'features[customer_update][allowed_updates][4]': 'tax_id',
    'features[subscription_cancel][enabled]': 'true',
    'features[subscription_cancel][mode]': 'at_period_end',
    'features[subscription_cancel][proration_behavior]': 'none',
    'features[subscription_update][enabled]': 'false',
    'metadata[favornoms]': 'platform_billing_v1',
  };
}

/** A stored configuration is reused only while it still says what portalConfigurationParams says. */
export function isUsablePortalConfiguration(cfg: unknown): boolean {
  if (!cfg || typeof cfg !== 'object') return false;
  const c = cfg as {
    id?: unknown;
    active?: unknown;
    metadata?: { favornoms?: unknown } | null;
    features?: {
      subscription_update?: { enabled?: unknown } | null;
      payment_method_update?: { enabled?: unknown } | null;
      subscription_cancel?: { enabled?: unknown; mode?: unknown } | null;
    } | null;
  };
  const cancel = c.features?.subscription_cancel;
  return (
    typeof c.id === 'string' &&
    c.active === true &&
    c.metadata?.favornoms === 'platform_billing_v1' &&
    c.features?.subscription_update?.enabled === false &&
    c.features?.payment_method_update?.enabled === true &&
    (cancel?.enabled !== true || cancel.mode === 'at_period_end')
  );
}

// ---------------------------------------------------------------------------------------------
// The platform's own account (the setup page's checklist)
// ---------------------------------------------------------------------------------------------

function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^acct_[A-Za-z0-9]+$/.test(value);
}

/** https://dashboard.stripe.com/<acct>/ plus test/ in test mode; the page appends a path. */
export function stripeDashboardBase(accountId: unknown, mode: 'test' | 'live' | null): string {
  const base = isAccountId(accountId)
    ? `https://dashboard.stripe.com/${accountId}/`
    : 'https://dashboard.stripe.com/';
  return mode === 'test' ? `${base}test/` : base;
}

export interface AccountSummary {
  id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  currently_due: number;
  has_bank: boolean;
}

/**
 * GET /v1/account as the checklist needs it. Stripe returns external_accounts only to whoever
 * controls the account; when the list is absent, payouts_enabled (which needs a payout
 * destination) stands in for it.
 */
export function accountSummary(account: unknown): AccountSummary | null {
  if (!account || typeof account !== 'object') return null;
  const a = account as Record<string, unknown>;
  if (!isAccountId(a.id)) return null;
  const req = (a.requirements ?? {}) as { currently_due?: unknown; past_due?: unknown };
  const due = new Set<string>();
  for (const list of [req.past_due, req.currently_due]) {
    for (const item of Array.isArray(list) ? list : [])
      if (typeof item === 'string' && item) due.add(item);
  }
  const ext = (a.external_accounts ?? null) as { data?: unknown; total_count?: unknown } | null;
  const listed =
    (Array.isArray(ext?.data) ? ext.data.length : 0) > 0 || Number(ext?.total_count ?? 0) > 0;
  return {
    id: a.id,
    charges_enabled: a.charges_enabled === true,
    payouts_enabled: a.payouts_enabled === true,
    details_submitted: a.details_submitted === true,
    currently_due: due.size,
    has_bank: listed || a.payouts_enabled === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------------------------

/** cyrb53: a small, stable 53-bit string hash (not a secret, only a fingerprint of the params). */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Idempotency-Key for a create: `<scope>:<id>:<fingerprint of the params>`. A double click sends the
 * same params and gets Stripe's first answer back (one session, one update); anything that changes
 * what is sent (a price, the trial date, the return page) is a new key, because Stripe refuses a
 * reused key with different params for 24 hours.
 */
export function idempotencyKey(scope: string, id: string, params: Record<string, string>): string {
  return `${scope}:${id}:${fingerprint(params)}`;
}

function fingerprint(params: Record<string, string>): string {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return hash53(canonical);
}

/**
 * The key of a request's subscription change: ONE per request, with no fingerprint (§9.4). Every
 * retry of the same request is then the same Stripe request and gets Stripe's first answer back
 * instead of a second charge; a retry whose body differs (the first call added an item that now has
 * an id) is refused by Stripe with idempotency_error, which is resolved from the invoice.
 */
export function changeIdempotencyKey(requestId: string): string {
  return `billing_change:${requestId}`;
}

/** The standalone invoice that charges a change's one-time fees when no proration invoice exists. */
export function changeInvoiceIdempotencyKey(requestId: string): string {
  return `billing_change_invoice:${requestId}`;
}

/** One fee (group) created on that invoice: a retry gets the same item back, never a second one. */
export function feeInvoiceItemIdempotencyKey(
  requestId: string,
  invoiceId: string,
  index: number,
): string {
  return `billing_change_fee:${requestId}:${invoiceId}:${index}`;
}

/** Reversing a change invoice's customer-balance movement: once per request and invoice. */
export function balanceUndoIdempotencyKey(requestId: string, invoiceId: string): string {
  return `billing_balance_undo:${requestId}:${invoiceId}`;
}

/**
 * A Checkout session for a request (§9.4, ME-7). The previous session id is in the key, so
 * "Continue to payment" after a session was stored makes a new session rather than replaying one
 * that may have expired meanwhile; a double click (same previous session, same body) still gets the
 * same session back. `retryOf` is set when a replayed session turned out not to be open anymore.
 */
export function checkoutIdempotencyKey(
  requestId: string,
  previousSessionId: string | null,
  params: Record<string, string>,
  retryOf: string | null = null,
): string {
  const prev = previousSessionId ?? 'none';
  const retry = retryOf ? `:retry:${retryOf}` : '';
  return `billing_checkout:${requestId}:${prev}${retry}:${fingerprint(params)}`;
}

/** Putting a paid-but-unapplied change back: once per request and invoice. */
export function revertIdempotencyKey(requestId: string, invoiceId: string): string {
  return `billing_revert:${requestId}:${invoiceId}`;
}

/** One refund per payment, whoever issues it (the edge function or the webhook). */
export function refundIdempotencyKey(targetId: string): string {
  return `billing_refund:${targetId}`;
}

/**
 * The subscription's own default card made to follow the customer's new default. The event is in
 * the key (edge-rr-5): a redelivery of the same customer.updated replays, but switching back to a
 * card used earlier the same day is a new request, not a replay of the old answer.
 */
export function cardSyncIdempotencyKey(
  subscriptionId: string,
  paymentMethodId: string,
  eventId: string,
): string {
  return `billing_card_sync:${subscriptionId}:${paymentMethodId}:${eventId}`;
}
