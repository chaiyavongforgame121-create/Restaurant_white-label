// Stripe Connect helpers shared by stripe-connect-onboard and stripe-connect-webhook (and open to
// stripe-create-payment-intent / stripe-refund, which talk to the same connected accounts).
//
// Every call these two functions make to Stripe about a connected ACCOUNT lives here: creating it,
// minting its onboarding link and reading whether it can take cards; so do the webhook's re-reads
// of a refund or a charge before it records refund state. Keeping them in one module
// means the request shapes, the API versions and the "is this branch ready" rule are written once,
// and the admin app's tests pin them without a Deno runtime.
//
// Pure where it can be: nothing here reads Deno.env or a database, so the signature check, the
// account-state mapping and the redirect allow-list can be exercised outside the edge runtime.
//
// NOTE ON DEPLOYMENT — as with _shared/entitlements.ts, the Supabase CLI uploads the whole
// `supabase/functions` tree, so `../_shared/stripe-connect.ts` resolves. Through the Management
// API / MCP, pass this file as `_shared/stripe-connect.ts` next to `<fn>/index.ts`.
//
// WHICH STRIPE API FOR WHAT (docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md, Stripe's own planner):
//   - Connected accounts are CREATED with Accounts v2 (POST /v2/core/accounts) and onboarded with
//     Account Links v2 (POST /v2/core/account_links). Stripe tells new platforms not to create
//     accounts through Accounts v1 or its legacy `type`/controller settings.
//   - Whether an account can take cards is READ through GET /v1/accounts/{id}, which Stripe
//     documents as valid for accounts created with v2 (it answers in the v1 shape). See
//     readAccountState for why this read, and not a v2 retrieve, feeds branch_payment_accounts.
//   - Charges, refunds and their events stay on API v1, pinned to STRIPE_API_VERSION.

/**
 * Pinned for every v1 call and for the Connect webhook endpoint, matching stripe-webhook. A
 * mismatch changes payload shapes, including the account.updated snapshot the webhook reads.
 */
export const STRIPE_API_VERSION = '2025-08-27.basil';

/**
 * API v2 refuses a request without a Stripe-Version header. This is the GA (non-preview) version
 * current on 2026-09-24; Accounts v2 for Connect platforms is GA since 2025-12-15.clover. It is
 * separate from STRIPE_API_VERSION on purpose: the v2 requests only send a body and read back the
 * account id, capability statuses and the link, so moving it does not move any v1 payload shape.
 */
export const STRIPE_V2_API_VERSION = '2026-08-26.dahlia';

/** Reject signatures older than this. Without it a captured body replays forever. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** acct_ followed by Stripe's id alphabet. Anything else is not a connected account id. */
export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^acct_[A-Za-z0-9]+$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// Webhook signatures
// ---------------------------------------------------------------------------------------------

/**
 * Stripe-Signature is `t=<unix>,v1=<hex>[,v1=<hex>...][,v0=...]`. More than one v1 appears while
 * an endpoint secret is being rolled, so every one of them is kept rather than the last one seen.
 */
export function parseSignatureHeader(header: string): { t: string | null; v1: string[] } {
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') t = value;
    else if (key === 'v1' && value) v1.push(value);
  }
  return { t, v1 };
}

/** HMAC-SHA256 of `${t}.${payload}` compared with each v1, inside the replay window. */
export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): Promise<boolean> {
  const { t, v1 } = parseSignatureHeader(header);
  if (!t || v1.length === 0) return false;
  // Replay window. The signature itself never expires, so without this check a body captured
  // once can be re-POSTed indefinitely and still verify.
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) return false;

  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  let match = false;
  // Every candidate is compared, so the time taken does not say which one matched.
  for (const candidate of v1) {
    if (timingSafeEqual(expected, candidate)) match = true;
  }
  return match;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ---------------------------------------------------------------------------------------------
// Key mode
// ---------------------------------------------------------------------------------------------

/**
 * Which Stripe mode a secret or restricted key works in. A connected account keeps ONE id in
 * both modes, and a Connect endpoint in live mode receives test events too, so an event whose
 * livemode differs from the key's is about a different world and must not touch these rows: a
 * test-mode account.updated would otherwise mark a live branch ready to take cards.
 */
