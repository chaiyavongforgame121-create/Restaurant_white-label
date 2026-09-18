import { describe, expect, it } from 'vitest';
import {
  describeCounterFailure,
  describeSettleError,
  orderMayExist,
  parsePlaceOrderFailure,
} from './counter-errors';

const describe_ = (raw: string) => describeCounterFailure(parsePlaceOrderFailure(raw));

describe('counter errors', () => {
  it("names the owner's report: a delivery with no address", () => {
    const d = describe_('place_order_failed:400:{"error":"delivery_address_required"}');
    expect(d.key).toBe('deliveryAddressRequired');
    expect(d.code).toBeNull();
  });

  it('keeps the ids the body names, so the message can say which dish', () => {
    const d = describe_(
      'place_order_failed:409:{"error":"insufficient_stock","item_id":"abc","available":2}',
    );
    expect(d).toMatchObject({ key: 'insufficientStock', itemId: 'abc', available: 2 });
  });

  it('shows the machine code for a code the till has no sentence for', () => {
    const d = describe_('place_order_failed:422:{"error":"brand_new_rule"}');
    expect(d).toMatchObject({ key: 'unknown', code: 'brand_new_rule' });
  });

  it('shows the code on a server failure too', () => {
    const d = describe_('place_order_failed:500:{"error":"order_insert_failed","detail":"duplicate key"}');
    expect(d).toMatchObject({ key: 'orderInsertFailed', code: 'order_insert_failed' });
  });

  it('does not find Object.prototype members as codes', () => {
    expect(describe_('place_order_failed:400:{"error":"toString"}').key).toBe('unknown');
    expect(describe_('place_order_failed:400:{"error":"constructor"}').key).toBe('unknown');
  });

  it('matches the longest code in a body that is not JSON', () => {
    const d = describe_('place_order_failed:409:<html>branch_closed_at_scheduled_time</html>');
    expect(d.key).toBe('branchClosedAtTime');
  });

  it('falls back to the HTTP status when a non-JSON body names nothing', () => {
    expect(describe_('place_order_failed:502:Bad gateway')).toMatchObject({ key: 'unknown', code: 'http_502' });
  });

  it('calls a request that never got an answer a network problem', () => {
    expect(describe_('Failed to fetch').key).toBe('network');
  });

  it('maps every code the counter can meet to a sentence', () => {
    for (const code of [
      'dropoff_required',
      'delivery_not_available_at_that_time',
      'delivery_must_be_scheduled',
      'transfer_not_configured',
      'payment_method_not_accepted',
      'table_not_in_branch',
      'table_session_closed',
      'combo_not_in_branch',
      'combo_item_unavailable',
      'combo_empty',
      'modifier_inactive',
      'invalid_quantity',
      'feature_not_entitled',
      'insufficient_points',
      'gift_card_changed',
      'item_sold_out',
      'rate_limited',
      'branch_closed',
      'branch_paused',
      'login_required',
      'not_staff_at_branch',
      'invalid_customer_phone',
      'invalid_discount_percent',
      'customer_branch_mismatch',
      'credit_reservation_failed',
      'staff_check_failed',
    ]) {
      expect(describe_(`place_order_failed:409:{"error":"${code}"}`).key, code).not.toBe('unknown');
    }
  });
});

describe('whether a failed sale may have been placed anyway', () => {
  const mayExist = (raw: string) => orderMayExist(parsePlaceOrderFailure(raw));

  it('is certain nothing was placed when place-order refused with a code', () => {
    expect(mayExist('place_order_failed:409:{"error":"item_sold_out","item_id":"x"}')).toBe(false);
    expect(mayExist('place_order_failed:429:{"error":"rate_limited"}')).toBe(false);
  });

  it('is certain when place-order deleted the order it had inserted', () => {
    expect(mayExist('place_order_failed:500:{"error":"order_items_insert_failed"}')).toBe(false);
    expect(mayExist('place_order_failed:500:{"error":"order_insert_failed"}')).toBe(false);
  });

  it('cannot tell after a dropped connection, a gateway page or an unknown 5xx', () => {
    expect(mayExist('TypeError: Failed to fetch')).toBe(true);
    expect(mayExist('place_order_failed:504:Gateway Timeout')).toBe(true);
    expect(mayExist('place_order_failed:500:{"error":"something_new"}')).toBe(true);
    expect(mayExist('place_order_failed:400:not json')).toBe(true);
  });
});

describe('record_counter_transfer failures', () => {
  it('names each raised code and says whether trying again can help', () => {
    expect(describeSettleError('order_not_settleable')).toEqual({
      key: 'orderNotSettleable',
      code: 'order_not_settleable',
      permanent: true,
    });
    expect(describeSettleError('payment_not_found')).toMatchObject({ key: 'paymentNotFound', permanent: true });
    expect(describeSettleError('forbidden')).toMatchObject({ key: 'forbidden', permanent: true });
    expect(describeSettleError('auth_required')).toMatchObject({ key: 'authRequired', permanent: false });
  });

  it('treats a dropped call as worth another try, and keeps a bare code for display', () => {
    expect(describeSettleError('TypeError: Failed to fetch')).toEqual({ key: 'failed', code: null, permanent: false });
    expect(describeSettleError('some_new_code')).toEqual({ key: 'failed', code: 'some_new_code', permanent: false });
    expect(describeSettleError(null)).toEqual({ key: 'failed', code: null, permanent: false });
  });
});
