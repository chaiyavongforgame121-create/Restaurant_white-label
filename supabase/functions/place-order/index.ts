// place-order v10.0 — US pivot + modifiers + combos + happy-hour + schedules + gift cards
//   v10.0 (2026-08-16): points now buy NAMED REWARDS, not arbitrary dollars off.
//        The old `redeem_points` let any diner slide up to 50% of the subtotal off
//        at 100 pts = $1, with the merchant unable to say what points are for.
//        Redemption is now keyed on `reward_id` pointing at a row the merchant
//        published in `loyalty_rewards`, and this function prices it server-side
//        (percent_off with an optional cap / fixed_off / free_item / free_delivery).
//        Points cost is whatever the merchant set — decoupled from the discount.
//        `redeem_points` is REJECTED with 409 stale_client_refresh_required rather
//        than ignored: ignoring it would charge a pre-catalog client more than the
//        total it displayed, and a silent overcharge is worse than a forced reload.
//   v9.9 (2026-08-16): scheduled orders are checked against the time the food is
//        wanted, not the time the order was typed. is_branch_open() was called
//        with no p_at, so a branch closed right now rejected every pre-order for
//        tomorrow (409 branch_closed) — scheduling was unusable outside opening
//        hours — while an order placed during today's lunch for a day the branch
//        is shut sailed straight through. scheduled_for is now parsed BEFORE the
//        hours check and passed as p_at; a slot outside hours returns the
//        distinct code `branch_closed_at_scheduled_time` so the diner is told to
//        pick another time rather than that the restaurant is closed.
//   v9.8 (2026-08-11): login is now MANDATORY for customer-placed orders. A non-staff
//        caller with no authenticated user is rejected 401 login_required, before any
//        customer/loyalty/order work. The storefront also gates add-to-cart and
//        checkout, but this is the real gate: `source` is client-supplied, so a guest
//        cannot pose as a staff channel — callerIsStaff() reads the JWT role and a
//        tokenless caller is never staff, so staffPlaced stays false and the 401 fires.
//   v9.7 (2026-08-11): ACCOUNT TAKEOVER fix in lazy customer creation. When the
//        (user, restaurant) lookup missed, the insert that followed could lose
//        customers_restaurant_phone_uidx, and the fallback then re-read the row by
//        (restaurant_id, phone) alone — on the service-role client, so no RLS. Since
//        phone sign-in is OTP-less and customer_phone is raw request body, any signed-in
//        diner could name a victim's number and have customerId resolve to the VICTIM's
//        row: their loyalty balance was then readable, spendable, and the order was filed
//        under their identity. The fallback now re-reads the caller's own row, and only
//        claims a phone-matched row while it is UNOWNED (user_id IS NULL — the staff- or
//        guest-created row the fallback was actually written for). Nothing safe to adopt
//        means a guest order, not someone else's account.
//   v9.6 (2026-08-11): dine-in is exempt from the merchant payment matrix — the
//        dine-in checkout has no payment step and always sends 'cash' ("pay at
//        the restaurant"), so a branch that had turned asap.cash off would have
//        rejected every dine-in order with payment_method_not_accepted. The
//        entitlement gate and the invalid_payment_method check still apply.
//        + Loyalty redemption now requires a PROVEN identity (403
//        google_link_required), checked before the order row is written. Phone
//        sign-in is OTP-less, so knowing a phone number is enough to become that
//        customer; proving the account is really yours is the second factor that
//        stops a stranger spending someone else's points. Either a linked Google
//        identity OR a confirmed real email (the shipped magic-link path) counts —
//        NOT the synthetic customer-auth address every phone diner carries. Staff-
//        placed orders (counter/POS) are exempt — the authenticated user there is
//        the cashier, not the diner. The wire code stays `google_link_required`
//        for clients that already match on it.
//   v9.5 (2026-08-10): loyalty redemption is brand-scope aware. The balance
//        check and debit previously filtered loyalty_points by the ordering
//        branch_id, but brand-scope balances (the locked default) live at
//        branch_id NULL + restaurant_id, so redemption silently did nothing.
//        The ledger insert also used type 'redeem', which violates the
//        loyalty_transactions type check ('redeemed').
//                  + distance-based delivery fees (Mapbox location backbone, Phase 1)
//                  + payment-method gating + structured drop-off.
//   v9.4 (2026-08-06): `channel` is validated against the enum (400 invalid_channel)
//        instead of failing as a Postgres cast. New `source` field ('web' | 'counter'
//        | 'pos', default + fallback 'web') is stored on the order instead of the
//        hardcoded 'web'. Dine-in from source 'web' now requires table_id or
//        table_number (400 table_required) — staff surfaces are exempt because the
//        counter takes walk-in dine-in with no table. A supplied table_number is
//        resolved (exact match, dine_in/qr_ordering only) against the branch's
//        active `tables` rows to populate orders.table_id, which until now no
//        surface ever wrote.
//   v9.2 (2026-07-12): payment gating from branches.settings.payment_methods
//        ({asap|scheduled}.{cash|card}); absent key/subkey => allowed, explicit false
//        => 400 payment_method_not_accepted. Delivery orders now require a structured
//        drop-off: delivery_address.dropoff_pref (leave_at_door | hand_to_me | at_desk
//        | other), dropoff_other required when 'other'; free-text fields trimmed and
//        length-capped (dropoff_other 120, gate_code/room 40) and whitelisted into the
//        delivery_address JSON stored on the order (survives saved-address rebuild).
//   v9.3 (2026-07-12): payment gating exempts active staff of the branch's restaurant
//        (the counter/POS pay buttons are staff-facing, not customer-facing); a
//        checkout-typed delivery_address.notes now survives the saved-address rebuild.
//   v9   (2026-06-11): when delivery_address has lat/lng (direct or saved address),
//        calls quote_delivery() for the authoritative distance fee + heuristic ETA,
//        rejects out-of-radius addresses (409 delivery_out_of_range), and populates
//        deliveries.pickup_location/delivery_location/dropoff_lat/lng/distance_km/
//        estimated_duration_min. No coords → legacy flat fee (graceful fallback).
//   v9.1 (2026-06-11): scheduled orders beyond prep_time+15min are inserted with
//        held=true (hidden from the kitchen) and released by pg_cron at
//        scheduled_for − prep_time (private.release_scheduled_orders).
//   v8.1 (2026-06-11): modifiers column is NOT NULL '[]'::jsonb — send [] not null.
//   • Computes US sales tax from branches.sales_tax_rate.
//   • Drops PromptPay payment_method, US uses card | cash.
//   • Reads delivery_fee from branch settings (defaults to $3.99).
//   • Item modifiers: client sends modifier_option_ids[], server looks up
//     price_delta from modifier_options table and adds to line subtotal.
//   • Combos: client sends `combos` array. Each combo entry resolves to one
//     order_items row with combo_id set and the combo's total_price as unit price.
//   • Happy hour: server fetches get_effective_prices() and uses those instead
//     of menu_items.price when present.
//   • Schedules: rejects items whose availability_schedule doesn't include now.
// Server-side recalculation never trusts client totals.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  billingInactiveBody,
  edgeHasFeature,
  featureNotEntitledBody,
  loadEntitlements,
} from '../_shared/entitlements.ts';

