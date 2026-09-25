import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as connect from '../../../../../../../../supabase/functions/_shared/stripe-connect';

/**
 * The rules stripe-connect-onboard and stripe-connect-webhook are built on, pinned from here
 * because a Deno function cannot run under this app's test runner but a module with no imports
 * can: supabase/functions/_shared/stripe-connect.ts imports nothing for exactly this reason.
 *
 * What is at stake: which Stripe account a branch's card money is paid into, whether the storefront
 * believes a branch can take cards, and whether an event claiming a payment went through is
 * believed.
 */

const sign = (payload: string, secret: string, t: number) =>
  createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');

describe('webhook signatures', () => {
  const now = 1_800_000_000;
  const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';
  const good = sign(body, 'whsec_a', now);

  it('accepts the endpoint secret inside the five-minute window', async () => {
    expect(await connect.verifyStripeSignature(body, `t=${now},v1=${good}`, 'whsec_a', now)).toBe(true);
    expect(await connect.verifyStripeSignature(body, `t=${now},v1=${good}`, 'whsec_a', now + 300)).toBe(true);
  });

  it('refuses another secret, a changed body and a replay after the window', async () => {
    expect(await connect.verifyStripeSignature(body, `t=${now},v1=${good}`, 'whsec_b', now)).toBe(false);
    expect(await connect.verifyStripeSignature(`${body} `, `t=${now},v1=${good}`, 'whsec_a', now)).toBe(false);
    expect(await connect.verifyStripeSignature(body, `t=${now},v1=${good}`, 'whsec_a', now + 301)).toBe(false);
  });

  it('checks every v1 while a secret is being rolled, and needs a timestamp', async () => {
    const old = sign(body, 'whsec_old', now);
    expect(await connect.verifyStripeSignature(body, `t=${now},v1=${old},v1=${good}`, 'whsec_a', now)).toBe(true);
    expect(await connect.verifyStripeSignature(body, `v1=${good}`, 'whsec_a', now)).toBe(false);
    expect(await connect.verifyStripeSignature(body, `t=soon,v1=${good}`, 'whsec_a', now)).toBe(false);
  });
});

describe('test and live stay apart', () => {
  it('reads the mode off the secret or restricted key', () => {
    expect(connect.stripeKeyMode('sk_test_abc')).toBe('test');
    expect(connect.stripeKeyMode('rk_live_abc')).toBe('live');
    expect(connect.stripeKeyMode('pk_live_abc')).toBeNull();
    expect(connect.stripeKeyMode(undefined)).toBeNull();
  });

  it('applies only events of the key mode: an account has one id in both', () => {
    expect(connect.eventMatchesMode(false, 'test')).toBe(true);
    expect(connect.eventMatchesMode(true, 'test')).toBe(false);
    expect(connect.eventMatchesMode(true, 'live')).toBe(true);
    expect(connect.eventMatchesMode(undefined, 'live')).toBe(false);
    expect(connect.eventMatchesMode(false, null)).toBe(false);
  });
});

