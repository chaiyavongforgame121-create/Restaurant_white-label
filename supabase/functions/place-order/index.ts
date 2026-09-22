// place-order — the single writer for customer, counter and POS orders.
// Server-side recalculation never trusts client totals.
//
// Version history: see ./CHANGELOG.md (moved out of this file 2026-08-28).
// Current: v11.5 — every branch is its own shop. The caller counts as staff only at a branch
// they may ring up (staff_can_ring_up), a staff sale is never filed under the cashier's own
// customer record, a diner is resolved by (branch, user), and points, promos and gift cards
// are taken atomically for the order or the order is not placed. A unit price is never
// rounded to the cent; each line is, once (lineTotal), and the subtotal is their exact sum.
// Lines of one selection (dish, options, note) are consolidated into one before any of it.

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
  payment_method: 'card' | 'cash' | 'transfer';
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
  /** The open sitting this round belongs to. Re-checked here — see the session gate. */
  session_id?: string;
  source?: 'web' | 'counter' | 'pos';
  scheduled_for?: string;
  gift_card_code?: string;
  /** Staff only: a percentage 0..100 taken off the food before tax and the card service fee. */
  discount_percent?: number;
  /** Staff only: an E.164 number the customer gave, matched against THIS branch's customers. */
  customer_lookup_phone?: string;
  items: Array<{ menu_item_id: string; quantity: number; notes?: string; modifier_option_ids?: string[] }>;
  combos?: Array<{ combo_id: string; quantity: number; notes?: string }>;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

// Round to two decimals.
function r2(n: number) { return Math.round(n * 100) / 100; }

// Money on an order line. Mirror of packages/shared/src/utils/money.ts (money.test.ts pins that
// side); a Deno function cannot import the workspace package, so the two are edited together.
//
// A unit price is NOT money yet and is never rounded to the cent: half of SET A's $15.99 is
// $7.995, and rounding that to $8.00 before multiplying billed seven of them as $56.00 while the
// storefront's cart line said $55.97. A line is (unit + options) x quantity, rounded half-up to
// the cent once, worked in whole ten-thousandths so no float product decides the cent. The order
// subtotal is the exact sum of the lines.

// Postgres round(): half away from zero. `+ 0` turns a -0 into 0.
function roundHalfUp(n: number) { return (n < 0 ? -Math.round(-n) : Math.round(n)) + 0; }

// A unit price to the four decimals order_items.unit_price (numeric(12,4)) keeps.
function unitPrice4(n: number) { return roundHalfUp(Number(n) * 10000) / 10000; }

// (unit + options) x quantity, to the cent, rounded once. lineTotal() in money.ts.
function lineTotal(unit: number, modDelta: number, quantity: number) {
  const u4 = roundHalfUp((Number(unit) + (Number(modDelta) || 0)) * 10000);
  return roundHalfUp((u4 * (Number(quantity) || 0)) / 100) / 100;
}

// The exact sum of amounts that are already whole cents. sumMoney() in money.ts.
function sumMoney(amounts: number[]) {
  let cents = 0;
  for (const a of amounts) cents += roundHalfUp(Number(a) * 100);
  return cents / 100;
}

// Trim a free-text field and hard-cap its length (non-strings become '').
function clip(v: unknown, max: number) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

// One line per selection. Mirror of consolidateOrderLines() in packages/shared/src/utils/modifiers.ts
// (modifiers.test.ts pins that side, and the storefront cart and the till key their lines the same
// way); a Deno function cannot import the workspace package, so the two are edited together.
//
// The same dish with the same options, in any order, and the same note is ONE line on the bill,
// its quantities added: SET A added from the storefront's Happy Hour strip and again from the menu
// is "8 x SET A", not two SET A lines. Different options are different food at a different price
// and stay apart. A combo line is the combo and its note. A note is trimmed and a blank one is no
// note; an option id sent twice on one line counts once (it used to be charged twice). The first
// line of a selection keeps its place.
type ItemLine = PlaceOrderRequest['items'][number];
type ComboLine = NonNullable<PlaceOrderRequest['combos']>[number];

// normalizeLineNotes() in modifiers.ts.
function lineNotes(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

function consolidateLines(items: ItemLine[], combos: ComboLine[]): { items: ItemLine[]; combos: ComboLine[] } {
  const outItems: ItemLine[] = [];
  const itemByKey = new Map<string, ItemLine>();
  for (const line of items) {
    const optionIds = [...new Set(line.modifier_option_ids ?? [])];
    const notes = lineNotes(line.notes);
    const key = `${line.menu_item_id}|${[...optionIds].sort().join(',')}|${notes ?? ''}`;
    const first = itemByKey.get(key);
    if (first) {
      first.quantity += line.quantity;
      continue;
    }
    const merged: ItemLine = { menu_item_id: line.menu_item_id, quantity: line.quantity, notes, modifier_option_ids: optionIds };
    itemByKey.set(key, merged);
    outItems.push(merged);
  }
  const outCombos: ComboLine[] = [];
  const comboByKey = new Map<string, ComboLine>();
  for (const cline of combos) {
    const notes = lineNotes(cline.notes);
    const key = `combo:${cline.combo_id}|${notes ?? ''}`;
    const first = comboByKey.get(key);
    if (first) {
      first.quantity += cline.quantity;
      continue;
    }
    const merged: ComboLine = { combo_id: cline.combo_id, quantity: cline.quantity, notes };
    comboByKey.set(key, merged);
    outCombos.push(merged);
  }
  return { items: outItems, combos: outCombos };
}

const DROPOFF_PREFS = ['leave_at_door', 'hand_to_me', 'at_desk', 'other'] as const;

// The number the counter sends for a walk-in who gave none. It is nobody's: the customers table
// refuses it (customers_phone_not_placeholder), so it is never stored on or looked up as a diner.
const WALK_IN_PHONE = '+10000000000';
const E164 = /^\+[1-9][0-9]{6,14}$/;

// A phone worth keeping on a customer record: at least seven digits and not the walk-in placeholder.
function realPhone(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const phone = v.trim();
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7 || digits === WALK_IN_PHONE.slice(1)) return null;
  return phone.slice(0, 32);
}

// A name worth keeping on a customer record. The counter's fallbacks ('Walk-in', 'Table 4') are
// labels for the ticket, not somebody's name.
function realName(v: unknown): string | null {
  const name = clip(v, 120);
  if (!name || /^walk-?in$/i.test(name) || /^table\s+\S+$/i.test(name)) return null;
  return name;
}

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

