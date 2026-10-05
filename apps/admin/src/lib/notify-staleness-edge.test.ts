import { describe, expect, it } from 'vitest';
import {
  OFFER_FALLBACK_LIFE_SEC,
  STALE_AFTER_SEC,
  planSend,
  pushData,
  pushOptions,
  secondsLeft,
  staleAtMs,
  staleCutoffIso,
  staleReason,
  type OutboxTiming,
} from '../../../../supabase/functions/_shared/notify-staleness';

/**
 * The rules notify-worker sends by (docs/DISPATCH-FIXES-2026-10-05.md D10), pinned from here
 * because a Deno function cannot run under this app's test runner but a module with no imports
 * can: supabase/functions/_shared/notify-staleness.ts imports nothing for that reason.
 *
 * What is at stake: the live queue holds months of pending rows. Without these rules, switching the
 * worker on pushes June's expired delivery offers to riders and "your rider is arriving" to diners
 * whose food came months ago, oldest first, while a live offer waits behind them; and an offer
 * sent with web-push's defaults can be held for weeks, or sit in Android's Doze past its 75 seconds.
 */

const NOW = Date.parse('2026-10-05T16:00:00.000Z');
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

function offer(createdSecAgo: number, vars: Record<string, unknown> = { expires_in_seconds: 75 }): OutboxTiming & { id: string } {
  const at = ago(createdSecAgo);
  return {
    id: `offer-${createdSecAgo}`,
    template: 'new_dispatch',
    variables: { delivery_id: 'd-1', ...vars },
    created_at: at,
    scheduled_for: at,
  };
}

function other(template: string, createdSecAgo: number, scheduledSecAgo = createdSecAgo): OutboxTiming & { id: string } {
  return {
    id: `${template}-${createdSecAgo}`,
    template,
    variables: { order_id: 'o-1' },
    created_at: ago(createdSecAgo),
    scheduled_for: ago(scheduledSecAgo),
  };
}

describe('an offer is worth sending while the offer is open', () => {
  it('lives expires_in_seconds from when it was queued', () => {
    expect(staleReason(offer(74), NOW)).toBeNull();
    expect(staleReason(offer(75), NOW)).toBe('offer_expired');
    expect(staleReason(offer(600), NOW)).toBe('offer_expired');
  });

  it('lives 120 seconds when the row does not say', () => {
    expect(OFFER_FALLBACK_LIFE_SEC).toBe(120);
    expect(staleReason(offer(119, {}), NOW)).toBeNull();
    expect(staleReason(offer(120, {}), NOW)).toBe('offer_expired');
  });

  it('reads a numeric string, and treats zero, negative or garbage as not saying', () => {
    expect(staleReason(offer(80, { expires_in_seconds: '90' }), NOW)).toBeNull();
    expect(staleReason(offer(91, { expires_in_seconds: '90' }), NOW)).toBe('offer_expired');
    for (const bad of [0, -5, 'soon', null, Number.NaN]) {
      expect(staleAtMs(offer(0, { expires_in_seconds: bad }))).toBe(NOW + OFFER_FALLBACK_LIFE_SEC * 1000);
    }
  });

  it('ends at the offer_expires_at it carries when that is sooner, and is never extended by it', () => {
    const early = offer(10, { expires_in_seconds: 75, offer_expires_at: ago(1) });
    expect(staleReason(early, NOW)).toBe('offer_expired');
    const late = offer(80, { expires_in_seconds: 75, offer_expires_at: new Date(NOW + 3_600_000).toISOString() });
    expect(staleReason(late, NOW)).toBe('offer_expired');
  });

  it('never lives longer than anything else does', () => {
    expect(staleReason(offer(STALE_AFTER_SEC - 1, { expires_in_seconds: 86_400 }), NOW)).toBeNull();
    expect(staleReason(offer(STALE_AFTER_SEC, { expires_in_seconds: 86_400 }), NOW)).toBe('offer_expired');
  });

  it('is not sent when it cannot be dated', () => {
    expect(staleReason({ ...offer(0), created_at: 'yesterday' }, NOW)).toBe('undated');
    expect(staleReason({ ...offer(0), created_at: null }, NOW)).toBe('undated');
  });
});

describe('anything else is worth sending for 30 minutes after it fell due', () => {
  it('goes stale at 30 minutes', () => {
    expect(STALE_AFTER_SEC).toBe(1800);
    expect(staleReason(other('order_arriving', 1799), NOW)).toBeNull();
    expect(staleReason(other('order_arriving', 1800), NOW)).toBe('too_old');
  });

  it('counts from scheduled_for when that is later than created_at', () => {
    // Queued an hour ago for ten minutes ago: due ten minutes ago, still worth sending.
    expect(staleReason(other('order_released', 3600, 600), NOW)).toBeNull();
    expect(staleReason(other('order_released', 3600, 1800), NOW)).toBe('too_old');
  });

  it('covers in_app and every other channel alike, and a row with no dates is not sent', () => {
    expect(staleReason(other('dispatch_failed', 7200), NOW)).toBe('too_old');
    expect(staleReason({ ...other('promo', 0), created_at: null, scheduled_for: 'x' }, NOW)).toBe('undated');
  });

  it("retires the live backlog: June's offer and arrival push, a 03 October low-stock alert", () => {
    const june = Date.parse('2026-06-14T16:23:52Z');
    const rows: OutboxTiming[] = [
      { template: 'new_dispatch', variables: { expires_in_seconds: 75 }, created_at: new Date(june).toISOString(), scheduled_for: new Date(june).toISOString() },
      { template: 'order_arriving', variables: {}, created_at: new Date(june).toISOString(), scheduled_for: new Date(june).toISOString() },
      { template: 'low_stock', variables: {}, created_at: '2026-10-03T19:53:53Z', scheduled_for: '2026-10-03T19:53:53Z' },
    ];
    expect(rows.map((r) => staleReason(r, NOW))).toEqual(['offer_expired', 'too_old', 'too_old']);
  });
});

