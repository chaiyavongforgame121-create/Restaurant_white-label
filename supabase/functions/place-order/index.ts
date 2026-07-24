// place-order v9.2 — US pivot + modifiers + combos + happy-hour + schedules + gift cards
//                  + distance-based delivery fees (Mapbox location backbone, Phase 1)
//                  + payment-method gating + structured drop-off.
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

interface PlaceOrderRequest {
  branch_id: string;
  channel: 'dine_in' | 'pickup' | 'delivery' | 'qr_ordering';
  customer_name?: string;
  customer_phone?: string;
  delivery_address?: { line1: string; line2?: string; city?: string; state?: string; postal_code?: string; notes?: string; lat?: number; lng?: number; dropoff_pref?: 'leave_at_door' | 'hand_to_me' | 'at_desk' | 'other'; dropoff_other?: string; gate_code?: string; room?: string };
  saved_address_id?: string;
  customer_notes?: string;
  payment_method: 'card' | 'cash';
  redeem_points?: number;
  tip_amount?: number;
  promo_code?: string;
  table_id?: string;
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
  const hasItems = Array.isArray(payload.items) && payload.items.length > 0;
  const hasCombos = Array.isArray(payload.combos) && payload.combos.length > 0;
  if (!hasItems && !hasCombos) return json(400, { error: 'empty_order' });
  if (!Array.isArray(payload.items)) payload.items = [];
  if (payload.channel === 'delivery' && !payload.delivery_address?.line1 && !payload.saved_address_id) return json(400, { error: 'delivery_address_required' });
  if (!payload.customer_phone) return json(400, { error: 'customer_phone_required' });
  if (payload.payment_method !== 'card' && payload.payment_method !== 'cash') return json(400, { error: 'invalid_payment_method' });

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

  const { data: openCheck } = await admin.rpc('is_branch_open', { p_branch_id: payload.branch_id });
  if (openCheck === false) return json(409, { error: 'branch_closed' });

  const { data: branch, error: bErr } = await admin.from('branches').select('id, restaurant_id, is_active, settings, sales_tax_rate, geo_lat, geo_lng').eq('id', payload.branch_id).single();
  if (bErr || !branch || !branch.is_active) return json(404, { error: 'branch_not_found_or_inactive' });

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
  let discountAmount = 0;
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
          // A row with this (restaurant, phone) already exists (e.g. created by staff) — adopt it.
          const { data: existing } = await admin.from('customers').select('id')
            .eq('restaurant_id', branch.restaurant_id).eq('phone', payload.customer_phone).maybeSingle();
          customerId = existing?.id ?? null;
        }
      }
    }
  }

  // Payment gating: settings.payment_methods = { asap: { cash, card }, scheduled: { cash, card } }.
  // Absent key/subkey => enabled (backward compatible); only an explicit false blocks.
  // The matrix governs what CUSTOMERS may pick — staff-placed orders (counter/POS
  // have their own hard-coded Cash/Card buttons) are exempt.
  const paymentMethods = settings.payment_methods as Record<string, Record<string, boolean>> | undefined;
  const orderMode = payload.scheduled_for ? 'scheduled' : 'asap';
  if (paymentMethods?.[orderMode]?.[payload.payment_method] === false) {
    const { data: staffRow } = authedUserId
      ? await admin.from('staff_members').select('id')
          .eq('user_id', authedUserId).eq('restaurant_id', branch.restaurant_id)
          .eq('status', 'active').limit(1).maybeSingle()
      : { data: null };
    if (!staffRow) return json(400, { error: 'payment_method_not_accepted' });
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

  // Loyalty redemption: stored points are integer "cents-off". 100 pts = $1.
  const redeem = Math.max(0, Math.floor(payload.redeem_points ?? 0));
  if (redeem > 0) {
    if (!customerId) return json(400, { error: 'redeem_requires_auth' });
    const { data: pts } = await admin.from('loyalty_points').select('points_balance').eq('branch_id', payload.branch_id).eq('customer_id', customerId).maybeSingle();
    const balance = pts?.points_balance ?? 0;
    const maxRedeem = Math.min(balance, Math.floor(subtotal * 50));
    discountAmount = Math.min(redeem, maxRedeem);
  }
  const loyaltyDollarsOff = r2(discountAmount / 100);

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

  // Validate scheduled_for: at least 15 min in the future, at most 14 days.
  let scheduledFor: string | null = null;
  if (payload.scheduled_for) {
    const t = new Date(payload.scheduled_for).getTime();
    const now = Date.now();
    if (!Number.isFinite(t)) return json(400, { error: 'invalid_scheduled_for' });
    if (t < now + 10 * 60_000) return json(400, { error: 'scheduled_too_soon' });
    if (t > now + 14 * 24 * 60 * 60_000) return json(400, { error: 'scheduled_too_far' });
    scheduledFor = new Date(t).toISOString();
  }

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
    table_id: payload.table_id ?? null, source: 'web',
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

  if (discountAmount > 0 && customerId) {
    const balanceBefore = await admin.from('loyalty_points').select('points_balance, lifetime_spent').eq('branch_id', payload.branch_id).eq('customer_id', customerId).maybeSingle();
    const newBalance = Math.max(0, (balanceBefore.data?.points_balance ?? 0) - discountAmount);
    await admin.from('loyalty_points').update({ points_balance: newBalance, lifetime_spent: (balanceBefore.data?.lifetime_spent ?? 0) + discountAmount, updated_at: new Date().toISOString() }).eq('branch_id', payload.branch_id).eq('customer_id', customerId);
    await admin.from('loyalty_transactions').insert({ branch_id: payload.branch_id, customer_id: customerId, points: -discountAmount, balance_after: newBalance, type: 'redeem', reference_type: 'order', reference_id: order.id, description: `Redeemed ${discountAmount} pts on order ${order.order_number}` });
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

  return json(201, { order_id: order.id, order_number: order.order_number, total, subtotal, tax_amount: taxAmount, discount_amount: loyaltyDollarsOff + promoDiscount, eta_min: tripEtaMin, payment_id: payment?.id ?? null, payment_method: payload.payment_method });
});