interface PlaceOrderRequest {
  branch_id: string;
  channel: 'dine_in' | 'pickup' | 'delivery' | 'qr_ordering';
  customer_name?: string;
  customer_phone?: string;
  delivery_address?: { line1: string; line2?: string; city?: string; state?: string; postal_code?: string; notes?: string; lat?: number; lng?: number; dropoff_pref?: 'leave_at_door' | 'hand_to_me' | 'at_desk' | 'other'; dropoff_other?: string; gate_code?: string; room?: string };
  saved_address_id?: string;
  customer_notes?: string;
  payment_method: 'card' | 'cash';
  /**
   * Deprecated free-form points redemption. Rejected on sight — see the loyalty
   * block below for why a stale client must fail loudly instead of silently
   * being charged more than it displayed.
   */
  redeem_points?: number;
  /** Which named reward from the merchant's catalog to spend points on. */
  reward_id?: string;
  tip_amount?: number;
  promo_code?: string;
  table_id?: string;
  table_number?: string;
  source?: 'web' | 'counter' | 'pos';
  scheduled_for?: string;
  gift_card_code?: string;
  items: Array<{ menu_item_id: string; quantity: number; notes?: string; modifier_option_ids?: string[] }>;
  combos?: Array<{ combo_id: string; quantity: number; notes?: string }>;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

// Round to two decimals.
function r2(n: number) { return Math.round(n * 100) / 100; }

// Trim a free-text field and hard-cap its length (non-strings become '').
function clip(v: unknown, max: number) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

const DROPOFF_PREFS = ['leave_at_door', 'hand_to_me', 'at_desk', 'other'] as const;

// `customer-auth` mints every phone-only diner as a synthetic confirmed user
// `c{digits}@customer.favornoms.local` (email_confirm: true), so those accounts
// ALSO carry a provider-'email' identity. Excluding this exact domain is the only
// thing that keeps the loyalty gate below meaningful — a bare `provider !== 'phone'`
// test would wave every unverified phone account straight through.
// Keep in sync with EMAIL_DOMAIN in supabase/functions/customer-auth/index.ts.
const SYNTHETIC_CUSTOMER_EMAIL_SUFFIX = '@customer.favornoms.local';

// Points are money. Spending them needs proof the account is really yours:
// a linked Google identity, or a confirmed email the diner actually owns (the
// shipped magic-link sign-in). Defensive about shapes — a malformed identity
// payload must fall through to "not proven", never throw a 500 onto the order.
// deno-lint-ignore no-explicit-any
function loyaltyIdentityProven(user: any): boolean {
  const identities: any[] = Array.isArray(user?.identities) ? user.identities : [];
  if (identities.some((i) => i?.provider === 'google')) return true;
  const emailConfirmed = !!user?.email_confirmed_at;
  return identities.some((i) => {
    if (i?.provider !== 'email') return false;
    // The identity payload and the user row can disagree; prefer the identity's own.
    const raw = i?.identity_data?.email ?? user?.email;
    const addr = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!addr || !addr.includes('@') || addr.endsWith(SYNTHETIC_CUSTOMER_EMAIL_SUFFIX)) return false;
    return emailConfirmed || i?.identity_data?.email_verified === true;
  });
}

