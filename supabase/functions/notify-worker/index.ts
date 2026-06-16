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
  channel: string;
  recipient_type: string;
  recipient_id: string;
  template: string;
  variables: Record<string, unknown>;
  attempts: number;
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
    .select('id, channel, recipient_type, recipient_id, template, variables, attempts')
    .in('status', ['pending', 'failed'])
    .lte('scheduled_for', new Date().toISOString())
    .lt('attempts', MAX_ATTEMPTS)
    .order('scheduled_for', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) return json({ error: error.message }, 500);

  const results = await Promise.all(
    (rows ?? []).map(async (row: OutboxRow) => {
      try {
        await dispatch(supabase, row);
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
) {
  switch (row.channel) {
    case 'in_app':
      return;
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
  const branchName = escapeHtml(String(vars.branch_name ?? 'your restaurant'));
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
      <p style="margin:0;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;opacity:0.9">Favornoms · ${branchName}</p>
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

  const payload = JSON.stringify({
    title: renderTitle(row.template, row.variables),
    body: renderTemplate(row.template, row.variables),
    url: renderUrl(row.template, row.variables),
    tag: row.template,
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

function renderUrl(template: string, vars: Record<string, unknown>) {
  if (template.startsWith('order_') && vars.order_id) return `/orders/${vars.order_id}`;
  if (template === 'driver_assigned' && vars.order_id) return `/orders/${vars.order_id}`;
  if (template === 'new_message') {
    return (vars.sender as string) === 'driver' && vars.order_id ? `/orders/${vars.order_id}` : '/app/active';
  }
  if (template === 'new_dispatch') return '/app';
  if (template === 'promo' && vars.url) return vars.url as string;
  return '/';
}

function renderTemplate(template: string, vars: Record<string, unknown>) {
  const dict: Record<string, string> = {
    order_confirmed: `Order ${vars.order_number} confirmed. ETA ${vars.eta_minutes ?? 30} min.`,
    order_ready_pickup: `Order ${vars.order_number} is ready for pickup at ${vars.branch_name}.`,
    order_out_for_delivery: `Order ${vars.order_number} is on the way!`,
    order_delivered: `Order ${vars.order_number} delivered. Enjoy!`,
    driver_assigned: `A driver has taken your order ${vars.order_number}${vars.eta_minutes ? ` — about ${vars.eta_minutes} min away` : ''}.`,
    order_arriving: `Your driver is arriving with order ${vars.order_number} — time to meet them!`,
    new_message: `${(vars.sender as string) === 'driver' ? 'Driver' : 'Customer'}: ${vars.preview ?? 'New message'}`,
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
