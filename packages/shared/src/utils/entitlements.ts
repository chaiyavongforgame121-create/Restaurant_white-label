// Entitlements — what a restaurant has actually paid for.
//
// The authority is public.billing_entitlements, one resolved row per restaurant,
// recomputed by private.billing_compute() on every billing write. Nothing here
// decides access on its own: the SQL triggers (orders / payments / deliveries /
// branches) are the real gate. This module exists so the UI and the server
// components agree with the database instead of guessing.
//
// Every function in this file fails CLOSED. A missing row, a missing key, a
// parse error or a lapsed deadline all read as "no".
//
// Pricing model locked 2026-09-23 — see docs/PACKAGING-2026-09-23.md. Money is
// paid once AND every month: $228 for the base (first branch), $99 for each
// branch after it, $59 to unlock delivery on a branch; then $29 per branch and
// $29 more for every branch that delivers. Delivery is PER BRANCH, so an
// Entitlements payload loaded for a branch answers features.delivery for THAT
// branch, and carries deliveryBranchIds for the whole restaurant.
//
// Prices live in billing_products and nowhere else. Nothing here hardcodes a
// number; every function takes the catalog. The server re-prices everything
// anyway (private.billing_price_one_time, public.request_package_change) — this
// module exists so the page shows the same figure before the server says it.

import { DEFAULT_UI_LOCALE, isUiLocale, type UiLocale } from '../i18n';