const ORDER_CHANNELS = ['dine_in', 'pickup', 'delivery', 'qr_ordering'] as const;
// Staff surfaces take walk-in dine-in orders with no table; the customer
// storefront never should. Anything unrecognised is treated as `web` — the
// strictest bucket, so a forged value cannot loosen a rule.
const ORDER_SOURCES = ['web', 'counter', 'pos'] as const;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let payload: PlaceOrderRequest;
  try { payload = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  if (!payload.branch_id || !payload.channel || !payload.payment_method) return json(400, { error: 'missing_fields' });
  // Validate against the enum here rather than letting Postgres fail the cast
  // three steps later with a 500.
  if (!ORDER_CHANNELS.includes(payload.channel)) return json(400, { error: 'invalid_channel' });
  const source = ORDER_SOURCES.includes(payload.source as (typeof ORDER_SOURCES)[number])
    ? payload.source as (typeof ORDER_SOURCES)[number]
    : 'web';
  const hasItems = Array.isArray(payload.items) && payload.items.length > 0;
  const hasCombos = Array.isArray(payload.combos) && payload.combos.length > 0;
  if (!hasItems && !hasCombos) return json(400, { error: 'empty_order' });
  if (!Array.isArray(payload.items)) payload.items = [];
  if (payload.channel === 'delivery' && !payload.delivery_address?.line1 && !payload.saved_address_id) return json(400, { error: 'delivery_address_required' });
  if (!payload.customer_phone) return json(400, { error: 'customer_phone_required' });
  // Dine-in ordered by the diner has to say which table, or the food has nowhere
  // to go. Staff surfaces legitimately ring up walk-in dine-in with no table, so
  // the rule is scoped to the customer storefront.
  const tableNumber = clip(payload.table_number, 20);
  if (payload.channel === 'dine_in' && source === 'web' && !payload.table_id && !tableNumber) {
    return json(400, { error: 'table_required' });
  }
  if (payload.payment_method !== 'card' && payload.payment_method !== 'cash') return json(400, { error: 'invalid_payment_method' });

  // Rate limiting (v9.5): this endpoint is public (verify_jwt=false), so cap
  // scripted abuse without throttling a busy counter. Fail-open on RPC error —
  // a rate-limit outage must never block real orders.
  // - per IP: 60 orders / 10 min (a flat-out POS at one order per 10s stays under)
  // - per phone: 15 orders / 10 min, skipping the counter walk-in sentinel
  const clientIp = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  const phoneDigits = String(payload.customer_phone).replace(/\D/g, '');
  const rlChecks: Array<{ key: string; max: number }> = [
    { key: `order:ip:${clientIp}`, max: 60 },
    ...(phoneDigits && phoneDigits !== '10000000000'
      ? [{ key: `order:phone:${payload.branch_id}:${phoneDigits}`, max: 15 }]
      : []),
  ];
  for (const rl of rlChecks) {
    const { data: verdict } = await admin.rpc('check_rate_limit', { p_bucket_key: rl.key, p_max_count: rl.max, p_window_seconds: 600 });
    if (verdict && (verdict as { allowed?: boolean }).allowed === false) {
      return json(429, { error: 'rate_limited', retry_after_seconds: 600 });
    }
  }

  // Structured drop-off (delivery only). dropoff_pref is required; the whitelisted
  // object is merged into delivery_address later so it survives a saved-address rebuild.
  let dropoff: { dropoff_pref: (typeof DROPOFF_PREFS)[number]; dropoff_other?: string; gate_code?: string; room?: string } | null = null;
  if (payload.channel === 'delivery') {
    const pref = payload.delivery_address?.dropoff_pref;
    if (!pref || !DROPOFF_PREFS.includes(pref)) return json(400, { error: 'dropoff_required' });
    const dropoffOther = clip(payload.delivery_address?.dropoff_other, 120);
    if (pref === 'other' && !dropoffOther) return json(400, { error: 'dropoff_other_required' });
    const gateCode = clip(payload.delivery_address?.gate_code, 40);
    const room = clip(payload.delivery_address?.room, 40);
    dropoff = {
      dropoff_pref: pref,
      ...(pref === 'other' ? { dropoff_other: dropoffOther } : {}),
      ...(gateCode ? { gate_code: gateCode } : {}),
      ...(room ? { room } : {}),
    };
  }

  // Validate scheduled_for: at least 10 min in the future, at most 14 days.
  // Parsed here rather than next to the insert because the store-hours check
  // below needs it: a 7pm pickup ordered at 2pm has to be judged against 7pm
  // opening hours, not against whether the branch happens to be open right now.
  let scheduledFor: string | null = null;
  if (payload.scheduled_for) {
    const t = new Date(payload.scheduled_for).getTime();
    const now = Date.now();
    if (!Number.isFinite(t)) return json(400, { error: 'invalid_scheduled_for' });
    if (t < now + 10 * 60_000) return json(400, { error: 'scheduled_too_soon' });
    if (t > now + 14 * 24 * 60 * 60_000) return json(400, { error: 'scheduled_too_far' });
    scheduledFor = new Date(t).toISOString();
  }

  // A scheduled order is checked against its own pickup time. Without p_at, an
  // order for tomorrow lunch placed after closing was rejected as `branch_closed`,
  // and one placed during today's lunch for a day the branch is shut sailed through.
  const { data: openCheck } = await admin.rpc('is_branch_open', {
    p_branch_id: payload.branch_id,
    ...(scheduledFor ? { p_at: scheduledFor } : {}),
  });
  if (openCheck === false) {
    return json(409, { error: scheduledFor ? 'branch_closed_at_scheduled_time' : 'branch_closed' });
  }

  const { data: branch, error: bErr } = await admin.from('branches').select('id, restaurant_id, is_active, settings, sales_tax_rate, geo_lat, geo_lng').eq('id', payload.branch_id).single();
  if (bErr || !branch || !branch.is_active) return json(404, { error: 'branch_not_found_or_inactive' });

  // Turn the typed table number into a real table row so the kitchen and the
  // floor plan see it. A number that matches nothing is not an error — the
  // restaurant may not have mapped its tables — it just rides along in the notes.
  //
  // Exact match, never `ilike`: PostgREST aliases `*` to `%` on like/ilike, so a
  // diner typing `*` would match every table in the branch and `.limit(1)` would
  // hand them an arbitrary one. `tables_branch_id_table_number_key
  // UNIQUE (branch_id, table_number)` makes `eq` at most one row anyway.
  //
  // Only dine-in and QR ordering sit at a table. The staff surfaces keep the
  // typed table number in state after the channel is switched, so without this
  // guard a pickup order would be stamped with a real table's FK and show up on
  // the kitchen board as a table order.
  const wantsTable = payload.channel === 'dine_in' || payload.channel === 'qr_ordering';
  let tableId: string | null = wantsTable ? payload.table_id ?? null : null;
  if (wantsTable && !tableId && tableNumber) {
    const { data: tableRows } = await admin
      .from('tables')
      .select('id')
      .eq('branch_id', payload.branch_id)
      .eq('is_active', true)
      .eq('table_number', tableNumber)
      .limit(1);
    tableId = tableRows?.[0]?.id ?? null;
  }

  // Billing gate. The BEFORE INSERT triggers on orders/payments/deliveries are the
  // real authority — this check exists so a suspended tenant gets one clean 402
  // instead of a half-written order rolled back by a P0001 three steps later.
  const ent = await loadEntitlements(admin, { restaurantId: branch.restaurant_id });
  if (!ent.entitled) return json(402, billingInactiveBody('orders'));
  if (payload.channel === 'delivery' && !edgeHasFeature(ent, 'delivery')) {
    return json(403, featureNotEntitledBody('delivery'));
  }

  const menuItemIds = payload.items.map((i) => i.menu_item_id);
  // deno-lint-ignore no-explicit-any
  let items: any[] = [];
  if (menuItemIds.length > 0) {
    const { data, error: iErr } = await admin.from('menu_items').select('id, branch_id, name, price, image_url, is_active, stock_quantity, track_stock').in('id', menuItemIds).eq('branch_id', payload.branch_id);
    if (iErr || !data) return json(500, { error: 'item_lookup_failed', detail: iErr?.message });
    items = data;
  }

  // Look up combos for any combo lines, validate they belong to the branch.
  // deno-lint-ignore no-explicit-any
  const comboMap = new Map<string, { id: string; name: string; total_price: number; image_url: string | null }>();
  if (hasCombos && payload.combos) {
    const comboIds = payload.combos.map((c) => c.combo_id);
    const { data: combos, error: cErr } = await admin
      .from('combo_sets')
      .select('id, name, total_price, image_url, branch_id, is_active')
      .in('id', comboIds)
      .eq('branch_id', payload.branch_id);
    if (cErr) return json(500, { error: 'combo_lookup_failed', detail: cErr.message });
    for (const c of combos ?? []) {
      if (!c.is_active) return json(400, { error: 'combo_inactive', combo_id: c.id });
      comboMap.set(c.id, { id: c.id, name: c.name, total_price: Number(c.total_price), image_url: c.image_url });
    }
  }

  // deno-lint-ignore no-explicit-any
  const itemMap = new Map<string, any>(items.map((i: any) => [i.id, i]));

  // Fetch effective prices (happy-hour aware). Falls back to list price.
  // deno-lint-ignore no-explicit-any
  const priceOverride = new Map<string, number>();
  if (items.length > 0) {
    const { data: effective } = await admin.rpc('get_effective_prices', { p_branch_id: payload.branch_id });
    // deno-lint-ignore no-explicit-any
    for (const row of (effective ?? []) as any[]) {
      const eff = Number(row.effective_price);
      const list = Number(row.list_price);
      if (Number.isFinite(eff) && eff < list) priceOverride.set(row.menu_item_id, eff);
    }
  }
  for (const [id, it] of itemMap.entries()) {
    const override = priceOverride.get(id);
    if (override !== undefined) it.price = override;
  }
  for (const line of payload.items) {
    const it = itemMap.get(line.menu_item_id);
    if (!it) return json(400, { error: 'item_not_in_branch', item_id: line.menu_item_id });
    if (!it.is_active) return json(400, { error: 'item_inactive', item_id: line.menu_item_id });
    if (it.track_stock && it.stock_quantity != null && it.stock_quantity < line.quantity) return json(409, { error: 'insufficient_stock', item_id: line.menu_item_id, available: it.stock_quantity });
    if (line.quantity < 1 || line.quantity > 99) return json(400, { error: 'invalid_quantity', item_id: line.menu_item_id });
  }

  // Look up modifier options for all lines that send modifier_option_ids
  const allModIds = Array.from(new Set(payload.items.flatMap((l) => l.modifier_option_ids ?? [])));
  // deno-lint-ignore no-explicit-any
  const modMap = new Map<string, { id: string; group_id: string; name: string; price_delta: number; is_active: boolean }>();
  if (allModIds.length > 0) {
    const { data: opts, error: optErr } = await admin
      .from('modifier_options')
      .select('id, group_id, name, price_delta, is_active, modifier_groups!inner(branch_id)')
      // deno-lint-ignore no-explicit-any
      .in('id', allModIds as any);
    if (optErr) return json(500, { error: 'modifier_lookup_failed', detail: optErr.message });
    // deno-lint-ignore no-explicit-any
    for (const o of (opts ?? []) as any[]) {
      const grp = Array.isArray(o.modifier_groups) ? o.modifier_groups[0] : o.modifier_groups;
      if (!grp || grp.branch_id !== payload.branch_id) {
        return json(400, { error: 'modifier_branch_mismatch', option_id: o.id });
      }
      if (!o.is_active) return json(400, { error: 'modifier_inactive', option_id: o.id });
      modMap.set(o.id, { id: o.id, group_id: o.group_id, name: o.name, price_delta: Number(o.price_delta), is_active: o.is_active });
    }
  }

  const settings = (branch.settings || {}) as Record<string, unknown>;

  // Per-line subtotal: (unit_price + mod_delta) * quantity. Modifier total saved per line.
  const lineComputations = payload.items.map((line) => {
    const it = itemMap.get(line.menu_item_id)!;
    const modIds = line.modifier_option_ids ?? [];
    const lineMods = modIds.map((id) => modMap.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
    const modDelta = lineMods.reduce((s, m) => s + Number(m.price_delta), 0);
    const unitWithMods = r2(Number(it.price) + modDelta);
    const lineSubtotal = r2(unitWithMods * line.quantity);
    return { line, it, lineMods, modDelta, unitWithMods, lineSubtotal };
  });
  const comboComputations = (payload.combos ?? []).map((cline) => {
    const combo = comboMap.get(cline.combo_id)!;
    const qty = Math.max(1, Math.min(99, cline.quantity));
    return {
      combo,
      qty,
      notes: cline.notes,
      lineSubtotal: r2(combo.total_price * qty),
    };
  });
  const subtotal = r2(
    lineComputations.reduce((sum, c) => sum + c.lineSubtotal, 0) +
    comboComputations.reduce((sum, c) => sum + c.lineSubtotal, 0),
  );
  const defaultDeliveryFee = Number(settings.delivery_fee ?? 3.99);
  let deliveryFee = payload.channel === 'delivery' ? defaultDeliveryFee : 0;
  const serviceFee = r2(subtotal * (Number(settings.service_fee_percent ?? 0) / 100));
  const tipAmount = Math.max(0, r2(payload.tip_amount ?? 0));

  let customerId: string | null = null;
  let authedUserId: string | null = null;
  let promoDiscount = 0;
  let promoId: string | null = null;
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: { user } } = await userClient.auth.getUser();
    if (user) {
      authedUserId = user.id;
      // Customer identity is per RESTAURANT (shared across its branches), so resolve
      // by (user, restaurant) and lazily create the row on first order at any branch.
      const { data: c } = await admin.from('customers').select('id').eq('user_id', user.id).eq('restaurant_id', branch.restaurant_id).maybeSingle();
      customerId = c?.id ?? null;
      if (!customerId) {
        const { data: created } = await admin.from('customers')
          .insert({ restaurant_id: branch.restaurant_id, branch_id: payload.branch_id, user_id: user.id, phone: payload.customer_phone, full_name: payload.customer_name ?? null, preferred_language: 'en' })
          .select('id').single();
        if (created) {
          customerId = created.id;
        } else {
          // The insert lost a partial unique index. Re-read our OWN row first —
          // a second concurrent order from the same diner trips
          // customers_restaurant_user_uidx (restaurant_id, user_id).
          const { data: mine } = await admin.from('customers').select('id')
            .eq('restaurant_id', branch.restaurant_id).eq('user_id', user.id).maybeSingle();
          customerId = mine?.id ?? null;
          if (!customerId) {
            // Otherwise customers_restaurant_phone_uidx blocked it: some row already
            // holds this phone. customer_phone is raw request body and phone sign-in
            // is OTP-less, so it proves NOTHING about who is calling — claim the row
            // only while it is still UNOWNED, which is the staff-/guest-created row
            // this fallback was written for. `is('user_id', null)` is part of the
            // UPDATE, so a row belonging to another diner matches nothing and their
            // points balance, address book and order history stay theirs. Claiming
            // (rather than merely reading the id) is what makes the row answer to
            // private.customer_id_for_user(), so the order shows up under Your orders.
            const { data: claimed } = await admin.from('customers')
              .update({ user_id: user.id })
              .eq('restaurant_id', branch.restaurant_id).eq('phone', payload.customer_phone).is('user_id', null)
              .select('id').maybeSingle();
            // Nothing safe to adopt → stay null and file this as a guest order:
            // orders.customer_id is nullable, the loyalty award trigger skips NULL,
            // and a redeem_points attempt is rejected below with redeem_requires_auth.
            customerId = claimed?.id ?? null;
          }
        }
      }
    }
  }

  // Is the caller an active staff member of this restaurant? Resolved at most
  // once — the login gate, the payment matrix and the loyalty identity gate all
  // need it. callerIsStaff() reads the JWT role, so a tokenless/guest caller is
  // never staff — which is what makes the `source` spoof below harmless.
  let staffLookupDone = false;
  let callerIsStaffCached = false;
  async function callerIsStaff(): Promise<boolean> {
    if (staffLookupDone) return callerIsStaffCached;
    staffLookupDone = true;
    if (!authedUserId) return false;
    const { data: staffRow } = await admin.from('staff_members').select('id')
      .eq('user_id', authedUserId).eq('restaurant_id', branch.restaurant_id)
      .eq('status', 'active').limit(1).maybeSingle();
    callerIsStaffCached = !!staffRow;
    return callerIsStaffCached;
  }

  // Login is mandatory for customer-placed orders (defense-in-depth over the
  // storefront's add-to-cart/checkout gates). A staff surface authenticates the
  // CASHIER, not the diner, so counter/POS stay exempt; a guest who forged
  // source:'counter' still fails here because callerIsStaff() is false without a
  // staff JWT. Resolved once and reused by the loyalty identity gate below.
  const staffPlaced = source !== 'web' && (await callerIsStaff());
  if (!staffPlaced && !authedUserId) return json(401, { error: 'login_required' });

  // Payment gating: settings.payment_methods = { asap: { cash, card }, scheduled: { cash, card } }.
  // Absent key/subkey => enabled (backward compatible); only an explicit false blocks.
  // The matrix governs what CUSTOMERS may pick — staff-placed orders (counter/POS
  // have their own hard-coded Cash/Card buttons) are exempt.
  // Entitlement gate on card. Unlike the merchant's own matrix below, this one is
  // NOT staff-exempt: if card_payment was never paid for, the counter cannot take
  // a card either. Checked before the matrix so the reason returned is the true one.
  if (payload.payment_method === 'card' && !edgeHasFeature(ent, 'card_payment')) {
    return json(403, featureNotEntitledBody('card_payment'));
  }

  const paymentMethods = settings.payment_methods as Record<string, Record<string, boolean>> | undefined;
  const orderMode = payload.scheduled_for ? 'scheduled' : 'asap';
  // Dine-in never shows the diner a payment step — they settle at the restaurant,
  // and the checkout sends 'cash' purely because payments.method is NOT NULL.
  // Running that through the matrix would let a branch which turned asap.cash off
  // (a perfectly reasonable delivery/pickup policy) kill every dine-in order.
  if (payload.channel !== 'dine_in' && paymentMethods?.[orderMode]?.[payload.payment_method] === false) {
    if (!(await callerIsStaff())) return json(400, { error: 'payment_method_not_accepted' });
  }

  let deliveryAddress = payload.delivery_address ?? null;
  if (payload.saved_address_id && customerId) {
    const { data: a } = await admin.from('customer_addresses').select('*').eq('id', payload.saved_address_id).eq('customer_id', customerId).maybeSingle();
    // The checkout sends both delivery_address and saved_address_id — a
    // freshly-typed "Delivery instructions" note beats the saved row's stale
    // one (mirrors the dropoff merge below, which also survives the rebuild).
    const typedNotes = clip(payload.delivery_address?.notes, 300);
    if (a) deliveryAddress = { line1: a.address_line1, line2: a.address_line2, city: a.city ?? a.district, state: a.state ?? a.province, postal_code: a.postal_code, notes: typedNotes || a.delivery_notes, lat: a.lat ?? undefined, lng: a.lng ?? undefined } as never;
  }
  if (dropoff) {
    // Drop any raw drop-off keys from the incoming address; only the validated object wins.
    const { dropoff_pref: _p, dropoff_other: _o, gate_code: _g, room: _r, ...rest } = (deliveryAddress ?? {}) as Record<string, unknown>;
    deliveryAddress = { ...rest, ...dropoff } as never;
  }

  // Distance-based delivery quote (server-authoritative — same RPC the checkout
  // UI previews with). Falls back to the legacy flat fee when no coordinates.
  let tripDistanceKm: number | null = null;
  let tripEtaMin: number | null = null;
  let dropoffLat: number | null = null;
  let dropoffLng: number | null = null;
  if (payload.channel === 'delivery') {
    const addr = deliveryAddress as { lat?: number; lng?: number } | null;
    const lat = typeof addr?.lat === 'number' && Number.isFinite(addr.lat) ? addr.lat : null;
    const lng = typeof addr?.lng === 'number' && Number.isFinite(addr.lng) ? addr.lng : null;
    if (lat != null && lng != null) {
      const { data: q } = await admin.rpc('quote_delivery', { p_branch_id: payload.branch_id, p_lat: lat, p_lng: lng });
      const quote = q as { deliverable?: boolean; reason?: string; distance_km?: number; fee?: number; eta_min?: number; radius_km?: number } | null;
      if (quote?.deliverable) {
        deliveryFee = Number(quote.fee ?? deliveryFee);
        tripDistanceKm = Number.isFinite(Number(quote.distance_km)) ? Number(quote.distance_km) : null;
        tripEtaMin = Number.isFinite(Number(quote.eta_min)) ? Number(quote.eta_min) : null;
        dropoffLat = lat;
        dropoffLng = lng;
      } else if (quote?.reason === 'out_of_range') {
        return json(409, { error: 'delivery_out_of_range', distance_km: quote.distance_km, radius_km: quote.radius_km });
      } else if (quote?.reason === 'delivery_not_entitled') {
        // Must NOT fall through to the legacy flat fee below — that would quietly
        // sell a delivery the account has not paid for.
        return json(403, featureNotEntitledBody('delivery'));
      }
      // branch_unavailable / invalid_coordinates → keep the legacy flat fee.
    } else {
      console.warn('delivery_no_coords:legacy_flat_fee', { branch_id: payload.branch_id });
    }
  }

  if (payload.promo_code) {
    const { data: prom } = await admin.rpc('validate_promo_code', { p_branch_id: payload.branch_id, p_code: payload.promo_code, p_subtotal: subtotal });
    const p = prom as { valid?: boolean; amount_off?: number; free_delivery?: boolean; promo_id?: string };
    if (p?.valid) {
      promoDiscount = Number(p.amount_off ?? 0);
      if (p.free_delivery) deliveryFee = 0;
      promoId = p.promo_id ?? null;
    }
  }

  // Loyalty redemption. Points are no longer a free-form currency the diner
  // slides against any order: they buy exactly the named rewards the merchant
  // published in `loyalty_rewards`, and THIS function prices the reward.
  //
  // A client that still sends `redeem_points` is running pre-catalog code. We
  // reject rather than ignore, because ignoring means quietly charging more
  // than the total that client displayed — a silent overcharge is worse than a
  // visible "please refresh". `reward_id` and `redeem_points` are never both
  // valid, so this also stops a crafted payload from stacking the two.
  if (payload.redeem_points != null) {
    return json(409, { error: 'stale_client_refresh_required' });
  }

  // Points cost of the chosen reward. Kept separate from the dollar discount:
  // 100 pts = $1 was only ever true for the old slider, and a merchant is free
  // to price "Free dessert" at 300 points regardless of what it is worth.
  let pointsSpent = 0;
  let loyaltyDollarsOff = 0;
  let rewardName: string | null = null;
  let loyaltyBrandScope = false;

  if (payload.reward_id) {
    if (!customerId) return json(400, { error: 'redeem_requires_auth' });
    // Phone sign-in is OTP-less: anyone who knows a number can sign in as that
    // customer. Points are money, so spending them needs a second factor — a
    // linked Google identity or a confirmed real email (see
    // loyaltyIdentityProven). Checked BEFORE the order row is written so a
    // rejection leaves nothing behind. Staff surfaces are exempt: the diner is
    // standing at the counter and the authenticated user is the cashier
    // (staffPlaced was resolved up front, alongside the login gate).
    if (!staffPlaced) {
      const { data: authUser } = await admin.auth.admin.getUserById(authedUserId ?? '');
      // Wire code unchanged (other surfaces match on it) even though a verified
      // email now satisfies the gate too — the customer-facing copy names both.
      if (!loyaltyIdentityProven(authUser?.user)) return json(403, { error: 'google_link_required' });
    }

    // Scoped to THIS restaurant so a reward id lifted from another tenant's
    // storefront cannot be spent here.
    const { data: reward } = await admin
      .from('loyalty_rewards')
      .select('id, name, kind, value, max_discount, points_cost, min_subtotal, menu_item_id, is_active, restaurant_id')
      .eq('id', payload.reward_id)
      .eq('restaurant_id', branch.restaurant_id)
      .maybeSingle();
    if (!reward || !reward.is_active) return json(400, { error: 'reward_unavailable' });
    if (subtotal < Number(reward.min_subtotal ?? 0)) {
      return json(400, { error: 'reward_min_subtotal', min_subtotal: Number(reward.min_subtotal) });
    }

    const { data: rest } = await admin.from('restaurants').select('loyalty_scope').eq('id', branch.restaurant_id).maybeSingle();
    loyaltyBrandScope = rest?.loyalty_scope === 'brand';
    let q = admin.from('loyalty_points').select('points_balance').eq('customer_id', customerId);
    q = loyaltyBrandScope ? q.eq('restaurant_id', branch.restaurant_id).is('branch_id', null) : q.eq('branch_id', payload.branch_id);
    const { data: pts } = await q.maybeSingle();
    const balance = pts?.points_balance ?? 0;
    const cost = Number(reward.points_cost);
    if (balance < cost) return json(400, { error: 'insufficient_points', balance, required: cost });

    switch (reward.kind) {
      case 'percent_off': {
        const off = (subtotal * Number(reward.value)) / 100;
        loyaltyDollarsOff = r2(reward.max_discount != null ? Math.min(off, Number(reward.max_discount)) : off);
        break;
      }
      case 'fixed_off':
        loyaltyDollarsOff = r2(Math.min(Number(reward.value), subtotal));
        break;
      case 'free_item': {
        // The diner adds the item to the cart as normal and the reward pays for
        // one of them. Discounting the BASE price, not the line total, keeps
        // paid add-ons paid — "free fries" should not also hand over $3 of
        // extra toppings. Rejecting (rather than silently discounting nothing)
        // stops the diner from spending points for no benefit.
        const match = lineComputations.find((c) => c.line.menu_item_id === reward.menu_item_id);
        if (!match) return json(400, { error: 'reward_item_not_in_cart', menu_item_id: reward.menu_item_id });
        loyaltyDollarsOff = r2(Math.min(Number(match.it.price), subtotal));
        break;
      }
      case 'free_delivery':
        // Nothing off the food; the fee is zeroed instead. Charging points for
        // a fee the diner was never going to pay would be theft, so a pickup or
        // dine-in order is refused rather than silently costing points.
        if (payload.channel !== 'delivery' || deliveryFee <= 0) {
          return json(400, { error: 'reward_not_applicable' });
        }
        deliveryFee = 0;
        break;
      default:
        return json(400, { error: 'reward_unavailable' });
    }

    pointsSpent = cost;
    rewardName = reward.name;
  }

  // Sales tax computed on the post-discount, pre-tip, pre-delivery food subtotal.
  const taxRate = Number(branch.sales_tax_rate ?? 0);
  const taxableBase = Math.max(0, subtotal - loyaltyDollarsOff - promoDiscount);
  const taxAmount = r2(taxableBase * taxRate);

  // Gift card credit. We check balance now (server-side) and reserve on insert.
  let giftCardCredit = 0;
  let giftCardCode: string | null = null;
  if (payload.gift_card_code && payload.gift_card_code.trim()) {
    const { data: check } = await admin.rpc('check_gift_card', { p_code: payload.gift_card_code.trim() });
    const c = check as { valid?: boolean; balance?: number };
    if (c?.valid) {
      giftCardCredit = Math.min(Number(c.balance ?? 0), taxableBase);
      giftCardCode = payload.gift_card_code.trim();
    }
  }

  const total = r2(Math.max(0, taxableBase + deliveryFee + serviceFee + tipAmount + taxAmount - giftCardCredit));

  const { data: orderNumberData, error: nErr } = await admin.schema('private').rpc('generate_order_number', { p_branch_id: payload.branch_id });
  if (nErr) console.error('order_number_rpc_failed', nErr);
  const orderNumber = (orderNumberData as unknown as string) || `A-${new Date().toISOString().slice(2,7).replace('-','')}-${String(Date.now() % 1000000).padStart(6,'0')}`;

  // Hold far-future scheduled orders out of the kitchen. Released by the
  // pg_cron job private.release_scheduled_orders() at scheduled_for − prep_time.
  const prepTimeMin = Number(settings.prep_time_min ?? 15);
  const held = scheduledFor != null &&
    new Date(scheduledFor).getTime() - Date.now() > (prepTimeMin + 15) * 60_000;

  const { data: order, error: oErr } = await admin.from('orders').insert({
    order_number: orderNumber, branch_id: payload.branch_id, customer_id: customerId,
    customer_name: payload.customer_name, customer_phone: payload.customer_phone,
    channel: payload.channel, status: 'pending', subtotal, delivery_fee: deliveryFee,
    service_fee: serviceFee, tax_amount: taxAmount, discount_amount: loyaltyDollarsOff + promoDiscount,
    tip_amount: tipAmount, promo_code: promoId ? payload.promo_code : null, promo_discount: promoDiscount,
    total, delivery_address: deliveryAddress, customer_notes: payload.customer_notes,
    table_id: tableId, source,
    scheduled_for: scheduledFor,
    held,
    status_history: [{ status: 'pending', at: new Date().toISOString(), scheduled_for: scheduledFor, held }],
  }).select('id, order_number').single();
  if (oErr || !order) return json(500, { error: 'order_insert_failed', detail: oErr?.message });

  // Reserve gift card credit (best-effort; if it fails the order still stands).
  if (giftCardCode && giftCardCredit > 0) {
    await admin.rpc('redeem_gift_card', {
      p_code: giftCardCode,
      p_order_id: order.id,
      p_max_amount: giftCardCredit,
    });
  }

  const orderItems = [
    ...lineComputations.map((c) => ({
      order_id: order.id,
      menu_item_id: c.line.menu_item_id,
      item_name: c.it.name,
      item_image_url: c.it.image_url,
      unit_price: c.it.price,
      quantity: c.line.quantity,
      // order_items.modifiers is NOT NULL (default '[]'::jsonb) — never send null.
      modifiers: c.lineMods.map((m) => ({ group_id: m.group_id, option_id: m.id, name: m.name, price_delta: m.price_delta })),
      modifier_total: r2(c.modDelta * c.line.quantity),
      subtotal: c.lineSubtotal,
      notes: c.line.notes,
      prep_status: 'pending',
    })),
    ...comboComputations.map((c) => ({
      order_id: order.id,
      menu_item_id: null,
      combo_id: c.combo.id,
      item_name: c.combo.name,
      item_image_url: c.combo.image_url,
      unit_price: c.combo.total_price,
      quantity: c.qty,
      modifiers: [],
      modifier_total: 0,
      subtotal: c.lineSubtotal,
      notes: c.notes,
      prep_status: 'pending',
    })),
  ];
  const { error: oiErr } = await admin.from('order_items').insert(orderItems);
  if (oiErr) { await admin.from('orders').delete().eq('id', order.id); return json(500, { error: 'order_items_insert_failed', detail: oiErr.message }); }

  if (promoId && customerId && promoDiscount > 0) {
    await admin.from('promo_redemptions').insert({ promo_id: promoId, customer_id: customerId, order_id: order.id, amount_off: promoDiscount });
    await admin.from('promos').update({ redemption_count: ((await admin.from('promos').select('redemption_count').eq('id', promoId).single()).data?.redemption_count ?? 0) + 1 }).eq('id', promoId);
  }

  if (pointsSpent > 0 && customerId) {
    let balQ = admin.from('loyalty_points').select('points_balance, lifetime_spent').eq('customer_id', customerId);
    balQ = loyaltyBrandScope ? balQ.eq('restaurant_id', branch.restaurant_id).is('branch_id', null) : balQ.eq('branch_id', payload.branch_id);
    const balanceBefore = await balQ.maybeSingle();
    const newBalance = Math.max(0, (balanceBefore.data?.points_balance ?? 0) - pointsSpent);
    let updQ = admin.from('loyalty_points').update({ points_balance: newBalance, lifetime_spent: (balanceBefore.data?.lifetime_spent ?? 0) + pointsSpent, updated_at: new Date().toISOString() }).eq('customer_id', customerId);
    updQ = loyaltyBrandScope ? updQ.eq('restaurant_id', branch.restaurant_id).is('branch_id', null) : updQ.eq('branch_id', payload.branch_id);
    const { error: debitErr } = await updQ;
    if (debitErr) console.error('loyalty_debit_failed', debitErr);
    // reference_type stays 'order' — list_my_loyalty_transactions filters on it
    // to hide points spent on an order that was never completed. The reward is
    // named in the description so the diner's history reads as what they got,
    // not as an unexplained points deduction.
    const { error: ledgerErr } = await admin.from('loyalty_transactions').insert({ branch_id: loyaltyBrandScope ? null : payload.branch_id, restaurant_id: branch.restaurant_id, customer_id: customerId, points: -pointsSpent, balance_after: newBalance, type: 'redeemed', reference_type: 'order', reference_id: order.id, description: `${rewardName ?? 'Reward'} — ${pointsSpent} pts on order ${order.order_number}` });
    if (ledgerErr) console.error('loyalty_ledger_failed', ledgerErr);
  }

  const { data: payment } = await admin.from('payments').insert({ order_id: order.id, branch_id: payload.branch_id, amount: total, method: payload.payment_method, status: 'pending', gateway: payload.payment_method === 'cash' ? null : 'stripe', gateway_metadata: { pending: true } }).select('id').single();
  if (payload.channel === 'delivery') {
    // EWKT strings — PostGIS parses them into geography on insert.
    const pickupEwkt = branch.geo_lat != null && branch.geo_lng != null
      ? `SRID=4326;POINT(${branch.geo_lng} ${branch.geo_lat})`
      : null;
    const dropoffEwkt = dropoffLat != null && dropoffLng != null
      ? `SRID=4326;POINT(${dropoffLng} ${dropoffLat})`
      : null;
    await admin.from('deliveries').insert({
      order_id: order.id,
      branch_id: payload.branch_id,
      status: 'pending',
      delivery_fee: deliveryFee,
      ...(pickupEwkt ? { pickup_location: pickupEwkt } : {}),
      ...(dropoffEwkt ? { delivery_location: dropoffEwkt } : {}),
      ...(dropoffLat != null && dropoffLng != null ? { dropoff_lat: dropoffLat, dropoff_lng: dropoffLng } : {}),
      ...(tripDistanceKm != null ? { distance_km: tripDistanceKm } : {}),
      ...(tripEtaMin != null ? { estimated_duration_min: tripEtaMin } : {}),
    });
  }

  return json(201, { order_id: order.id, order_number: order.order_number, total, subtotal, tax_amount: taxAmount, discount_amount: loyaltyDollarsOff + promoDiscount, points_spent: pointsSpent, eta_min: tripEtaMin, payment_id: payment?.id ?? null, payment_method: payload.payment_method });
});
