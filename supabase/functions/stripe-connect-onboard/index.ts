// Stripe Connect onboarding for a branch (admin -> Branch settings -> Card payments).
//
// POST { branch_id, action, source_branch_id? } with the caller's JWT.
//
//   start       Creates the branch's connected account if it has none, with Accounts v2 (full
//               Stripe Dashboard, Stripe collects the fees and carries the losses, card_payments
//               requested, US, metadata {branch_id, restaurant_id}), and returns a Stripe-hosted
//               onboarding link from Account Links v2: { url, expires_at, state }. Also what
//               "Continue setup" and the ?stripe=refresh return call, since a link is single-use
//               and short-lived.
//   refresh     Re-reads the account from Stripe and stores its state on every branch paid into
//               it: { connected, state }. Called on the ?stripe=return return, because coming back
//               from Stripe's form does not mean the form was finished.
//   share       Pays this branch into the account another branch of the SAME restaurant already
//               uses (source_branch_id), so an owner with one bank onboards once: { state }.
//   dashboard   Where the account is managed: { url }. Every account made here has the full
//               Stripe Dashboard, which the restaurant signs in to itself, so the answer is that
//               account's page on dashboard.stripe.com (login links exist only for Express).
//   disconnect  Stops paying this branch into its account. The Stripe account itself is never
//               deleted: it is the restaurant's, with its balance, payouts and history.
//
// Every Stripe call is made through ../_shared/stripe-connect.ts, which also says why the account's
// state is read through GET /v1/accounts/{id} while it is created and onboarded through API v2.
//
// WHO MAY CALL. billing.manage (the owner, and platform admins) for start, share and disconnect,
// and branch.settings (owner and admin) for refresh and dashboard. Connecting is choosing where the
// branch's card money is paid, and an onboarding link is where the bank account is entered: given
// to an admin, it is the same diversion the account id was moved out of branches.settings to
// prevent. Reading the state back is harmless, and branch.settings is who can see the card at all
// (the RLS read of branch_payment_accounts).
//
// Secrets: STRIPE_SECRET_KEY (absent -> 503 stripe_not_configured, which the admin card shows as
// "not switched on yet"), PUBLIC_ADMIN_URL (the admin origin Stripe returns the owner to; the same
// secret invite-staff uses; it must be HTTPS, because Account Links v2 refuse any other return
// URL, in test mode too), optional STRIPE_CONNECT_RETURN_ORIGINS (more HTTPS admin origins, comma
// separated). A request Origin is honoured only when it is one of those, or an HTTPS localhost dev
// server while the key is a test key; Stripe never sends anyone to an origin the request made up.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  type AccountState,
  createConnectedAccount,
  createOnboardingLink,
  isUuid,
  onboardingUrls,
  readAccountState,
  resolveAdminOrigin,
  stripeDashboardUrl,
  stripeKeyMode,
} from '../_shared/stripe-connect.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
const IS_LOCAL_STACK = /localhost|127\.0\.0\.1/.test(SUPABASE_URL);
// The local default is the admin dev server over HTTPS (`next dev --experimental-https`), since
// Stripe will not accept an http return URL even for a test account.
const PUBLIC_ADMIN_URL =
  Deno.env.get('PUBLIC_ADMIN_URL')?.replace(/\/$/, '') ?? (IS_LOCAL_STACK ? 'https://localhost:3004' : '');
const EXTRA_RETURN_ORIGINS = Deno.env.get('STRIPE_CONNECT_RETURN_ORIGINS') ?? '';

const ACTIONS = ['start', 'refresh', 'share', 'dashboard', 'disconnect'] as const;
type Action = (typeof ACTIONS)[number];