// What reserve_order_credits refuses with, and the status each is answered with. Anything else it
// raises is this function's own fault and stays a 500.
const CREDIT_REFUSALS: Array<[string, number]> = [
  ['insufficient_points', 409],
  ['per_customer_limit_reached', 409],
  ['promo_exhausted', 409],
  ['promo_unavailable', 409],
  ['gift_card_changed', 409],
  ['redeem_requires_auth', 400],
];
// Carried as `hint` on a promo or gift-card refusal. The storefront finds its copy by substring over
// the whole body, and a checkout deployed before these refusals existed knows none of their codes:
// without a hint it shows "Something went wrong" and the same button fails the same way. This code
// it does know ("Rewards changed while you were ordering. Please refresh this page and try again."),
// and a refresh clears the code or card, which the diner can then re-apply and be told why it fails.
// The counter reads `error` only, so the hint does not reach it.
const STALE_CREDIT_HINT = 'stale_client_refresh_required';
const wantsRefreshHint = (code: string) =>
  code.startsWith('promo') || code === 'per_customer_limit_reached' || code === 'gift_card_changed';

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
  if (!Array.isArray(payload.combos)) payload.combos = [];
  if (payload.channel === 'delivery' && !payload.delivery_address?.line1 && !payload.saved_address_id) return json(400, { error: 'delivery_address_required' });
  if (!payload.customer_phone) return json(400, { error: 'customer_phone_required' });
  // Dine-in ordered by the diner has to say which table, or the food has nowhere
  // to go. Staff surfaces legitimately ring up walk-in dine-in with no table, so
  // the rule is scoped to the customer storefront.
  const tableNumber = clip(payload.table_number, 20);
  if (payload.channel === 'dine_in' && source === 'web' && !payload.table_id && !tableNumber) {
    return json(400, { error: 'table_required' });
  }
  if (payload.payment_method !== 'card' && payload.payment_method !== 'cash' && payload.payment_method !== 'transfer') {
    return json(400, { error: 'invalid_payment_method' });
  }

  // The till's discount, as a percentage of the food. Its shape is checked here; whether the caller
  // may give one at all is decided once we know who they are.
  let discountPercent = 0;
  if (payload.discount_percent != null) {
    const pct = Number(payload.discount_percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return json(400, { error: 'invalid_discount_percent' });
    discountPercent = pct;
  }
  // A number typed at the till to find this branch's customer record. Only ever looked up, never
  // used to create or claim one, so a wrong number just leaves the sale a walk-in.
  let lookupPhone: string | null = null;
  if (payload.customer_lookup_phone != null && String(payload.customer_lookup_phone).trim() !== '') {
    const phone = String(payload.customer_lookup_phone).trim();
    if (!E164.test(phone) || phone === WALK_IN_PHONE) return json(400, { error: 'invalid_customer_phone' });
    lookupPhone = phone;
  }

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

  // Parsed here rather than next to the insert because the store-hours check below needs
  // it: a 7pm pickup ordered at 2pm has to be judged against 7pm opening hours, not
  // against whether the branch happens to be open right now.
  //
  // The BOUNDS (too soon / too far / scheduling switched off) are per-branch settings and
  // are enforced further down, once branch.settings has been read. They were hardcoded
  // 10-minutes-to-14-days here, and disagreed with the checkout input's own hardcoded
  // 15 minutes — a diner picking a 12-minute-out slot cleared the picker and failed here.
  let scheduledFor: string | null = null;
  if (payload.scheduled_for) {
    const t = new Date(payload.scheduled_for).getTime();
    if (!Number.isFinite(t)) return json(400, { error: 'invalid_scheduled_for' });
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

  // Who is calling, resolved HERE rather than down in the pricing block, because the
  // dine-in session gate below has to know before anything is priced. `Bearer
  // <publishableKey>` yields no user, so an anonymous caller stays anonymous.
  let authedUser: { id: string } | null = null;
  let authedUserId: string | null = null;
  {
    const header = req.headers.get('authorization');
    if (header && header.toLowerCase().startsWith('bearer ')) {
      const userClient = createClient(url, anonKey, { global: { headers: { Authorization: header } }, auth: { persistSession: false } });
      const { data: { user } } = await userClient.auth.getUser();
      authedUser = user ?? null;
      authedUserId = user?.id ?? null;
    }
  }

  // STAFF OR DINER, decided before anything else reads either. A counter or POS sale is staff-placed
  // only when the caller may ring up at THIS branch: the same rule as
  // private.staff_has_capability(branch, 'counter.access') — owner rows and restaurant-wide rows
  // cover every branch, other rows only their own, plus the restaurant's owner_user_id and platform
  // admins. It used to be any active staff row of the restaurant, so a Hamburger cashier could ring
  // up Food Thai Thai orders around its payment matrix; and it was decided after the customer, so a
  // counter sale was filed under the cashier's own customer record and would have earned them the
  // walk-in's points. A staff surface whose caller is not staff here is refused outright rather
  // than treated as a diner: that is how the cashier's account ended up as a customer.
  let staffPlaced = false;
  let staffRowId: string | null = null;
  if (source !== 'web') {
    if (!authedUserId) return json(401, { error: 'login_required' });
    const { data: canRing, error: ringErr } = await admin.rpc('staff_can_ring_up', { p_user_id: authedUserId, p_branch_id: branch.id });
    if (ringErr) return json(500, { error: 'staff_check_failed', detail: ringErr.message });
    if (canRing !== true) return json(403, { error: 'not_staff_at_branch' });
    staffPlaced = true;
    // orders.staff_id: who rang it up, as their staff row for this branch (the branch's own row
    // first, then a restaurant-wide one, then an owner row pinned elsewhere). An owner known only
    // through restaurants.owner_user_id, or a platform admin, has no row, and the column stays null.
    const { data: rows } = await admin.from('staff_members')
      .select('id, branch_id, created_at')
      .eq('user_id', authedUserId)
      .eq('restaurant_id', branch.restaurant_id)
      .eq('status', 'active')
      .or(`branch_id.eq.${branch.id},branch_id.is.null,role.eq.owner`);
    const rank = (r: { branch_id: string | null }) => (r.branch_id === branch.id ? 0 : r.branch_id == null ? 1 : 2);
    const best = ((rows ?? []) as Array<{ id: string; branch_id: string | null; created_at: string }>)
      .sort((a, b) => rank(a) - rank(b) || a.created_at.localeCompare(b.created_at))[0];
    staffRowId = best?.id ?? null;
  }
  if (discountPercent > 0 && !staffPlaced) return json(403, { error: 'discount_requires_staff' });

  // Structured drop-off (delivery only). dropoff_pref is required from the storefront; a staff
  // sale defaults to 'hand_to_me' (the rider phones the customer). The whitelisted object is
  // merged into delivery_address later so it survives a saved-address rebuild.
  let dropoff: { dropoff_pref: (typeof DROPOFF_PREFS)[number]; dropoff_other?: string; gate_code?: string; room?: string } | null = null;
  if (payload.channel === 'delivery') {
    const pref = payload.delivery_address?.dropoff_pref ?? (staffPlaced ? 'hand_to_me' : undefined);
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
    // The rider has to be able to call someone. The storefront always sends the diner's number;
    // the till sends the walk-in placeholder when nobody typed one.
    if (staffPlaced && !realPhone(payload.customer_phone)) return json(400, { error: 'customer_phone_required' });
  }

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
  let tableId: string | null = null;
  if (wantsTable && payload.table_id) {
    // A table id arrives from the client and its FK only proves the row EXISTS. Without
    // this check a token lifted from one restaurant's tent stamped an order at THIS branch
    // with THAT branch's table, and the ticket was walked to a table that is not here.
    // (tg_orders_table_and_session enforces the same rule at the insert; this is here so
    // the diner gets a readable 400 instead of a database error.)
    const { data: t } = await admin
      .from('tables')
      .select('id, branch_id, is_active')
      .eq('id', payload.table_id)
      .maybeSingle();
    if (!t || t.branch_id !== payload.branch_id || !t.is_active) {
      return json(400, { error: 'table_not_in_branch' });
    }
    tableId = t.id;
  }
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

  // DINE-IN SESSION. A table QR is a sitting, not a standing licence to order: food is only
  // cooked while a session is open at that table, and settling the bill closes it. Before
  // this, anyone who photographed a table tent could have food cooked and carried to that
  // table, from anywhere on earth, unpaid, forever.
  let sessionId: string | null = null;
  if (wantsTable && tableId) {
    const { data: sess } = await admin
      .from('table_sessions')
      .select('id, status')
      .eq('table_id', tableId)
      .neq('status', 'closed')
      .maybeSingle();
    if (!staffPlaced) {
      if (!sess) return json(409, { error: 'table_not_seated' });
      if (sess.status !== 'open') return json(409, { error: 'table_session_closed' });
      // The sitting the checkout thought it was adding to has been settled and another
      // party seated since. Better a refusal than this round landing on their bill.
      if (payload.session_id && payload.session_id !== sess.id) {
        return json(409, { error: 'table_session_changed' });
      }
      // The storefront's sign-in requirement is client-side javascript. This is the server
      // one, and it is why the token being public does not matter outside a live sitting.
      if (!authedUserId) return json(401, { error: 'sign_in_required' });
      const { count } = await admin
        .from('table_session_participants')
        .select('user_id', { count: 'exact', head: true })
        .eq('session_id', sess.id)
        .eq('user_id', authedUserId);
      if (!count) return json(403, { error: 'not_at_this_table' });
      sessionId = sess.id;
    } else {
      // The till and the POS may seat a table themselves, so a walk-in rung up at the
      // counter joins the same bill the diner's phone is adding to.
      if (sess?.status === 'open') {
        sessionId = sess.id;
      } else if (!sess) {
        const { data: opened } = await admin
          .from('table_sessions')
          .insert({ branch_id: payload.branch_id, table_id: tableId, opened_via: 'counter' })
          .select('id').single();
        sessionId = opened?.id ?? null;
        await admin.from('tables').update({ status: 'occupied' }).eq('id', tableId);
      }
    }
  }

  // Login is mandatory for customer-placed orders (defense-in-depth over the
  // storefront's add-to-cart/checkout gates). Staff surfaces were settled above.
  if (!staffPlaced && !authedUserId) return json(401, { error: 'login_required' });

  // Billing gate. The BEFORE INSERT triggers on orders/payments/deliveries are the
  // real authority — this check exists so a suspended tenant gets one clean 402
  // instead of a half-written order rolled back by a P0001 three steps later.
  const ent = await loadEntitlements(admin, { restaurantId: branch.restaurant_id });
  if (!ent.entitled) return json(402, billingInactiveBody('orders'));
  if (payload.channel === 'delivery' && !edgeHasFeature(ent, 'delivery')) {
    return json(403, featureNotEntitledBody('delivery'));
  }

  // Quantities first: every check below sums them. A combo line is held to the same rule as a
  // dish line; it used to be clamped silently, so a client sending 0 or 150 was charged for 1 or 99.
  for (const line of payload.items) {
    const q = Number(line.quantity);
    if (!Number.isInteger(q) || q < 1 || q > 99) return json(400, { error: 'invalid_quantity', item_id: line.menu_item_id });
    line.quantity = q;
    // A list of option ids, or nothing. Anything else is a client bug: a string used to be read
    // as one id, or throw a TypeError (a bare 500) further down.
    if (line.modifier_option_ids != null && !Array.isArray(line.modifier_option_ids)) {
      return json(400, { error: 'invalid_modifiers', item_id: line.menu_item_id });
    }
  }
  for (const cline of payload.combos!) {
    const q = Number(cline.quantity);
    if (!Number.isInteger(q) || q < 1 || q > 99) return json(400, { error: 'invalid_quantity', combo_id: cline.combo_id });
    cline.quantity = q;
  }

  // One line per selection (consolidateLines), before anything is looked up, checked or priced, so
  // every rule below -- stock and demand, sold out, options, the free-item reward, the price --
  // sees exactly the lines the bill and the kitchen ticket will have. Each line as sent was held to
  // 1..99 above; a line they fold into is held to the same rule, as the storefront cart (which
  // merges them too, and stops a merge at 99: MAX_LINE_QUANTITY in modifiers.ts) would have sent
  // it. Refused rather than clamped: billing 99 for 110 ordered would drop food without a word.
  {
    const consolidated = consolidateLines(payload.items, payload.combos!);
    for (const line of consolidated.items) {
      if (line.quantity > 99) return json(400, { error: 'invalid_quantity', item_id: line.menu_item_id });
    }
    for (const cline of consolidated.combos) {
      if (cline.quantity > 99) return json(400, { error: 'invalid_quantity', combo_id: cline.combo_id });
    }
    payload.items = consolidated.items;
    payload.combos = consolidated.combos;
  }

  // Look up combos for any combo lines, validate they belong to the branch, and read what is in
  // them: a combo is its dishes, and each one has to be on sale here for the combo to be.
  type ComboPart = { menu_item_id: string; quantity: number; position: number };
  const comboMap = new Map<string, { id: string; name: string; total_price: number; image_url: string | null; parts: ComboPart[] }>();
  if (hasCombos) {
    const comboIds = payload.combos!.map((c) => c.combo_id);
    const { data: combos, error: cErr } = await admin
      .from('combo_sets')
      .select('id, name, total_price, image_url, branch_id, is_active, archived_at, combo_items(menu_item_id, quantity, position)')
      .in('id', comboIds)
      .eq('branch_id', payload.branch_id);
    if (cErr) return json(500, { error: 'combo_lookup_failed', detail: cErr.message });
    // deno-lint-ignore no-explicit-any
    for (const c of (combos ?? []) as any[]) {
      if (!c.is_active || c.archived_at) return json(400, { error: 'combo_inactive', combo_id: c.id });
      const parts = ((c.combo_items ?? []) as ComboPart[])
        .map((p) => ({ menu_item_id: p.menu_item_id, quantity: Number(p.quantity) || 1, position: Number(p.position) || 0 }))
        .sort((a, b) => a.position - b.position);
      comboMap.set(c.id, { id: c.id, name: c.name, total_price: Number(c.total_price), image_url: c.image_url, parts });
    }
    // The lookup is scoped to this branch, so a combo from another branch (a cart carried
    // across storefronts on the same host) or a deleted one simply is not returned. Nothing
    // checked for that, and the pricing step's `comboMap.get(id)!` threw a TypeError: a bare
    // 500 for what is really "this set is not on this menu". `hint` carries a code the
    // checkout and the counter already match by substring, so a client that predates
    // combo_not_in_branch still reads "no longer available" rather than a raw body.
    for (const cline of payload.combos!) {
      const combo = comboMap.get(cline.combo_id);
      if (!combo) {
        return json(400, { error: 'combo_not_in_branch', combo_id: cline.combo_id, hint: 'item_not_in_branch' });
      }
      // A combo with nothing in it would sell the diner a name at full price.
      if (combo.parts.length === 0) return json(409, { error: 'combo_empty', combo_id: combo.id, hint: 'combo_inactive' });
    }
  }

  // Every dish the order touches: the lines' own and the combos' contents, in one read. Not scoped
  // to the branch in the query, so a line naming another branch's dish is told apart from one that
  // does not exist; both are refused below.
  const menuItemIds = Array.from(new Set([
    ...payload.items.map((i) => i.menu_item_id),
    ...Array.from(comboMap.values()).flatMap((c) => c.parts.map((p) => p.menu_item_id)),
  ]));
  // deno-lint-ignore no-explicit-any
  let items: any[] = [];
  if (menuItemIds.length > 0) {
    const { data, error: iErr } = await admin.from('menu_items').select('id, branch_id, name, price, image_url, is_active, stock_quantity, track_stock, sold_out_until, station').in('id', menuItemIds);
    if (iErr || !data) return json(500, { error: 'item_lookup_failed', detail: iErr?.message });
    items = data;
  }

  // deno-lint-ignore no-explicit-any
  const itemMap = new Map<string, any>(items.map((i: any) => [i.id, i]));
  const soldOut = (it: { sold_out_until?: string | null }) => !!it.sold_out_until && new Date(it.sold_out_until).getTime() > Date.now();

  // Fetch effective prices (happy-hour aware). Falls back to list price.
  // deno-lint-ignore no-explicit-any
  const priceOverride = new Map<string, number>();
  if (payload.items.length > 0) {
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
    if (override !== undefined && it.branch_id === payload.branch_id) it.price = override;
  }

  // How many of each dish the order takes off the shelf, dish lines and combo contents together:
  // two lines of the same dish with different options, or a dish that is also inside a combo in
  // the same cart, each passed a per-line check the shelf could not honour.
  const demand = new Map<string, number>();
  for (const line of payload.items) demand.set(line.menu_item_id, (demand.get(line.menu_item_id) ?? 0) + line.quantity);
  for (const cline of payload.combos!) {
    const combo = comboMap.get(cline.combo_id)!;
    for (const p of combo.parts) demand.set(p.menu_item_id, (demand.get(p.menu_item_id) ?? 0) + p.quantity * cline.quantity);
  }
  // A tracked dish always carries a count (menu_items CHECK), so null only reaches here from an
  // older row, and it means nothing on the shelf — the menu and the cart read it the same way.
  const onShelf = (it: { stock_quantity: number | null }) => Number(it.stock_quantity ?? 0);

  for (const line of payload.items) {
    const it = itemMap.get(line.menu_item_id);
    if (!it || it.branch_id !== payload.branch_id) return json(400, { error: 'item_not_in_branch', item_id: line.menu_item_id });
    if (!it.is_active) return json(400, { error: 'item_inactive', item_id: line.menu_item_id });
    // A manual 86 has to be refused here, not just hidden on the menu. Staff mark an item
    // sold out mid-service, and any diner whose menu was already loaded (or cached by the
    // service worker) still holds a page that offers it.
    if (soldOut(it)) return json(409, { error: 'item_sold_out', item_id: line.menu_item_id, until: it.sold_out_until });
    if (it.track_stock && onShelf(it) < (demand.get(it.id) ?? 0)) return json(409, { error: 'insufficient_stock', item_id: line.menu_item_id, available: Math.max(0, onShelf(it)) });
  }
  // A combo is on sale only while every dish in it is: this branch's, on the menu, not 86'd, and
  // on the shelf in the quantity the whole order needs.
  for (const cline of payload.combos!) {
    const combo = comboMap.get(cline.combo_id)!;
    for (const p of combo.parts) {
      const it = itemMap.get(p.menu_item_id);
      const refuse = (reason: string, extra: Record<string, unknown> = {}) =>
        json(409, { error: 'combo_item_unavailable', combo_id: combo.id, item_id: p.menu_item_id, reason, ...extra, hint: 'combo_inactive' });
      if (!it || it.branch_id !== payload.branch_id) return refuse('not_in_branch');
      if (!it.is_active) return refuse('inactive');
      if (soldOut(it)) return refuse('sold_out', { until: it.sold_out_until });
      if (it.track_stock && onShelf(it) < (demand.get(it.id) ?? 0)) return refuse('insufficient_stock', { available: Math.max(0, onShelf(it)) });
    }
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
    // An option id that matched no row (deleted since the cart was built) used to be dropped
    // without a word by the pricing step's filter, so the order went through WITHOUT the
    // extra the diner chose, and cheaper than the total their screen showed. Refuse it the
    // way an inactive option is refused.
    for (const id of allModIds) {
      if (!modMap.has(id)) return json(400, { error: 'modifier_inactive', option_id: id });
    }
  }

  const settings = (branch.settings || {}) as Record<string, unknown>;

  // Per-branch scheduling policy. Defaults reproduce the old hardcoded behaviour, and match
  // storefront_status() key for key — if the two ever drift, the picker offers times this
  // function then refuses, which is the exact failure the picker was rebuilt to remove.
  if (scheduledFor) {
    const schedulingEnabled = settings.scheduling_enabled === undefined
      ? true
      : settings.scheduling_enabled === true;
    if (!schedulingEnabled) return json(400, { error: 'scheduling_disabled' });

    const minLeadMin = Math.max(0, Number(settings.schedule_min_lead_min ?? 15));
    const maxDays = Math.max(0, Number(settings.schedule_max_days ?? 14));
    const t = new Date(scheduledFor).getTime();
    const now = Date.now();
    if (t < now + minLeadMin * 60_000) return json(400, { error: 'scheduled_too_soon' });
    // maxDays counts branch-local DAYS and the client offers the whole of the last one, so
    // the server allows a further 24h rather than cutting mid-day. Deliberately looser than
    // the picker: the set of times a diner can choose stays a subset of what is accepted.
    if (t > now + (maxDays + 1) * 24 * 60 * 60_000) return json(400, { error: 'scheduled_too_far' });

    // The per-weekday BOOKABLE window, on top of is_branch_open() further up. A shop open
    // all day may still only take pre-orders 17:00-22:00 Monday to Saturday and 10:00-14:00
    // on Sunday, which no amount of opening-hours data can express.
    //
    // Evaluated in the database so the BRANCH's timezone decides. Doing the weekday
    // arithmetic here would use the edge runtime's UTC clock and put a shop in Asia/Bangkok
    // seven hours out — its 17:00 window would be read as 17:00 UTC, which is midnight
    // local. Returns true whenever the merchant has not armed the feature, so this can be
    // asked unconditionally.
    //
    // Staff surfaces are exempt on purpose: the window is a self-service policy for diners,
    // and a manager taking a phone booking at the till IS the override. They are NOT exempt
    // from opening hours above. tg_enforce_scheduled_time exempts exactly the same sources;
    // if the two ever diverge, a counter booking clears this check and dies in the trigger
    // as a bare 500.
    if (source === 'web') {
      const { data: windowOk } = await admin.rpc('is_schedule_window_open', {
        p_branch_id: payload.branch_id,
        p_at: scheduledFor,
      });
      if (windowOk === false) return json(409, { error: 'outside_scheduling_window' });
    }
  }

  // Per-line subtotal: lineTotal(unit_price, mod_delta, quantity), the only rounding a line gets.
  // The unit is kept to four decimals (a happy-hour 7.995 stays 7.995) and stored that way.
  // Modifier total saved per line.
  const lineComputations = payload.items.map((line) => {
    const it = itemMap.get(line.menu_item_id)!;
    const modIds = line.modifier_option_ids ?? [];
    const lineMods = modIds.map((id) => modMap.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
    const modDelta = lineMods.reduce((s, m) => s + Number(m.price_delta), 0);
    const unitPrice = unitPrice4(Number(it.price));
    const lineSubtotal = lineTotal(unitPrice, modDelta, line.quantity);
    return { line, it, lineMods, modDelta, unitPrice, lineSubtotal };
  });
  const comboComputations = payload.combos!.map((cline) => {
    const combo = comboMap.get(cline.combo_id)!;
    const qty = cline.quantity;
    return {
      combo,
      qty,
      notes: cline.notes,
      lineSubtotal: lineTotal(combo.total_price, 0, qty),
      // What the combo held when it was sold, per ONE combo: the kitchen cooks from it, and
      // order_items_decrement_stock / the cancel restore count the dishes from it.
      contents: combo.parts.map((p) => {
        const it = itemMap.get(p.menu_item_id);
        return { menu_item_id: p.menu_item_id, name: it?.name ?? null, quantity: p.quantity, station: it?.station ?? null };
      }),
    };
  });
  // Exactly the lines added up: each is whole cents already, so nothing is rounded here.
  const subtotal = sumMoney([
    ...lineComputations.map((c) => c.lineSubtotal),
    ...comboComputations.map((c) => c.lineSubtotal),
  ]);
  // The till's discount comes off the food first, before tax and the card fee, exactly as the
  // counter quotes it (quoteCounterCart): min(subtotal, r2(subtotal x pct / 100)).
  const staffDiscount = staffPlaced && discountPercent > 0 ? Math.min(subtotal, r2(subtotal * (discountPercent / 100))) : 0;
  const defaultDeliveryFee = Number(settings.delivery_fee ?? 3.99);
  let deliveryFee = payload.channel === 'delivery' ? defaultDeliveryFee : 0;
  const tipAmount = Math.max(0, r2(payload.tip_amount ?? 0));

  // Customers order one of two ways: Pickup, prepared now, or Schedule Delivery, booked for a
  // chosen time. The storefront only offers those two, but a tab opened before that change (or a
  // hand-made request) can still send an ASAP delivery or a booked pickup, so the rule lives
  // here as well. Staff are exempt, like the payment matrix and the booking window: the counter
  // rings up walk-in deliveries for right now, and that is its job. Dine-in and QR table orders
  // are untouched — the order type is the table's, not a choice.
  //
  // `hint` carries a code the checkout has matched for a long time. The checkout finds its copy by
  // substring over the whole response body, so a tab opened before these two codes existed still
  // reads "choose delivery or pickup and try again" instead of this body printed as raw JSON.
  if (!staffPlaced) {
    if (payload.channel === 'delivery' && !scheduledFor) {
      return json(409, { error: 'delivery_must_be_scheduled', hint: 'invalid_channel' });
    }
    if (payload.channel === 'pickup' && scheduledFor) {
      return json(409, { error: 'pickup_is_asap_only', hint: 'invalid_channel' });
    }
  }

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

  // A branch that has not uploaded its QR cannot accept transfers, whatever the matrix
  // says — the diner would reach a payment step with nothing to scan. The counter's QR sale
  // passes here and is settled straight after by record_counter_transfer.
  if (payload.payment_method === 'transfer') {
    const qr = settings.qr_transfer as { image_url?: string } | undefined;
    if (!qr?.image_url) return json(400, { error: 'transfer_not_configured' });
  }

  const paymentMethods = settings.payment_methods as Record<string, Record<string, boolean>> | undefined;
  const orderMode = payload.scheduled_for ? 'scheduled' : 'asap';
  // Dine-in never shows the diner a payment step — they settle at the restaurant,
  // and the checkout sends 'cash' purely because payments.method is NOT NULL.
  // Running that through the matrix would let a branch which turned asap.cash off
  // (a perfectly reasonable delivery/pickup policy) kill every dine-in order.
  if (payload.channel !== 'dine_in' && paymentMethods?.[orderMode]?.[payload.payment_method] === false) {
    if (!staffPlaced) return json(400, { error: 'payment_method_not_accepted' });
  }

  // WHOSE ORDER. Customers are one row per (branch, user): each branch keeps its own diners, points
  // and history, and only the login is shared.
  //
  // A staff sale is never the caller's: the cashier's session proves who is at the till, not who is
  // eating. It stays a walk-in (customer_id null) unless the till looked a number up, and then it
  // is filed under THIS branch's existing record for that number, which is only read — never
  // created or claimed — so a mistyped number cannot hand anyone a login or a points balance.
  let customerId: string | null = null;
  if (staffPlaced) {
    if (lookupPhone) {
      // Matched by digits, not text: the till sends E.164 ('+16266386401') while the storefront
      // stores what the diner typed ('6266386401', '(626) 638-6401'). An exact text match never
      // found Food Thai Thai's only customer with a phone. A failed lookup leaves a walk-in.
      const { data: found, error: findErr } = await admin.rpc('find_branch_customer_by_phone', { p_branch_id: branch.id, p_phone: lookupPhone });
      if (findErr) console.error('customer_lookup_failed', { branch_id: branch.id, detail: findErr.message });
      customerId = typeof found === 'string' && found ? found : null;
    }
  } else if (authedUser) {
    const user = authedUser;
    const phone = realPhone(payload.customer_phone);
    const name = realName(payload.customer_name);
    type Row = { id: string; full_name: string | null; phone: string | null };
    const mine = async (): Promise<Row | null> => {
      const { data } = await admin.from('customers').select('id, full_name, phone')
        .eq('branch_id', branch.id).eq('user_id', user.id).maybeSingle();
      return (data as Row | null) ?? null;
    };
    const create = async (withPhone: string | null): Promise<Row | null> => {
      const { data } = await admin.from('customers')
        .insert({ restaurant_id: branch.restaurant_id, branch_id: branch.id, user_id: user.id, phone: withPhone, full_name: name, preferred_language: 'en' })
        .select('id, full_name, phone').single();
      return (data as Row | null) ?? null;
    };
    let row = await mine();
    if (!row) row = await create(phone);
    // The insert lost a unique index. A second concurrent order from the same diner trips
    // customers_branch_user_uidx: re-read our own row first.
    if (!row) row = await mine();
    if (!row && phone) {
      // Otherwise customers_branch_phone_uidx blocked it: a row at this branch already holds
      // the number. customer_phone is raw request body and phone sign-in is OTP-less, so it
      // proves NOTHING about who is calling — claim the row only while it is still UNOWNED (a
      // guest record), which `is('user_id', null)` makes part of the UPDATE. Another diner's
      // row matches nothing, and their points and history stay theirs; this diner then gets a
      // record of their own without the number.
      const { data: claimed } = await admin.from('customers')
        .update({ user_id: user.id })
        .eq('branch_id', branch.id).eq('phone', phone).is('user_id', null)
        .select('id, full_name, phone').maybeSingle();
      row = (claimed as Row | null) ?? (await create(null)) ?? (await mine());
    }
    // A record made before any order (the checkout creates one on load) is often blank. Fill
    // what is missing from what the diner just typed; each field on its own, so a number another
    // record at this branch already holds (the unique index refuses it) does not also lose the name.
    if (row && !row.full_name && name) {
      await admin.from('customers').update({ full_name: name }).eq('id', row.id).is('full_name', null);
    }
    if (row && !row.phone && phone) {
      await admin.from('customers').update({ phone }).eq('id', row.id).is('phone', null);
    }
    // Nothing usable → a guest order: orders.customer_id is nullable, the loyalty award
    // trigger skips NULL, and a reward attempt is refused below with redeem_requires_auth.
    customerId = row?.id ?? null;
  }

  // The service fee is a CARD-ONLY surcharge. Cash, QR transfer and dine-in (the
  // storefront submits dine-in as 'cash') pay none, and there is no staff carve-out:
  // a card sale rung up at the counter is charged like any other card sale, so the
  // till and this row cannot disagree. Computed here, after the payment gates, so a
  // method that is about to be refused never gets priced. Mirrored by
  // computeServiceFee() in packages/shared/src/utils/pricing.ts — a Deno function
  // cannot import that package, so the two expressions have to be kept identical.
  // The till's discount is off the food it is charged on (quoteCounterCart does the same).
  const serviceFeePercent = Math.max(0, Math.min(25, Number(settings.service_fee_percent ?? 0) || 0));
  const serviceFee = payload.payment_method === 'card' ? r2(Math.max(0, subtotal - staffDiscount) * (serviceFeePercent / 100)) : 0;

  let deliveryAddress = payload.delivery_address ?? null;
  if (payload.saved_address_id && customerId) {
    const { data: a } = await admin.from('customer_addresses').select('*').eq('id', payload.saved_address_id).eq('customer_id', customerId).maybeSingle();
    // The checkout sends both delivery_address and saved_address_id — a
    // freshly-typed "Delivery instructions" note beats the saved row's stale
    // one (mirrors the dropoff merge below, which also survives the rebuild).
    const typedNotes = clip(payload.delivery_address?.notes, 300);
    if (a) deliveryAddress = { line1: a.address_line1, line2: a.address_line2, city: a.city ?? a.district, state: a.state ?? a.province, postal_code: a.postal_code, notes: typedNotes || a.delivery_notes, lat: a.lat ?? undefined, lng: a.lng ?? undefined } as never;
  }
  // A saved address that is not this diner's at this branch leaves nothing to deliver to.
  if (payload.channel === 'delivery' && !clip((deliveryAddress as { line1?: unknown } | null)?.line1, 300)) {
    return json(400, { error: 'delivery_address_required' });
  }
  if (dropoff) {
    // Drop any raw drop-off keys from the incoming address; only the validated object wins.
    const { dropoff_pref: _p, dropoff_other: _o, gate_code: _g, room: _r, ...rest } = (deliveryAddress ?? {}) as Record<string, unknown>;
    deliveryAddress = { ...rest, ...dropoff } as never;
  }

  // Distance-based delivery quote (server-authoritative — same RPC the checkout
  // UI previews with). Without coordinates the branch's flat settings.delivery_fee
  // (default 3.99) applies: that is the counter's delivery with no map pin.
  let tripDistanceKm: number | null = null;
  let tripEtaMin: number | null = null;
  // quote_delivery has always returned the multiplier it applied; nothing ever stored it,
  // so no completed order could answer "was this surged, and by how much".
  let tripSurge: number | null = null;
  let dropoffLat: number | null = null;
  let dropoffLng: number | null = null;
  if (payload.channel === 'delivery') {
    const addr = deliveryAddress as { lat?: number; lng?: number } | null;
    const lat = typeof addr?.lat === 'number' && Number.isFinite(addr.lat) ? addr.lat : null;
    const lng = typeof addr?.lng === 'number' && Number.isFinite(addr.lng) ? addr.lng : null;
    if (lat != null && lng != null) {
      const { data: q } = await admin.rpc('quote_delivery', { p_branch_id: payload.branch_id, p_lat: lat, p_lng: lng });
      const quote = q as { deliverable?: boolean; reason?: string; distance_km?: number; fee?: number; eta_min?: number; radius_km?: number; surge?: number } | null;
      if (quote?.deliverable) {
        deliveryFee = Number(quote.fee ?? deliveryFee);
        tripDistanceKm = Number.isFinite(Number(quote.distance_km)) ? Number(quote.distance_km) : null;
        tripEtaMin = Number.isFinite(Number(quote.eta_min)) ? Number(quote.eta_min) : null;
        tripSurge = Number.isFinite(Number(quote.surge)) ? Number(quote.surge) : null;
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
      console.warn('delivery_no_coords:flat_fee', { branch_id: payload.branch_id, staff: staffPlaced });
    }
  }

  // Promo. Checked against this diner's record at this branch (p_customer_id: this function runs as
  // the service role, where validate_promo_code has no auth.uid() to go on), and counted atomically
  // with the order below. A code the checkout showed as applied but that no longer is gets a
  // refusal, not a silently higher total.
  let promoDiscount = 0;
  let promoId: string | null = null;
  if (payload.promo_code && payload.promo_code.trim()) {
    const { data: prom, error: promErr } = await admin.rpc('validate_promo_code', {
      p_branch_id: payload.branch_id,
      p_code: payload.promo_code.trim(),
      p_subtotal: subtotal,
      ...(customerId ? { p_customer_id: customerId } : {}),
    });
    if (promErr) return json(500, { error: 'promo_lookup_failed', detail: promErr.message });
    const p = prom as { valid?: boolean; error?: string; amount_off?: number; free_delivery?: boolean; promo_id?: string; min_subtotal?: number };
    if (!p?.valid) {
      return json(409, { error: p?.error ?? 'invalid_code', promo: true, ...(p?.min_subtotal != null ? { min_subtotal: p.min_subtotal } : {}), hint: STALE_CREDIT_HINT });
    }
    promoDiscount = Number(p.amount_off ?? 0);
    const freesDelivery = !!p.free_delivery && payload.channel === 'delivery' && deliveryFee > 0;
    if (p.free_delivery) deliveryFee = 0;
    // A use is counted only when the code gave something: a free-delivery code on a pickup would
    // otherwise spend the diner's one use (per_customer_limit) on nothing.
    promoId = promoDiscount > 0 || freesDelivery ? p.promo_id ?? null : null;
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

  if (payload.reward_id) {
    // Spending points needs the diner's own signed-in account. At the till the session is the
    // cashier's, and a number typed there proves nothing about who owns the balance.
    if (staffPlaced || !customerId) return json(400, { error: 'redeem_requires_auth' });
    // Phone sign-in is OTP-less: anyone who knows a number can sign in as that
    // customer. Points are money, so spending them needs a second factor — a
    // linked Google identity or a confirmed real email (see
    // loyaltyIdentityProven). Checked BEFORE the order row is written so a
    // rejection leaves nothing behind.
    const { data: authUser } = await admin.auth.admin.getUserById(authedUserId ?? '');
    // Wire code unchanged (other surfaces match on it) even though a verified
    // email now satisfies the gate too — the customer-facing copy names both.
    if (!loyaltyIdentityProven(authUser?.user)) return json(403, { error: 'google_link_required' });

    // Each branch has its own catalogue, so a reward id lifted from another branch's (or another
    // tenant's) storefront cannot be spent here.
    const { data: reward } = await admin
      .from('loyalty_rewards')
      .select('id, name, kind, value, max_discount, points_cost, min_subtotal, menu_item_id, is_active, branch_id')
      .eq('id', payload.reward_id)
      .eq('branch_id', payload.branch_id)
      .maybeSingle();
    if (!reward || !reward.is_active) return json(400, { error: 'reward_unavailable' });
    if (subtotal < Number(reward.min_subtotal ?? 0)) {
      return json(400, { error: 'reward_min_subtotal', min_subtotal: Number(reward.min_subtotal) });
    }

    // Points are per branch (restaurants.loyalty_scope is pinned to 'branch'). This read only
    // gives an early, readable refusal; the debit after the insert is the one that counts.
    const { data: pts } = await admin.from('loyalty_points').select('points_balance')
      .eq('branch_id', payload.branch_id).eq('customer_id', customerId).maybeSingle();
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
        // One unit is worth what it would be charged as a line of one: a happy-hour $7.995 is
        // $8.00 off, the same cent the diner would pay for it on its own. The checkout quotes it
        // with loyaltyRewardDiscount (packages/database/src/queries/loyalty.ts) from the same
        // line of its cart; edit the two together.
        const match = lineComputations.find((c) => c.line.menu_item_id === reward.menu_item_id);
        if (!match) return json(400, { error: 'reward_item_not_in_cart', menu_item_id: reward.menu_item_id });
        loyaltyDollarsOff = Math.min(lineTotal(match.unitPrice, 0, 1), subtotal);
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
  const taxableBase = Math.max(0, subtotal - loyaltyDollarsOff - promoDiscount - staffDiscount);
  const taxAmount = r2(taxableBase * taxRate);
  const discountAmount = r2(loyaltyDollarsOff + promoDiscount + staffDiscount);

  // Gift card credit. A card is good only at the branch that issued it. Checked now so the total
  // can be priced, and taken for real (all of it, or the order is not placed) once the order exists.
  let giftCardCredit = 0;
  let giftCardCode: string | null = null;
  if (payload.gift_card_code && payload.gift_card_code.trim()) {
    const code = payload.gift_card_code.trim();
    const { data: check, error: gErr } = await admin.rpc('check_gift_card', { p_code: code, p_branch_id: branch.id });
    if (gErr) return json(500, { error: 'gift_card_lookup_failed', detail: gErr.message });
    const c = check as { valid?: boolean; reason?: string; balance?: number };
    // The checkout sends a code only after it checked out, so a refusal here means the card was
    // spent, emptied or disabled in between. Charging the full price instead would be a silent
    // overcharge.
    if (!c?.valid) return json(409, { error: 'gift_card_changed', reason: c?.reason ?? null, hint: STALE_CREDIT_HINT });
    giftCardCredit = r2(Math.min(Number(c.balance ?? 0), taxableBase));
    if (giftCardCredit > 0) giftCardCode = code;
  }

  const total = r2(Math.max(0, taxableBase + deliveryFee + serviceFee + tipAmount + taxAmount - giftCardCredit));

  // Hold far-future scheduled orders out of the kitchen. Released by the pg_cron job
  // private.release_scheduled_orders() at scheduled_for − schedule_lead_time_min.
  //
  // Both sides must read the SAME number or the hold and the release disagree. They did:
  // this used prep_time_min + 15 while the job used prep_time_min, so for 15 minutes an
  // order could be held with nothing scheduled to let it out until the next cron tick.
  // schedule_lead_time_min also separates "when the kitchen sees it" from prep_time_min,
  // which is the figure quoted to the diner as an ETA — they were the same key.
  const prepTimeMin = Number(settings.prep_time_min ?? 15);
  const leadTimeMin = Math.max(0, Number(settings.schedule_lead_time_min ?? prepTimeMin));
  const held = scheduledFor != null &&
    new Date(scheduledFor).getTime() - Date.now() > leadTimeMin * 60_000;

  // The branch's own counter (A-YYMM-NNNN, month in the branch's timezone), taken atomically.
  // The random fallback only covers the RPC being unreachable, and the insert retries once on a
  // clash.
  const nextOrderNumber = async (): Promise<string> => {
    const { data, error } = await admin.rpc('next_order_number', { p_branch_id: branch.id });
    if (!error && typeof data === 'string' && data) return data;
    console.error('order_number_rpc_failed', error);
    return `A-${new Date().toISOString().slice(2, 7).replace('-', '')}-${String(Date.now() % 1000000).padStart(6, '0')}`;
  };
  const insertOrder = (orderNumber: string) => admin.from('orders').insert({
    order_number: orderNumber, branch_id: payload.branch_id, customer_id: customerId,
    customer_name: payload.customer_name, customer_phone: payload.customer_phone,
    channel: payload.channel, status: 'pending', subtotal, delivery_fee: deliveryFee,
    service_fee: serviceFee, tax_amount: taxAmount, discount_amount: discountAmount,
    tip_amount: tipAmount, promo_code: promoId ? payload.promo_code!.trim() : null, promo_discount: promoDiscount,
    total, delivery_address: deliveryAddress, customer_notes: payload.customer_notes,
    table_id: tableId, session_id: sessionId, source,
    staff_id: staffRowId,
    scheduled_for: scheduledFor,
    held,
    // Set here as well as by the payments trigger. The order row is inserted BEFORE the
    // payment row, so a kitchen client subscribed to realtime would otherwise see the
    // ticket appear and then vanish a moment later when the trigger fired.
    // A transfer of nothing (a gift card or reward covered it all) waits for no slip: there is
    // no payment row to approve (payments.amount must be above zero), so it would never leave
    // "awaiting payment". It goes to the kitchen like any other order with nothing to collect.
    awaiting_payment: payload.payment_method === 'transfer' && total > 0,
    status_history: [{ status: 'pending', at: new Date().toISOString(), scheduled_for: scheduledFor, held }],
  }).select('id, order_number, customer_id').single();

  let inserted = await insertOrder(await nextOrderNumber());
  if (inserted.error?.code === '23505' && (inserted.error.message ?? '').includes('order_number')) {
    inserted = await insertOrder(await nextOrderNumber());
  }
  const { data: order, error: oErr } = inserted;
  // The BEFORE INSERT gates on orders (delivery hours, scheduled time) raise P0001 with the
  // wire code as the message. Reporting those as a 500 blames the server for a rule the
  // request broke, and only worked at all because the checkout matches ORDER_ERRORS by
  // substring against the whole body. Give them back the status they would have had.
  if (oErr || !order) {
    const detail = oErr?.message ?? '';
    for (const code of [
      'outside_scheduling_window',
      'branch_closed_at_scheduled_time',
      'delivery_not_available_at_that_time',
      // tg_orders_table_and_session. It is the real authority on the table/session rules —
      // the checks above exist so the diner reads copy instead of a database error.
      'table_not_in_branch',
      'table_session_closed',
      'session_branch_mismatch',
      'session_table_mismatch',
      // tg_orders_customer_same_branch: the record is another branch's.
      'customer_branch_mismatch',
    ]) {
      if (detail.includes(code)) return json(409, { error: code });
    }
    return json(500, { error: 'order_insert_failed', detail });
  }

  // Points, promo and gift card, taken for this order in ONE transaction: any refusal undoes all
  // three, and the order goes with them. They used to be read-then-write after the insert with
  // their failures only logged — two checkouts could spend the same points, a promo could pass its
  // cap, and a gift card that failed to redeem left the credit on the order anyway.
  // The customer is the order's own (the insert's triggers have the last word on it).
  const reserveCredits = pointsSpent > 0 || promoId != null || giftCardCode != null;
  if (reserveCredits) {
    const { error: rErr } = await admin.rpc('reserve_order_credits', {
      p_order_id: order.id,
      p_customer_id: order.customer_id ?? null,
      p_points: pointsSpent,
      p_points_description: pointsSpent > 0 ? `${rewardName ?? 'Reward'} — ${pointsSpent} pts on order ${order.order_number}` : null,
      p_promo_id: promoId,
      p_promo_amount: promoDiscount,
      p_gift_card_code: giftCardCode,
      p_gift_card_amount: giftCardCredit,
    });
    if (rErr) {
      const detail = rErr.message ?? '';
      const refusal = CREDIT_REFUSALS.find(([code]) => detail.includes(code));
      // A known refusal is raised inside the RPC's transaction, so nothing was taken. Anything else
      // (a timeout, a dropped connection) may have committed after all: give back whatever the
      // reservation left behind before the order goes. release_order_credits works only from the
      // redemption and ledger rows the order has, so it is harmless when nothing was reserved.
      if (!refusal) {
        const { error: relErr } = await admin.rpc('release_order_credits', { p_order_id: order.id, p_promo_id: promoId });
        if (relErr) console.error('release_order_credits_failed', { order_id: order.id, detail: relErr.message });
      }
      const { error: delErr } = await admin.from('orders').delete().eq('id', order.id);
      if (delErr) console.error('order_delete_failed', { order_id: order.id, detail: delErr.message });
      if (refusal) {
        const [code, status] = refusal;
        const promo = code.startsWith('promo') || code === 'per_customer_limit_reached';
        return json(status, { error: code, ...(promo ? { promo: true } : {}), ...(wantsRefreshHint(code) ? { hint: STALE_CREDIT_HINT } : {}) });
      }
      return json(500, { error: 'credit_reservation_failed', detail });
    }
  }

  const orderItems = [
    ...lineComputations.map((c) => ({
      order_id: order.id,
      menu_item_id: c.line.menu_item_id,
      item_name: c.it.name,
      item_image_url: c.it.image_url,
      // Unrounded, to four decimals, so the bill can say 7 x $7.995 = $55.97.
      unit_price: c.unitPrice,
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
      combo_contents: c.contents,
    })),
  ];
  const { error: oiErr } = await admin.from('order_items').insert(orderItems);
  if (oiErr) {
    // Give back what reserve_order_credits took before the order goes: it never reached the kitchen.
    if (reserveCredits) {
      const { error: relErr } = await admin.rpc('release_order_credits', { p_order_id: order.id, p_promo_id: promoId });
      if (relErr) console.error('release_order_credits_failed', { order_id: order.id, detail: relErr.message });
    }
    const { error: delErr } = await admin.from('orders').delete().eq('id', order.id);
    if (delErr) console.error('order_delete_failed', { order_id: order.id, detail: delErr.message });
    return json(500, { error: 'order_items_insert_failed', detail: oiErr.message });
  }

  // A till discount is money off by a person, so it is on the record: who, how much, on what.
  if (staffDiscount > 0) {
    const { error: auditErr } = await admin.from('audit_logs').insert({
      restaurant_id: branch.restaurant_id, branch_id: branch.id, actor_id: authedUserId, actor_type: 'staff',
      action: 'order.discount', entity_type: 'order', entity_id: order.id,
      metadata: { order_number: order.order_number, source, discount_percent: discountPercent, discount_amount: staffDiscount, subtotal },
    });
    if (auditErr) console.error('discount_audit_failed', auditErr);
  }

  // Nothing to collect, no payment row: payments_amount_check refuses an amount of 0, and the insert
  // only ever failed there.
  const { data: payment } = total > 0
    ? await admin.from('payments').insert({ order_id: order.id, branch_id: payload.branch_id, amount: total, method: payload.payment_method, status: 'pending', gateway: payload.payment_method === 'card' ? 'stripe' : null, gateway_metadata: { pending: true } }).select('id').single()
    : { data: null };
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
      ...(tripSurge != null ? { surge_multiplier: tripSurge } : {}),
    });
  }

  return json(201, {
    order_id: order.id, order_number: order.order_number, total, subtotal, tax_amount: taxAmount, discount_amount: discountAmount,
    points_spent: pointsSpent, eta_min: tripEtaMin, payment_id: payment?.id ?? null, payment_method: payload.payment_method,
    // Only when the till looked a number up: whether it found this branch's customer, so the
    // cashier can tell a walk-in sale from one filed under a regular.
    ...(staffPlaced && lookupPhone ? { customer_matched: order.customer_id != null } : {}),
  });
});
