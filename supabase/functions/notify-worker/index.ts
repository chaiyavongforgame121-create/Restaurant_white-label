// Drains the notifications_outbox queue: takes up to N pending rows, attempts
// delivery via the appropriate channel (sms, push, in_app, email), and marks them sent or failed.
//
// Channels:
//  - in_app: no-op (driver/staff query outbox directly)
//  - sms: Twilio REST API
//  - push: Web Push via VAPID (RFC 8291) — fans out to all push_subscriptions rows for recipient
//  - email: not yet wired (SendGrid/Resend)
//
// Invoke via pg_cron every minute or manually via HTTP w/ x-worker-secret header.
//
// BILLING: deliberately NOT entitlement-gated (owner decision, 2026-07-25). This
// drains a queue of messages about orders that were already accepted while the
// account was live — a customer waiting on "your rider is here" must still get it
// even if the restaurant lapsed an hour ago. Suspension is enforced upstream at
// order creation (place-order), so nothing new can enter this queue anyway.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WORKER_SECRET = Deno.env.get('NOTIFY_WORKER_SECRET') ?? '';
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE_NUMBER');
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:ops@favornoms.com';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const RESEND_FROM = Deno.env.get('RESEND_FROM') ?? 'Favornoms <orders@favornoms.com>';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;

interface OutboxRow {
  id: string;
  /** Which branch the message is about. Written by every enqueue site that has one. */
  branch_id: string | null;
  channel: string;
  recipient_type: string;
  recipient_id: string;
  template: string;
  variables: Record<string, unknown>;
  attempts: number;
}

/** Where an order lives on the storefront, and which branch it belongs to. */
interface OrderRoute {
  path: string | null;
  branchId: string | null;
}

/** What a branch's storefront is called and looks like, as its installed app shows it. */
interface StorefrontIdentity {
  /** "<brand> - <branch>", or one of the two when they are the same. */
  name: string;
  /** /r/<restaurant>/<branch> */
  path: string | null;
  /**
   * The branch's app icon (192px, else 512px), else its brand's, else the restaurant's default
   * brand's. Only ever an https URL.
   */
  icon: string | null;
}

/** The parts of a brand row a notification wears. */
interface BrandIdentityRow {
  name?: string | null;
  icon_192_url?: string | null;
  icon_512_url?: string | null;
}

/**
 * Variables only this worker derives. Whoever can queue a row controls `variables`, so a row that
 * arrives carrying one of these is not believed: they are dropped and resolved from the database.
 */
const DERIVED_VARS = ['order_path', 'storefront_name', 'storefront_path', 'storefront_icon'] as const;

/**
 * Lookups shared by the rows of ONE invocation: a batch is usually many notifications about a
 * handful of orders. Built per request rather than at module scope, because a warm isolate
 * serves many invocations and a renamed brand or a new icon must not wait for a cold start.
 * Promises rather than values so rows dispatched concurrently share one query.
 */
interface Lookups {
  orders: Map<string, Promise<OrderRoute | null>>;
  branches: Map<string, Promise<StorefrontIdentity | null>>;
}