/** The capability each action needs at the branch. See the header for why. */
const NEEDS: Record<Action, 'billing.manage' | 'branch.settings'> = {
  start: 'billing.manage',
  share: 'billing.manage',
  disconnect: 'billing.manage',
  refresh: 'branch.settings',
  dashboard: 'branch.settings',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface Body {
  branch_id?: string;
  action?: string;
  source_branch_id?: string;
}

interface AccountRow extends AccountState {
  branch_id: string;
  stripe_account_id: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const mode = stripeKeyMode(STRIPE_SECRET_KEY);
  if (!STRIPE_SECRET_KEY || !mode) return json({ error: 'stripe_not_configured' }, 503);

  const body = (await req.json().catch(() => null)) as Body | null;
  const action = body?.action as Action | undefined;
  if (!body || !isUuid(body.branch_id) || !action || !ACTIONS.includes(action)) {
    return json({ error: 'bad_request', allowed_actions: ACTIONS }, 400);
  }
  const branchId = body.branch_id;

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'auth_required' }, 401);
  const jwt = authHeader.slice(7);

  // The caller's own client, for the capability question (my_capabilities reads auth.uid()), and
  // the service-role client for everything the caller may not write themselves.
  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData.user) return json({ error: 'invalid_token' }, 401);
  const userId = userData.user.id;

  if (!(await holds(userClient, branchId, NEEDS[action]))) {
    return json({ error: 'forbidden', needs: NEEDS[action] }, 403);
  }

  const { data: branch } = await admin
    .from('branches')
    .select('id, restaurant_id, name')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) return json({ error: 'branch_not_found' }, 404);

  const { data: rowData, error: rowErr } = await admin
    .from('branch_payment_accounts')
    .select('branch_id, stripe_account_id, charges_enabled, payouts_enabled, details_submitted, requirements_due, disabled_reason')
    .eq('branch_id', branchId)
    .maybeSingle();
  if (rowErr) return json({ error: 'read_failed' }, 500);
  const row = rowData as AccountRow | null;

  switch (action) {
    case 'start':
      return start(req, admin, branch, row, userId, mode);
    case 'refresh': {
      if (!row) return json({ connected: false, state: null });
      const state = await refreshAccount(admin, row.stripe_account_id);
      return json({ connected: true, state: state ?? pickState(row), refreshed: state !== null });
    }
    case 'share':
      return share(userClient, admin, branch, row, body.source_branch_id, userId);
    case 'dashboard':
      if (!row) return json({ error: 'not_connected' }, 404);
      return json({ url: stripeDashboardUrl(row.stripe_account_id), kind: 'dashboard' });
    case 'disconnect': {
      if (!row) return json({ ok: true, connected: false });
      const { error } = await admin.from('branch_payment_accounts').delete().eq('branch_id', branchId);
      if (error) return json({ error: 'write_failed' }, 500);
      await audit(admin, branch, userId, 'stripe_connect_disconnected', { stripe_account_id: row.stripe_account_id });
      return json({ ok: true, connected: false });
    }
  }
});

type Branch = { id: string; restaurant_id: string; name: string };

