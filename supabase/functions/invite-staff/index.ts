// Invite a staff member. Creates a `staff_members` row in 'pending' state, then delivers it one
// of two ways, chosen by the caller:
//
//   delivery 'link'   -> nothing is sent. The response carries `accept_url`, which the owner copies
//                        or shares over LINE. The invitee opens it and signs in as the invited
//                        address (Google, or an existing email/password account), and
//                        accept_staff_invite checks the confirmed email matches before joining.
//                        The link is not a credential: the staff id alone lets nobody in. This is
//                        the default in the back office, because Supabase's built-in mailer sends
//                        about two emails an hour and only to the project's own team.
//
//   delivery 'email'  -> the original flow below, which takes one of two paths depending on
//                        whether that address already has an auth account. Also the default when
//                        a caller sends no `delivery`, so an older back office keeps working.
//
//   new address       -> inviteUserByEmail. The mail lands on /auth/callback, which
//                        exchanges the code and hands off to /invite/accept, which links
//                        the row and asks them to choose a password.
//   existing account  -> no mail, and the row stays PENDING: the response carries accept_url
//                        (already_registered: true) for the owner to send, and the person joins
//                        by pressing Join on it, or is taken there by my_pending_staff_invite the
//                        next time they sign in. This used to make the row active on the spot,
//                        which let any restaurant owner (a free trial is one Google click away)
//                        put an existing user on their team, as admin even, without asking them.
//
// The response says which happened (`emailed`), because the admin UI has to word those two
// outcomes differently — see staff-view.tsx.
//
// BRANCHES (2026-09-18): every branch is its own team. The branch must belong to the restaurant
// in the request (400 branch_not_in_restaurant; this closed a cross-tenant takeover), an admin
// of one branch invites into that branch only, and invitations are de-duplicated per
// (restaurant, email, branch), so an employee of one branch can be invited to another.
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

// This is called straight from the browser (staff-view.tsx -> queries/staff.ts inviteStaff)
// cross-origin to <ref>.supabase.co with a JSON content type, which makes the request
// preflighted. Without an OPTIONS branch the preflight got a bare 405 with no
// Access-Control-* headers, so the browser blocked the POST before it was ever sent and the
// owner saw a raw "Failed to fetch" — no staff row, no email, no second user on the account.
// Every other browser-facing function in this project carries the same block.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which of several rows for one address and branch the invitation acts on: the live one. */
const STATUS_RANK: Record<string, number> = { active: 0, suspended: 1, pending: 2, removed: 3 };

interface Body {
  email: string;
  role: AssignableRole;
  restaurant_id: string;
  branch_id?: string | null;
  permissions?: string[];
  delivery?: 'link' | 'email';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

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
  // One spelling of the address for the lookup, the row and the email.
  const email = String(body.email).trim().toLowerCase();
  if (!email.includes('@')) {
    return json({ error: 'bad_request', missing: ['email'] }, 400);
  }

  // Admin client for privileged actions
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Every row the caller holds here, not maybeSingle(): someone with an owner row and a branch
  // row (or admin rows at two branches) made maybeSingle() error, which read as "not allowed".
  const [{ data: callerRows }, { data: restaurant }] = await Promise.all([
    admin
      .from('staff_members')
      .select('role, branch_id')
      .eq('user_id', userData.user.id)
      .eq('restaurant_id', body.restaurant_id)
      .eq('status', 'active')
      .in('role', [...INVITER_ROLES]),
    admin.from('restaurants').select('owner_user_id').eq('id', body.restaurant_id).maybeSingle(),
  ]);
  const inviterRows = callerRows ?? [];
  // restaurants.owner_user_id is the owner even without an owner row, as everywhere else.
  const callerIsOwner =
    inviterRows.some((r) => r.role === 'owner') || restaurant?.owner_user_id === userData.user.id;
  if (!callerIsOwner && inviterRows.length === 0) {
    return json({ error: 'forbidden', reason: 'must be owner or admin' }, 403);
  }
  // An owner, or an admin of every branch (branch_id null), invites anywhere in the restaurant.
  const callerRestaurantWide = callerIsOwner || inviterRows.some((r) => r.branch_id === null);

