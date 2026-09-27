import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import type { StripeBillingStatus } from '@favornoms/database/queries';
import {
  WEBHOOK_EVENTS,
  eventLabelKey,
  eventTone,
  fmtDateTimeUtc,
  setEnabledErrorKey,
  setupSteps,
  statusLoadErrorKey,
  supabaseSecretsUrl,
  switchModel,
  usefulLinks,
  webhookEndpointFor,
  type SetupMsg,
  type SetupStep,
} from './setup-model';

// The setup page is where the owner decides to charge real cards. A step that reads
// "done" when it is not, or a switch that turns on without the webhook secret, would
// take money the platform then never records — so every state is pinned here, and every
// key the page can produce is proved to exist in all four languages.

const SECRETS = 'https://supabase.com/dashboard/project/ayyfczidnzxetndiijmv/functions/secrets';

function status(over: Partial<StripeBillingStatus> = {}): StripeBillingStatus {
  return {
    mode: 'live',
    secretKeySet: true,
    publishableKeySet: true,
    webhookSecretSet: true,
    connectWebhookSecretSet: true,
    stripeEnabled: false,
    account: {
      id: 'acct_1Plat',
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      currentlyDue: 0,
      hasBank: true,
    },
    portalConfigured: false,
    pricesReady: false,
    lastEventAt: null,
    dashboardBase: 'https://dashboard.stripe.com/acct_1Plat/',
    ...over,
  };
}

const byId = (steps: SetupStep[]) => Object.fromEntries(steps.map((s) => [s.id, s]));

describe('webhook endpoint and secrets', () => {
  it('points Stripe at the hosted project, never at a local URL', () => {
    expect(webhookEndpointFor('https://ayyfczidnzxetndiijmv.supabase.co')).toBe(
      'https://ayyfczidnzxetndiijmv.supabase.co/functions/v1/stripe-webhook',
    );
    expect(webhookEndpointFor('https://abcdefghijklmnopqrst.supabase.co/')).toBe(
      'https://abcdefghijklmnopqrst.supabase.co/functions/v1/stripe-webhook',
    );
    expect(webhookEndpointFor('http://127.0.0.1:54321')).toBe(
      'https://ayyfczidnzxetndiijmv.supabase.co/functions/v1/stripe-webhook',
    );
    expect(webhookEndpointFor(undefined)).toBe(
      'https://ayyfczidnzxetndiijmv.supabase.co/functions/v1/stripe-webhook',
    );
    expect(supabaseSecretsUrl('https://ayyfczidnzxetndiijmv.supabase.co')).toBe(SECRETS);
  });

  it('subscribes to exactly the spec §4.3 events, and never invoice.created', () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual(
      [
        'checkout.session.completed',
        'checkout.session.expired',
        'customer.subscription.created',
        'customer.subscription.deleted',
        'customer.subscription.pending_update_applied',
        'customer.subscription.pending_update_expired',
        'customer.subscription.trial_will_end',
        'customer.subscription.updated',
        'customer.updated',
        'invoice.paid',
        'invoice.payment_action_required',
        'invoice.payment_failed',
      ].sort(),
    );
    expect(WEBHOOK_EVENTS).not.toContain('invoice.created');
    expect(new Set(WEBHOOK_EVENTS).size).toBe(WEBHOOK_EVENTS.length);
  });
});