async function start(
  req: Request,
  admin: SupabaseClient,
  branch: Branch,
  row: AccountRow | null,
  userId: string,
  mode: 'live' | 'test',
): Promise<Response> {
  // Resolved before anything is created: a missing or non-HTTPS admin origin would otherwise
  // leave a new Stripe account behind with no link to finish it.
  const origin = resolveAdminOrigin({
    requestOrigin: req.headers.get('origin'),
    publicAdminUrl: PUBLIC_ADMIN_URL,
    extraOrigins: EXTRA_RETURN_ORIGINS,
    // Only a test key may send the owner back to a developer's localhost admin, which is also the
    // only time a local admin is talking to real Stripe.
    allowLocalhost: mode === 'test' || IS_LOCAL_STACK,
  });
  if (!origin) {
    return json(
      {
        error: 'admin_url_not_configured',
        detail:
          'Set the PUBLIC_ADMIN_URL secret to the merchant app origin over HTTPS so Stripe can send the owner back; Stripe onboarding links accept only HTTPS return URLs.',
      },
      500,
    );
  }

  let accountId = row?.stripe_account_id ?? null;
  let state: AccountState | null = row ? pickState(row) : null;

  if (!accountId) {
    const { data: restaurant } = await admin
      .from('restaurants')
      .select('name, owner_user_id')
      .eq('id', branch.restaurant_id)
      .maybeSingle();
    // Two quick presses must not make two accounts. The key repeats within a ten-minute window
    // (Stripe answers the same account for it); a press after a disconnect, later, makes a new one.
    const created = await createConnectedAccount(
      STRIPE_SECRET_KEY!,
      {
        branchId: branch.id,
        restaurantId: branch.restaurant_id,
        restaurantName: (restaurant?.name as string | undefined) ?? null,
        branchName: branch.name,
        contactEmail: await ownerEmail(admin, restaurant?.owner_user_id as string | undefined),
      },
      `connect_account:${branch.id}:${Math.floor(Date.now() / 600_000)}`,
    );
    if (!created.ok) return stripeFailure('create_account', created.status, created.error);

    state = created.data.state;
    // ignoreDuplicates: if a parallel request stored an account first, keep theirs and use it.
    const { error: insErr } = await admin
      .from('branch_payment_accounts')
      .upsert(
        { branch_id: branch.id, stripe_account_id: created.data.id, ...state },
        { onConflict: 'branch_id', ignoreDuplicates: true },
      );
    if (insErr) return json({ error: 'write_failed' }, 500);
    const { data: stored } = await admin
      .from('branch_payment_accounts')
      .select('stripe_account_id')
      .eq('branch_id', branch.id)
      .maybeSingle();
    accountId = (stored?.stripe_account_id as string | undefined) ?? created.data.id;
    if (accountId !== created.data.id) {
      console.warn('connect start raced; using the stored account', branch.id, accountId, created.data.id);
    } else {
      await audit(admin, branch, userId, 'stripe_connect_account_created', {
        stripe_account_id: accountId,
        accounts_api: 'v2',
      });
    }
  }

  const link = await createOnboardingLink(STRIPE_SECRET_KEY!, accountId, onboardingUrls(origin, branch.id));
  if (!link.ok) return stripeFailure('account_link', link.status, link.error);
  return json({ url: link.data.url, expires_at: link.data.expires_at, state });
}

/**
 * The restaurant owner's email, as the Stripe account's contact: the account is theirs whoever
 * pressed Connect (a platform admin may, holding billing.manage), so the caller's own email is
 * never used in its place. Null when it cannot be read; the create is then sent without one, and
 * if Stripe insists on it the owner sees Stripe's refusal (502 stripe_error) instead of an account
 * registered to the wrong person.
 */
async function ownerEmail(admin: SupabaseClient, ownerUserId: string | undefined): Promise<string | null> {
  if (!isUuid(ownerUserId)) return null;
  const { data, error } = await admin.auth.admin.getUserById(ownerUserId);
  if (error) {
    console.warn('owner email lookup failed', error.message);
    return null;
  }
  return data.user?.email ?? null;
}

