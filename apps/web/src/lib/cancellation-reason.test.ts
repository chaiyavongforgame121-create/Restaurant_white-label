import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_CANCELLATION_REASONS, cancellationReasonKey } from './cancellation-reason';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('cancellationReasonKey', () => {
  it('says the machine-written and preset reasons in the diner’s language', () => {
    expect(cancellationReasonKey('The card payment was not completed within 30 minutes.')).toBe('cardExpired');
    expect(cancellationReasonKey('The card payment could not be set up.')).toBe('cardSetupFailed');
    expect(cancellationReasonKey('Payment slip was not accepted.')).toBe('slipRejected');
    expect(cancellationReasonKey('Rejected by kitchen')).toBe('kitchenRejected');
    expect(cancellationReasonKey('Admin canceled')).toBe('restaurantCancelled');
    expect(cancellationReasonKey('No rider available')).toBe('noRider');
    // Stored text that picked up stray spacing or capitals on the way is still recognised.
    expect(cancellationReasonKey('  rejected   BY kitchen ')).toBe('kitchenRejected');
  });

  it('leaves whatever a person typed exactly as they typed it', () => {
    expect(cancellationReasonKey('Out of salmon tonight, sorry!')).toBeNull();
    expect(cancellationReasonKey('Rejected by kitchen: no gas')).toBeNull();
    expect(cancellationReasonKey('')).toBeNull();
    expect(cancellationReasonKey(null)).toBeNull();
  });

  // Each sentence is recognised only while its writer spells it exactly so. A reworded writer
  // would silently put the English back in front of every diner; this fails first instead.
  const WRITERS: Record<string, string[]> = {
    cardExpired: ['supabase/migrations/20260925100000_stripe_connect_payments.sql'],
    cardSetupFailed: ['supabase/functions/place-order/index.ts'],
    slipRejected: ['supabase/migrations/20260918100000_branch_staff_parity.sql'],
    customerCancelled: ['apps/web/src/app/r/[restaurant]/[branch]/orders/[orderNumber]/_components/order-actions.tsx'],
    kitchenRejected: ['apps/admin/src/app/kitchen/[branchId]/_components/kitchen-view.tsx'],
    restaurantCancelled: ['apps/admin/src/app/b/[branchId]/orders/_components/order-row-actions.tsx'],
    kitchenCannotMake: ['apps/admin/src/app/b/[branchId]/deliveries/_components/live-ops-view.tsx'],
    customerAsked: ['apps/admin/src/app/b/[branchId]/deliveries/_components/live-ops-view.tsx'],
    noRider: ['apps/admin/src/app/b/[branchId]/deliveries/_components/live-ops-view.tsx'],
    duplicate: ['apps/admin/src/app/b/[branchId]/deliveries/_components/live-ops-view.tsx'],
  };

  it.each(KNOWN_CANCELLATION_REASONS.map((r) => [r.key, r.stored] as const))(
    '%s is still written word for word by its writer',
    (key, stored) => {
      const files = WRITERS[key];
      expect(files, `no writer listed for ${key}`).toBeDefined();
      expect(files!.some((f) => read(f).includes(`'${stored}'`)), `${stored} in ${files!.join(', ')}`).toBe(true);
    },
  );

  it('matches the expiry job’s figure to the page’s: the diner is told 28 minutes to pay', () => {
    // The stored sentence says 30 (when the job cancels); the page never repeats that figure. It
    // says the time to pay instead, the same {minutes} the expired card box uses.
    const en = JSON.parse(read('apps/web/messages/en/tracking.json')) as {
      closed: { reasons: Record<string, string> };
    };
    expect(en.closed.reasons.cardExpired).toContain('{minutes}');
    expect(en.closed.reasons.cardExpired).not.toContain('30');
  });
});

describe('the closed-order copy', () => {
  const LOCALES = ['en', 'es', 'th', 'vi'];
  const tracking = (locale: string) =>
    JSON.parse(read(`apps/web/messages/${locale}/tracking.json`)) as {
      closed: { reasons: Record<string, unknown> };
      actions: Record<string, unknown>;
    };

  it.each(LOCALES)('names every known reason, and the card cancel prompt, in %s', (locale) => {
    const json = tracking(locale);
    for (const { key } of KNOWN_CANCELLATION_REASONS) {
      const value = json.closed.reasons[key];
      expect(typeof value === 'string' && value.trim().length > 0, `${locale} closed.reasons.${key}`).toBe(true);
    }
    expect(Object.keys(json.closed.reasons).sort()).toEqual(KNOWN_CANCELLATION_REASONS.map((r) => r.key).sort());
    const prompt = json.actions.cancelPromptCard;
    expect(typeof prompt === 'string' && prompt.trim().length > 0, `${locale} actions.cancelPromptCard`).toBe(true);
  });

  it.each(LOCALES)('never says "transfer" in the card cancel prompt in %s', (locale) => {
    // The transfer prompt's own word, per language: the card one must not borrow it.
    const TRANSFER: Record<string, RegExp> = { en: /transfer/i, es: /transferencia/i, th: /โอน/, vi: /chuyển khoản/i };
    expect(String(tracking(locale).actions.cancelPromptCard)).not.toMatch(TRANSFER[locale]!);
    expect(String(tracking(locale).actions.cancelPrompt)).toMatch(TRANSFER[locale]!);
  });
});