describe('setupSteps', () => {
  it('reads every step as unknown when the status could not be read, links still there', () => {
    const steps = setupSteps(null, { secretsUrl: SECRETS });
    expect(steps.map((s) => s.id)).toEqual([
      'account',
      'publishableKey',
      'activation',
      'bank',
      'webhook',
      'retries',
      'prices',
      'portal',
    ]);
    for (const s of steps) {
      expect(s.state, s.id).toBe(s.id === 'retries' ? 'manual' : 'unknown');
    }
    const s = byId(steps);
    // Without a base, links open the bare Dashboard inside the signed-in account.
    expect(s.webhook!.links).toEqual([
      { key: 'webhooks', href: 'https://dashboard.stripe.com/workbench/webhooks' },
      { key: 'secrets', href: SECRETS },
    ]);
    expect(s.retries!.links).toEqual([
      { key: 'retries', href: 'https://dashboard.stripe.com/revenue_recovery/retries' },
    ]);
    // The exact setting, every time: retry within 1 week (inside the 7-day grace), then cancel.
    expect(s.retries!.detail).toEqual({ key: 'stripe.setup.steps.retries.setting' });
  });

  it('reads a fully set-up live account as done, with its id and mode', () => {
    const s = byId(setupSteps(status({ pricesReady: true, portalConfigured: true }), { secretsUrl: SECRETS }));
    expect(s.account).toMatchObject({
      state: 'done',
      detail: { key: 'stripe.setup.steps.account.connected', values: { id: 'acct_1Plat', mode: 'live' } },
    });
    for (const id of ['publishableKey', 'activation', 'bank', 'webhook', 'prices', 'portal']) {
      expect(s[id]!.state, id).toBe('done');
    }
    expect(s.webhook!.detail).toEqual({ key: 'stripe.setup.steps.webhook.noEventYet' });
    expect(s.bank!.links[0]!.href).toBe('https://dashboard.stripe.com/acct_1Plat/settings/payouts');
  });

  it('says what is missing', () => {
    const s = byId(
      setupSteps(
        status({
          secretKeySet: false,
          publishableKeySet: false,
          webhookSecretSet: false,
          account: null,
        }),
        { secretsUrl: SECRETS },
      ),
    );
    expect(s.account).toMatchObject({ state: 'todo', detail: { key: 'stripe.setup.steps.account.noKey' } });
    expect(s.publishableKey!.state).toBe('todo');
    expect(s.webhook).toMatchObject({ state: 'todo', detail: { key: 'stripe.setup.steps.webhook.missing' } });
    // No account answer: activation and bank cannot be judged.
    expect(s.activation!.state).toBe('unknown');
    expect(s.bank!.state).toBe('unknown');
  });

  it('does not call a key that gets no answer from Stripe "connected"', () => {
    const s = byId(setupSteps(status({ account: null }), { secretsUrl: SECRETS }));
    expect(s.account).toMatchObject({ state: 'todo', detail: { key: 'stripe.setup.steps.account.noAnswer' } });
  });

  it('points an account Stripe has not activated at onboarding', () => {
    const due = status({
      account: { ...status().account!, currentlyDue: 3, payoutsEnabled: false },
    });
    expect(byId(setupSteps(due, { secretsUrl: SECRETS })).activation).toEqual({
      id: 'activation',
      state: 'todo',
      detail: { key: 'stripe.setup.steps.activation.due', values: { count: 3 } },
      links: [{ key: 'onboarding', href: 'https://dashboard.stripe.com/acct_1Plat/account/onboarding' }],
    });
    const payoutsOnly = status({ account: { ...status().account!, payoutsEnabled: false } });
    expect(byId(setupSteps(payoutsOnly, { secretsUrl: SECRETS })).activation!.detail).toEqual({
      key: 'stripe.setup.steps.activation.payoutsOff',
    });
    const chargesOff = status({ account: { ...status().account!, chargesEnabled: false } });
    expect(byId(setupSteps(chargesOff, { secretsUrl: SECRETS })).activation!.detail).toEqual({
      key: 'stripe.setup.steps.activation.chargesOff',
    });
  });

  it('does not ask a sandbox to be activated: test cards work before activation', () => {
    const sandbox = status({ mode: 'test', account: { ...status().account!, chargesEnabled: false, currentlyDue: 2 } });
    expect(byId(setupSteps(sandbox, { secretsUrl: SECRETS })).activation).toMatchObject({
      state: 'notNeeded',
      detail: { key: 'stripe.setup.steps.activation.testMode' },
    });
  });

  it('needs no bank in test mode, and one in live mode', () => {
    const noBank = { ...status().account!, hasBank: false };
    expect(byId(setupSteps(status({ mode: 'test', account: noBank }), { secretsUrl: SECRETS })).bank!.state).toBe(
      'notNeeded',
    );
    expect(byId(setupSteps(status({ mode: 'live', account: noBank }), { secretsUrl: SECRETS })).bank!.state).toBe(
      'todo',
    );
  });

  it('treats missing prices as automatic while off, and as a fault while on', () => {
    const off = byId(setupSteps(status(), { secretsUrl: SECRETS }));
    expect(off.prices).toMatchObject({ state: 'auto', detail: { key: 'stripe.setup.steps.prices.auto' } });
    expect(off.portal).toMatchObject({ state: 'auto', detail: { key: 'stripe.setup.steps.portal.auto' } });
    const on = byId(setupSteps(status({ stripeEnabled: true }), { secretsUrl: SECRETS }));
    expect(on.prices).toMatchObject({ state: 'todo', detail: { key: 'stripe.setup.steps.prices.missingWhileOn' } });
    expect(on.portal!.state).toBe('todo');
  });

  it('shows when the last event arrived, in UTC', () => {
    const s = byId(setupSteps(status({ lastEventAt: '2026-09-26T14:03:00Z' }), { secretsUrl: SECRETS, locale: 'en' }));
    expect(s.webhook!.detail).toEqual({
      key: 'stripe.setup.steps.webhook.lastEvent',
      values: { date: fmtDateTimeUtc('2026-09-26T14:03:00Z', 'en') },
    });
  });
});

