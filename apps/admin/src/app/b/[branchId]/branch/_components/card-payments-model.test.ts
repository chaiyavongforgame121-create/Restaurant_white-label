import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cardPaymentsStatus,
  connectErrorKey,
  disabledNotice,
  disabledReasonKey,
  requirementGroups,
  shareOptions,
  sharedWith,
  stripeReturnParam,
  withoutStripeParam,
  type CardAccountState,
} from './card-payments-model';

const account = (over: Partial<CardAccountState> = {}): CardAccountState => ({
  stripe_account_id: 'acct_A',
  charges_enabled: false,
  payouts_enabled: false,
  details_submitted: false,
  requirements_due: [],
  disabled_reason: null,
  ...over,
});

describe('cardPaymentsStatus', () => {
  it('is not connected without an account', () => {
    expect(cardPaymentsStatus(null)).toBe('not_connected');
    expect(cardPaymentsStatus(undefined)).toBe('not_connected');
  });

  it('asks to finish setting up until Stripe has the details', () => {
    expect(cardPaymentsStatus(account())).toBe('onboarding');
    expect(cardPaymentsStatus(account({ requirements_due: ['external_account'] }))).toBe('onboarding');
  });

  it('is under review when everything was sent and Stripe is only checking', () => {
    expect(cardPaymentsStatus(account({ details_submitted: true }))).toBe('under_review');
    expect(
      cardPaymentsStatus(account({ details_submitted: true, disabled_reason: 'requirements.pending_verification' })),
    ).toBe('under_review');
    expect(cardPaymentsStatus(account({ details_submitted: true, disabled_reason: 'under_review' }))).toBe('under_review');
  });

  it('is ready when charges are on and nothing is due', () => {
    expect(cardPaymentsStatus(account({ details_submitted: true, charges_enabled: true }))).toBe('ready');
    // Payouts still off is a note on a ready account, not a different state.
    expect(cardPaymentsStatus(account({ details_submitted: true, charges_enabled: true, payouts_enabled: false }))).toBe('ready');
  });

  it('needs action when Stripe wants something, even while cards still work', () => {
    expect(
      cardPaymentsStatus(account({ details_submitted: true, charges_enabled: true, requirements_due: ['company.tax_id'] })),
    ).toBe('action_needed');
    expect(cardPaymentsStatus(account({ details_submitted: true, requirements_due: ['external_account'] }))).toBe('action_needed');
    expect(cardPaymentsStatus(account({ details_submitted: true, disabled_reason: 'rejected.fraud' }))).toBe('action_needed');
    expect(cardPaymentsStatus(account({ details_submitted: true, disabled_reason: 'requirements.past_due' }))).toBe('action_needed');
  });
});

describe('disabledReasonKey', () => {
  it('groups Stripe reasons into what the owner can be told', () => {
    expect(disabledReasonKey(null)).toBeNull();
    expect(disabledReasonKey('rejected.terms_of_service')).toBe('rejected');
    expect(disabledReasonKey('requirements.pending_verification')).toBe('review');
    expect(disabledReasonKey('listed')).toBe('review');
    expect(disabledReasonKey('requirements.past_due')).toBe('pastDue');
    expect(disabledReasonKey('platform_paused')).toBe('paused');
    expect(disabledReasonKey('something_new')).toBe('other');
  });
});

describe('disabledNotice', () => {
  it('stays quiet while the owner is still in Stripe’s form', () => {
    // Stripe's usual reason for an account whose form is not finished: nothing is overdue yet,
    // and "Finish setting up" already says what to do.
    expect(disabledNotice(account({ disabled_reason: 'requirements.past_due', requirements_due: ['external_account'] }))).toBeNull();
    expect(disabledNotice(account({ disabled_reason: 'platform_paused' }))).toBeNull();
    expect(disabledNotice(account({ disabled_reason: 'something_new' }))).toBeNull();
  });

  it('always says a rejection, whatever state the account is in', () => {
    expect(disabledNotice(account({ disabled_reason: 'rejected.fraud' }))).toBe('rejected');
    expect(disabledNotice(account({ details_submitted: true, disabled_reason: 'rejected.terms_of_service' }))).toBe('rejected');
  });

  it('explains why a finished account cannot take cards', () => {
    expect(
      disabledNotice(account({ details_submitted: true, disabled_reason: 'requirements.past_due', requirements_due: ['company.tax_id'] })),
    ).toBe('pastDue');
    expect(disabledNotice(account({ details_submitted: true, disabled_reason: 'platform_paused' }))).toBe('paused');
    expect(disabledNotice(account({ details_submitted: true, disabled_reason: 'something_new' }))).toBe('other');
  });

  it('never shows a review, a ready account or no account as a problem', () => {
    expect(disabledNotice(account({ details_submitted: true, disabled_reason: 'requirements.pending_verification' }))).toBeNull();
    expect(disabledNotice(account({ details_submitted: true, charges_enabled: true, disabled_reason: 'other' }))).toBeNull();
    expect(disabledNotice(null)).toBeNull();
  });
});

describe('requirementGroups', () => {
  it('turns field paths into plain groups, once each, in form order', () => {
    expect(
      requirementGroups([
        'tos_acceptance.date',
        'individual.verification.document',
        'external_account',
        'representative.dob.day',
        'company.tax_id',
        'business_profile.url',
        'person_1Abc.verification.document',
        'settings.payments.statement_descriptor',
      ]),
    ).toEqual(['bank', 'people', 'business', 'profile', 'terms', 'other']);
    expect(requirementGroups([])).toEqual([]);
    expect(requirementGroups(null)).toEqual([]);
  });
});