export function stripeKeyMode(key: string | null | undefined): 'live' | 'test' | null {
  if (!key) return null;
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  return null;
}

export function eventMatchesMode(livemode: unknown, mode: 'live' | 'test' | null): boolean {
  if (mode === null) return false;
  return livemode === (mode === 'live');
}

// ---------------------------------------------------------------------------------------------
// Connected account state (what branch_payment_accounts stores)
// ---------------------------------------------------------------------------------------------

/** A connected account as GET /v1/accounts/{id} and the v1 account.updated snapshot shape it. */
export interface StripeAccountLike {
  id?: string;
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  requirements?: {
    currently_due?: string[] | null;
    past_due?: string[] | null;
    disabled_reason?: string | null;
  } | null;
  controller?: { stripe_dashboard?: { type?: string | null } | null } | null;
}

/** The branch_payment_accounts columns that mirror a Stripe Account. */
export interface AccountState {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements_due: string[];
  disabled_reason: string | null;
}

/**
 * What the branch settings card needs to say in plain words, from the v1 view of an account.
 * requirements_due is what Stripe wants NOW: past_due (already blocking something) and
 * currently_due (blocking at the deadline). eventually_due is left out on purpose; it is collected
 * up front by the onboarding link and would otherwise show "action needed" on an account that
 * needs nothing today.
 */
export function accountState(account: StripeAccountLike): AccountState {
  const req = account.requirements ?? {};
  const due = new Set<string>();
  for (const list of [req.past_due, req.currently_due]) {
    for (const item of list ?? []) {
      if (typeof item === 'string' && item) due.add(item);
    }
  }
  return {
    charges_enabled: account.charges_enabled === true,
    payouts_enabled: account.payouts_enabled === true,
    details_submitted: account.details_submitted === true,
    requirements_due: [...due].sort(),
    disabled_reason: typeof req.disabled_reason === 'string' && req.disabled_reason ? req.disabled_reason : null,
  };
}

/** The parts of an Accounts v2 object that createdAccountState reads (requested through `include`). */
export interface V2AccountLike {
  id?: string;
  configuration?: {
    merchant?: {
      capabilities?: {
        card_payments?: { status?: string | null } | null;
        stripe_balance?: { payouts?: { status?: string | null } | null } | null;
      } | null;
    } | null;
  } | null;
}

/**
 * The row stored for an account the moment POST /v2/core/accounts answers, before anyone has
 * opened Stripe's form. Only the capability statuses are taken from the v2 payload, and only an
 * `active` status counts: Stripe's planner gives card_payments.status as the v2 equivalent of v1
 * charges_enabled, and the merchant configuration's own stripe_balance.payouts as payouts_enabled.
 *
 * The other columns keep their v1 meaning rather than being translated from v2: a new account has
 * submitted nothing (details_submitted false, which the card shows as "Finish setting up"), and
 * requirements_due / disabled_reason are v1 field paths and v1 reasons that the admin card groups
 * and words. They are filled in by the v1 read (readAccountState) when the owner returns from
 * Stripe or the first account.updated arrives. Leaving them empty here can only understate what
 * Stripe wants, never mark a branch able to take cards.
 */
