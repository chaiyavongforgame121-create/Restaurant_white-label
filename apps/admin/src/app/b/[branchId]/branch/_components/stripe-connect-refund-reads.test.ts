import { afterEach, describe, expect, it, vi } from 'vitest';
import * as connect from '../../../../../../../../supabase/functions/_shared/stripe-connect';

/**
 * How stripe-connect-webhook reads refund state before it records it, pinned from here because a
 * Deno function cannot run under this app's test runner but the shared module it calls can.
 *
 * What is at stake: whether the books say a diner's card money went back. Stripe sends events out
 * of order, retries arrive hours late, and a refund that succeeded can still fail afterwards. A
 * stale 'succeeded' or 'refunded: true' snapshot recorded after the failure let staff cancel or
 * mark the order refunded with nothing sent back, so the webhook records what Stripe says now.
 */

type Call = { url: string; method: string; headers: Record<string, string> };
let calls: Call[] = [];

function stubFetch(answer: (call: Call) => { status?: number; json?: unknown } | Error) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: Call = { url: String(url), method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const a = answer(call);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refund events record the refund as Stripe has it now', () => {
  it('re-reads the refund on the connected account and returns the current object', async () => {
    stubFetch(() => ({ json: { id: 're_1', amount: 1000, status: 'failed' } }));
    const snapshot = { id: 're_1', amount: 1000, status: 'succeeded' };
    const read = await connect.currentRefund('sk_test_x', 'acct_1', snapshot);
    expect(read).toEqual({ refund: { id: 're_1', amount: 1000, status: 'failed' }, fresh: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/refunds/re_1');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['Stripe-Account']).toBe('acct_1');
    expect(calls[0]?.headers['Stripe-Version']).toBe(connect.STRIPE_API_VERSION);
  });

  it('falls back to the snapshot when Stripe cannot be read or answers about another refund', async () => {
    const snapshot = { id: 're_1', amount: 1000, status: 'succeeded' };
    stubFetch(() => ({ status: 503 }));
    expect(await connect.currentRefund('sk_test_x', 'acct_1', snapshot)).toEqual({ refund: snapshot, fresh: false, status: 503 });
    stubFetch(() => ({ json: { id: 're_OTHER', status: 'succeeded' } }));
    expect((await connect.currentRefund('sk_test_x', 'acct_1', snapshot)).fresh).toBe(false);
  });

  it('never puts an id that is not a plain Stripe id into a URL', async () => {
    stubFetch(() => ({ json: {} }));
    const snapshot = { id: '../v1/balance', status: 'succeeded' };
    expect(await connect.currentRefund('sk_test_x', 'acct_1', snapshot)).toEqual({ refund: snapshot, fresh: false, status: 0 });
    expect(await connect.currentRefund('sk_test_x', 'not-an-account', { id: 're_1' })).toMatchObject({ fresh: false });
    expect(calls).toHaveLength(0);
    expect(connect.isStripeObjectId('re_3Q2w3E4r5T6y7U8i')).toBe(true);
    expect(connect.isStripeObjectId('ch_1/../../x')).toBe(false);
    expect(connect.isStripeObjectId(42)).toBe(false);
  });
});

describe('charge.refunded never applies its own snapshot', () => {
  it('lists the charge’s refunds on the connected account and hands them over to be recorded', async () => {
    stubFetch(() => ({ json: { data: [{ id: 're_1', status: 'failed' }, { id: 're_2', status: 'succeeded' }] } }));
    const read = await connect.readChargeRefunds('sk_test_x', 'acct_1', 'ch_1');
    expect(read).toEqual({ kind: 'refunds', refunds: [{ id: 're_1', status: 'failed' }, { id: 're_2', status: 'succeeded' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/refunds?charge=ch_1&limit=100');
    expect(calls[0]?.headers['Stripe-Account']).toBe('acct_1');
  });

  it('re-reads the Charge only when the listing cannot be read, and returns the fresh one', async () => {
    const fresh = { id: 'ch_1', refunded: false, amount_refunded: 0 };
    stubFetch((c) => (c.url.includes('/v1/refunds') ? { status: 500 } : { json: fresh }));
    const read = await connect.readChargeRefunds('sk_test_x', 'acct_1', 'ch_1');
    expect(read).toEqual({ kind: 'charge', charge: fresh, refundsStatus: 500 });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.stripe.com/v1/refunds?charge=ch_1&limit=100',
      'https://api.stripe.com/v1/charges/ch_1',
    ]);
    expect(calls.every((c) => c.headers['Stripe-Account'] === 'acct_1')).toBe(true);
  });

  it('asks for a redelivery when Stripe was unreachable, and not when it refused', async () => {
    stubFetch(() => ({ status: 503 }));
    expect(await connect.readChargeRefunds('sk_test_x', 'acct_1', 'ch_1')).toEqual({
      kind: 'unreadable', retry: true, refundsStatus: 503, chargeStatus: 503,
    });
    stubFetch(() => new Error('network down'));
    expect(await connect.readChargeRefunds('sk_test_x', 'acct_1', 'ch_1')).toMatchObject({ kind: 'unreadable', retry: true });
    stubFetch(() => ({ status: 403 }));
    expect(await connect.readChargeRefunds('sk_test_x', 'acct_1', 'ch_1')).toEqual({
      kind: 'unreadable', retry: false, refundsStatus: 403, chargeStatus: 403,
    });
  });

  it('does not apply a Charge answer about another object', async () => {
    stubFetch((c) => (c.url.includes('/v1/refunds') ? { status: 400 } : { json: { id: 'ch_OTHER', refunded: true } }));
    expect(await connect.readChargeRefunds('sk_test_x', 'acct_1', 'ch_1')).toEqual({
      kind: 'unreadable', retry: false, refundsStatus: 400, chargeStatus: 200,
    });
  });

  it('reads nothing for an event without a usable charge id', async () => {
    stubFetch(() => ({ json: {} }));
    expect(await connect.readChargeRefunds('sk_test_x', 'acct_1', undefined)).toEqual({ kind: 'no_charge' });
    expect(await connect.readChargeRefunds('sk_test_x', 'acct_1', 'ch_1?expand[]=x')).toEqual({ kind: 'no_charge' });
    expect(calls).toHaveLength(0);
  });
});