interface PushSub {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

Deno.serve(async (req) => {
  if (WORKER_SECRET && req.headers.get('x-worker-secret') !== WORKER_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: rows, error } = await supabase
    .from('notifications_outbox')
    .select('id, branch_id, channel, recipient_type, recipient_id, template, variables, attempts')
    .in('status', ['pending', 'failed'])
    .lte('scheduled_for', new Date().toISOString())
    .lt('attempts', MAX_ATTEMPTS)
    .order('scheduled_for', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) return json({ error: error.message }, 500);

  const lookups: Lookups = { orders: new Map(), branches: new Map() };
  const results = await Promise.all(
    (rows ?? []).map(async (row: OutboxRow) => {
      try {
        await dispatch(supabase, row, lookups);
        await supabase
          .from('notifications_outbox')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', row.id);
        return { id: row.id, ok: true };
      } catch (err) {
        const msg = (err as Error).message;
        await supabase
          .from('notifications_outbox')
          .update({
            status: 'failed',
            attempts: row.attempts + 1,
            last_error: msg.slice(0, 500),
          })
          .eq('id', row.id);
        return { id: row.id, ok: false, error: msg };
      }
    }),
  );

  return json({
    processed: results.length,
    success: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });
});

async function dispatch(
  supabase: ReturnType<typeof createClient>,
  row: OutboxRow,
  lookups: Lookups,
) {
  // Nothing is delivered for in_app (staff and drivers read the outbox themselves), so there is
  // nothing to render and no reason to look anything up for it.
  if (row.channel === 'in_app') return;

  // Every order notification used to deep-link to `/orders/{uuid}`, which does not exist:
  // the customer app serves orders at /r/{restaurant}/{branch}/orders/{order_number} —
  // wrong prefix AND wrong identifier. So every "your order is ready" push landed on a
  // 404. The slugs are not in `variables` (the DB triggers never wrote them), so they are
  // resolved here, once per row, before anything is rendered. Doing it here rather than in
  // the triggers also repairs rows already sitting in the queue. The storefront's name and
  // icon are resolved the same way, for the same reasons.
  row = { ...row, variables: await enrichVars(supabase, row, lookups) };

  switch (row.channel) {
    case 'sms':
      await sendSms(supabase, row);
      return;
    case 'push':
      await sendPush(supabase, row);
      return;
    case 'email':
      await sendEmail(supabase, row);
      return;
    default:
      throw new Error(`unknown_channel:${row.channel}`);
  }
}

async function sendEmail(
  supabase: ReturnType<typeof createClient>,
  row: OutboxRow,
) {
  if (!RESEND_API_KEY) throw new Error('resend_not_configured');
  let email: string | null = null;
  if (row.recipient_type === 'customer') {
    const { data } = await supabase.from('customers').select('email').eq('id', row.recipient_id).maybeSingle();
    email = data?.email ?? null;
  } else if (row.recipient_type === 'driver') {
    const { data } = await supabase.from('drivers').select('email').eq('id', row.recipient_id).maybeSingle();
    email = data?.email ?? null;
  } else if (row.recipient_type === 'staff') {
    // staff_members.user_id → auth.users.email (requires service role, which we have)
    const { data: staff } = await supabase.from('staff_members').select('user_id').eq('id', row.recipient_id).maybeSingle();
    if (staff?.user_id) {
      const adminClient = supabase as unknown as { auth: { admin: { getUserById: (id: string) => Promise<{ data: { user?: { email?: string } } }> } } };
      const { data: u } = await adminClient.auth.admin.getUserById(staff.user_id);
      email = u.user?.email ?? null;
    }
  }
  if (!email) throw new Error('recipient_no_email');

  const subject = renderTitle(row.template, row.variables);
  const html = renderEmailHtml(row.template, row.variables);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [email],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`resend_${res.status}:${(await res.text()).slice(0, 200)}`);
  }
}

