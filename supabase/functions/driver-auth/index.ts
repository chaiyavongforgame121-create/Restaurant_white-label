// driver-auth — OTP-less phone signup/login for drivers (no SMS, no cost).
//
// POST { phone }                    -> if a phone account exists: logs in (returns session)
//                                      else: { status: 'needs_profile' }
// POST { phone, profile: {...} }    -> creates the account (+ driver row) and returns a session
//
// How it stays free + sessionful without OTP:
//   • Each phone maps to a synthetic confirmed auth user  d{digits}@driver.favornoms.local
//   • Its password is DETERMINISTIC = HMAC-SHA256(phone, SERVICE_ROLE_KEY) — derived
//     server-side only, never sent to the client and never stored. So we can always
//     re-mint a session for a returning driver from just their phone.
//   • The session is minted by signing in with that password (anon key) and the tokens
//     are handed to the client, which calls supabase.auth.setSession(...).
//
// SECURITY NOTE (accepted trade-off): there is NO phone verification. Anyone who knows a
// driver's phone number can sign in as them. This is deliberate for a zero-SMS MVP; add a
// PIN or real OTP later if drivers handle money/PII. New drivers land as kyc_status='pending'
// and still need KYC + per-branch approval before they can receive dispatch.

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

async function derivePassword(phone: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('driver-auth:' + phone));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'Dp1!' + hex; // prefix guarantees length + character-class complexity
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  const body = await req.json().catch(() => ({}));
  const norm = normalizePhone(String(body?.phone ?? ''));
  if (!norm) return json(200, { status: 'invalid_phone' });

  const email = `d${norm.digits}@${EMAIL_DOMAIN}`;
  const password = await derivePassword(norm.e164, serviceKey);
  const authClient = createClient(url, anonKey, { auth: { persistSession: false } });

  // 1) Returning driver? A successful password sign-in means the phone account exists.
  const login = await authClient.auth.signInWithPassword({ email, password });
  if (login.data?.session) {
    return json(200, {
      status: 'login',
      access_token: login.data.session.access_token,
      refresh_token: login.data.session.refresh_token,
    });
  }

  // 2) New phone — need the profile to create the account.
  const profile = (body?.profile ?? {}) as {
    full_name?: string; vehicle_type?: string; vehicle_plate?: string; email?: string;
  };
  const fullName = (profile.full_name ?? '').trim();
  if (!fullName) return json(200, { status: 'needs_profile' });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // handle_new_user trigger reads these and inserts the drivers row (phone is UNIQUE).
    user_metadata: { signup_type: 'driver', phone: norm.e164, full_name: fullName },
  });
  if (created.error || !created.data?.user) {
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

  const session = await authClient.auth.signInWithPassword({ email, password });
  if (session.error || !session.data?.session) {
    return json(200, { status: 'error', error: 'session_failed', detail: session.error?.message });
  }
  return json(200, {
    status: 'signup',
    access_token: session.data.session.access_token,
    refresh_token: session.data.session.refresh_token,
  });
});
