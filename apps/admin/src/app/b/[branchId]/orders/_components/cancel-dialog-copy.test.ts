import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarizeCardPayment, type CardPaymentRow } from './card-refund';

/**
 * The Orders page's Cancel dialog says what happens to the diner's card before the operator
 * presses the button. Each sentence below is one case order-row-actions.tsx picks between, and a
 * missing one would print its key at an operator in the middle of a cancel.
 */

const MESSAGES = path.resolve(__dirname, '../../../../../../messages');
const LOCALES = ['en', 'es', 'th', 'vi'];
const cancelDialog = (locale: string) =>
  (JSON.parse(fs.readFileSync(path.join(MESSAGES, locale, 'orders.json'), 'utf8')) as {
    actions: { cancelDialog: Record<string, unknown> };
  }).actions.cancelDialog;

const KEYS = [
  'title',
  'body',
  'keep',
  'confirm',
  'confirmRefund',
  'bodyCard',
  'bodyCardUnpaid',
  'bodyCardNothingLeft',
  'bodyCardDisputed',
];

describe('the Cancel dialog copy', () => {
  it.each(LOCALES)('has every case the dialog can show in %s', (locale) => {
    const copy = cancelDialog(locale);
    for (const key of KEYS) {
      const value = copy[key];
      expect(typeof value === 'string' && value.trim().length > 0, `${locale} actions.cancelDialog.${key}`).toBe(true);
    }
  });

  it('does not promise a refund, or claim one was made, for a payment a dispute took back', () => {
    // The state the dialog reads for a cancelled chargeback: paid, disputed, nothing refundable.
    const pay: CardPaymentRow = {
      id: 'pay-1',
      order_id: 'order-1',
      amount: '24.50',
      status: 'completed',
      method: 'card',
      gateway: 'stripe',
      gateway_charge_id: 'pi_1',
      created_at: '2026-09-24T10:00:00Z',
      dispute_status: 'needs_response',
    };
    const state = summarizeCardPayment([pay], []);
    expect(state).toMatchObject({ paid: true, disputed: true, refundable: 0 });
    const en = cancelDialog('en');
    expect(String(en.bodyCardDisputed)).toMatch(/dispute/i);
    expect(String(en.bodyCardDisputed)).not.toMatch(/\{amount\}/);
    expect(en.bodyCardDisputed).not.toBe(en.bodyCardNothingLeft);
  });

  it('is picked for a disputed payment before the refund wording', () => {
    // order-row-actions.tsx chooses the body in one if/else chain; the dispute case must come
    // before "refunds {amount}" and "already refunded".
    const src = fs.readFileSync(path.join(__dirname, 'order-row-actions.tsx'), 'utf8');
    const disputed = src.indexOf("t('actions.cancelDialog.bodyCardDisputed')");
    expect(disputed).toBeGreaterThan(-1);
    expect(disputed).toBeLessThan(src.indexOf("t('actions.cancelDialog.bodyCard', {"));
    expect(disputed).toBeLessThan(src.indexOf("t('actions.cancelDialog.bodyCardNothingLeft')"));
  });
});
