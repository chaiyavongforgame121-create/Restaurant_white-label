// The platform owner's Stripe setup page, as decisions (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md
// §6 and §7).
//
// The stripe-billing `status` action answers booleans and ids only — never a secret — and
// this file turns them into a checklist, the state of the "Charge packages by card"
// switch and the Dashboard links. Nothing here is worded: every sentence is a key in the
// `platformBilling` namespace, rendered by billing-setup-view.tsx.
//
// A status of null means the function could not tell us anything (dormant, not deployed,
// unreachable). Every step then reads 'unknown' rather than 'todo': "not set" would be a
// claim about a secret nobody looked at. The steps and their links are still shown, since
// they are exactly what the owner needs to make the status readable.

import type { StripeBillingStatus } from '@favornoms/database/queries';
import { DEFAULT_UI_LOCALE, intlLocaleFor, type UiLocale } from '@favornoms/shared';
import { stripeDashboardUrl } from '../../_components/stripe-rail';

/** A message in the `platformBilling` namespace plus its values. */
export interface SetupMsg {
  key: string;
  values?: Record<string, string | number>;
}

const msg = (key: string, values?: Record<string, string | number>): SetupMsg =>
  values ? { key, values } : { key };

// --- the webhook the owner creates in Stripe ----------------------------------------

/**
 * The events the package-payment endpoint subscribes to — exactly these (spec §4.3).
 * Never `invoice.created`: the webhook does not handle it, and Stripe would hold every
 * renewal invoice waiting for an answer to it.
 */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.expired',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
  'customer.subscription.trial_will_end',
  'customer.updated',
] as const;

/** The version the webhook reads its events in (EVENT_API_VERSION in _shared/stripe-billing.ts). */
export const WEBHOOK_API_VERSION = '2026-08-26.dahlia';

/** The one live project. */
const PROJECT_REF = 'ayyfczidnzxetndiijmv';

function projectRefOf(supabaseUrl: string | null | undefined): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec((supabaseUrl ?? '').trim());
  return m ? (m[1] ?? null) : null;
}

/**
 * The endpoint URL to paste into Stripe.
 *
 * Built from the app's Supabase URL when that is a hosted project. A local URL
 * (http://127.0.0.1:54321 during development) is never offered: Stripe cannot reach it,
 * and the webhook being configured here is the live project's anyway.
 */
export function webhookEndpointFor(supabaseUrl: string | null | undefined): string {
  return `https://${projectRefOf(supabaseUrl) ?? PROJECT_REF}.supabase.co/functions/v1/stripe-webhook`;
}

/** Where the owner saves STRIPE_WEBHOOK_SECRET: the project's Edge Function secrets. */
export function supabaseSecretsUrl(supabaseUrl: string | null | undefined): string {
  return `https://supabase.com/dashboard/project/${projectRefOf(supabaseUrl) ?? PROJECT_REF}/functions/secrets`;
}

// --- links ------------------------------------------------------------------------------

/** Label: platformBilling.stripe.setup.links.<key>. Every one opens in a new tab. */
export type LinkKey =
  | 'apiKeys'
  | 'onboarding'
  | 'payouts'
  | 'webhooks'
  | 'secrets'
  | 'retries'
  | 'invoices'
  | 'customers'
  | 'subscriptions';

export interface SetupLink {
  key: LinkKey;
  href: string;
}

const DASHBOARD_PATHS: Record<Exclude<LinkKey, 'secrets'>, string> = {
  apiKeys: 'apikeys',
  onboarding: 'account/onboarding',
  payouts: 'settings/payouts',
  webhooks: 'workbench/webhooks',
  retries: 'revenue_recovery/retries',
  invoices: 'invoices',
  customers: 'customers',
  subscriptions: 'subscriptions',
};

function linkTo(key: LinkKey, base: string | null, secretsUrl: string): SetupLink {
  return { key, href: key === 'secrets' ? secretsUrl : stripeDashboardUrl(base, DASHBOARD_PATHS[key]) };
}

/** The Dashboard pages the owner comes back to after setup. */
export function usefulLinks(status: StripeBillingStatus | null): SetupLink[] {
  const base = status?.dashboardBase ?? null;
  return (['payouts', 'retries', 'invoices', 'customers', 'subscriptions', 'webhooks'] as const).map((key) => ({
    key,
    href: stripeDashboardUrl(base, DASHBOARD_PATHS[key]),
  }));
}

// --- the checklist ------------------------------------------------------------------------

