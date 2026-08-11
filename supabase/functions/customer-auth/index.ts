// customer-auth — phone signup/login for diners (no SMS, no cost), now PASSWORD-based.
//
// POST { mode:'login',  phone, password, branch_id }              -> signInWithPassword
// POST { mode:'signup', phone, password, branch_id, full_name? }  -> createUser then sign in
//
// How it stays free + sessionful without OTP:
//   • Each phone maps to a synthetic confirmed auth user  c{digits}@customer.favornoms.local
//     — a domain distinct from the drivers' one so the two namespaces can never collide.
//   • The password is now CHOSEN BY THE DINER (min 8 chars) and stored by GoTrue like any
//     email/password account. We no longer derive it from the phone, so a returning diner
//     must present the same password they signed up with.
//   • The session is minted by signing in with that password (anon key) and the tokens
//     are handed to the client, which calls supabase.auth.setSession(...).
//
// SECURITY NOTE: a password is now required, so knowing a phone number is NO LONGER enough
// to sign in as a diner through this function. Two residuals remain, both accepted:
//   • There is still NO proof of phone ownership. Whoever registers a number FIRST (and
//     sets its password) squats it; a genuine later owner of that number cannot claim it.
//   • This function is defense-in-depth only. The raw /auth/v1/signup endpoint can still
//     mint a synthetic account and fire handle_new_user directly, so the DB-level
//     account-takeover guard in docs/AUTH-OTPLESS.sql is what actually protects the
//     customers row from a phone-squat re-point — keep it applied.
//
// Unlike driver-auth the name is optional, so a signup carries everything it needs in one
// request; there is no two-step 'needs_profile' stage.

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

const EMAIL_DOMAIN = 'customer.favornoms.local';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  // a contract violation, not a diner-facing outcome.
  const mode = body?.mode;
  if (mode !== 'login' && mode !== 'signup') return json(200, { status: 'error', error: 'mode_required' });

  const norm = normalizePhone(String(body?.phone ?? ''));
  if (!norm) return json(200, { status: 'invalid_phone' });

  // Password is the new credential. Check length BEFORE any auth call so a too-short
  // password can never reach createUser (whose own policy error we'd have to disambiguate).
  const password = String(body?.password ?? '');
  if (password.length < MIN_PASSWORD) return json(200, { status: 'weak_password' });

  const branchId = String(body?.branch_id ?? '');

  // Rate limiting: this endpoint is public (verify_jwt=false) and mints sessions, so it
  // is the natural target for phone-number enumeration and password-guessing. Reuses the
  // generic check_rate_limit RPC / rate_limits table introduced for place-order in v9.5.
  // Fail-open on RPC error — a rate-limit outage must never lock every diner out.
  // - per IP: 30 sign-ins / 10 min (a shared NAT at an office or mall stays under)
  // - per phone: 10 sign-ins / 10 min
  const clientIp = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  const rlChecks: Array<{ key: string; max: number }> = [
    { key: `custauth:ip:${clientIp}`, max: 30 },
    { key: `custauth:phone:${norm.digits}`, max: 10 },
  ];
  for (const rl of rlChecks) {
    const { data: verdict } = await admin.rpc('check_rate_limit', { p_bucket_key: rl.key, p_max_count: rl.max, p_window_seconds: 600 });
    if (verdict && (verdict as { allowed?: boolean }).allowed === false) {
      return json(429, { error: 'rate_limited', retry_after_seconds: 600 });
    }
  }

  // handle_new_user silently skips provisioning the customers row when branch_id is
  // missing or bogus, so reject it here rather than minting a session with no profile.
  if (!UUID_RE.test(branchId)) return json(200, { status: 'invalid_branch' });
  const { data: branch } = await admin.from('branches').select('id').eq('id', branchId).maybeSingle();
  if (!branch) return json(200, { status: 'invalid_branch' });

  const email = `c${norm.digits}@${EMAIL_DOMAIN}`;
  const authClient = createClient(url, anonKey, { auth: { persistSession: false } });

  // A returning diner may be signing in at a brand they have never ordered from. The
  // trigger only fires on account creation, so top up the customers row every time.
  // Non-fatal: a provisioning hiccup must never block the sign-in itself.
  const provision = async (accessToken: string) => {
    const userClient = createClient(url, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { error } = await userClient.rpc('provision_customer_for_branch', { p_branch_id: branchId });
    if (error) console.error('provision_customer_for_branch failed', error.message);
  };

  // LOGIN: the phone account must already exist and the password must match. We do not
  // distinguish "no such account" from "wrong password" — both return invalid_credentials
  // so this endpoint cannot be used to enumerate which phone numbers are registered.
  if (mode === 'login') {
    const login = await authClient.auth.signInWithPassword({ email, password });
    if (!login.data?.session) return json(200, { status: 'invalid_credentials' });
    await provision(login.data.session.access_token);
    return json(200, {
      status: 'login',
      access_token: login.data.session.access_token,
      refresh_token: login.data.session.refresh_token,
    });
  }

  // SIGNUP: create the account with the diner's chosen password. A phone that already has
  // an account cannot be re-registered — tell them to log in instead (account_exists),
  // rather than leaking whether the password they just typed happens to match.
  const fullName = String(body?.full_name ?? '').trim();
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // handle_new_user trigger reads these and inserts the customers row for this brand.
    user_metadata: {
      signup_type: 'customer',
      branch_id: branchId,
      phone: norm.e164,
      ...(fullName ? { full_name: fullName } : {}),
    },
  });
  if (created.error || !created.data?.user) {
    if (isAlreadyRegistered(created.error)) return json(200, { status: 'account_exists' });
    return json(200, { status: 'error', error: 'signup_failed', detail: created.error?.message });
  }

  // Mint the session by signing in with the freshly set password.
  const session = await authClient.auth.signInWithPassword({ email, password });
  if (!session.data?.session) {
    return json(200, { status: 'error', error: 'session_failed', detail: session.error?.message });
  }
  await provision(session.data.session.access_token);
  return json(200, {
    status: 'signup',
    access_token: session.data.session.access_token,
    refresh_token: session.data.session.refresh_token,
  });
});
