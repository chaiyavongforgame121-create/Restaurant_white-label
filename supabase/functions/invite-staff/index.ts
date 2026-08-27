// Invite a staff member by email.
// Creates a `staff_members` row in 'pending' state, then sends a Supabase
// magic-link invitation. When the invitee clicks the link, the admin app
// `/invite/accept` page links the auth user to the row.
//
// RECOVERED 2026-08-28: this function was deployed (v1) but its source was never
// committed. Pulled back out of the live project so the repo is the source of truth
// again. Only change on recovery: the caller allow-list gains 'admin'.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUBLIC_ADMIN_URL = Deno.env.get('PUBLIC_ADMIN_URL') ?? 'http://localhost:3004';

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

  // Send the magic link
  const redirectTo = `${PUBLIC_ADMIN_URL}/invite/accept?staff_id=${staffId}`;
  const invite = await admin.auth.admin.inviteUserByEmail(body.email, {
    redirectTo,
    data: { signup_type: 'staff', staff_id: staffId },
  });
  if (invite.error) {
    // If user already exists, fall back to magic link sign-in
    const link = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: body.email,
      options: { redirectTo },
    });
    if (link.error) {
      return json({ error: 'email_failed', detail: link.error.message }, 500);
    }
  }

  return json({ ok: true, staff_id: staffId, redirect_to: redirectTo });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
