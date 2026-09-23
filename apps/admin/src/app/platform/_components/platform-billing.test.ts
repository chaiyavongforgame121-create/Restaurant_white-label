import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  billingErrorOf,
  decisionErrorKey,
  formatMoney,
  requestAsk,
  requestOneTime,
  type PlatformBranchLite,
} from './platform-billing';

// Money and refusals. Both are places where a plausible-looking wrong answer is
// worse than a crash: a blended total or a swallowed "that code is gone" reads as
// success to the operator approving it.

const branch = (id: string, name: string, isActive = true): PlatformBranchLite => ({
  id,
  name,
  isActive,
});

const BRANCHES = [
  branch('b1', 'Riverside'),
  branch('b2', 'Food Thai Thai'),
  branch('b3', 'Airport', false),
];

describe('formatMoney', () => {
  it('shows whole catalog prices without cents', () => {
    expect(formatMoney(228)).toBe('$228');
    expect(formatMoney(0)).toBe('$0');
  });

  it('keeps the cents a percentage code creates', () => {
    // 20% off 198 is 158.40 — rounding that to $158 would not match the ledger.
    expect(formatMoney(158.4)).toBe('$158.40');
    expect(formatMoney(39.6)).toBe('$39.60');
  });

  it('never renders NaN at an operator', () => {
    expect(formatMoney(Number.NaN)).toBe('$0');
  });
});

describe('requestAsk', () => {
  it('names the branches a request asks delivery for', () => {
    const ask = requestAsk(2, ['b2'], BRANCHES);
    expect(ask.seats).toBe(2);
    expect(ask.deliveryBranchNames).toEqual(['Food Thai Thai']);
    expect(ask.unnamedDeliveryBranches).toBe(0);
  });

  it('keeps the branch list order, not the request array order', () => {
    const ask = requestAsk(3, ['b2', 'b1'], BRANCHES);
    expect(ask.deliveryBranchNames).toEqual(['Riverside', 'Food Thai Thai']);
  });

  it('counts an id it cannot name rather than dropping it', () => {
    // A branch deleted after the request was raised still changes what approving
    // does, so the card has to admit there is one.
    const ask = requestAsk(2, ['b1', 'gone'], BRANCHES);
    expect(ask.deliveryBranchNames).toEqual(['Riverside']);
    expect(ask.unnamedDeliveryBranches).toBe(1);
  });

  it('collapses a repeated id', () => {
    const ask = requestAsk(1, ['b1', 'b1'], BRANCHES);
    expect(ask.deliveryBranchNames).toEqual(['Riverside']);
    expect(ask.unnamedDeliveryBranches).toBe(0);
  });

  it('never reports fewer than one seat', () => {
    expect(requestAsk(0, [], BRANCHES).seats).toBe(1);
  });

  it('includes a hidden branch, because approving still switches it', () => {
    expect(requestAsk(3, ['b3'], BRANCHES).deliveryBranchNames).toEqual(['Airport']);
  });
});

describe('requestOneTime', () => {
  it('adds the discount back to reach the list price', () => {
    // one_time_total is stored NET of the discount.
    const money = requestOneTime({
      one_time_total: 158,
      discount_amount: 40,
      discount_code: 'SUMMER',
    });
    expect(money.net).toBe(158);
    expect(money.discount).toBe(40);
    expect(money.gross).toBe(198);
    expect(money.code).toBe('SUMMER');
  });

  it('does not name a code that took nothing off', () => {
    const money = requestOneTime({
      one_time_total: 198,
      discount_amount: 0,
      discount_code: 'EXPIRED',
    });
    expect(money.gross).toBe(198);
    expect(money.code).toBeNull();
  });

  it('treats a fully bought package as nothing to pay once', () => {
    const money = requestOneTime({ one_time_total: 0, discount_amount: 0, discount_code: null });
    expect(money.gross).toBe(0);
    expect(money.net).toBe(0);
  });
});

describe('billingErrorOf', () => {
  it('decodes a seat count the branches no longer fit into', () => {
    expect(billingErrorOf('plan_limit_exceeded:branches:3/2')).toEqual({
      kind: 'seats',
      current: 3,
      limit: 2,
    });
  });

  it('returns null for a refusal with no contract code', () => {
    expect(billingErrorOf('request_already_decided')).toBeNull();
  });
});

describe('decisionErrorKey', () => {
  it('names the refusals the RPC raises by hand', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(decisionErrorKey('request_already_decided')).toBe('errors.alreadyDecided');
    expect(decisionErrorKey('request_not_found')).toBe('errors.requestNotFound');
    expect(decisionErrorKey('permission denied for table')).toBe('errors.permission');
    expect(decisionErrorKey('TypeError: Failed to fetch')).toBe('errors.network');
    expect(decisionErrorKey('something nobody has seen')).toBe('errors.decisionFailed');
    expect(decisionErrorKey(undefined)).toBe('errors.decisionFailed');
    spy.mockRestore();
  });

  it('has a message for every key it can return, in every language', () => {
    const keys = [
      'alreadyDecided',
      'requestNotFound',
      'permission',
      'network',
      'decisionFailed',
      'saveFailed',
    ];
    for (const locale of ['en', 'es', 'th', 'vi']) {
      const file = path.resolve(__dirname, '../../../../messages', locale, 'platformBilling.json');
      const tree = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        errors: Record<string, string>;
      };
      for (const key of keys) {
        expect(tree.errors[key], `${locale}.errors.${key}`).toBeTruthy();
      }
    }
  });
});