describe('switchModel', () => {
  it('cannot be moved while the status is unknown', () => {
    expect(switchModel(null)).toEqual({
      on: null,
      canTurnOn: false,
      canTurnOff: false,
      blockers: [{ key: 'stripe.setup.switch.blockers.noStatus' }],
      warnings: [],
    });
  });

  it('refuses to turn on without the secret key and the webhook secret', () => {
    const m = switchModel(status({ secretKeySet: false, webhookSecretSet: false, account: null }));
    expect(m.canTurnOn).toBe(false);
    expect(m.blockers.map((b) => b.key)).toEqual([
      'stripe.setup.switch.blockers.secretKey',
      'stripe.setup.switch.blockers.webhookSecret',
    ]);
    expect(switchModel(status({ webhookSecretSet: false })).canTurnOn).toBe(false);
  });

  it('turns on when both are set, warning about test mode and, live only, an unfinished account', () => {
    const live = switchModel(status());
    expect(live).toMatchObject({ on: false, canTurnOn: true, canTurnOff: false, blockers: [], warnings: [] });
    // Test mode takes test cards before activation, so an unactivated sandbox is no warning.
    const test = switchModel(
      status({ mode: 'test', account: { ...status().account!, chargesEnabled: false, hasBank: false } }),
    );
    expect(test.canTurnOn).toBe(true);
    expect(test.warnings.map((w) => w.key)).toEqual(['stripe.setup.switch.warnings.testMode']);
    const liveUnactivated = switchModel(status({ account: { ...status().account!, chargesEnabled: false } }));
    expect(liveUnactivated.warnings.map((w) => w.key)).toEqual(['stripe.setup.switch.warnings.chargesOff']);
    expect(switchModel(status({ account: { ...status().account!, hasBank: false } })).warnings).toEqual([
      { key: 'stripe.setup.switch.warnings.noBank' },
    ]);
  });

  it('can always be turned off once on', () => {
    expect(switchModel(status({ stripeEnabled: true, webhookSecretSet: false }))).toEqual({
      on: true,
      canTurnOn: false,
      canTurnOff: true,
      blockers: [],
      warnings: [],
    });
  });
});

describe('failures', () => {
  it('names why the status could not be read', () => {
    expect(statusLoadErrorKey('not_signed_in')).toBe('stripe.setup.load.notSignedIn');
    expect(statusLoadErrorKey('stripe_billing_failed:forbidden')).toBe('stripe.setup.load.forbidden');
    expect(statusLoadErrorKey('stripe_billing_failed:403')).toBe('stripe.setup.load.forbidden');
    expect(statusLoadErrorKey('stripe_billing_failed:404')).toBe('stripe.setup.load.notDeployed');
    expect(statusLoadErrorKey('TypeError: Failed to fetch')).toBe('stripe.setup.load.network');
    expect(statusLoadErrorKey('stripe_billing_failed:stripe_error')).toBe('stripe.setup.load.failed');
    // A status code that merely starts with 404 is not "not deployed".
    expect(statusLoadErrorKey('stripe_billing_failed:4040')).toBe('stripe.setup.load.failed');
  });

  it("maps the function's own refusal codes, not only the HTTP statuses", () => {
    // The function reads is_platform_admin fresh; the page gate reads a JWT claim that can
    // outlive a demotion.
    expect(statusLoadErrorKey('stripe_billing_failed:platform_admin_only')).toBe('stripe.setup.load.forbidden');
    // A token the function rejected, none sent, or the gateway's bare 401: sign in again.
    expect(statusLoadErrorKey('stripe_billing_failed:invalid_token')).toBe('stripe.setup.load.notSignedIn');
    expect(statusLoadErrorKey('stripe_billing_failed:auth_required')).toBe('stripe.setup.load.notSignedIn');
    expect(statusLoadErrorKey('stripe_billing_failed:401')).toBe('stripe.setup.load.notSignedIn');
  });

  it('names why the switch did not move', () => {
    expect(setEnabledErrorKey('stripe_billing_failed:not_ready')).toBe('stripe.setup.switch.errors.notReady');
    expect(setEnabledErrorKey('stripe_billing_failed:catalog_incomplete')).toBe(
      'stripe.setup.switch.errors.catalogIncomplete',
    );
    expect(setEnabledErrorKey('stripe_billing_failed:403')).toBe('stripe.setup.switch.errors.forbidden');
    expect(setEnabledErrorKey('stripe_billing_failed:platform_admin_only')).toBe('stripe.setup.switch.errors.forbidden');
    expect(setEnabledErrorKey('not_signed_in')).toBe('stripe.setup.switch.errors.notSignedIn');
    expect(setEnabledErrorKey('stripe_billing_failed:invalid_token')).toBe('stripe.setup.switch.errors.notSignedIn');
    expect(setEnabledErrorKey('stripe_billing_failed:auth_required')).toBe('stripe.setup.switch.errors.notSignedIn');
    expect(setEnabledErrorKey('stripe_billing_failed:stripe_error')).toBe('stripe.setup.switch.errors.stripeError');
    expect(setEnabledErrorKey('Failed to fetch')).toBe('stripe.setup.switch.errors.network');
    expect(setEnabledErrorKey('stripe_billing_failed:500')).toBe('stripe.setup.switch.errors.failed');
    // Only the code itself: a longer code that merely starts with it is not the same refusal.
    expect(setEnabledErrorKey('stripe_billing_failed:not_ready_yet')).toBe('stripe.setup.switch.errors.failed');
  });
});