export function createdAccountState(account: V2AccountLike | null | undefined): AccountState {
  const caps = account?.configuration?.merchant?.capabilities ?? null;
  return {
    charges_enabled: caps?.card_payments?.status === 'active',
    payouts_enabled: caps?.stripe_balance?.payouts?.status === 'active',
    details_submitted: false,
    requirements_due: [],
    disabled_reason: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Request bodies (pure, so the admin tests pin exactly what Stripe receives)
// ---------------------------------------------------------------------------------------------

/** What the v2 create reads back: the capability statuses createdAccountState maps, nothing else. */
export const CREATE_ACCOUNT_INCLUDE = ['configuration.merchant'] as const;

const DISPLAY_NAME_MAX = 100;

/** "Restaurant – Branch", or whichever of the two is known, as Stripe's Dashboard names it. */
export function accountDisplayName(restaurantName?: string | null, branchName?: string | null): string | null {
  const clean = (s?: string | null) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
  const r = clean(restaurantName);
  const b = clean(branchName);
  const name = r && b && r.toLowerCase() !== b.toLowerCase() ? `${r} – ${b}` : r || b;
  return name ? name.slice(0, DISPLAY_NAME_MAX) : null;
}

/**
 * Domains no mailbox can exist under (RFC 2606 and RFC 6761, plus mDNS .local). Seeded and demo
 * owners use them: the test restaurant's owner is demo-owner@favornoms.local. Stripe would either
 * refuse the create over such an address or offer it as the owner's Stripe login, so the account
 * is made without one and Stripe's own form asks the owner for a real one.
 */
const UNDELIVERABLE_EMAIL_DOMAIN = /(^|\.)(test|example|invalid|localhost|local)$|(^|\.)example\.(com|net|org)$/i;

function isDeliverableEmail(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  return !UNDELIVERABLE_EMAIL_DOMAIN.test(value.slice(value.lastIndexOf('@') + 1));
}

/**
 * POST /v2/core/accounts for one branch (docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md §2, Stripe's
 * SaaS recipe for direct charges):
 *   dashboard full                     the restaurant runs its own Stripe Dashboard;
 *   fees_collector stripe              Stripe takes its fees from the restaurant's account, the
 *                                      platform takes nothing;
 *   losses_collector stripe            Stripe, not the platform, carries negative balances, which
 *                                      also makes Stripe the one that collects the requirements;
 *   merchant.card_payments requested   the capability a direct charge needs;
 *   identity.country US                the platform's own country (the owner confirmed it).
 * The business type, bank and people are left to Stripe's hosted form: KYC is never collected here.
 * The contact email is the restaurant owner's, the person the account belongs to, unless it is on
 * a domain no mail can reach (isDeliverableEmail).
 */
export function connectedAccountBody(input: {
  branchId: string;
  restaurantId: string;
  restaurantName?: string | null;
  branchName?: string | null;
  contactEmail?: string | null;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    dashboard: 'full',
    identity: { country: 'US' },
    defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
    configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    metadata: { branch_id: input.branchId, restaurant_id: input.restaurantId },
    include: [...CREATE_ACCOUNT_INCLUDE],
  };
  const email = typeof input.contactEmail === 'string' ? input.contactEmail.trim() : '';
  if (isDeliverableEmail(email)) body.contact_email = email;
  const name = accountDisplayName(input.restaurantName, input.branchName);
  if (name) body.display_name = name;
  return body;
}

/**
 * POST /v2/core/account_links for the hosted onboarding of the merchant configuration. Everything
 * Stripe will eventually need is asked once (collection_options.fields = eventually_due), so a
 * restaurant that finished is not sent back to the form a few weeks after its first payouts.
 */
export function onboardingLinkBody(
  accountId: string,
  urls: { return_url: string; refresh_url: string },
): Record<string, unknown> {
  return {
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['merchant'],
        return_url: urls.return_url,
        refresh_url: urls.refresh_url,
        collection_options: { fields: 'eventually_due' },
      },
    },
  };
}

/**
 * API v2 answers timestamps as RFC 3339 strings, v1 as unix seconds. The onboard function has
 * always answered expires_at in unix seconds, so a v2 time is converted rather than passed on.
 */
export function unixSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return null;
}

/**
 * Where a full-Dashboard account is managed. Stripe's planner links platforms to the account's
 * own Dashboard at dashboard.stripe.com/<account id>; login links exist only for Express-Dashboard
 * accounts, and every account created here has the full Dashboard.
 */
export function stripeDashboardUrl(accountId: string | null | undefined): string {
  return isAccountId(accountId) ? `https://dashboard.stripe.com/${accountId}` : 'https://dashboard.stripe.com/';
}

// ---------------------------------------------------------------------------------------------
// Redirects back to the admin app
// ---------------------------------------------------------------------------------------------

/**
 * Account Links v2 refuse any return or refresh URL that is not HTTPS, in test as well as live,
 * so only HTTPS origins are ever allowed. An http origin (a plain `next dev`) is dropped here
 * instead of being sent to Stripe, where it would fail the link after the account was created.
 */
function httpsOriginOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

function isHttpsUrl(value: unknown): boolean {
  return typeof value === 'string' && httpsOriginOf(value) !== null;
}