describe('creating the connected account (Accounts v2)', () => {
  const input = {
    branchId: 'b1',
    restaurantId: 'r1',
    restaurantName: 'Coastal  Grill',
    branchName: 'Downtown',
    contactEmail: ' owner@coastal.example ',
  };

  it('asks for the full Dashboard, Stripe-collected fees and losses, card payments, in the US', () => {
    expect(connect.connectedAccountBody(input)).toEqual({
      dashboard: 'full',
      identity: { country: 'US' },
      defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      metadata: { branch_id: 'b1', restaurant_id: 'r1' },
      include: ['configuration.merchant'],
      contact_email: 'owner@coastal.example',
      display_name: 'Coastal Grill – Downtown',
    });
  });

  it('never uses the legacy account type, controller settings or an application fee', () => {
    const body = connect.connectedAccountBody(input);
    for (const key of ['type', 'country', 'controller', 'capabilities', 'business_type', 'application_fee_amount']) {
      expect(body).not.toHaveProperty(key);
    }
    // Nothing the platform could collect on the restaurant's behalf: no KYC, no bank.
    expect(JSON.stringify(body)).not.toMatch(/external_account|tos_acceptance|individual|company/);
  });

  it('leaves out a contact email that is not one, and names the account by what is known', () => {
    const body = connect.connectedAccountBody({ branchId: 'b1', restaurantId: 'r1', contactEmail: 'not an email', branchName: 'Main' });
    expect(body).not.toHaveProperty('contact_email');
    expect(body.display_name).toBe('Main');
    expect(connect.accountDisplayName('Pho 99', 'pho 99')).toBe('Pho 99');
    expect(connect.accountDisplayName(null, null)).toBeNull();
    expect(connect.accountDisplayName('x'.repeat(80), 'y'.repeat(80))).toHaveLength(100);
  });

  it('stores a new account as not able to take cards until Stripe says card_payments is active', () => {
    const fresh = {
      id: 'acct_1',
      configuration: {
        merchant: {
          capabilities: {
            card_payments: { status: 'restricted' },
            stripe_balance: { payouts: { status: 'pending' } },
          },
        },
      },
    };
    expect(connect.createdAccountState(fresh)).toEqual({
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements_due: [],
      disabled_reason: null,
    });
    const active = {
      configuration: {
        merchant: { capabilities: { card_payments: { status: 'active' }, stripe_balance: { payouts: { status: 'active' } } } },
      },
    };
    expect(connect.createdAccountState(active)).toMatchObject({ charges_enabled: true, payouts_enabled: true, details_submitted: false });
    // v2 answers nested objects it was not asked to include as null: that is "not active", never "ready".
    expect(connect.createdAccountState({ id: 'acct_1', configuration: null }).charges_enabled).toBe(false);
    expect(connect.createdAccountState(null).charges_enabled).toBe(false);
  });

  it('onboards the merchant configuration and collects everything up front', () => {
    expect(
      connect.onboardingLinkBody('acct_1', { return_url: 'https://a.example/r', refresh_url: 'https://a.example/f' }),
    ).toEqual({
      account: 'acct_1',
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant'],
          return_url: 'https://a.example/r',
          refresh_url: 'https://a.example/f',
          collection_options: { fields: 'eventually_due' },
        },
      },
    });
  });

  it('answers link expiry in unix seconds, whether Stripe sent a v2 time or a number', () => {
    expect(connect.unixSeconds('2026-09-24T10:00:30.000Z')).toBe(Date.UTC(2026, 8, 24, 10, 0, 30) / 1000);
    expect(connect.unixSeconds(1_800_000_000.9)).toBe(1_800_000_000);
    expect(connect.unixSeconds('soon')).toBeNull();
    expect(connect.unixSeconds(undefined)).toBeNull();
  });

  it("links a full-Dashboard account to its own page on Stripe's Dashboard", () => {
    expect(connect.stripeDashboardUrl('acct_1Q2w')).toBe('https://dashboard.stripe.com/acct_1Q2w');
    expect(connect.stripeDashboardUrl('acct_1/../../evil')).toBe('https://dashboard.stripe.com/');
  });

  it('only accepts account ids that look like Stripe ones', () => {
    expect(connect.isAccountId('acct_1Q2w3E4r')).toBe(true);
    expect(connect.isAccountId('acct_')).toBe(false);
    expect(connect.isAccountId("acct_1' or 1=1")).toBe(false);
    expect(connect.isAccountId(undefined)).toBe(false);
  });
});

describe('the readiness read (v1 shape of the account)', () => {
  it('mirrors what Stripe wants now: past due and currently due, once, sorted', () => {
    expect(
      connect.accountState({
        charges_enabled: true,
        payouts_enabled: null,
        details_submitted: true,
        requirements: {
          currently_due: ['external_account', 'business_profile.url'],
          past_due: ['external_account'],
          disabled_reason: null,
        },
      }),
    ).toEqual({
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      requirements_due: ['business_profile.url', 'external_account'],
      disabled_reason: null,
    });
  });

  it('keeps Stripe’s block reason and reads an empty account as nothing enabled', () => {
    expect(connect.accountState({ requirements: { disabled_reason: 'requirements.past_due' } }).disabled_reason).toBe(
      'requirements.past_due',
    );
    expect(connect.accountState({})).toEqual({
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements_due: [],
      disabled_reason: null,
    });
  });
});