  // Only an owner may mint another admin — otherwise an admin could clone their own
  // level of access and the owner-only boundary stops meaning anything.
  if (body.role === 'admin' && !callerIsOwner) {
    return json({ error: 'forbidden', reason: 'only the owner can add an admin' }, 403);
  }

  // The branch must belong to the restaurant named in the same request. Nothing checked this, and
  // being owner or admin of your own restaurant was enough to write a staff row pointing at any
  // other restaurant's branch: a cross-tenant takeover. The database now refuses such a row too
  // (staff_members_branch_in_restaurant_fkey); this answers with a clear 400 first.
  const branchId = body.branch_id ?? null;
  if (branchId !== null) {
    const branch = UUID_RE.test(branchId)
      ? await admin
          .from('branches')
          .select('id')
          .eq('id', branchId)
          .eq('restaurant_id', body.restaurant_id)
          .maybeSingle()
      : { data: null };
    if (!branch.data) {
      return json({ error: 'branch_not_in_restaurant' }, 400);
    }
  }

  // An admin of one branch hands out access to that branch only: not to another branch, and not
  // to every branch at once.
  if (!callerRestaurantWide) {
    const ownBranches = new Set(inviterRows.map((r) => r.branch_id).filter((id): id is string => !!id));
    if (branchId === null || !ownBranches.has(branchId)) {
      return json({ error: 'forbidden', reason: 'branch_scoped_inviter' }, 403);
    }
  }