/**
 * The admin origin Stripe may send the owner back to. Account Links carry our return and refresh
 * URLs, so an origin taken from the request unchecked would let anyone who can call the function
 * turn Stripe's page into a redirect to a site of their choosing. The request's Origin is used
 * only when it is the configured admin origin, one of the extra allowed origins, or (with a test
 * key) an HTTPS localhost dev server; otherwise the configured origin. Null when no HTTPS origin
 * is configured.
 */
export function resolveAdminOrigin(input: {
  requestOrigin: string | null | undefined;
  publicAdminUrl: string | null | undefined;
  extraOrigins?: string | null;
  allowLocalhost: boolean;
}): string | null {
  const configured = httpsOriginOf(input.publicAdminUrl);
  const allowed = new Set<string>();
  if (configured) allowed.add(configured);
  for (const raw of (input.extraOrigins ?? '').split(',')) {
    const o = httpsOriginOf(raw.trim());
    if (o) allowed.add(o);
  }
  const requested = httpsOriginOf(input.requestOrigin);
  if (requested && (allowed.has(requested) || (input.allowLocalhost && isLocalhostOrigin(requested)))) {
    return requested;
  }
  return configured;
}

/** Where Stripe's onboarding sends the owner: back to this branch's settings page. */
export function onboardingUrls(origin: string, branchId: string): { return_url: string; refresh_url: string } {
  const base = `${origin}/b/${encodeURIComponent(branchId)}/branch`;
  return { return_url: `${base}?stripe=return`, refresh_url: `${base}?stripe=refresh` };
}

// ---------------------------------------------------------------------------------------------
// Talking to Stripe
// ---------------------------------------------------------------------------------------------

/**
 * Stripe's form encoding: nested objects become a[b][c]=v, arrays a[0]=v. Undefined and null are
 * left out rather than sent as empty strings, which Stripe reads as "clear this field".
 */
export function formEncode(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(`${prefix}[${k}]`, v);
      return;
    }
    out.append(prefix, String(value));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out;
}

export interface StripeErrorBody {
  error?: { type?: string; code?: string; message?: string; param?: string };
}

export type StripeResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: StripeErrorBody | null };

/**
 * Sends one request and reads its JSON. A network failure is status 0, so callers can tell
 * "Stripe said no" (4xx: do not retry) from "Stripe could not be reached" (retry).
 */
async function send<T>(url: string, init: RequestInit, label: string): Promise<StripeResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    console.error('stripe request failed', label, err);
    return { ok: false, status: 0, error: null };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) return { ok: false, status: res.status, error: (parsed as StripeErrorBody | null) ?? null };
  return { ok: true, status: res.status, data: parsed as T };
}

/**
 * One Stripe API v1 call (form-encoded). `account` sends the Stripe-Account header, which is what
 * makes a call act ON the connected account (a direct charge, its refunds) instead of on the
 * platform's own.
 */