export const FEATURE_KEYS = [
  'card_payment',
  'ai_menu_import',
  'delivery',
  'ai_suite',
  'digital_signage',
  'ai_voice',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Product codes seeded in public.billing_products. */
export const PLAN_BASE = 'base';
export const PLAN_TRIAL = 'trial';
export const PRODUCT_EXTRA_BRANCH = 'extra_branch';
export const ADDON_DELIVERY = 'delivery';
// The AI Suite was withdrawn on 2026-09-23 and its product code went with it: nothing sells
// it, so nothing should be able to name it as something to sell. FEATURE_KEYS above keeps
// 'ai_suite' so old rows and platform overrides still parse.

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'cancelled'
  | 'expired'
  | 'none';

export interface Entitlements {
  restaurantId: string;
  /** 'base' | 'trial' | 'none' */
  planCode: string;
  status: SubscriptionStatus | string;
  /** entitledThrough is set and still in the future. */
  entitled: boolean;
  /** The deadline. Suspension is simply "null or in the past" — no flag, no cron. */
  entitledThrough: string | null;
  trialEndsAt: string | null;
  branchSeats: number;
  branchesUsed: number;
  monthlyTotal: number;
  /**
   * RAW grants (what was bought). Use hasFeature(), which also checks the deadline.
   *
   * When this payload was loaded for a BRANCH (get_branch_entitlements), `delivery`
   * is that branch's own answer. Loaded for a restaurant it keeps the account-wide
   * meaning: "delivery is sold to this account", not "every branch delivers".
   */
  features: Record<string, boolean>;
  addons: string[];
  /** Every branch of the restaurant that delivers. Present on both payloads. */
  deliveryBranchIds: string[];
  /**
   * Every branch whose $59 delivery unlock is already bought (private.branch_delivery_unlocked:
   * a branch_addons row, on or off, or a PAID charge). Switching delivery back on at one of
   * these costs nothing once. Present on both payloads, so a locked delivery screen can quote
   * the real price without reading the billing ledger, which is the owner's.
   */
  deliveryUnlockedBranchIds: string[];
}

const NO_FEATURES: Record<string, boolean> = Object.freeze({});

/** The value every read path falls back to. Never grants anything. */
export const DENIED_ENTITLEMENTS: Entitlements = Object.freeze({
  restaurantId: '',
  planCode: 'none',
  status: 'none',
  entitled: false,
  entitledThrough: null,
  trialEndsAt: null,
  branchSeats: 0,
  branchesUsed: 0,
  monthlyTotal: 0,
  features: NO_FEATURES,
  addons: [] as string[],
  deliveryBranchIds: [] as string[],
  deliveryUnlockedBranchIds: [] as string[],
}) as Entitlements;

function asNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asIsoOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** A jsonb array of ids; anything that is not one reads as "none". */
function asIdList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Parse the jsonb returned by get_entitlements / get_branch_entitlements.
 * Never throws — anything unrecognised becomes DENIED_ENTITLEMENTS.
 */
export function parseEntitlements(raw: unknown): Entitlements {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DENIED_ENTITLEMENTS;
  const r = raw as Record<string, unknown>;

  const features: Record<string, boolean> = {};
  const rawFeatures = r.features;
  if (rawFeatures && typeof rawFeatures === 'object' && !Array.isArray(rawFeatures)) {
    for (const [k, v] of Object.entries(rawFeatures as Record<string, unknown>)) {
      // Only an explicit `true` counts. Truthy strings do not.
      if (v === true) features[k] = true;
    }
  }

  const entitledThrough = asIsoOrNull(r.entitled_through);
  // Trust the server's own verdict when present, but re-derive it from the
  // deadline as well: a stale cached payload must not keep granting access.
  const deadlineOk = entitledThrough !== null && Date.parse(entitledThrough) > Date.now();
  const entitled = r.entitled === true && deadlineOk;

  return {
    restaurantId: typeof r.restaurant_id === 'string' ? r.restaurant_id : '',
    planCode: typeof r.plan_code === 'string' ? r.plan_code : 'none',
    status: typeof r.status === 'string' ? r.status : 'none',
    entitled,
    entitledThrough,
    trialEndsAt: asIsoOrNull(r.trial_ends_at),
    branchSeats: Math.max(0, Math.trunc(asNumber(r.branch_seats))),
    branchesUsed: Math.max(0, Math.trunc(asNumber(r.branches_used))),
    monthlyTotal: asNumber(r.monthly_total),
    features,
    addons: asIdList(r.addons),
    deliveryBranchIds: asIdList(r.delivery_branch_ids),
    // Absent from a payload older than the 2026-09-23 fixes, which reads as "nothing unlocked":
    // the worst that does is quote a $59 the plan page then does not charge.
    deliveryUnlockedBranchIds: asIdList(r.delivery_unlocked_branch_ids),
  };
}

/** True only when the restaurant is paid up AND owns the feature. */
export function hasFeature(e: Entitlements | null | undefined, key: FeatureKey): boolean {
  if (!e || !e.entitled) return false;
  return e.features[key] === true;
}

/** Owns the feature, regardless of whether the subscription has lapsed. */
export function ownsFeature(e: Entitlements | null | undefined, key: FeatureKey): boolean {
  return e?.features[key] === true;
}

// --- per-restaurant overrides ------------------------------------------------
//
// restaurants.feature_overrides is a switch the platform operator controls, kept
// deliberately separate from the package: `on` grants a key the plan never sold,
// `off` hides a key it did, and `plan` (the key absent) follows the package.
// private.billing_compute() folds it into billing_entitlements.features, so
// hasFeature() already reflects it — this is only for rendering the switch.

export type FeatureOverrideState = 'on' | 'off' | 'plan';

/** Parse restaurants.feature_overrides. Non-boolean values are dropped. */
export function parseFeatureOverrides(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function featureOverrideState(
  overrides: Record<string, boolean> | null | undefined,
  key: string,
): FeatureOverrideState {
  const v = overrides?.[key];
  if (v === true) return 'on';
  if (v === false) return 'off';
  return 'plan';
}

export function isEntitled(e: Entitlements | null | undefined): boolean {
  return e?.entitled === true;
}

export function isTrialing(e: Entitlements | null | undefined): boolean {
  return e?.status === 'trialing';
}

/** Whole days remaining in the trial (0 on the last day), or null if not trialing. */
export function trialDaysLeft(e: Entitlements | null | undefined): number | null {
  if (!e || !isTrialing(e)) return null;
  const ends = e.trialEndsAt ?? e.entitledThrough;
  if (!ends) return null;
  const ms = Date.parse(ends) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** A seat is free. Adding a branch beyond this is blocked until one is bought. */
export function canAddBranch(e: Entitlements | null | undefined): boolean {
  if (!e || !e.entitled) return false;
  return e.branchesUsed < e.branchSeats;
}

// --- catalog / pricing -------------------------------------------------------

export interface BillingProduct {
  code: string;
  name: string;
  kind: 'plan' | 'addon' | 'seat' | string;
  monthly_price: number;
  /** Paid once, ever. 228 for the base, 99 for a branch, 59 to unlock a branch's delivery. */
  one_time_price: number;
  included_seats: number;
  seats_per_unit: number;
  trial_days: number;
  is_quantity: boolean;
  features: Record<string, boolean>;
  stripe_price_id: string | null;
  is_active: boolean;
  sort_order: number;
  description: string | null;
}

export interface PackageSelection {
  /** 'base'. The trial is granted at signup, never selected. */
  planCode: string;
  /** Branches paid for, >= 1. */
  branchSeats: number;
  /** The branches that deliver. Its length is the delivery line's quantity. */
  deliveryBranchIds: string[];
}

/**
 * What is already bought, so nothing one-time is charged twice.
 *
 * Bought means PAID (private.billing_paid_state). The charges on a request that is still
 * waiting for the platform are on order, not bought: they are not in here, and the plan page
 * shows them from the request itself (BillingRequest.one_time_total). Counting them used to
 * make the page say "everything is already paid for" to a merchant who had paid nothing.
 */
export interface BillingPaidState {
  basePaid: boolean;
  /** Branch seats already paid for, the base's included branch included. */
  seatsPaid: number;
  /** Branches whose $59 was paid at some point — switching one back on is free. */
  deliveryUnlockedBranchIds: string[];
}

/** Nothing is bought yet. What a brand-new account prices against. */
export const NOTHING_PAID: BillingPaidState = Object.freeze({
  basePaid: false,
  seatsPaid: 0,
  deliveryUnlockedBranchIds: [] as string[],
}) as BillingPaidState;

export interface PriceLine {
  code: string;
  label: string;
  qty: number;
  unit: number;
  total: number;
  /** Set on a line that belongs to one branch (a delivery unlock). */
  branchId?: string;
}

/** @deprecated Use PriceLine. Kept so the current plan page compiles. */
export type PackageLine = PriceLine;

function findProduct(catalog: BillingProduct[], code: string): BillingProduct | undefined {
  return catalog.find((p) => p.code === code);
}

/** Whole branches, never fewer than one. */
function seatsOf(sel: PackageSelection): number {
  return Math.max(1, Math.trunc(sel.branchSeats || 1));
}

/** The chosen branches, each one once, so a repeated id cannot be billed twice. */
function deliveryIdsOf(sel: PackageSelection): string[] {
  return [...new Set((sel.deliveryBranchIds ?? []).filter((id) => typeof id === 'string' && id))];
}

/**
 * What one branch costs a month before delivery.
 *
 * Every paid branch is billed at the extra-branch price — which is also what the
 * base's own $29 covers for the first one — so the per-branch figures add up to
 * the package total. A trial branch is free, and the plan's own price is the
 * fallback for a catalog with no seat product at all.
 */
function seatPrice(plan: BillingProduct | undefined, catalog: BillingProduct[]): number {
  if ((plan?.trial_days ?? 0) > 0) return plan?.monthly_price ?? 0;
  const seat = findProduct(catalog, PRODUCT_EXTRA_BRANCH);
  return seat ? seat.monthly_price : (plan?.monthly_price ?? 0);
}

/**
 * The monthly bill, expanded into the lines the database actually stores.
 *
 * Mirrors private.billing_apply_selection exactly: one plan line, one extra-branch
 * line of (seats − plan.included_seats), and one delivery line whose QUANTITY is
 * the number of delivering branches. Use branchMonthly() for the per-branch view.
 */
export function monthlyLines(sel: PackageSelection, catalog: BillingProduct[]): PriceLine[] {
  const lines: PriceLine[] = [];
  const plan = findProduct(catalog, sel.planCode);
  if (!plan) return lines;

  lines.push({
    code: plan.code,
    label: plan.name,
    qty: 1,
    unit: plan.monthly_price,
    total: plan.monthly_price,
  });

  // seatPrice(), not seat.monthly_price: a trial is $0 with everything on, extra branches
  // included (docs/PACKAGING-2026-09-23.md §1). Charging the catalog's $29 here made a
  // two-branch trial read "$29 every month" while branchMonthly() — which does go through
  // seatPrice() — priced each of its branches at 0, so the page's per-branch lines and its
  // total disagreed. private.billing_apply_selection now writes the same 0 into the seat
  // line's unit_price, and the two must stay in step.
  const seat = findProduct(catalog, PRODUCT_EXTRA_BRANCH);
  const extra = Math.max(seatsOf(sel) - (plan.included_seats ?? 0), 0);
  if (seat && extra > 0) {
    const unit = seatPrice(plan, catalog);
    lines.push({
      code: seat.code,
      label: seat.name,
      qty: extra,
      unit,
      total: unit * extra,
    });
  }

  // The trial delivers from every branch by rule and bills nothing for it.
  const delivery = findProduct(catalog, ADDON_DELIVERY);
  const delivers = (plan.trial_days ?? 0) > 0 ? 0 : deliveryIdsOf(sel).length;
  if (delivery && delivers > 0) {
    lines.push({
      code: delivery.code,
      label: delivery.name,
      qty: delivers,
      unit: delivery.monthly_price,
      total: delivery.monthly_price * delivers,
    });
  }

  return lines;
}

/** @deprecated Use monthlyLines. Kept so the current plan page compiles. */
export const packageLines = monthlyLines;

/** $29 × branches + $29 × delivery branches. */
export function packageMonthlyTotal(sel: PackageSelection, catalog: BillingProduct[]): number {
  return monthlyLines(sel, catalog).reduce((sum, l) => sum + l.total, 0);
}

/** What one branch adds to the monthly bill: $29, or $58 with delivery. */
export function branchMonthly(
  sel: PackageSelection,
  catalog: BillingProduct[],
  branchId: string,
): number {
  const plan = findProduct(catalog, sel.planCode);
  if (!plan) return 0;
  const delivery = findProduct(catalog, ADDON_DELIVERY);
  const delivers = (plan.trial_days ?? 0) > 0 ? false : deliveryIdsOf(sel).includes(branchId);
  return seatPrice(plan, catalog) + (delivers && delivery ? delivery.monthly_price : 0);
}

/**
 * What this change adds to the "pay once today" total — only what is NOT bought yet.
 *
 * Mirrors private.billing_price_one_time. The base INCLUDES the first branch, so a
 * first-time buyer of one branch pays 228 and not 228 + 99; once the base is paid,
 * what is covered is what the ledger says. A branch whose $59 was ever paid is
 * absent, which is why switching its delivery off and on again costs nothing.
 *
 * The server writes one billing_charges row per seat; this returns one line of
 * quantity N, because that is what the merchant reads.
 */
export function oneTimeLines(
  sel: PackageSelection,
  catalog: BillingProduct[],
  paid: BillingPaidState,
): PriceLine[] {
  const lines: PriceLine[] = [];
  const plan = findProduct(catalog, sel.planCode);
  // The trial is granted once at signup and never sold, so it raises nothing.
  if (!plan || (plan.trial_days ?? 0) > 0) return lines;

  if (!paid.basePaid) {
    lines.push({
      code: plan.code,
      label: plan.name,
      qty: 1,
      unit: plan.one_time_price,
      total: plan.one_time_price,
    });
  }

  const covered = paid.basePaid ? Math.max(0, paid.seatsPaid) : (plan.included_seats ?? 0);
  const seat = findProduct(catalog, PRODUCT_EXTRA_BRANCH);
  const extra = Math.max(seatsOf(sel) - covered, 0);
  if (seat && extra > 0) {
    lines.push({
      code: seat.code,
      label: seat.name,
      qty: extra,
      unit: seat.one_time_price,
      total: seat.one_time_price * extra,
    });
  }

  const delivery = findProduct(catalog, ADDON_DELIVERY);
  if (delivery) {
    const unlocked = new Set(paid.deliveryUnlockedBranchIds ?? []);
    for (const branchId of deliveryIdsOf(sel)) {
      if (unlocked.has(branchId)) continue;
      lines.push({
        code: delivery.code,
        label: delivery.name,
        qty: 1,
        unit: delivery.one_time_price,
        total: delivery.one_time_price,
        branchId,
      });
    }
  }

  return lines;
}

/** The "pay once today" figure, before any discount code. */
export function packageOneTimeTotal(
  sel: PackageSelection,
  catalog: BillingProduct[],
  paid: BillingPaidState,
): number {
  return oneTimeLines(sel, catalog, paid).reduce((sum, l) => sum + l.total, 0);
}

/**
 * Does THIS branch deliver? Give it a payload loaded for a branch
 * (get_branch_entitlements / getEntitlementsForBranch) — a restaurant payload
 * answers "delivery is sold to this account", which is a different question.
 */
export function deliversHere(e: Entitlements | null | undefined): boolean {
  return hasFeature(e, ADDON_DELIVERY);
}

/** Feature keys a selection would grant, before it is paid for. */
export function selectionFeatures(sel: PackageSelection, catalog: BillingProduct[]): Set<string> {
  const out = new Set<string>();
  for (const line of monthlyLines(sel, catalog)) {
    const product = findProduct(catalog, line.code);
    if (!product) continue;
    for (const [k, v] of Object.entries(product.features ?? {})) {
      if (v === true) out.add(k);
    }
  }
  return out;
}

/**
 * The selection a restaurant is currently on, for pre-filling the plan page.
 *
 * The trial is not a purchasable plan — it is granted once at signup and never
 * sold. Seeding the builder with `trial` would let a trialing merchant "buy"
 * $0/mo with every feature on, so a trial always pre-fills as Base instead. The
 * branches that deliver carry over, because that is what they are used to — and
 * for a trialing merchant that is every branch, which is exactly what the $59
 * unlocks are quoted against.
 */
export function currentSelection(e: Entitlements | null | undefined): PackageSelection {
  const plan = e?.planCode;
  const purchasable = plan && plan !== 'none' && plan !== PLAN_TRIAL;
  return {
    planCode: purchasable ? plan : PLAN_BASE,
    branchSeats: Math.max(1, e?.branchSeats ?? 1),
    deliveryBranchIds: e?.deliveryBranchIds ? [...e.deliveryBranchIds] : [],
  };
}

// --- error decoding ----------------------------------------------------------

/**
 * Why a discount code did not apply, as the server says it to a merchant
 * (private.billing_discount_refusal / billing_discount_quote). validate_billing_discount
 * answers with the reason; request_package_change returns it and requestPackageChange
 * throws it as 'discount_invalid:<reason>'. Never an error the page has to parse itself.
 *
 * - invalid_code: no such code, switched off, or not started yet. One answer for all three
 *   on purpose: those are the states a guesser learns from, and an honest merchant cannot
 *   act on the difference.
 * - code_expired / code_exhausted / per_restaurant_limit_reached: a code only reaches these
 *   after it was handed out, so the merchant holding it was given it and needs the reason.
 * - not_applicable: a real code that covers nothing in this purchase.
 * - nothing_to_discount: there is nothing to pay once, so no code has anything to come off.
 * - rate_limited: 10 unsuccessful code checks in 15 minutes; every check, a good code
 *   included, is refused until the window passes.
 */
export const DISCOUNT_REASONS = [
  'invalid_code',
  'code_expired',
  'code_exhausted',
  'per_restaurant_limit_reached',
  'not_applicable',
  'nothing_to_discount',
  'rate_limited',
] as const;

export type DiscountReason = (typeof DISCOUNT_REASONS)[number];

export type BillingError =
  | { kind: 'inactive'; scope: string }
  | { kind: 'feature'; feature: string }
  | { kind: 'seats'; current: number; limit: number }
  | { kind: 'discount'; reason: string }
  | { kind: 'dormant' };

/**
 * Decode the error contract raised by the SQL triggers (P0001) and returned by
 * the edge functions (402 / 403 / 503). Returns null for anything else.
 */
export function describeBillingError(err: unknown): BillingError | null {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : typeof err === 'object' && err !== null
          ? String(
              (err as { message?: unknown; error?: unknown }).message ??
                (err as { error?: unknown }).error ??
                '',
            )
          : '';
  if (!msg) return null;

  const seats = msg.match(/plan_limit_exceeded:branches:(\d+)\/(-?\d+)/);
  if (seats) return { kind: 'seats', current: Number(seats[1]), limit: Number(seats[2]) };

  // request_package_change refuses a code that went stale between quoting and submitting
  // (requestPackageChange throws it in this shape). Approval no longer refuses a code at all:
  // the use is reserved when the merchant submits, so there is no approval-time reason.
  const discount = msg.match(/discount_invalid:([a-z_]+)/);
  if (discount) return { kind: 'discount', reason: discount[1] ?? 'invalid_code' };

  const inactive = msg.match(/billing_inactive(?::([a-z_]+))?/);
  if (inactive) return { kind: 'inactive', scope: inactive[1] ?? 'account' };

  const feature = msg.match(/feature_not_entitled(?::([a-z_]+))?/);
  if (feature) return { kind: 'feature', feature: feature[1] ?? 'unknown' };

  if (/delivery_not_entitled/.test(msg)) return { kind: 'feature', feature: 'delivery' };
  if (/stripe_not_configured/.test(msg)) return { kind: 'dormant' };

  return null;
}

// --- labels and messages, per interface language -----------------------------
//
// Display only. Feature keys and error codes stay the stable values above; nothing here is
// stored or compared.

const FEATURE_LABELS: Record<UiLocale, Record<string, string>> = {
  en: {
    card_payment: 'Card payment',
    ai_menu_import: 'AI menu import',
    delivery: 'Delivery',
    ai_suite: 'AI Suite',
    digital_signage: 'Digital Signage',
    ai_voice: 'AI Voice Assistant',
  },
  es: {
    card_payment: 'Pago con tarjeta',
    ai_menu_import: 'Importación de menú con IA',
    delivery: 'Entrega a domicilio',
    ai_suite: 'AI Suite',
    digital_signage: 'Señalización digital',
    ai_voice: 'Asistente de voz con IA',
  },
  vi: {
    card_payment: 'Thanh toán bằng thẻ',
    ai_menu_import: 'Nhập thực đơn bằng AI',
    delivery: 'Giao hàng',
    ai_suite: 'AI Suite',
    digital_signage: 'Bảng hiệu kỹ thuật số',
    ai_voice: 'Trợ lý giọng nói AI',
  },
  th: {
    card_payment: 'ชำระเงินด้วยบัตร',
    ai_menu_import: 'นำเข้าเมนูด้วย AI',
    delivery: 'การจัดส่ง',
    ai_suite: 'AI Suite',
    digital_signage: 'ป้ายดิจิทัล',
    ai_voice: 'ผู้ช่วยเสียง AI',
  },
};

/**
 * A feature key as people read it, in `locale` (English when omitted). Unknown keys come back
 * unchanged.
 *
 * Overloaded so `keys.map(featureLabel)` keeps compiling: map passes the index as the second
 * argument, and anything that is not an interface language reads as English.
 */
export function featureLabel(key: string): string;
export function featureLabel(key: string, locale: UiLocale | undefined): string;
export function featureLabel(key: string, locale?: unknown): string {
  const loc = isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE;
  return FEATURE_LABELS[loc][key] ?? FEATURE_LABELS.en[key] ?? key;
}

interface BillingErrorCopy {
  inactive: string;
  feature: (feature: string) => string;
  seats: (current: number, limit: number) => string;
  dormant: string;
  discount: Record<DiscountReason | 'unknown', string>;
}

const BILLING_ERROR_COPY: Record<UiLocale, BillingErrorCopy> = {
  en: {
    inactive: 'Your subscription is not active. Choose a package to continue.',
    feature: (feature) => `${feature} is not included in your current package.`,
    seats: (current, limit) =>
      `You are using ${current} of ${limit} branch seats. Add a seat to create another branch.`,
    dormant: 'Online payment is not configured yet. Your request has been sent for manual activation.',
    discount: {
      invalid_code: 'That code is not valid. Check it and try again.',
      code_expired: 'That code has expired.',
      code_exhausted: 'That code has been used the maximum number of times.',
      per_restaurant_limit_reached: 'You have already used that code.',
      not_applicable: 'That code does not apply to anything in this purchase.',
      nothing_to_discount: 'There is nothing to pay once today, so this code has nothing to come off.',
      rate_limited: 'Too many codes tried. Wait 15 minutes, then try again.',
      unknown: 'That code could not be applied.',
    },
  },
  es: {
    inactive: 'Tu suscripción no está activa. Elige un paquete para continuar.',
    feature: (feature) => `${feature} no está incluido en tu paquete actual.`,
    seats: (current, limit) =>
      `Cupos de sucursal en uso: ${current} de ${limit}. Agrega un cupo para crear otra sucursal.`,
    dormant: 'El pago en línea aún no está configurado. Enviamos tu solicitud para activarlo manualmente.',
    discount: {
      invalid_code: 'Ese código no es válido. Revísalo y vuelve a intentarlo.',
      code_expired: 'Ese código ya caducó.',
      code_exhausted: 'Ese código alcanzó su número máximo de usos.',
      per_restaurant_limit_reached: 'Ya usaste ese código.',
      not_applicable: 'Ese código no se aplica a nada de esta compra.',
      nothing_to_discount: 'Hoy no hay ningún pago único, así que este código no tiene nada que descontar.',
      rate_limited: 'Probaste demasiados códigos. Espera 15 minutos y vuelve a intentarlo.',
      unknown: 'No se pudo aplicar ese código.',
    },
  },
  vi: {
    inactive: 'Gói đăng ký của bạn chưa hoạt động. Hãy chọn một gói để tiếp tục.',
    feature: (feature) => `${feature} không có trong gói hiện tại của bạn.`,
    seats: (current, limit) =>
      `Bạn đang dùng ${current}/${limit} suất chi nhánh. Hãy thêm suất để tạo chi nhánh mới.`,
    dormant: 'Thanh toán trực tuyến chưa được thiết lập. Yêu cầu của bạn đã được gửi để kích hoạt thủ công.',
    discount: {
      invalid_code: 'Mã này không hợp lệ. Vui lòng kiểm tra và thử lại.',
      code_expired: 'Mã này đã hết hạn.',
      code_exhausted: 'Mã này đã được dùng hết số lần cho phép.',
      per_restaurant_limit_reached: 'Bạn đã dùng mã này rồi.',
      not_applicable: 'Mã này không áp dụng cho khoản nào trong lần mua này.',
      nothing_to_discount: 'Hôm nay không có khoản thanh toán một lần nào, nên mã này không có gì để giảm.',
      rate_limited: 'Bạn đã thử quá nhiều mã. Vui lòng đợi 15 phút rồi thử lại.',
      unknown: 'Không thể áp dụng mã này.',
    },
  },
  th: {
    inactive: 'การสมัครสมาชิกของคุณไม่ได้เปิดใช้งานอยู่ โปรดเลือกแพ็กเกจเพื่อดำเนินการต่อ',
    feature: (feature) => `${feature} ไม่รวมอยู่ในแพ็กเกจปัจจุบันของคุณ`,
    seats: (current, limit) =>
      `คุณใช้สิทธิ์สาขาไปแล้ว ${current} จาก ${limit} สิทธิ์ เพิ่มสิทธิ์สาขาเพื่อสร้างสาขาใหม่`,
    dormant: 'ยังไม่ได้ตั้งค่าการชำระเงินออนไลน์ เราได้ส่งคำขอของคุณเพื่อเปิดใช้งานให้แล้ว',
    discount: {
      invalid_code: 'รหัสนี้ใช้ไม่ได้ โปรดตรวจสอบแล้วลองอีกครั้ง',
      code_expired: 'รหัสนี้หมดอายุแล้ว',
      code_exhausted: 'รหัสนี้ถูกใช้ครบจำนวนครั้งที่กำหนดแล้ว',
      per_restaurant_limit_reached: 'คุณใช้รหัสนี้ไปแล้ว',
      not_applicable: 'รหัสนี้ใช้กับรายการในการซื้อครั้งนี้ไม่ได้',
      nothing_to_discount: 'วันนี้ไม่มียอดที่ต้องชำระครั้งเดียว รหัสนี้จึงไม่มีส่วนใดให้ลด',
      rate_limited: 'ลองรหัสหลายครั้งเกินไป โปรดรอ 15 นาทีแล้วลองอีกครั้ง',
      unknown: 'ไม่สามารถใช้รหัสนี้ได้',
    },
  },
};

/**
 * Why a discount code did not apply, in `locale`. The reason codes come from
 * validate_billing_discount; an unrecognised one reads as a plain refusal rather
 * than leaking a database string onto the page.
 */
export function discountReasonMessage(
  reason: string | null | undefined,
  locale: UiLocale = DEFAULT_UI_LOCALE,
): string {
  const loc = isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE;
  const copy = BILLING_ERROR_COPY[loc].discount;
  const key = (DISCOUNT_REASONS as readonly string[]).includes(reason ?? '')
    ? (reason as DiscountReason)
    : 'unknown';
  return copy[key];
}

/** Human-readable copy for a decoded billing error, in `locale` (English when omitted). */
export function billingErrorMessage(e: BillingError, locale: UiLocale = DEFAULT_UI_LOCALE): string {
  const loc = isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE;
  const copy = BILLING_ERROR_COPY[loc];
  switch (e.kind) {
    case 'inactive':
      return copy.inactive;
    case 'feature':
      return copy.feature(featureLabel(e.feature, loc));
    case 'seats':
      return copy.seats(e.current, e.limit);
    case 'discount':
      return discountReasonMessage(e.reason, loc);
    case 'dormant':
      return copy.dormant;
  }
}