describe('the bulk cutoff agrees with the row-by-row rule', () => {
  it('marks only rows the rule calls stale, whatever the template', () => {
    const cutoff = Date.parse(staleCutoffIso(NOW));
    expect(cutoff).toBe(NOW - STALE_AFTER_SEC * 1000);
    const before = new Date(cutoff - 1).toISOString();
    for (const template of ['new_dispatch', 'order_delivered', 'new_message', 'dispatch_failed']) {
      for (const vars of [{}, { expires_in_seconds: 75 }, { expires_in_seconds: 999_999 }]) {
        const row: OutboxTiming = { template, variables: vars, created_at: before, scheduled_for: before };
        expect(staleReason(row, NOW)).not.toBeNull();
      }
    }
  });
});

describe('how a push service carries it', () => {
  it('sends an offer urgent, living exactly as long as the offer has left', () => {
    expect(pushOptions(offer(30), NOW)).toEqual({ TTL: 45, urgency: 'high' });
    expect(pushOptions(offer(0, { expires_in_seconds: 75 }), NOW)).toEqual({ TTL: 75, urgency: 'high' });
  });

  it('never asks for a TTL of 0, which drops the message unless the phone is reachable that instant', () => {
    expect(pushOptions(offer(74.6), NOW).TTL).toBe(1);
    expect(pushOptions(offer(500), NOW).TTL).toBe(1);
  });

  it('sends anything else at normal urgency, for no longer than it is worth sending', () => {
    expect(pushOptions(other('order_out_for_delivery', 60), NOW)).toEqual({ TTL: 1740, urgency: 'normal' });
    expect(pushOptions(other('new_message', 0), NOW)).toEqual({ TTL: STALE_AFTER_SEC, urgency: 'normal' });
  });

  it('counts whole seconds left', () => {
    expect(secondsLeft(offer(10.4), NOW)).toBe(64);
    expect(secondsLeft({ ...offer(0), created_at: 'x' }, NOW)).toBe(0);
  });
});

describe('what the push carries for the service worker', () => {
  it('names the offer and when it ends, so the worker can close it once it is over', () => {
    const row = offer(30, { expires_in_seconds: 75, delivery_id: 'd-9', batch_id: 'b-2' });
    expect(pushData(row)).toEqual({
      template: 'new_dispatch',
      delivery_id: 'd-9',
      batch_id: 'b-2',
      expires_at: new Date(NOW + 45_000).toISOString(),
    });
  });

  it('carries only the template for anything else', () => {
    expect(pushData(other('order_delivered', 5))).toEqual({ template: 'order_delivered' });
  });

  it('leaves out ids that are not strings', () => {
    expect(pushData(offer(0, { delivery_id: 42, expires_in_seconds: 75 }))).toEqual({
      template: 'new_dispatch',
      expires_at: new Date(NOW + 75_000).toISOString(),
    });
  });
});

describe('the order a run sends in', () => {
  it('sends a fresh offer ahead of a backlog, newest first within each group', () => {
    const backlog = Array.from({ length: 30 }, (_, i) => other('order_delivered', 60 + i));
    const fresh = offer(10);
    const older = offer(40);
    const plan = planSend([...backlog, older, fresh], NOW, 25);
    expect(plan.send).toHaveLength(25);
    expect(plan.send[0]).toBe(fresh);
    expect(plan.send[1]).toBe(older);
    expect(plan.send[2]).toBe(backlog[0]);
    expect(plan.send[3]).toBe(backlog[1]);
    expect(plan.stale).toEqual([]);
  });

  it('retires every stale row it read, and leaves fresh rows past the limit for the next run', () => {
    const rows = [offer(10), offer(200), other('order_arriving', 3600), other('new_message', 5), other('promo', 4)];
    const plan = planSend(rows, NOW, 2);
    expect(plan.send.map((r) => r.id)).toEqual(['offer-10', 'promo-4']);
    expect(plan.stale).toEqual([
      { row: rows[1], reason: 'offer_expired' },
      { row: rows[2], reason: 'too_old' },
    ]);
  });

  it('sends nothing with a limit of 0, and still says what is stale', () => {
    const plan = planSend([offer(500), offer(1)], NOW, 0);
    expect(plan.send).toEqual([]);
    expect(plan.stale).toHaveLength(1);
  });

  it('orders the rest by when each fell due', () => {
    const late = other('order_released', 3600, 10);
    const early = other('order_delivered', 20);
    expect(planSend([early, late], NOW, 10).send).toEqual([late, early]);
  });
});