describe('event log', () => {
  it('names known events and leaves unknown ones as they came', () => {
    expect(eventLabelKey('invoice.paid')).toBe('stripe.setup.events.types.invoicePaid');
    expect(eventLabelKey('stripe.settle_failed')).toBe('stripe.setup.events.types.settleFailed');
    expect(eventLabelKey('something.new')).toBeNull();
    // Every subscribed event has a name.
    for (const e of WEBHOOK_EVENTS) expect(eventLabelKey(e), e).not.toBeNull();
  });

  it('colours by level, quietly for anything unknown', () => {
    expect(eventTone('error')).toBe('danger');
    expect(eventTone('warn')).toBe('warning');
    expect(eventTone('WARNING')).toBe('warning');
    expect(eventTone('info')).toBe('muted');
    expect(eventTone('debug')).toBe('muted');
  });

  it('formats times pinned to UTC and says so', () => {
    const en = fmtDateTimeUtc('2026-09-26T14:03:00Z', 'en');
    expect(en).toContain('2026');
    expect(en).toContain('14:03');
    expect(en).toContain('UTC');
    expect(fmtDateTimeUtc(null)).toBe('—');
    expect(fmtDateTimeUtc('not a date')).toBe('—');
  });
});

describe('useful links', () => {
  it('opens each page in the account the status named', () => {
    expect(usefulLinks(status({ dashboardBase: 'https://dashboard.stripe.com/acct_1/test/' }))).toEqual([
      { key: 'payouts', href: 'https://dashboard.stripe.com/acct_1/test/settings/payouts' },
      { key: 'retries', href: 'https://dashboard.stripe.com/acct_1/test/revenue_recovery/retries' },
      { key: 'invoices', href: 'https://dashboard.stripe.com/acct_1/test/invoices' },
      { key: 'customers', href: 'https://dashboard.stripe.com/acct_1/test/customers' },
      { key: 'subscriptions', href: 'https://dashboard.stripe.com/acct_1/test/subscriptions' },
      { key: 'webhooks', href: 'https://dashboard.stripe.com/acct_1/test/workbench/webhooks' },
    ]);
  });
});

// --- the words ----------------------------------------------------------------------------

type Tree = { [key: string]: string | Tree };
const LOCALES = ['en', 'es', 'th', 'vi'] as const;
const catalogue = (locale: string, ns: string): Tree =>
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../../../messages', locale, `${ns}.json`), 'utf8'),
  ) as Tree;

function leaves(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : leaves(v, `${prefix}${k}.`),
  );
}

// Every argument and tag any of the new messages takes. A message that needs one missing
// from here fails to render below, which is the point.
const tag = (chunks: string) => chunks;
const VALUES = {
  count: 2,
  date: 'Oct 7, 2026',
  amount: '$59',
  name: 'Pho Corner',
  id: 'acct_1Plat',
  mode: 'test',
  expiry: '08/27',
  brand: 'Visa',
  last4: '4242',
  version: '2026-08-26.dahlia',
  code: tag,
  link: tag,
  strong: tag,
  b: tag,
};