  // One invitation per (restaurant, email, branch). It was one per (restaurant, email), so a
  // cashier of the first branch could never be invited to the second: they were "already active".
  const { data: existingRows, error: existingErr } = await admin
    .from('staff_members')
    .select('id, status, role, user_id, branch_id')
    .eq('restaurant_id', body.restaurant_id)
    .eq('invited_email', email);
  if (existingErr) {
    return json({ error: 'lookup_failed', detail: existingErr.message }, 500);
  }
  const rows = existingRows ?? [];
  // Already working everywhere (an owner, or an active row for every branch): nothing to add.
  const everywhere = rows.find(
    (r) => r.status === 'active' && (r.role === 'owner' || r.branch_id === null),
  );
  if (everywhere) {
    return json({ error: 'already_active', staff_id: everywhere.id }, 409);
  }
  // The live row for this branch wins over a removed one, should both exist for the address.
  // Rows with an account always carry its address (migration 20260918190000 backfilled the ones
  // that did not and fills it on insert), so a removed team member is found here and revived
  // below instead of getting a second row that uniq_staff_user_branch refuses on accept.
  const existing = rows
    .filter((r) => (r.branch_id ?? null) === branchId)
    .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9))[0];

  let staffId: string;
  if (existing) {
    staffId = existing.id;
    if (existing.status === 'active') {
      return json({ error: 'already_active', staff_id: staffId }, 409);
    }
    // Suspended here: bringing them back is Reactivate on the Staff page, not a new invitation.
    if (existing.status === 'suspended') {
      return json({ error: 'already_suspended', staff_id: staffId }, 409);
    }
    // Inviting the same address again is how an owner corrects a mistake (Cashier -> Manager).
    // The row used to be reused as it was, so the email went out, the modal said "Invitation
    // sent", and the person joined with the old role. The newest invitation wins.
    if (existing.status === 'pending' && !existing.user_id) {
      if (existing.role === 'admin' && !callerIsOwner) {
        return json({ error: 'forbidden', reason: 'only the owner can change an admin invitation' }, 403);
      }
      const updated = await admin
        .from('staff_members')
        .update({
          role: body.role,
          permissions: body.permissions ?? [],
        })
        .eq('id', staffId)
        .eq('status', 'pending')
        .is('user_id', null)
        .select('id')
        .single();
      if (updated.error) {
        return json({ error: 'update_failed', detail: updated.error.message }, 500);
      }
    }
    // Removed from this branch earlier (set_staff_status): a removed row is final, so inviting the
    // person again turns it back into an open invitation. A second row for the same account and
    // branch would be refused by uniq_staff_user_branch the moment they accepted.
    if (existing.status === 'removed') {
      if (existing.role === 'admin' && !callerIsOwner) {
        return json({ error: 'forbidden', reason: 'only the owner can change an admin invitation' }, 403);
      }
      const revived = await admin
        .from('staff_members')
        .update({
          role: body.role,
          permissions: body.permissions ?? [],
          status: 'pending',
          user_id: null,
          accepted_at: null,
          invited_at: new Date().toISOString(),
        })
        .eq('id', staffId)
        .eq('status', 'removed')
        .select('id')
        .single();
      if (revived.error) {
        return json({ error: 'update_failed', detail: revived.error.message }, 500);
      }
    }
  } else {
    const insert = await admin
      .from('staff_members')
      .insert({
        restaurant_id: body.restaurant_id,
        branch_id: branchId,
        invited_email: email,
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

  // Opened straight on the accept page; openExternalBrowser=1 makes LINE hand it to the phone's
  // browser, because Google refuses to sign anyone in inside LINE's in-app browser.
  const acceptUrl = `${PUBLIC_ADMIN_URL}/invite/accept?staff_id=${staffId}&openExternalBrowser=1`;

  if (body.delivery === 'link') {
    // Nothing is linked server-side here either, even for an address that already has an account:
    // the person joins by opening the link (or is sent to it by my_pending_staff_invite when they
    // next sign in), so nobody lands on a team without saying yes.
    return json({ ok: true, staff_id: staffId, emailed: false, delivery: 'link', accept_url: acceptUrl });
  }

  // Send the magic link.
  //
  // Via /auth/callback, not straight to /invite/accept: the invitation comes back as a PKCE
  // `?code=` and only that route can trade it for a session. Pointed at the page directly
  // (as it was) the invitee landed on "Sign in required" with the code unspent, which made
  // every staff invitation a dead end.
  const acceptPath = `/invite/accept?staff_id=${staffId}`;
  const redirectTo = `${PUBLIC_ADMIN_URL}/auth/callback?next=${encodeURIComponent(acceptPath)}`;
  const invite = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { signup_type: 'staff', staff_id: staffId },
  });
  if (!invite.error) {
    return json({ ok: true, staff_id: staffId, emailed: true, delivery: 'email', redirect_to: redirectTo, accept_url: acceptUrl });
  }

  // Supabase's built-in mailer allows a couple of emails an hour. Say so, instead of treating a
  // refused send as "this person already has an account" and linking them with no email at all.
  if (invite.error.status === 429 || invite.error.code === 'over_email_send_rate_limit') {
    return json({ error: 'rate_limited', detail: invite.error.message }, 429);
  }
  const alreadyRegistered =
    invite.error.code === 'email_exists' || /already (been )?registered/i.test(invite.error.message);
  if (!alreadyRegistered) {
    return json({ error: 'email_failed', detail: invite.error.message }, 500);
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
    email,
    options: { redirectTo },
  });
  const existingUser = existingAuthUser.data?.user;
  const existingUserId = existingUser?.id;
  if (!existingUserId) {
    return json({ error: 'email_failed', detail: invite.error.message }, 500);
  }

  // Someone who can already sign in needs no email: an account they created themselves (no
  // invited_at), an invited one that has chosen a password, or one with a Google (any non-email)
  // identity. Someone who cannot (an earlier invitation opened once, by the person or a mail
  // scanner, confirms the address and inviteUserByEmail then refuses it) is sent a link to set a
  // password. Either way the row stays pending until they press Join.
  const canSignIn =
    !existingUser?.invited_at ||
    existingUser?.user_metadata?.password_set === true ||
    (existingUser?.identities ?? []).some((identity) => identity.provider !== 'email');
  if (!canSignIn) {
    const recovery = await admin.auth.resetPasswordForEmail(email, { redirectTo });
    if (recovery.error) {
      if (recovery.error.status === 429) {
        return json({ error: 'rate_limited', detail: recovery.error.message }, 429);
      }
      return json({ error: 'email_failed', detail: recovery.error.message }, 500);
    }
    return json({ ok: true, staff_id: staffId, emailed: true, delivery: 'email', redirect_to: redirectTo, accept_url: acceptUrl });
  }

  return json({
    ok: true,
    staff_id: staffId,
    emailed: false,
    delivery: 'email',
    already_registered: true,
    redirect_to: redirectTo,
    accept_url: acceptUrl,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