export type StepId =
  | 'account'
  | 'publishableKey'
  | 'activation'
  | 'bank'
  | 'webhook'
  | 'retries'
  | 'prices'
  | 'portal';

/**
 * - done: nothing to do.
 * - todo: the owner has to do something.
 * - auto: not there yet, and the switch prepares it by itself.
 * - notNeeded: does not apply in this mode (a test account needs no bank).
 * - manual: a Stripe setting this page cannot read; the owner checks it there.
 * - unknown: the status could not be read.
 */
export type StepState = 'done' | 'todo' | 'auto' | 'notNeeded' | 'manual' | 'unknown';

export interface SetupStep {
  id: StepId;
  state: StepState;
  /** What the status says about this step; null when the state says it all. */
  detail: SetupMsg | null;
  links: SetupLink[];
}

const DATE_TIME_FMTS = new Map<UiLocale, Intl.DateTimeFormat>();

/**
 * A timestamp as this page shows it, pinned to UTC and saying so: the page renders on the
 * server (UTC) and in the owner's browser, and an unpinned time would differ between them.
 */
export function fmtDateTimeUtc(iso: string | null | undefined, locale: UiLocale = DEFAULT_UI_LOCALE): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  let f = DATE_TIME_FMTS.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(intlLocaleFor(locale), {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    DATE_TIME_FMTS.set(locale, f);
  }
  return f.format(at);
}

export function setupSteps(
  status: StripeBillingStatus | null,
  opts: { secretsUrl: string; locale?: UiLocale },
): SetupStep[] {
  const base = status?.dashboardBase ?? null;
  const link = (key: LinkKey) => linkTo(key, base, opts.secretsUrl);
  const account = status?.account ?? null;

  const accountStep = (): SetupStep => {
    const links = [link('apiKeys'), link('secrets')];
    if (!status) return { id: 'account', state: 'unknown', detail: null, links };
    if (!status.secretKeySet) {
      return { id: 'account', state: 'todo', detail: msg('stripe.setup.steps.account.noKey'), links };
    }
    // A key that is set but gets no answer is wrong or revoked — not "connected".
    if (!account) {
      return { id: 'account', state: 'todo', detail: msg('stripe.setup.steps.account.noAnswer'), links };
    }
    return {
      id: 'account',
      state: 'done',
      detail: msg('stripe.setup.steps.account.connected', { id: account.id, mode: status.mode ?? 'unknown' }),
      links: [link('apiKeys')],
    };
  };

  const publishableStep = (): SetupStep => {
    const links = [link('apiKeys'), link('secrets')];
    if (!status) return { id: 'publishableKey', state: 'unknown', detail: null, links };
    return status.publishableKeySet
      ? { id: 'publishableKey', state: 'done', detail: null, links: [] }
      : { id: 'publishableKey', state: 'todo', detail: msg('stripe.setup.steps.publishableKey.missing'), links };
  };

  const activationStep = (): SetupStep => {
    const links = [link('onboarding')];
    if (!status || !account) return { id: 'activation', state: 'unknown', detail: null, links };
    if (account.chargesEnabled && account.payoutsEnabled && account.currentlyDue === 0) {
      return { id: 'activation', state: 'done', detail: null, links: [] };
    }
    // Test mode takes Stripe's test cards before the account is activated, so an unactivated
    // sandbox is not a blocker; it only matters for live mode.
    if (status.mode === 'test') {
      return { id: 'activation', state: 'notNeeded', detail: msg('stripe.setup.steps.activation.testMode'), links };
    }
    // The most useful single sentence: what Stripe still wants, then what it withholds.
    const detail =
      account.currentlyDue > 0
        ? msg('stripe.setup.steps.activation.due', { count: account.currentlyDue })
        : !account.chargesEnabled
          ? msg('stripe.setup.steps.activation.chargesOff')
          : msg('stripe.setup.steps.activation.payoutsOff');
    return { id: 'activation', state: 'todo', detail, links };
  };

  const bankStep = (): SetupStep => {
    const links = [link('payouts')];
    if (!status || !account) return { id: 'bank', state: 'unknown', detail: null, links };
    if (account.hasBank) return { id: 'bank', state: 'done', detail: null, links };
    // The sandbox pays nothing out, so it needs no bank (spec §7.1).
    if (status.mode === 'test') {
      return { id: 'bank', state: 'notNeeded', detail: msg('stripe.setup.steps.bank.testMode'), links };
    }
    return { id: 'bank', state: 'todo', detail: msg('stripe.setup.steps.bank.missing'), links };
  };

  const webhookStep = (): SetupStep => {
    const links = [link('webhooks'), link('secrets')];
    if (!status) return { id: 'webhook', state: 'unknown', detail: null, links };
    if (!status.webhookSecretSet) {
      return { id: 'webhook', state: 'todo', detail: msg('stripe.setup.steps.webhook.missing'), links };
    }
    return {
      id: 'webhook',
      state: 'done',
      detail: status.lastEventAt
        ? msg('stripe.setup.steps.webhook.lastEvent', { date: fmtDateTimeUtc(status.lastEventAt, opts.locale) })
        : msg('stripe.setup.steps.webhook.noEventYet'),
      links,
    };
  };

  // Prices and the portal are prepared by set_enabled. Missing while the switch is OFF is
  // expected ('auto'); missing while it is ON means a merchant's checkout would fail.
  const preparedStep = (id: 'prices' | 'portal', ready: boolean | undefined): SetupStep => {
    if (!status) return { id, state: 'unknown', detail: null, links: [] };
    if (ready) return { id, state: 'done', detail: null, links: [] };
    return status.stripeEnabled
      ? { id, state: 'todo', detail: msg(`stripe.setup.steps.${id}.missingWhileOn`), links: [] }
      : { id, state: 'auto', detail: msg(`stripe.setup.steps.${id}.auto`), links: [] };
  };

  return [
    accountStep(),
    publishableStep(),
    activationStep(),
    bankStep(),
    webhookStep(),
    // Smart Retries "within 1 week" and "cancel the subscription" once they all fail live in
    // Stripe's settings, which the status does not read. Shown every time: the 7-day grace
    // (§9.1) only holds if Stripe gives up within it, and Stripe's own default (2 weeks)
    // would keep retrying a card after the store had gone dark.
    { id: 'retries', state: 'manual', detail: msg('stripe.setup.steps.retries.setting'), links: [link('retries')] },
    preparedStep('prices', status?.pricesReady),
    preparedStep('portal', status?.portalConfigured),
  ];
}