describe('shareOptions and sharedWith', () => {
  const rows = [
    { ...account({ stripe_account_id: 'acct_A', details_submitted: true, charges_enabled: true }), branch_id: 'b1', branch_name: 'Hamburger' },
    { ...account({ stripe_account_id: 'acct_A', details_submitted: true, charges_enabled: true }), branch_id: 'b2', branch_name: 'Food Thai Thai' },
    { ...account({ stripe_account_id: 'acct_B' }), branch_id: 'b3', branch_name: 'Half done' },
    { ...account({ stripe_account_id: 'acct_C', details_submitted: true }), branch_id: 'b4', branch_name: 'In review' },
  ];

  it('offers each other finished account once, named after every branch it pays', () => {
    expect(shareOptions(rows, 'b9')).toEqual([
      { accountId: 'acct_A', sourceBranchId: 'b1', branchNames: ['Hamburger', 'Food Thai Thai'] },
      { accountId: 'acct_C', sourceBranchId: 'b4', branchNames: ['In review'] },
    ]);
  });

  it('offers only accounts that can take cards or are only being checked', () => {
    const more = [
      ...rows,
      { ...account({ stripe_account_id: 'acct_R', details_submitted: true, disabled_reason: 'rejected.fraud' }), branch_id: 'b5', branch_name: 'Rejected' },
      {
        ...account({ stripe_account_id: 'acct_D', details_submitted: true, requirements_due: ['company.tax_id'], disabled_reason: 'requirements.past_due' }),
        branch_id: 'b6',
        branch_name: 'Past due',
      },
      {
        ...account({ stripe_account_id: 'acct_E', details_submitted: true, charges_enabled: true, requirements_due: ['individual.id_number'] }),
        branch_id: 'b7',
        branch_name: 'Wants more',
      },
    ];
    expect(shareOptions(more, 'b9').map((o) => o.accountId)).toEqual(['acct_A', 'acct_C']);
  });

  it('never offers the branch its own row', () => {
    expect(shareOptions(rows, 'b1').map((o) => o.branchNames)).toEqual([['Food Thai Thai'], ['In review']]);
  });

  it('names the other branches paid into the same account', () => {
    expect(sharedWith(rows, { branch_id: 'b1', stripe_account_id: 'acct_A' })).toEqual(['Food Thai Thai']);
    expect(sharedWith(rows, { branch_id: 'b3', stripe_account_id: 'acct_B' })).toEqual([]);
    expect(sharedWith(rows, null)).toEqual([]);
  });
});

describe('the ?stripe= return', () => {
  it('reads only the two values Stripe is given', () => {
    expect(stripeReturnParam('?stripe=return')).toBe('return');
    expect(stripeReturnParam('?a=1&stripe=refresh')).toBe('refresh');
    expect(stripeReturnParam('?stripe=https://evil.example')).toBeNull();
    expect(stripeReturnParam('')).toBeNull();
  });

  it('drops the parameter and keeps the rest', () => {
    expect(withoutStripeParam('/b/x/branch', '?stripe=return')).toBe('/b/x/branch');
    expect(withoutStripeParam('/b/x/branch', '?tab=a&stripe=refresh')).toBe('/b/x/branch?tab=a');
  });
});

describe('the card payments copy', () => {
  const LOCALES = ['en', 'es', 'th', 'vi'];
  const cardPayments = (locale: string) =>
    (JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../../../messages', locale, 'branchOps.json'), 'utf8')) as {
      cardPayments: { errors: Record<string, string>; disabled: Record<string, string> };
    }).cardPayments;

  it.each(LOCALES)('has every error the card can show in %s, and never promises "nothing changed"', (locale) => {
    const copy = cardPayments(locale);
    const codes = ['forbidden', 'already_connected', 'source_not_connected', 'other_restaurant', 'not_connected', 'admin_url_not_configured', 'stripe_error', 'network', null];
    for (const code of codes) {
      const key = connectErrorKey(code).replace(/^errors\./, '');
      expect(typeof copy.errors[key] === 'string' && copy.errors[key]!.trim().length > 0, `${locale} errors.${key}`).toBe(true);
    }
    expect(copy.errors.generic).not.toBe(copy.errors.stripeRefused);
    for (const key of ['rejected', 'pastDue', 'paused', 'other']) {
      expect(typeof copy.disabled[key] === 'string', `${locale} disabled.${key}`).toBe(true);
    }
  });

  it('does not tell the owner nothing changed when that may not be true', () => {
    // The English words, as the reference the other three follow.
    const en = cardPayments('en').errors;
    expect(en.generic).not.toMatch(/nothing changed/i);
    expect(en.stripeRefused).not.toMatch(/nothing changed/i);
  });
});

describe('connectErrorKey', () => {
  it('maps the function refusals and falls back to the generic message', () => {
    expect(connectErrorKey('forbidden')).toBe('errors.forbidden');
    expect(connectErrorKey('already_connected')).toBe('errors.alreadyConnected');
    // Stripe's own refusal is not "nothing changed, try again": an account may have been created.
    expect(connectErrorKey('stripe_error')).toBe('errors.stripeRefused');
    expect(connectErrorKey('network')).toBe('errors.generic');
    expect(connectErrorKey(undefined)).toBe('errors.generic');
  });
});