export async function stripeRequest<T>(
  secretKey: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { params?: Record<string, unknown>; account?: string | null; idempotencyKey?: string } = {},
): Promise<StripeResult<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
  if (opts.account) headers['Stripe-Account'] = opts.account;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  let url = `https://api.stripe.com${path}`;
  let body: URLSearchParams | undefined;
  if (opts.params) {
    const encoded = formEncode(opts.params);
    if (method === 'GET') {
      const qs = encoded.toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    } else {
      body = encoded;
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  return send<T>(url, { method, headers, body }, `${method} ${path}`);
}

/**
 * One Stripe API v2 call: JSON in and out, and a Stripe-Version header, which v2 requires on every
 * request. It has no Stripe-Account option on purpose: the only v2 calls made here (creating an
 * account, minting its onboarding link) are the platform's own and name the account in the body.
 * Anything that acts on a connected account's money goes through stripeRequest with `account`.
 */
export async function stripeV2Request<T>(
  secretKey: string,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<StripeResult<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Stripe-Version': STRIPE_V2_API_VERSION,
  };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let body: string | undefined;
  if (opts.body && method === 'POST') {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  return send<T>(`https://api.stripe.com${path}`, { method, headers, body }, `${method} ${path}`);
}

/** A Stripe failure worth retrying: unreachable, rate limited, or Stripe's own fault. */
export function isRetryableStripeFailure(status: number): boolean {
  return status === 0 || status === 409 || status === 429 || status >= 500;
}

function malformed(status: number, message: string): StripeResult<never> {
  return { ok: false, status, error: { error: { type: 'api_error', code: 'unexpected_response', message } } };
}

/**
 * Creates the branch's connected account with Accounts v2 and maps the answer to the row the
 * onboard function stores. The idempotency key is the caller's: Stripe v2 replays a request with
 * the same key for 30 days, so the key alone decides when a second press may make a second account.
 */
export async function createConnectedAccount(
  secretKey: string,
  input: Parameters<typeof connectedAccountBody>[0],
  idempotencyKey: string,
): Promise<StripeResult<{ id: string; state: AccountState }>> {
  const res = await stripeV2Request<V2AccountLike>(secretKey, 'POST', '/v2/core/accounts', {
    body: connectedAccountBody(input),
    idempotencyKey,
  });
  if (!res.ok) return res;
  // An id that is not acct_… would be stored as where the branch's card money goes; refuse it.
  const id = res.data?.id;
  if (!isAccountId(id)) return malformed(res.status, 'The account Stripe returned has no usable id.');
  return { ok: true, status: res.status, data: { id, state: createdAccountState(res.data) } };
}

/**
 * A single-use, minutes-long Stripe-hosted onboarding link for the account (Account Links v2). It
 * is handed only to the signed-in owner who asked for it, never stored, emailed or texted. Both
 * URLs must be HTTPS; a non-HTTPS one is refused here rather than by Stripe.
 */
export async function createOnboardingLink(
  secretKey: string,
  accountId: string,
  urls: { return_url: string; refresh_url: string },
): Promise<StripeResult<{ url: string; expires_at: number | null }>> {
  if (!isAccountId(accountId)) return malformed(400, 'Not a connected account id.');
  if (!isHttpsUrl(urls.return_url) || !isHttpsUrl(urls.refresh_url)) {
    return { ok: false, status: 400, error: { error: { type: 'invalid_request_error', code: 'https_required', message: 'Onboarding return and refresh URLs must be HTTPS.' } } };
  }
  const res = await stripeV2Request<{ url?: unknown; expires_at?: unknown }>(secretKey, 'POST', '/v2/core/account_links', {
    body: onboardingLinkBody(accountId, urls),
  });
  if (!res.ok) return res;
  const url = res.data?.url;
  if (typeof url !== 'string' || !isHttpsUrl(url)) {
    return malformed(res.status, 'The account link Stripe returned has no usable URL.');
  }
  return { ok: true, status: res.status, data: { url, expires_at: unixSeconds(res.data?.expires_at) } };
}

/**
 * THE readiness read: whether a connected account can take cards, and what Stripe wants from it,
 * as the branch_payment_accounts columns. The onboard function (return from Stripe, "Check status",
 * sharing an account) and the webhook's account.updated both use it, so a row means the same thing
 * whichever of them wrote it last.
 *
 * It reads GET /v1/accounts/{id}, which Stripe documents as valid for an account created with v2
 * (the answer is the v1 shape of the same account), rather than GET /v2/core/accounts/{id}:
 *   - the columns ARE v1 fields: charges_enabled (Stripe's planner gives it as the v1 equivalent of
 *     v2 configuration.merchant.capabilities.card_payments.status = active), payouts_enabled,
 *     details_submitted, requirements past_due + currently_due as v1 field paths, and v1's
 *     requirements.disabled_reason. The storefront's card gate and the admin card's wording and
 *     requirement groups are built on exactly those values; v2 has no details_submitted, names
 *     requirements as entries with descriptions rather than field paths, and has changed those
 *     enums between versions, so a v2 read would need a lossy translation into the same columns;
 *   - the Connect webhook receives account.updated as a v1 snapshot (scope "Connected accounts"),
 *     and when the re-read fails it falls back to that payload. Reading v1 here means the re-read
 *     and the fallback go through the one mapping, accountState.
 * It is a platform call: no Stripe-Account header, the account is in the path.
 */
export async function readAccountState(secretKey: string, accountId: string): Promise<StripeResult<AccountState>> {
  if (!isAccountId(accountId)) return malformed(400, 'Not a connected account id.');
  const res = await stripeRequest<StripeAccountLike>(secretKey, 'GET', `/v1/accounts/${accountId}`);
  if (!res.ok) return res;
  return { ok: true, status: res.status, data: accountState(res.data ?? {}) };
}

// ---------------------------------------------------------------------------------------------
// Refund state for the Connect webhook
// ---------------------------------------------------------------------------------------------
//
// Why these reads exist: an event's object is a snapshot from when the event was sent, Stripe
// does not deliver events in order, a retried delivery can arrive hours later, and a refund that
// succeeded can still fail afterwards. Recording a stale snapshot has told the books a diner's
// money went back when it had not, which then let staff cancel or refund the order with nothing
// sent. So the webhook records refunds from what Stripe says NOW, read on the connected account.

/** A Stripe object id as it may go into a URL path: letters, digits and underscores only. */
export function isStripeObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_]{3,255}$/.test(value);
}