async function share(
  userClient: SupabaseClient,
  admin: SupabaseClient,
  branch: Branch,
  row: AccountRow | null,
  sourceBranchId: string | undefined,
  userId: string,
): Promise<Response> {
  if (!isUuid(sourceBranchId) || sourceBranchId === branch.id) return json({ error: 'bad_source_branch' }, 400);
  // Replacing an account is a second decision about where the money goes; it is made by
  // disconnecting first, on purpose.
  if (row) return json({ error: 'already_connected' }, 409);

  const { data: source } = await admin
    .from('branches')
    .select('id, restaurant_id')
    .eq('id', sourceBranchId)
    .maybeSingle();
  // One business, one bank: another restaurant's account is never offered, whoever asks.
  if (!source || source.restaurant_id !== branch.restaurant_id) return json({ error: 'other_restaurant' }, 403);
  if (!(await holds(userClient, sourceBranchId, 'billing.manage'))) {
    return json({ error: 'forbidden', needs: 'billing.manage' }, 403);
  }

  const { data: sourceRow } = await admin
    .from('branch_payment_accounts')
    .select('branch_id, stripe_account_id, charges_enabled, payouts_enabled, details_submitted, requirements_due, disabled_reason')
    .eq('branch_id', sourceBranchId)
    .maybeSingle();
  if (!sourceRow) return json({ error: 'source_not_connected' }, 409);
  const accountId = (sourceRow as AccountRow).stripe_account_id;

  const fetched = await readAccountState(STRIPE_SECRET_KEY!, accountId);
  const state = fetched.ok ? fetched.data : pickState(sourceRow as AccountRow);

  const { error } = await admin
    .from('branch_payment_accounts')
    .insert({ branch_id: branch.id, stripe_account_id: accountId, ...state });
  if (error) {
    if (error.code === '23505') return json({ error: 'already_connected' }, 409);
    return json({ error: 'write_failed' }, 500);
  }
  if (fetched.ok) {
    // The source's row learns the fresh state too; they are one account.
    await admin
      .from('branch_payment_accounts')
      .update({ ...state, updated_at: new Date().toISOString() })
      .eq('stripe_account_id', accountId);
  }
  await audit(admin, branch, userId, 'stripe_connect_shared', {
    stripe_account_id: accountId,
    source_branch_id: sourceBranchId,
  });
  return json({ connected: true, state });
}

/** Re-read the account and store its state on every branch paid into it. Null when Stripe could not be read. */
async function refreshAccount(admin: SupabaseClient, accountId: string): Promise<AccountState | null> {
  const fetched = await readAccountState(STRIPE_SECRET_KEY!, accountId);
  if (!fetched.ok) {
    console.warn('refresh: account read failed', accountId, fetched.status);
    return null;
  }
  const state = fetched.data;
  const { error } = await admin
    .from('branch_payment_accounts')
    .update({ ...state, updated_at: new Date().toISOString() })
    .eq('stripe_account_id', accountId);
  if (error) console.error('refresh: write failed', accountId, error);
  return state;
}

/** Does the caller hold this capability at the branch? Asked as the caller, through my_capabilities. */
async function holds(userClient: SupabaseClient, branchId: string, capability: string): Promise<boolean> {
  const { data, error } = await userClient.rpc('my_capabilities', { p_branch_id: branchId });
  if (error) {
    console.error('my_capabilities failed', error);
    return false;
  }
  const caps = new Set((Array.isArray(data) ? data : []) as string[]);
  // billing.manage is the owner's; whoever holds it may do anything branch.settings allows here.
  return caps.has(capability) || (capability === 'branch.settings' && caps.has('billing.manage'));
}

function pickState(row: AccountState): AccountState {
  return {
    charges_enabled: row.charges_enabled === true,
    payouts_enabled: row.payouts_enabled === true,
    details_submitted: row.details_submitted === true,
    requirements_due: Array.isArray(row.requirements_due) ? row.requirements_due : [],
    disabled_reason: row.disabled_reason ?? null,
  };
}

/** Where the branch's card money goes is on the record: who changed it, and to which account. */
async function audit(
  admin: SupabaseClient,
  branch: Branch,
  userId: string,
  action: string,
  metadata: Record<string, unknown>,
) {
  const { error } = await admin.from('audit_logs').insert({
    restaurant_id: branch.restaurant_id,
    branch_id: branch.id,
    actor_id: userId,
    actor_type: 'staff',
    action,
    entity_type: 'branch',
    entity_id: branch.id,
    metadata,
  });
  if (error) console.error('audit insert failed', action, error);
}

function stripeFailure(
  step: string,
  status: number,
  error: { error?: { code?: string; message?: string } } | null,
): Response {
  console.error('stripe call failed', step, status, error);
  return json(
    {
      error: 'stripe_error',
      step,
      stripe_status: status,
      stripe_code: error?.error?.code ?? null,
      detail: error?.error?.message ?? null,
    },
    // Never 503: that status means "Stripe is not configured here" to the admin client.
    502,
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