describe('where Stripe sends the owner back', () => {
  const base = { publicAdminUrl: 'https://admin.example.com/', extraOrigins: 'https://staging.example.com', allowLocalhost: false };

  it('uses the request origin only when it is an allowed admin origin', () => {
    expect(connect.resolveAdminOrigin({ ...base, requestOrigin: 'https://staging.example.com' })).toBe('https://staging.example.com');
    expect(connect.resolveAdminOrigin({ ...base, requestOrigin: 'https://evil.example' })).toBe('https://admin.example.com');
    expect(connect.resolveAdminOrigin({ ...base, requestOrigin: 'https://admin.example.com.evil.example' })).toBe(
      'https://admin.example.com',
    );
    expect(connect.resolveAdminOrigin({ ...base, requestOrigin: 'javascript:alert(1)' })).toBe('https://admin.example.com');
  });

  it('lets an HTTPS localhost admin back in only while testing', () => {
    expect(connect.resolveAdminOrigin({ ...base, requestOrigin: 'https://localhost:3004' })).toBe('https://admin.example.com');
    expect(connect.resolveAdminOrigin({ ...base, allowLocalhost: true, requestOrigin: 'https://admin.localhost:3004' })).toBe(
      'https://admin.localhost:3004',
    );
    expect(connect.resolveAdminOrigin({ ...base, allowLocalhost: true, requestOrigin: 'https://localhost.evil.example' })).toBe(
      'https://admin.example.com',
    );
  });

  it('never returns an http origin: Stripe onboarding links take HTTPS only, in test too', () => {
    expect(connect.resolveAdminOrigin({ ...base, allowLocalhost: true, requestOrigin: 'http://localhost:3004' })).toBe(
      'https://admin.example.com',
    );
    expect(connect.resolveAdminOrigin({ ...base, extraOrigins: 'http://staging.example.com', requestOrigin: 'http://staging.example.com' })).toBe(
      'https://admin.example.com',
    );
    expect(connect.resolveAdminOrigin({ publicAdminUrl: 'http://admin.example.com', extraOrigins: '', allowLocalhost: true, requestOrigin: null })).toBeNull();
  });

  it('has no answer when nothing is configured and the request is not trusted', () => {
    expect(connect.resolveAdminOrigin({ publicAdminUrl: '', extraOrigins: '', allowLocalhost: false, requestOrigin: 'https://evil.example' })).toBeNull();
  });

  it('returns to the branch settings page with ?stripe=return and ?stripe=refresh', () => {
    expect(connect.onboardingUrls('https://admin.example.com', '44444444-4444-4444-4444-444444444444')).toEqual({
      return_url: 'https://admin.example.com/b/44444444-4444-4444-4444-444444444444/branch?stripe=return',
      refresh_url: 'https://admin.example.com/b/44444444-4444-4444-4444-444444444444/branch?stripe=refresh',
    });
  });
});

