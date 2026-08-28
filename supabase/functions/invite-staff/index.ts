// Invite a staff member by email. Creates a `staff_members` row in 'pending' state, then
// takes one of two paths depending on whether that address already has an auth account:
//
//   new address       -> inviteUserByEmail. The mail lands on /auth/callback, which
//                        exchanges the code and hands off to /invite/accept, which links
//                        the row and asks them to choose a password.
//   existing account  -> linked here, server-side, and no mail is sent. They already have
//                        a way in; sending them anything would just be a second password.
//
// The response says which happened (`emailed`), because the admin UI has to word those two
// outcomes differently — see staff-view.tsx.
//
// RECOVERED 2026-08-28: this function was deployed (v1) but its source was never
// committed. Pulled back out of the live project so the repo is the source of truth
// again. Only change on recovery: the caller allow-list gains 'admin'.
//
// DEPLOY ORDER (2026-08-29): the redirect now points at /auth/callback, which only exists
// in apps/admin from this batch onwards. Deploy this function AFTER the admin app carrying
// that route is live, or invitations will land on a 404.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Deliberately NOT defaulted to localhost. It was, and a project that never set the secret
// mailed real staff an invitation pointing at http://localhost:3004 — a link that can only
// work on the machine of whoever happened to click it. Falling back to localhost is only
// safe when Supabase itself is local; anywhere else an unset secret is a configuration
// error and is reported as one rather than papered over with a dead link.
const IS_LOCAL_STACK = /localhost|127\.0\.0\.1/.test(SUPABASE_URL);
const PUBLIC_ADMIN_URL =
  Deno.env.get('PUBLIC_ADMIN_URL')?.replace(/\/$/, '') ??
  (IS_LOCAL_STACK ? 'http://localhost:3004' : '');

/** Every role except `owner`, which is only ever created by restaurant onboarding.
 *  Kept as a runtime list so a forged payload cannot mint an owner. */
const ASSIGNABLE_ROLES = ['admin', 'manager', 'cashier', 'server', 'kitchen', 'driver', 'staff'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** Who may invite. Owner and admin only: handing out access is the one thing a
 *  day-to-day manager should not be able to do, and the owner asked for staff
 *  management to sit above Manager. */
const INVITER_ROLES = ['owner', 'admin'] as const;

interface Body {
  email: string;
  role: AssignableRole;
  restaurant_id: string;
  branch_id?: string | null;
  permissions?: string[];
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });

  if (!PUBLIC_ADMIN_URL) {
    return json(
      {
        error: 'admin_url_not_configured',
        detail:
          'Set the PUBLIC_ADMIN_URL secret on this project to the merchant app origin ' +
          '(e.g. https://restaurant-white-label-admin.vercel.app). Without it an invitation ' +
          'link points nowhere the invitee can reach.',
      },
      500,
    );
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) {
    return json({ error: 'unauthorized' }, 401);
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.email || !body?.role || !body?.restaurant_id) {
    return json({ error: 'bad_request', missing: ['email', 'role', 'restaurant_id'] }, 400);
  }
  // Validated here as well as by the enum: a bad value would otherwise surface as a
  // Postgres cast error 500 rather than a clean 400 naming the problem.
  if (!ASSIGNABLE_ROLES.includes(body.role)) {
    return json({ error: 'invalid_role', allowed: ASSIGNABLE_ROLES }, 400);
  }

  // Admin client for privileged actions
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: callerStaff } = await admin
    .from('staff_members')
    .select('role, restaurant_id')
    .eq('user_id', userData.user.id)
    .eq('restaurant_id', body.restaurant_id)
    .eq('status', 'active')
    .in('role', [...INVITER_ROLES])
    .maybeSingle();

  if (!callerStaff) {
    return json({ error: 'forbidden', reason: 'must be owner or admin' }, 403);
  }

  // Only an owner may mint another admin — otherwise an admin could clone their own
  // level of access and the owner-only boundary stops meaning anything.
  if (body.role === 'admin' && callerStaff.role !== 'owner') {
    return json({ error: 'forbidden', reason: 'only the owner can add an admin' }, 403);
  }

  // Idempotent: re-use existing pending row for same (restaurant, email)
  const existing = await admin
    .from('staff_members')
    .select('id, status')
    .eq('restaurant_id', body.restaurant_id)
    .eq('invited_email', body.email.toLowerCase())
    .maybeSingle();

  let staffId: string;
  if (existing.data?.id) {
    staffId = existing.data.id;
    if (existing.data.status === 'active') {
      return json({ error: 'already_active', staff_id: staffId }, 409);
    }
  } else {
    const insert = await admin
      .from('staff_members')
      .insert({
        restaurant_id: body.restaurant_id,
        branch_id: body.branch_id ?? null,
        invited_email: body.email.toLowerCase(),
        role: body.role,
        status: 'pending',
        permissions: body.permissions ?? [],
      })
      .select('id')
      .single();
    if (insert.error || !insert.data) {
      return json({ error: 'insert_failed', detail: insert.error?.message }, 500);
    }
    staffId = insert.data.id;
  }

  // Send the magic link.
  //
  // Via /auth/callback, not straight to /invite/accept: the invitation comes back as a PKCE
  // `?code=` and only that route can trade it for a session. Pointed at the page directly
  // (as it was) the invitee landed on "Sign in required" with the code unspent, which made
  // every staff invitation a dead end.
  const acceptPath = `/invite/accept?staff_id=${staffId}`;
  const redirectTo = `${PUBLIC_ADMIN_URL}/auth/callback?next=${encodeURIComponent(acceptPath)}`;
  const invite = await admin.auth.admin.inviteUserByEmail(body.email, {
    redirectTo,
    data: { signup_type: 'staff', staff_id: staffId },
  });
  if (!invite.error) {
    return json({ ok: true, staff_id: staffId, emailed: true, redirect_to: redirectTo });
  }

  // inviteUserByEmail refuses an address that already has an auth account. The old fallback
  // called generateLink() here and then returned ok:true — but generateLink only MINTS a
  // link, it never sends one, and nothing in this function sends it either. So inviting
  // anyone who already had an account reported success and delivered no email at all, and
  // the owner was left waiting for something that was never going to arrive.
  //
  // These people do not need an email: they already have a way in. generateLink doubles as
  // the lookup (it errors for an unknown address, and returns the user when it succeeds),
  // so link the staff row here and they can sign in with the credentials they already have.
  // Same three columns acceptStaffInvite writes, so both paths land in the same state.
  const existingAuthUser = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: body.email,
    options: { redirectTo },
  });
  const existingUserId = existingAuthUser.data?.user?.id;
  if (!existingUserId) {
    return json({ error: 'email_failed', detail: invite.error.message }, 500);
  }

  const linked = await admin
    .from('staff_members')
    .update({
      user_id: existingUserId,
      accepted_at: new Date().toISOString(),
      status: 'active',
    })
    .eq('id', staffId)
    .select('id')
    .single();
  if (linked.error) {
    return json({ error: 'link_failed', detail: linked.error.message }, 500);
  }

  return json({
    ok: true,
    staff_id: staffId,
    emailed: false,
    already_registered: true,
    redirect_to: redirectTo,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