// --- the switch -----------------------------------------------------------------------------

export interface SwitchModel {
  /** Null when the status could not be read: the switch is then neither on nor off here. */
  on: boolean | null;
  canTurnOn: boolean;
  canTurnOff: boolean;
  /** Why it cannot be turned on. Empty when it can, or when it is already on. */
  blockers: SetupMsg[];
  /** Worth reading before turning it on; none of them blocks it. */
  warnings: SetupMsg[];
}

/**
 * "Charge packages by card".
 *
 * Turning it on needs the secret key and the package-payment webhook secret — the same
 * rule set_enabled enforces server-side, so a disabled switch here is a convenience, not
 * the gate. Turning it off is always allowed: it stops NEW card purchases only (§9.9). A
 * restaurant already paying by card keeps renewing, can still change its package (charged
 * to its card) and open the customer portal; restaurants on the manual rail file requests
 * that wait on the Requests tab again.
 */
export function switchModel(status: StripeBillingStatus | null): SwitchModel {
  if (!status) {
    return {
      on: null,
      canTurnOn: false,
      canTurnOff: false,
      blockers: [msg('stripe.setup.switch.blockers.noStatus')],
      warnings: [],
    };
  }
  if (status.stripeEnabled) {
    return { on: true, canTurnOn: false, canTurnOff: true, blockers: [], warnings: [] };
  }
  const blockers: SetupMsg[] = [];
  if (!status.secretKeySet) blockers.push(msg('stripe.setup.switch.blockers.secretKey'));
  if (!status.webhookSecretSet) blockers.push(msg('stripe.setup.switch.blockers.webhookSecret'));

  const warnings: SetupMsg[] = [];
  // Test mode moves no money but still switches packages on — say so before anyone flips it.
  if (status.mode === 'test') warnings.push(msg('stripe.setup.switch.warnings.testMode'));
  // Only live checkouts need an activated account; test mode takes test cards regardless.
  if (status.mode === 'live' && status.account && !status.account.chargesEnabled) {
    warnings.push(msg('stripe.setup.switch.warnings.chargesOff'));
  }
  if (status.mode === 'live' && status.account && !status.account.hasBank) {
    warnings.push(msg('stripe.setup.switch.warnings.noBank'));
  }
  return { on: false, canTurnOn: blockers.length === 0, canTurnOff: false, blockers, warnings };
}