describe('the requests Stripe receives', () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
  let calls: Call[] = [];

  function stubFetch(answer: (call: Call) => { status?: number; json?: unknown } | Error) {
    calls = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        url: String(url),
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? init.body : init.body ? String(init.body) : undefined,
      };
      calls.push(call);
      const a = answer(call);
      if (a instanceof Error) throw a;
      return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
    });
  }

  /** The one request the call under test made; more or fewer is itself a failure. */
  function onlyCall(): Call {
    expect(calls).toHaveLength(1);
    const c = calls[0];
    if (!c) throw new Error('no Stripe request was made');
    return c;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the account with a JSON v2 request, the v2 version header and the caller’s idempotency key', async () => {
    stubFetch(() => ({
      json: { id: 'acct_NEW', configuration: { merchant: { capabilities: { card_payments: { status: 'restricted' } } } } },
    }));
    const res = await connect.createConnectedAccount(
      'sk_test_x',
      { branchId: 'b1', restaurantId: 'r1', restaurantName: 'Coastal Grill', branchName: 'Downtown', contactEmail: 'o@c.example' },
      'connect_account:b1:1',
    );
    expect(res).toEqual({
      ok: true,
      status: 200,
      data: { id: 'acct_NEW', state: { charges_enabled: false, payouts_enabled: false, details_submitted: false, requirements_due: [], disabled_reason: null } },
    });
    const c = onlyCall();
    expect(c.url).toBe('https://api.stripe.com/v2/core/accounts');
    expect(c.method).toBe('POST');
    expect(c.headers['Stripe-Version']).toBe(connect.STRIPE_V2_API_VERSION);
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(c.headers['Idempotency-Key']).toBe('connect_account:b1:1');
    // A platform call: it must never act as, or on, a connected account.
    expect(c.headers).not.toHaveProperty('Stripe-Account');
    expect(JSON.parse(c.body ?? '{}')).toMatchObject({
      dashboard: 'full',
      identity: { country: 'US' },
      defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      metadata: { branch_id: 'b1', restaurant_id: 'r1' },
    });
  });

  it('refuses an answer without an acct_ id, and passes Stripe’s refusal through', async () => {
    stubFetch(() => ({ json: { id: 'cus_1' } }));
    const bad = await connect.createConnectedAccount('sk_test_x', { branchId: 'b1', restaurantId: 'r1' }, 'k');
    expect(bad.ok).toBe(false);

    stubFetch(() => ({ status: 400, json: { error: { type: 'invalid_request_error', code: 'parameter_invalid', message: 'nope' } } }));
    const refused = await connect.createConnectedAccount('sk_test_x', { branchId: 'b1', restaurantId: 'r1' }, 'k');
    expect(refused).toEqual({ ok: false, status: 400, error: { error: { type: 'invalid_request_error', code: 'parameter_invalid', message: 'nope' } } });

    stubFetch(() => new Error('offline'));
    const down = await connect.createConnectedAccount('sk_test_x', { branchId: 'b1', restaurantId: 'r1' }, 'k');
    expect(down).toEqual({ ok: false, status: 0, error: null });
    expect(connect.isRetryableStripeFailure(down.status)).toBe(true);
  });

  it('mints the onboarding link through Account Links v2 and answers its expiry in seconds', async () => {
    stubFetch(() => ({ json: { url: 'https://connect.stripe.com/setup/x', expires_at: '2026-09-24T10:05:00.000Z' } }));
    const urls = connect.onboardingUrls('https://admin.example.com', 'b1');
    const res = await connect.createOnboardingLink('sk_test_x', 'acct_1', urls);
    expect(res).toEqual({
      ok: true,
      status: 200,
      data: { url: 'https://connect.stripe.com/setup/x', expires_at: Date.UTC(2026, 8, 24, 10, 5, 0) / 1000 },
    });
    const c = onlyCall();
    expect(c.url).toBe('https://api.stripe.com/v2/core/account_links');
    expect(c.headers['Stripe-Version']).toBe(connect.STRIPE_V2_API_VERSION);
    expect(c.headers).not.toHaveProperty('Stripe-Account');
    expect(JSON.parse(c.body ?? '{}')).toEqual(connect.onboardingLinkBody('acct_1', urls));
  });

  it('never asks Stripe for a link that would return to http or to a made-up account', async () => {
    stubFetch(() => ({ json: { url: 'https://connect.stripe.com/setup/x' } }));
    const http = await connect.createOnboardingLink('sk_test_x', 'acct_1', {
      return_url: 'http://localhost:3004/b/b1/branch?stripe=return',
      refresh_url: 'http://localhost:3004/b/b1/branch?stripe=refresh',
    });
    expect(http.ok).toBe(false);
    const notAnAccount = await connect.createOnboardingLink('sk_test_x', 'cus_1', connect.onboardingUrls('https://a.example', 'b1'));
    expect(notAnAccount.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reads readiness through GET /v1/accounts/{id} on the pinned v1 version, as the platform', async () => {
    stubFetch(() => ({
      json: {
        id: 'acct_1',
        charges_enabled: true,
        payouts_enabled: false,
        details_submitted: true,
        requirements: { currently_due: ['external_account'], past_due: [], disabled_reason: null },
      },
    }));
    const res = await connect.readAccountState('sk_test_x', 'acct_1');
    expect(res).toEqual({
      ok: true,
      status: 200,
      data: { charges_enabled: true, payouts_enabled: false, details_submitted: true, requirements_due: ['external_account'], disabled_reason: null },
    });
    const c = onlyCall();
    expect(c.url).toBe('https://api.stripe.com/v1/accounts/acct_1');
    expect(c.method).toBe('GET');
    expect(c.headers['Stripe-Version']).toBe(connect.STRIPE_API_VERSION);
    expect(c.headers).not.toHaveProperty('Stripe-Account');
  });

  it('does not read an id that is not an account, and reports Stripe being down as retryable', async () => {
    stubFetch(() => ({ json: {} }));
    expect((await connect.readAccountState('sk_test_x', '../balance')).ok).toBe(false);
    expect(calls).toHaveLength(0);
    stubFetch(() => ({ status: 503 }));
    const down = await connect.readAccountState('sk_test_x', 'acct_1');
    expect(down.ok).toBe(false);
    expect(connect.isRetryableStripeFailure(down.status)).toBe(true);
  });

  it('keeps v1 calls on a connected account form-encoded with the Stripe-Account header', async () => {
    stubFetch(() => ({ json: { id: 're_1' } }));
    await connect.stripeRequest('sk_test_x', 'POST', '/v1/refunds', {
      account: 'acct_1',
      idempotencyKey: 'late_payment_refund:pi_1',
      params: { payment_intent: 'pi_1', amount: 100, metadata: { order_id: 'o1' } },
    });
    const c = onlyCall();
    expect(c.headers['Stripe-Account']).toBe('acct_1');
    expect(c.headers['Stripe-Version']).toBe(connect.STRIPE_API_VERSION);
    expect(c.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(c.body).toBe('payment_intent=pi_1&amount=100&metadata%5Border_id%5D=o1');
  });
});

describe('retries', () => {
  it('retries what Stripe could not answer, never what it refused', () => {
    expect(connect.isRetryableStripeFailure(0)).toBe(true);
    expect(connect.isRetryableStripeFailure(429)).toBe(true);
    expect(connect.isRetryableStripeFailure(503)).toBe(true);
    expect(connect.isRetryableStripeFailure(400)).toBe(false);
    expect(connect.isRetryableStripeFailure(402)).toBe(false);
  });
});