function render(ns: string, tree: Tree, locale: string, key: string, values: Record<string, unknown> = VALUES) {
  const t = createTranslator({
    locale,
    messages: { [ns]: tree },
    namespace: ns,
    onError: (error) => {
      throw error;
    },
  });
  return (t as unknown as { markup: (k: string, v: Record<string, unknown>) => string }).markup(key, values);
}

describe('platformBilling.stripe messages', () => {
  const en = catalogue('en', 'platformBilling');
  const enKeys = leaves(en.stripe as Tree).sort();

  // Keys the model produces, gathered from every state it can reach.
  const produced: string[] = [];
  const collectSteps = (s: StripeBillingStatus | null) => {
    for (const step of setupSteps(s, { secretsUrl: SECRETS })) {
      produced.push(`stripe.setup.steps.${step.id}.title`, `stripe.setup.steps.${step.id}.body`);
      produced.push(`stripe.setup.state.${step.state}`);
      if (step.detail) produced.push(step.detail.key);
      for (const l of step.links) produced.push(`stripe.setup.links.${l.key}`);
    }
    const m = switchModel(s);
    produced.push(...[...m.blockers, ...m.warnings].map((x: SetupMsg) => x.key));
  };
  collectSteps(null);
  collectSteps(status());
  collectSteps(status({ pricesReady: true, portalConfigured: true, lastEventAt: '2026-09-26T00:00:00Z' }));
  collectSteps(status({ stripeEnabled: true }));
  collectSteps(status({ secretKeySet: false, publishableKeySet: false, webhookSecretSet: false, account: null }));
  collectSteps(status({ account: null }));
  collectSteps(status({ mode: 'test', account: { ...status().account!, hasBank: false, chargesEnabled: false } }));
  collectSteps(status({ account: { ...status().account!, hasBank: false, currentlyDue: 1 } }));
  collectSteps(status({ account: { ...status().account!, payoutsEnabled: false } }));
  for (const l of usefulLinks(null)) produced.push(`stripe.setup.links.${l.key}`);
  for (const e of [...WEBHOOK_EVENTS, 'stripe.request_settled', 'stripe.settle_failed', 'stripe.stale_checkout_refunded', 'billing.expired']) {
    const k = eventLabelKey(e);
    if (k) produced.push(k);
  }
  for (const m of [
    'not_signed_in',
    'stripe_billing_failed:403',
    'stripe_billing_failed:404',
    'stripe_billing_failed:platform_admin_only',
    'stripe_billing_failed:invalid_token',
    'stripe_billing_failed:auth_required',
    'stripe_billing_failed:not_ready',
    'stripe_billing_failed:catalog_incomplete',
    'stripe_billing_failed:stripe_error',
    'Failed to fetch',
    'x',
  ]) {
    produced.push(statusLoadErrorKey(m), setEnabledErrorKey(m));
  }

  it('produces only keys that exist in English', () => {
    const all = new Set(leaves(en));
    for (const k of new Set(produced)) expect(all.has(k), k).toBe(true);
  });

  for (const locale of LOCALES) {
    it(`has the same stripe keys in ${locale} and renders every one`, () => {
      const tree = catalogue(locale, 'platformBilling');
      expect(leaves(tree.stripe as Tree).sort()).toEqual(enKeys);
      expect(leaves(tree).includes('requests.status.cancelled')).toBe(true);
      for (const key of enKeys) {
        expect(render('platformBilling', tree, locale, `stripe.${key}`).trim(), `${locale} stripe.${key}`).not.toBe('');
      }
    });
  }

  it('picks the mode by name in the account line', () => {
    expect(render('platformBilling', en, 'en', 'stripe.setup.steps.account.connected', { ...VALUES, mode: 'live' })).toBe(
      'acct_1Plat · live mode',
    );
  });
});

describe('platform.stripe messages', () => {
  const en = catalogue('en', 'platform');
  const enKeys = leaves(en.stripe as Tree).sort();
  for (const locale of LOCALES) {
    it(`has the same stripe keys and the nav tab in ${locale}, and renders every one`, () => {
      const tree = catalogue(locale, 'platform');
      expect(leaves(tree.stripe as Tree).sort()).toEqual(enKeys);
      expect(typeof (tree.nav as Tree).stripe).toBe('string');
      for (const key of enKeys) {
        expect(render('platform', tree, locale, `stripe.${key}`).trim(), `${locale} stripe.${key}`).not.toBe('');
      }
    });
  }
});