/**
 * refund.* events: the refund as Stripe has it now (GET /v1/refunds/{id} on the connected
 * account). When it cannot be read, the event's snapshot is what gets recorded; that is safe on
 * its own, because stripe_connect_record_refund only moves a refund forward (failed and canceled
 * are final, nothing goes back to pending). `fresh` says which of the two it is.
 */
export async function currentRefund(
  secretKey: string,
  account: string,
  snapshot: Record<string, unknown>,
): Promise<{ refund: Record<string, unknown>; fresh: boolean; status: number }> {
  const refundId = snapshot.id;
  if (!isAccountId(account) || !isStripeObjectId(refundId)) return { refund: snapshot, fresh: false, status: 0 };
  const res = await stripeRequest<Record<string, unknown>>(secretKey, 'GET', `/v1/refunds/${refundId}`, { account });
  if (res.ok && res.data?.id === refundId) return { refund: res.data, fresh: true, status: res.status };
  return { refund: snapshot, fresh: false, status: res.status };
}

/** What charge.refunded may record, read from Stripe rather than taken from the event. */
export type ChargeRefundsRead =
  /** The charge's refunds as they are now; record each one (the refund rows settle the payment). */
  | { kind: 'refunds'; refunds: Record<string, unknown>[] }
  /** The listing could not be read but the Charge could: apply this fresh Charge. */
  | { kind: 'charge'; charge: Record<string, unknown>; refundsStatus: number }
  /** Neither could be read. retry: Stripe was unreachable or failing, so redeliver the event. */
  | { kind: 'unreadable'; retry: boolean; refundsStatus: number; chargeStatus: number }
  /** The event named no usable charge id. */
  | { kind: 'no_charge' };

/**
 * charge.refunded: the event's Charge is never applied as it came, because a late delivery still
 * says refunded: true for a refund that has failed since. The charge's refunds are listed from the
 * connected account (charge.refunded no longer embeds them) and, only when that listing cannot be
 * read, the Charge itself is re-read. A 2xx answering about another object counts as unreadable
 * and not retryable: it is Stripe's to explain, and redelivering would not change it.
 */
export async function readChargeRefunds(
  secretKey: string,
  account: string,
  chargeId: unknown,
): Promise<ChargeRefundsRead> {
  if (!isAccountId(account) || !isStripeObjectId(chargeId)) return { kind: 'no_charge' };
  const listed = await stripeRequest<{ data?: Record<string, unknown>[] }>(secretKey, 'GET', '/v1/refunds', {
    params: { charge: chargeId, limit: 100 },
    account,
  });
  if (listed.ok) return { kind: 'refunds', refunds: Array.isArray(listed.data?.data) ? listed.data.data : [] };

  const charge = await stripeRequest<Record<string, unknown>>(secretKey, 'GET', `/v1/charges/${chargeId}`, { account });
  if (charge.ok && charge.data?.id === chargeId) {
    return { kind: 'charge', charge: charge.data, refundsStatus: listed.status };
  }
  return {
    kind: 'unreadable',
    retry: isRetryableStripeFailure(listed.status) || (!charge.ok && isRetryableStripeFailure(charge.status)),
    refundsStatus: listed.status,
    chargeStatus: charge.status,
  };
}
