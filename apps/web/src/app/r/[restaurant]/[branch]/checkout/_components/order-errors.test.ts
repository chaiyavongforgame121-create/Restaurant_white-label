import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORDER_ERRORS, orderErrorKey, placeOrderBody, refusedCartPart } from './order-errors';

/** What placeOrder throws for a refusal: `place_order_failed:<status>:<body>`. */
const refusal = (status: number, body: Record<string, unknown>) =>
  `place_order_failed:${status}:${JSON.stringify(body)}`;

const STALE = 'stale_client_refresh_required';

describe('orderErrorKey', () => {
  // place-order adds the stale-client hint to these bodies for checkouts that predate the codes.
  // The matcher is a substring scan in table order, so each code must win over the hint.
  it.each([
    [{ error: 'gift_card_changed', reason: 'expired', hint: STALE }, 'errors.order.giftCardRefused'],
    [{ error: 'gift_card_changed', hint: STALE }, 'errors.order.giftCardRefused'],
    [{ error: 'promo_exhausted', promo: true, hint: STALE }, 'errors.order.promoRefused'],
    [{ error: 'promo_unavailable', promo: true, hint: STALE }, 'errors.order.promoRefused'],
    [{ error: 'per_customer_limit_reached', promo: true, hint: STALE }, 'errors.order.promoRefused'],
  ])('reads %j as its own sentence, not the refresh one', (body, key) => {
    expect(orderErrorKey(refusal(409, body))).toBe(key);
  });

  it('still reads a bare stale-client refusal as the refresh sentence', () => {
    expect(orderErrorKey(refusal(409, { error: STALE }))).toBe('errors.order.staleClientRefreshRequired');
  });

  it('reads a combo refusal as unavailable even when its reason is a stock code', () => {
    expect(
      orderErrorKey(
        refusal(409, {
          error: 'combo_item_unavailable',
          combo_id: 'c1',
          item_id: 'i1',
          reason: 'insufficient_stock',
          available: 0,
          hint: 'combo_inactive',
        }),
      ),
    ).toBe('errors.order.itemUnavailable');
    expect(orderErrorKey(refusal(409, { error: 'combo_empty', combo_id: 'c1', hint: 'combo_inactive' }))).toBe(
      'errors.order.itemUnavailable',
    );
  });

  it('keeps the dish-level stock sentences', () => {
    expect(orderErrorKey(refusal(409, { error: 'insufficient_stock', item_id: 'i1', available: 2 }))).toBe(
      'errors.order.insufficientStock',
    );
    expect(orderErrorKey(refusal(409, { error: 'item_sold_out', item_id: 'i1' }))).toBe('errors.order.itemSoldOut');
  });

  it('reads the mid-checkout delivery refusal as "this branch does not deliver" (DELIV-6)', () => {
    // place-order's up-front gate and its quote race both send this for a branch whose
    // delivery is off; the diner is at ONE branch of a restaurant that may deliver elsewhere.
    expect(orderErrorKey(refusal(403, { error: 'feature_not_entitled', feature: 'delivery' }))).toBe(
      'errors.order.deliveryNotOffered',
    );
    for (const locale of ['en', 'es', 'th', 'vi']) {
      const dir = path.resolve(__dirname, '../../../../../../../messages', locale);
      const read = (ns: string) => JSON.parse(fs.readFileSync(path.join(dir, `${ns}.json`), 'utf8'));
      const refusalCopy: string = read('errors').order.deliveryNotOffered;
      const branchCopy: string = read('checkout').orderType.deliveryNotOffered;
      // The same permanent, branch-scoped sentence the checkout's order-type picker uses —
      // not "this restaurant", and not the temporary "right now" wording.
      expect(refusalCopy.startsWith(branchCopy), `${locale}: ${refusalCopy}`).toBe(true);
    }
  });

  it('reads the card refusals as "pick another way to pay", not "try again"', () => {
    // The branch has no Stripe account that can take charges: the money would have nowhere to go.
    expect(orderErrorKey(refusal(400, { error: 'card_not_configured' }))).toBe('errors.order.cardNotConfigured');
    expect(orderErrorKey(refusal(400, { error: 'card_amount_too_small', minimum: 0.5 }))).toBe(
      'errors.order.cardAmountTooSmall',
    );
    expect(orderErrorKey(refusal(500, { error: 'payment_insert_failed' }))).toBe('errors.order.cardSetupFailed');
    // The entitlement refusal keeps its own sentence.
    expect(orderErrorKey(refusal(403, { error: 'feature_not_entitled', feature: 'card_payment' }))).toBe(
      'errors.order.cardNotAvailable',
    );
  });

  it('has every sentence it can pick in all four languages', () => {
    for (const locale of ['en', 'es', 'th', 'vi']) {
      const dir = path.resolve(__dirname, '../../../../../../../messages', locale);
      for (const [code, key] of ORDER_ERRORS) {
        const [ns, ...rest] = key.split('.');
        const messages = JSON.parse(fs.readFileSync(path.join(dir, `${ns}.json`), 'utf8')) as Record<string, unknown>;
        const value = rest.reduce<unknown>(
          (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
          messages,
        );
        expect(typeof value === 'string' && value.length > 0, `${locale}: ${code} -> ${key}`).toBe(true);
      }
    }
  });

  it('knows nothing it was not told', () => {
    expect(orderErrorKey(refusal(500, { error: 'something_new' }))).toBeNull();
    expect(orderErrorKey('TypeError: Failed to fetch')).toBeNull();
  });
});

describe('placeOrderBody', () => {
  it('parses the JSON body of a refusal', () => {
    expect(placeOrderBody(refusal(409, { error: 'promo_exhausted', promo: true, min_subtotal: 20 }))).toEqual({
      error: 'promo_exhausted',
      promo: true,
      min_subtotal: 20,
    });
  });

  it('is null for anything else', () => {
    expect(placeOrderBody('place_order_failed:502:<html>Bad gateway</html>')).toBeNull();
    expect(placeOrderBody('TypeError: Failed to fetch')).toBeNull();
    expect(placeOrderBody('place_order_failed:500:null')).toBeNull();
  });
});

describe('refusedCartPart', () => {
  it.each(['combo_item_unavailable', 'combo_empty', 'combo_not_in_branch', 'combo_inactive'])(
    'names the combo for %s',
    (error) => {
      expect(refusedCartPart(refusal(409, { error, combo_id: 'c1', item_id: 'i1' }))).toEqual({
        kind: 'combo',
        id: 'c1',
      });
    },
  );

  it('names the dish and the option', () => {
    expect(refusedCartPart(refusal(400, { error: 'item_inactive', item_id: 'i1' }))).toEqual({ kind: 'item', id: 'i1' });
    expect(refusedCartPart(refusal(400, { error: 'modifier_inactive', option_id: 'o1' }))).toEqual({
      kind: 'option',
      id: 'o1',
    });
  });

  it('takes nothing out for a shortage the diner can fix, or a refusal without an id', () => {
    expect(refusedCartPart(refusal(409, { error: 'insufficient_stock', item_id: 'i1', available: 1 }))).toBeNull();
    expect(refusedCartPart(refusal(409, { error: 'combo_empty' }))).toBeNull();
  });
});