function renderEmailHtml(template: string, vars: Record<string, unknown>): string {
  const title = renderTitle(template, vars);
  const url = renderUrl(template, vars);
  const ctaLabel =
    template.startsWith('order_') ? 'View order' :
    template === 'new_dispatch' ? 'Open driver app' :
    template === 'promo' ? 'View offer' : 'Open Favornoms';

  // Per-template body. Falls back to renderTemplate() if no rich template.
  const orderNum = escapeHtml(String(vars.order_number ?? ''));
  // "Coastal Grill - Hamburger", as the storefront names itself: a diner who orders from two
  // branches of one restaurant cannot tell the emails apart by the branch name alone, and the
  // platform's name in the header was never the restaurant they ordered from.
  const storefront = storefrontLabel(vars);
  const branchName = escapeHtml(storefront ?? 'your restaurant');
  const headerName = escapeHtml(storefront ?? 'Favornoms');
  const eta = String(vars.eta_minutes ?? 30);
  const total = vars.total ? `$${Number(vars.total).toFixed(2)}` : null;
  const distanceMi = vars.distance_km ? Number(vars.distance_km).toFixed(1) : null;
  const earningsUsd = vars.earnings ? `$${Number(vars.earnings).toFixed(2)}` : null;

  let hero = '';
  let lede = '';
  let pillEmoji = '';
  let pillText = '';

  switch (template) {
    case 'order_confirmed':
      pillEmoji = '✅'; pillText = 'Order confirmed';
      hero = `We&rsquo;ve received your order <strong>${orderNum}</strong>.`;
      lede = `${branchName} is getting it ready. Estimated arrival in <strong>${eta} min</strong>.`;
      break;
    case 'order_ready_pickup':
      pillEmoji = '🍱'; pillText = 'Ready for pickup';
      hero = `Your order <strong>${orderNum}</strong> is ready!`;
      lede = `Pick it up at ${branchName} whenever you&rsquo;re ready.`;
      break;
    case 'order_out_for_delivery':
      pillEmoji = '🛵'; pillText = 'On the way';
      hero = `Your driver is heading your way with <strong>${orderNum}</strong>.`;
      lede = `Track them in real time from the order page.`;
      break;
    case 'driver_assigned':
      pillEmoji = '🤝'; pillText = 'Driver assigned';
      hero = `A driver has taken your order <strong>${orderNum}</strong>.`;
      lede = `They're heading to ${branchName} to pick it up — track them live from the order page.`;
      break;
    case 'order_arriving':
      pillEmoji = '📍'; pillText = 'Arriving now';
      hero = `Your driver is arriving with <strong>${orderNum}</strong>!`;
      lede = `They're less than a few hundred meters away — time to meet them.`;
      break;
    case 'order_delivered':
      pillEmoji = '🎉'; pillText = 'Delivered';
      hero = `Order <strong>${orderNum}</strong> delivered. Enjoy!`;
      lede = total
        ? `Total: <strong>${total}</strong>. Tap below to view your receipt or rate the order.`
        : `Tap below to view your receipt or rate the order.`;
      break;
    case 'new_dispatch':
      pillEmoji = '🛎'; pillText = 'New delivery offer';
      hero = `${distanceMi ?? '?'} mi away · ${earningsUsd ?? ''}`;
      lede = `Open the driver app to accept within 45 seconds.`;
      break;
    case 'low_stock':
      pillEmoji = '⚠️'; pillText = 'Low stock';
      hero = `<strong>${escapeHtml(String(vars.name ?? 'Item'))}</strong> is running low.`;
      lede = `${escapeHtml(String(vars.remaining ?? 0))} left · threshold ${escapeHtml(String(vars.threshold ?? 0))}. Restock to avoid disappointing customers.`;
      break;
    default:
      hero = escapeHtml(title);
      lede = escapeHtml(renderTemplate(template, vars));
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;background:#faf6f2;margin:0;padding:24px;color:#1a1a1a">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:20px;padding:0;box-shadow:0 4px 24px rgba(0,0,0,0.06);overflow:hidden">
    <div style="background:linear-gradient(135deg,#FF6B35,#F7B538);padding:28px 32px;color:#fff">
      <p style="margin:0;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;opacity:0.9">${headerName}</p>
      <h1 style="margin:8px 0 0;font-size:24px;font-weight:800;line-height:1.25">${escapeHtml(title)}</h1>
    </div>
    <div style="padding:32px">
      <p style="display:inline-block;margin:0 0 16px;padding:4px 12px;background:#FFF1E6;color:#C73E1D;border-radius:999px;font-size:12px;font-weight:600">
        ${pillEmoji} ${escapeHtml(pillText)}
      </p>
      <p style="margin:0 0 12px;font-size:18px;line-height:1.5;font-weight:600">${hero}</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#444">${lede}</p>
      <a href="${escapeHtml(url)}" style="display:inline-block;background:linear-gradient(135deg,#FF6B35,#F7B538);color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:700;font-size:15px;box-shadow:0 4px 12px rgba(255,107,53,0.3)">${ctaLabel} &rarr;</a>
      <hr style="margin:32px 0 16px;border:0;border-top:1px dashed #e5e7ec">
      <p style="margin:0;color:#888;font-size:12px;line-height:1.5">
        You&rsquo;re getting this because you opted in to order notifications.
        <br><a href="/account" style="color:#999">Manage email preferences</a>
        &middot; <a href="/privacy" style="color:#999">Privacy policy</a>
      </p>
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendSms(
  supabase: ReturnType<typeof createClient>,
  row: OutboxRow,
) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) throw new Error('twilio_not_configured');
  let phone: string | null = null;
  if (row.recipient_type === 'customer') {
    const { data } = await supabase.from('customers').select('phone').eq('id', row.recipient_id).maybeSingle();
    phone = data?.phone ?? null;
  } else if (row.recipient_type === 'driver') {
    const { data } = await supabase.from('drivers').select('phone').eq('id', row.recipient_id).maybeSingle();
    phone = data?.phone ?? null;
  }
  if (!phone) throw new Error('recipient_no_phone');

  const body = renderTemplate(row.template, row.variables);
  const auth = btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`);
  const form = new URLSearchParams({ From: TWILIO_FROM, To: phone, Body: body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
  );
  if (!res.ok) {
    throw new Error(`twilio_${res.status}:${(await res.text()).slice(0, 200)}`);
  }
}

async function sendPush(
  supabase: ReturnType<typeof createClient>,
  row: OutboxRow,
) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) throw new Error('vapid_not_configured');
  const { data: subs, error: subErr } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('recipient_type', row.recipient_type)
    .eq('recipient_id', row.recipient_id);
  if (subErr) throw new Error(`sub_lookup_${subErr.code ?? 'err'}`);
  if (!subs || subs.length === 0) throw new Error('no_subscriptions');

  // A diner's notifications speak as the storefront. Every branch of a restaurant on one host
  // shares one service worker, so a device has one push subscription for all of them, and the
  // customer row is shared by the restaurant's branches too: the platform's name and icon could
  // not say whether this update came from the Hamburger branch or the Food Thai Thai one. The title is the
  // storefront's name and the body says what happened (every order body already stands on its
  // own). Drivers and staff are not diners of a storefront: their titles are unchanged, and the
  // driver app's worker ignores the icon anyway.
  const storefront = row.recipient_type === 'customer' ? cleanName(row.variables.storefront_name) : null;
  const icon =
    row.recipient_type === 'customer' && typeof row.variables.storefront_icon === 'string'
      ? row.variables.storefront_icon
      : null;
  const orderId = typeof row.variables.order_id === 'string' ? row.variables.order_id : null;

  const payload = JSON.stringify({
    title: storefront ?? renderTitle(row.template, row.variables),
    body: storefront
      ? renderStorefrontPushBody(row.template, row.variables)
      : renderTemplate(row.template, row.variables),
    url: renderUrl(row.template, row.variables),
    ...(icon ? { icon } : {}),
    // One tag per template meant every dispatch offer carried the constant tag 'new_dispatch',
    // and a notification whose tag is already on the shade REPLACES it in silence — no sound,
    // no vibration, no banner. Offer #2 arrived invisibly while offer #1 was still showing, and
    // the rider lost the work. Give each offer its own tag.
    //
    // The same was true of orders: "Delivered" for an order from one branch silently replaced
    // "Delivered" for an order from another. Order notifications now collapse per ORDER — a
    // repeat about the same order still replaces its predecessor, and each status of one order
    // already has a tag of its own because the template differs.
    tag:
      row.template === 'new_dispatch' && typeof row.variables.delivery_id === 'string'
        ? `new_dispatch:${row.variables.delivery_id}`
        : orderId
          ? `${row.template}:${orderId}`
          : row.template,
  });

  let okCount = 0;
  let lastErr: string | null = null;
  for (const sub of subs as PushSub[]) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      okCount++;
    } catch (err) {
      const e = err as { statusCode?: number; body?: string; message?: string };
      lastErr = `${e.statusCode ?? ''}:${e.message ?? ''}`.slice(0, 200);
      if (e.statusCode === 404 || e.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      }
    }
  }
  if (okCount === 0) throw new Error(`all_failed:${lastErr ?? 'unknown'}`);
}

function renderTitle(template: string, vars: Record<string, unknown>) {
  const dict: Record<string, string> = {
    order_confirmed: 'Order confirmed',
    order_ready_pickup: 'Order ready for pickup',
    order_out_for_delivery: 'On the way',
    order_delivered: 'Delivered',
    driver_assigned: 'Driver assigned',
    order_arriving: 'Arriving now',
    new_dispatch: 'New delivery offer',
    new_message: (vars.sender as string) === 'driver' ? 'Message from your driver' : 'Message from the customer',
    delivery_failed_at_door: 'Delivery failed at the door',
    delivery_returned: 'Delivery cancelled after pickup',
    order_released: 'Scheduled order due',
    dispatch_failed: 'No driver found',
    low_stock: 'Low stock alert',
    promo: (vars.title as string) ?? 'New promotion',
  };
  return dict[template] ?? template;
}

/**
 * Adds what the rendered message needs and the queued row does not carry:
 *  - order_path: the order's page on its storefront (see dispatch()).
 *  - storefront_name / storefront_path / storefront_icon: the branch's identity.
 *
 * The identity comes from the row's branch_id column whenever it has one. `variables.order_id`
 * is whatever the enqueuer wrote, so it only lends the message a link when the order really
 * belongs to that same branch; an order from anywhere else is ignored for the name, the icon and
 * the links alike. Otherwise anyone able to queue a row for their own branch could send a push
 * dressed as another restaurant, just by naming one of its orders. Only a row with no branch_id
 * (a legacy trigger's) takes its branch from the order.
 *
 * A failed lookup never stops a notification: it goes out without the missing piece.
 */
async function enrichVars(
  supabase: ReturnType<typeof createClient>,
  row: OutboxRow,
  lookups: Lookups,
): Promise<Record<string, unknown>> {
  const vars: Record<string, unknown> = { ...(row.variables ?? {}) };
  for (const key of DERIVED_VARS) delete vars[key];

  const orderId = typeof vars.order_id === 'string' ? vars.order_id : null;
  const route = orderId
    ? await cached(lookups.orders, orderId, () => loadOrderRoute(supabase, orderId))
    : null;
  const orderRoute = route && (!row.branch_id || route.branchId === row.branch_id) ? route : null;
  const branchId = row.branch_id ?? orderRoute?.branchId ?? null;

  if (orderRoute?.path) vars.order_path = orderRoute.path;

  if (branchId) {
    const identity = await cached(lookups.branches, branchId, () => loadStorefrontIdentity(supabase, branchId));
    if (identity) {
      vars.storefront_name = identity.name;
      if (identity.path) vars.storefront_path = identity.path;
      if (identity.icon) vars.storefront_icon = identity.icon;
    }
  }
  return vars;
}

function cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let hit = map.get(key);
  if (!hit) {
    hit = load();
    map.set(key, hit);
  }
  return hit;
}

async function loadOrderRoute(
  supabase: ReturnType<typeof createClient>,
  orderId: string,
): Promise<OrderRoute | null> {
  try {
    const { data } = await supabase
      .from('orders')
      .select('order_number, branch_id, branches(slug, restaurants(slug))')
      .eq('id', orderId)
      .maybeSingle();
    const row = data as {
      order_number?: string;
      branch_id?: string | null;
      branches?: { slug?: string; restaurants?: { slug?: string } | { slug?: string }[] } | null;
    } | null;
    if (!row) return null;
    const branch = row.branches ?? null;
    const restaurant = Array.isArray(branch?.restaurants) ? branch?.restaurants[0] : branch?.restaurants;
    return {
      path: row.order_number && branch?.slug && restaurant?.slug
        ? `/r/${restaurant.slug}/${branch.slug}/orders/${row.order_number}`
        : null,
      branchId: row.branch_id ?? null,
    };
  } catch {
    // A failed lookup must never stop the notification going out — it just falls back
    // to the storefront's root, or the app root, rather than a deep link.
    return null;
  }
}

/**
 * The branch's storefront name and icon, resolved the way the storefront resolves them.
 *  - Name: the brand the branch is linked to, else the restaurant's default brand (the one-brand-
 *    per-restaurant invariant makes that THE brand), else the restaurant's own name.
 *  - Icon: the branch's own (192, else 512), else the linked brand's, else the default brand's.
 * Brands are only ever read within the branch's own restaurant. The database now refuses a
 * brand_id that points at another restaurant's brand, but a row linked before that rule would
 * otherwise still lend that restaurant's name and icon to this branch's messages.
 */
async function loadStorefrontIdentity(
  supabase: ReturnType<typeof createClient>,
  branchId: string,
): Promise<StorefrontIdentity | null> {
  try {
    const { data } = await supabase
      .from('branches')
      .select('name, slug, brand_id, icon_192_url, icon_512_url, restaurant_id, restaurants(name, slug)')
      .eq('id', branchId)
      .maybeSingle();
    const b = data as {
      name?: string | null;
      slug?: string | null;
      brand_id?: string | null;
      icon_192_url?: string | null;
      icon_512_url?: string | null;
      restaurant_id?: string | null;
      restaurants?: { name?: string | null; slug?: string | null } | { name?: string | null; slug?: string | null }[] | null;
    } | null;
    if (!b) return null;
    const restaurant = Array.isArray(b.restaurants) ? b.restaurants[0] : b.restaurants;

    let linked: BrandIdentityRow | null = null;
    if (b.brand_id && b.restaurant_id) {
      const { data: row } = await supabase
        .from('brands')
        .select('name, icon_192_url, icon_512_url')
        .eq('id', b.brand_id)
        .eq('restaurant_id', b.restaurant_id)
        .maybeSingle();
      linked = row as BrandIdentityRow | null;
    }

    let brandName = cleanName(linked?.name);
    let icon = appIcon(b) ?? appIcon(linked);
    if ((!brandName || !icon) && b.restaurant_id) {
      const { data: defaults } = await supabase
        .from('brands')
        .select('name, icon_192_url, icon_512_url')
        .eq('restaurant_id', b.restaurant_id)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1);
      const fallback = (defaults as BrandIdentityRow[] | null)?.[0] ?? null;
      brandName ??= cleanName(fallback?.name);
      icon ??= appIcon(fallback);
    }
    brandName ??= cleanName(restaurant?.name);

    const name = storefrontDisplayName(brandName, cleanName(b.name));
    if (!name) return null;
    return {
      name,
      path: restaurant?.slug && b.slug ? `/r/${restaurant.slug}/${b.slug}` : null,
      icon,
    };
  } catch {
    return null;
  }
}

/** A branch's or brand's installed-app icon: the 192px one, else the 512px one, https only. */
function appIcon(source: { icon_192_url?: string | null; icon_512_url?: string | null } | null): string | null {
  return httpsUrl(source?.icon_192_url) ?? httpsUrl(source?.icon_512_url);
}

function cleanName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * "<brand> - <branch>" with an ASCII hyphen, as the storefront names itself. One of the two
 * when they are the same (a single-branch restaurant often names its branch after itself) or
 * when one is missing.
 */
function storefrontDisplayName(brand: string | null, branch: string | null): string | null {
  if (!brand || !branch) return brand ?? branch;
  if (brand.toLocaleLowerCase() === branch.toLocaleLowerCase()) return brand;
  return `${brand} - ${branch}`;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** The storefront's name for a message, falling back to the branch name a trigger wrote. */
function storefrontLabel(vars: Record<string, unknown>): string | null {
  return cleanName(vars.storefront_name) ?? cleanName(vars.branch_name);
}

function renderUrl(template: string, vars: Record<string, unknown>) {
  // order_path is set by enrichVars(). When the order could not be resolved, the storefront's
  // own root keeps the diner inside the branch the message is about; '/' is the last resort,
  // and is at least a page that exists.
  const orderPath = typeof vars.order_path === 'string' ? vars.order_path : null;
  const storefrontPath = typeof vars.storefront_path === 'string' ? vars.storefront_path : null;
  const customerFallback = storefrontPath ?? '/';
  if (template.startsWith('order_')) return orderPath ?? customerFallback;
  if (template === 'driver_assigned') return orderPath ?? customerFallback;
  if (template === 'new_message') {
    return (vars.sender as string) === 'driver' ? (orderPath ?? customerFallback) : '/app/active';
  }
  // The driver app has no page at /app — only /app/home and its siblings — so the most
  // time-critical notification in the product opened a 404.
  if (template === 'new_dispatch') return '/app/home';
  if (template === 'promo' && vars.url) return vars.url as string;
  return '/';
}

function renderTemplate(template: string, vars: Record<string, unknown>) {
  // `?? 'New message'` only caught null, so an empty preview rendered as "Driver: " on a
  // lock screen. A photo sent without a caption already carries "📷 Photo" as its body, so
  // has_attachment is only the belt to that braces.
  const messagePreview =
    typeof vars.preview === 'string' && vars.preview.trim() !== ''
      ? vars.preview.trim()
      : vars.has_attachment === true
        ? '📷 Photo'
        : 'New message';
  const dict: Record<string, string> = {
    order_confirmed: `Order ${vars.order_number} confirmed. ETA ${vars.eta_minutes ?? 30} min.`,
    order_ready_pickup: `Order ${vars.order_number} is ready for pickup at ${storefrontLabel(vars) ?? 'the restaurant'}.`,
    order_out_for_delivery: `Order ${vars.order_number} is on the way!`,
    order_delivered: `Order ${vars.order_number} delivered. Enjoy!`,
    driver_assigned: `A driver has taken your order ${vars.order_number}${vars.eta_minutes ? ` — about ${vars.eta_minutes} min away` : ''}.`,
    order_arriving: `Your driver is arriving with order ${vars.order_number} — time to meet them!`,
    new_message: `${(vars.sender as string) === 'driver' ? 'Driver' : 'Customer'}: ${messagePreview}`,
    delivery_failed_at_door: `Delivery for order failed: ${vars.reason ?? 'unknown reason'}. Open Orders to resolve.`,
    delivery_returned: `Driver cancelled after pickup: ${vars.reason ?? 'unknown reason'}. The order needs attention.`,
    order_released: `Scheduled order ${vars.order_number} is due — start preparing.`,
    dispatch_failed: `No driver found for a delivery — open Orders to re-dispatch.`,
    new_dispatch: `New delivery offer: ${Number(vars.distance_km ?? 0).toFixed(1)} mi · $${Number(vars.earnings ?? 0).toFixed(2)}. Open the Driver app.`,
    low_stock: `Low stock: ${vars.name} — ${vars.remaining} left (threshold ${vars.threshold}).`,
    promo: (vars.body as string) ?? '',
  };
  return dict[template] ?? `${template}: ${JSON.stringify(vars).slice(0, 200)}`;
}

/**
 * The body of a diner's push when the title is the storefront's name. Every order template's
 * body already says what happened; a promotion's does not — its headline was the title — so it
 * leads the body instead of being lost.
 */
function renderStorefrontPushBody(template: string, vars: Record<string, unknown>) {
  if (template === 'promo') {
    const headline = cleanName(vars.title);
    const text = cleanName(vars.body);
    return headline && text ? `${headline}: ${text}` : (headline ?? text ?? '');
  }
  return renderTemplate(template, vars);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
