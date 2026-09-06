// driver-auth — phone signup/login for drivers (no SMS, no cost), now PASSWORD-based.
//
// POST { mode:'login',  phone, password }                        -> signInWithPassword
// POST { mode:'signup', phone, password, profile:{ full_name, vehicle_type?, vehicle_plate?, email? } }
//                                                                -> createUser (+ enrich drivers row) then sign in
//
// How it stays free + sessionful without OTP:
//   • Each phone maps to a synthetic confirmed auth user  d{digits}@driver.favornoms.local
//   • The password is now CHOSEN BY THE DRIVER (min 8 chars) and stored by GoTrue like any
//     email/password account. We no longer derive it from the phone, so a returning driver
//     must present the same password they signed up with.
//   • The session is minted by signing in with that password (anon key) and the tokens
//     are handed to the client, which calls supabase.auth.setSession(...).
//
// SECURITY NOTE: a password is now required, so knowing a phone number is NO LONGER enough
// to sign in as a driver through this function. Two residuals remain, both accepted:
//   • There is still NO proof of phone ownership. Whoever registers a number FIRST (and
//     sets its password) squats it. New drivers still land as kyc_status='pending' and need
//     KYC + per-branch approval before dispatch, so a squat cannot receive work.
//   • This function is defense-in-depth only. The raw /auth/v1/signup endpoint can still
//     mint a synthetic account and fire handle_new_user directly, so the DB-level
//     account-takeover guard in docs/AUTH-OTPLESS.sql (drivers has a plain UNIQUE(phone),
//     so its ON CONFLICT always fires) is what actually protects the drivers row — keep it.
//
// BILLING: deliberately NOT entitlement-gated (owner decision, 2026-07-25). A driver
// is platform-scoped, not tenant-scoped — they have no restaurant_id at login time and
// may work for several branches. Locking a driver out because one of those branches
// lapsed would strand them mid-shift. The delivery gate lives in dispatch-driver.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const EMAIL_DOMAIN = 'driver.favornoms.local';
const MIN_PASSWORD = 8;

// Phone is only an identifier here (no SMS), so we just need a stable normalization.
// US-first (mirrors the client), but any input reduces to a consistent digits string.
function normalizePhone(raw: string): { digits: string; e164: string } | null {
  const t = (raw ?? '').trim();
  let digits = t.replace(/\D/g, '');
  if (!digits) return null;
  if (!t.startsWith('+')) {
    if (digits.length === 10) digits = '1' + digits;          // bare US 10-digit
    // (11-digit starting with 1, or already-intl, kept as typed)
  }
  return { digits, e164: '+' + digits };
}

// admin.createUser fails with an "already registered" error when the synthetic email is
// taken. GoTrue spells this as code 'email_exists' (newer) or a message that mentions the
// address is already registered (older); match both, and treat anything else as a real error.
function isAlreadyRegistered(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === 'email_exists') return true;
  return /already.*regist/i.test(err.message ?? '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const body = await req.json().catch(() => ({}));

  // Mode is explicit so login vs register is never inferred from account existence (which
  // is what leaked enumeration before). The client lane always sends it; anything else is
  // a contract violation, not a driver-facing outcome.
  const mode = body?.mode;
  if (mode !== 'login' && mode !== 'signup') return json(200, { status: 'error', error: 'mode_required' });

  const norm = normalizePhone(String(body?.phone ?? ''));
  if (!norm) return json(200, { status: 'invalid_phone' });

  // Password is the new credential. Check length BEFORE any auth call so a too-short
  // password can never reach createUser (whose own policy error we'd have to disambiguate).
  const password = String(body?.password ?? '');
  if (password.length < MIN_PASSWORD) return json(200, { status: 'weak_password' });

  // Rate limiting: this endpoint is public (verify_jwt=false) and mints sessions, so it is
  // the natural target for phone-number enumeration and password-guessing — more so than the
  // diner side, because a rider's synthetic address is fully derivable from a phone number
  // and a rider session can accept dispatch offers, read customer addresses and phone
  // numbers, and file payout requests. Same generic check_rate_limit RPC / rate_limits table
  // customer-auth uses, and the same two buckets:
  // - per IP: 30 sign-ins / 10 min (a shared NAT at a rider hub stays under)
  // - per phone: 10 sign-ins / 10 min
  // Fail-open on RPC error — a rate-limit outage must never strand a rider mid-shift.
  const clientIp = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  const rlChecks: Array<{ key: string; max: number }> = [
    { key: `drvauth:ip:${clientIp}`, max: 30 },
    { key: `drvauth:phone:${norm.digits}`, max: 10 },
  ];
  for (const rl of rlChecks) {
    const { data: verdict } = await admin.rpc('check_rate_limit', { p_bucket_key: rl.key, p_max_count: rl.max, p_window_seconds: 600 });
    if (verdict && (verdict as { allowed?: boolean }).allowed === false) {
      return json(429, { error: 'rate_limited', retry_after_seconds: 600 });
    }
  }

  const email = `d${norm.digits}@${EMAIL_DOMAIN}`;
  const authClient = createClient(url, anonKey, { auth: { persistSession: false } });

  // LOGIN: the phone account must already exist and the password must match. We do not
  // distinguish "no such account" from "wrong password" — both return invalid_credentials
  // so this endpoint cannot be used to enumerate which phone numbers are registered.
  if (mode === 'login') {
    const login = await authClient.auth.signInWithPassword({ email, password });
    if (!login.data?.session) return json(200, { status: 'invalid_credentials' });
    return json(200, {
      status: 'login',
      access_token: login.data.session.access_token,
      refresh_token: login.data.session.refresh_token,
    });
  }

  // SIGNUP: the register form now submits phone + password + profile in one call. A name is
  // required to create the drivers row; without it this is an incomplete form, not an
  // account, so surface needs_profile (matches the original two-step guard's validation).
  const profile = (body?.profile ?? {}) as {
    full_name?: string; vehicle_type?: string; vehicle_plate?: string; email?: string;
  };
  const fullName = (profile.full_name ?? '').trim();
  if (!fullName) return json(200, { status: 'needs_profile' });

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // handle_new_user trigger reads these and inserts the drivers row (phone is UNIQUE).
    user_metadata: { signup_type: 'driver', phone: norm.e164, full_name: fullName },
  });
  if (created.error || !created.data?.user) {
    // A phone that already has an account cannot be re-registered — tell them to log in
    // instead, rather than leaking whether the password they typed happens to match.
    if (isAlreadyRegistered(created.error)) return json(200, { status: 'account_exists' });
    return json(200, { status: 'error', error: 'signup_failed', detail: created.error?.message });
  }

  // Enrich the trigger-created row with the chosen profile fields.
  const vehicleType = (profile.vehicle_type ?? '').trim() || 'motorcycle';
  await admin
    .from('drivers')
    .update({
      full_name: fullName,
      vehicle_type: vehicleType,
      vehicle_plate: (profile.vehicle_plate ?? '').trim() || null,
      email: (profile.email ?? '').trim() || null,
    })
    .eq('user_id', created.data.user.id);

  // Mint the session by signing in with the freshly set password.
  const session = await authClient.auth.signInWithPassword({ email, password });
  if (!session.data?.session) {
    return json(200, { status: 'error', error: 'session_failed', detail: session.error?.message });
  }
  return json(200, {
    status: 'signup',
    access_token: session.data.session.access_token,
    refresh_token: session.data.session.refresh_token,
  });
});