// --- failures -------------------------------------------------------------------------------

const NETWORK = /failed to fetch|fetch failed|networkerror|network request failed|load failed/i;
// The function's own refusal is platform_admin_only: it reads is_platform_admin fresh, while
// the page gate reads the claim in a JWT that can outlive a demotion.
const FORBIDDEN = /stripe_billing_failed:(forbidden|not_platform_admin|platform_admin_only|unauthori[sz]ed|403)\b/i;
// No session in the browser, a token the function rejected (expired, revoked) or never got,
// and the gateway's bare 401 for a JWT it could not verify: all fixed by signing in again.
const NOT_SIGNED_IN = /not_signed_in|stripe_billing_failed:(invalid_token|auth_required|401)\b/i;

/**
 * Why the status could not be read, as a key. The thrown text is for the log: it is a
 * code from callStripeBilling (`stripe_billing_failed:<error or HTTP status>`).
 */
export function statusLoadErrorKey(message: string): string {
  if (NOT_SIGNED_IN.test(message)) return 'stripe.setup.load.notSignedIn';
  if (FORBIDDEN.test(message)) return 'stripe.setup.load.forbidden';
  // The platform answers 404 for a function that was never deployed.
  if (/stripe_billing_failed:(404|not_found)\b/i.test(message)) return 'stripe.setup.load.notDeployed';
  if (NETWORK.test(message)) return 'stripe.setup.load.network';
  return 'stripe.setup.load.failed';
}

/**
 * Why the switch did not move. The switch itself is unchanged in every one of these cases:
 * set_enabled writes it last, after everything it prepares in Stripe.
 */
export function setEnabledErrorKey(message: string): string {
  if (/stripe_billing_failed:not_ready\b/.test(message)) return 'stripe.setup.switch.errors.notReady';
  // A Catalog monthly product (Base, a seat, Delivery) is missing or unpriced, so there is
  // nothing to make the Stripe prices from.
  if (/stripe_billing_failed:catalog_incomplete\b/.test(message)) {
    return 'stripe.setup.switch.errors.catalogIncomplete';
  }
  if (NOT_SIGNED_IN.test(message)) return 'stripe.setup.switch.errors.notSignedIn';
  if (FORBIDDEN.test(message)) return 'stripe.setup.switch.errors.forbidden';
  // Stripe refused while the prices or the customer portal were being prepared.
  if (/stripe_billing_failed:stripe_error\b/.test(message)) return 'stripe.setup.switch.errors.stripeError';
  if (NETWORK.test(message)) return 'stripe.setup.switch.errors.network';
  return 'stripe.setup.switch.errors.failed';
}

// --- the event log -------------------------------------------------------------------------

/**
 * Stripe's event types, and the ones the package-payment code logs itself, as label keys
 * (platformBilling.stripe.setup.events.types.<key>). An unknown type has no key and is
 * shown as it came: a new event nobody named yet must still be visible.
 */
const EVENT_TYPE_KEYS: Record<string, string> = {
  'checkout.session.completed': 'checkoutCompleted',
  'checkout.session.expired': 'checkoutExpired',
  'invoice.paid': 'invoicePaid',
  'invoice.payment_failed': 'invoiceFailed',
  'invoice.payment_action_required': 'invoiceActionRequired',
  'customer.subscription.created': 'subscriptionCreated',
  'customer.subscription.updated': 'subscriptionUpdated',
  'customer.subscription.deleted': 'subscriptionDeleted',
  'customer.subscription.pending_update_applied': 'changeApplied',
  'customer.subscription.pending_update_expired': 'changeExpired',
  'customer.subscription.trial_will_end': 'trialWillEnd',
  'customer.updated': 'customerUpdated',
  'stripe.request_settled': 'requestSettled',
  'stripe.settle_failed': 'settleFailed',
  'stripe.stale_checkout_refunded': 'staleRefunded',
  'billing.expired': 'accessExpired',
};

export function eventLabelKey(type: string): string | null {
  const key = EVENT_TYPE_KEYS[type];
  return key ? `stripe.setup.events.types.${key}` : null;
}

export type EventTone = 'danger' | 'warning' | 'muted';

/** An error is red, a warning amber, everything else quiet. Unknown levels are quiet too. */
export function eventTone(level: string): EventTone {
  const l = level.toLowerCase();
  if (l === 'error') return 'danger';
  if (l === 'warn' || l === 'warning') return 'warning';
  return 'muted';
}
