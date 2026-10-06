import { describe, expect, it } from 'vitest';
import {
  CLAIM_LEASE_SEC,
  OFFER_FALLBACK_LIFE_SEC,
  STALE_AFTER_SEC,
  claimGroups,
  claimedInPlanOrder,
  leaseCutoffIso,
  offerIsOpen,
  offerTarget,
  planSend,
  pushData,
  pushOptions,
  secondsLeft,
  staleAtMs,
  staleCutoffIso,
  runScope,
  staleReason,
  type OfferDelivery,
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

// ── Claims (review BE-6) ─────────────────────────────────────────────────────────────────────────
//
// What is at stake: the worker read pending rows, sent them, and only then marked them sent, so two
// runs at once (a long tick, a kick beside the minute tick, anyone calling its open URL) sent every
// due push and SMS twice. A run now claims rows with one guarded UPDATE per attempts count and sends
// only what came back. The fake table below applies the worker's statements with Postgres's rule
// for an UPDATE whose row changed under it: the WHERE is checked again on the newest version.

type Status = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
interface FakeRow {
  id: string;
  status: Status;
  attempts: number;
  sent_at: string | null;
  last_error: string | null;
}

const MAX = 5;

function fakeTable(rows: Array<Partial<FakeRow> & { id: string }>) {
  const table = new Map<string, FakeRow>(
    rows.map((r) => [r.id, { status: 'pending', attempts: 0, sent_at: null, last_error: null, ...r }]),
  );
  return {
    table,
    /** notify-worker's claim(): the guarded UPDATE ... RETURNING, one per group. */
    claim(read: ReadonlyArray<{ id: string; attempts: number }>, atIso: string): FakeRow[] {
      const won: FakeRow[] = [];
      for (const group of claimGroups(read, MAX)) {
        for (const id of group.ids) {
          const row = table.get(id);
          if (!row || row.attempts !== group.attempts || !['pending', 'failed'].includes(row.status)) continue;
          Object.assign(row, { status: 'sending', attempts: group.attempts + 1, sent_at: atIso });
          won.push({ ...row });
        }
      }
      return claimedInPlanOrder(read, won);
    },
    /** notify-worker's finish(): only while the claim is still the caller's. */
    finish(claimed: FakeRow, patch: Partial<FakeRow>): boolean {
      const row = table.get(claimed.id);
      if (!row || row.status !== 'sending' || row.attempts !== claimed.attempts) return false;
      Object.assign(row, patch);
      return true;
    },
    /** The full run's release of claims older than the lease. */
    release(nowMs: number): number {
      const cutoff = Date.parse(leaseCutoffIso(nowMs));
      let n = 0;
      for (const row of table.values()) {
        if (row.status === 'sending' && row.sent_at !== null && Date.parse(row.sent_at) < cutoff) {
          Object.assign(row, { status: 'failed', sent_at: null, last_error: 'claim_expired' });
          n++;
        }
      }
      return n;
    },
    /** What a run reads: claimable rows with tries left. */
    read(): FakeRow[] {
      return [...table.values()]
        .filter((r) => ['pending', 'failed'].includes(r.status) && r.attempts < MAX)
        .map((r) => ({ ...r }));
    },
  };
}

describe('a run sends only the rows it claimed', () => {
  it('two runs that read the same rows send each row once', () => {
    const db = fakeTable([{ id: 'a' }, { id: 'b', status: 'failed', attempts: 2 }, { id: 'c' }]);
    const readByA = db.read();
    const readByB = db.read();
    const wonByA = db.claim(readByA, ago(0));
    const wonByB = db.claim(readByB, ago(0));
    expect(wonByA.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(wonByB).toEqual([]);
    // Twenty callers at once still send nothing more.
    for (let i = 0; i < 20; i++) expect(db.claim(readByB, ago(0))).toEqual([]);
  });

  it('counts the try when it claims, by exactly one, whatever count each row was read with', () => {
    const db = fakeTable([{ id: 'a' }, { id: 'b', status: 'failed', attempts: 3 }]);
    const won = db.claim(db.read(), ago(0));
    expect(won.map((r) => [r.id, r.status, r.attempts])).toEqual([
      ['a', 'sending', 1],
      ['b', 'sending', 4],
    ]);
  });

  it('does not claim a row that changed since it was read (sent, skipped, or retried by another run)', () => {
    const db = fakeTable([{ id: 'a' }, { id: 'b' }, { id: 'c', status: 'failed', attempts: 1 }]);
    const stale = db.read();
    db.table.get('a')!.status = 'sent';
    db.table.get('b')!.status = 'skipped';
    db.table.get('c')!.attempts = 2; // another run tried it again since
    expect(db.claim(stale, ago(0))).toEqual([]);
  });

  it('finishes a row only while the claim is still its own', () => {
    const db = fakeTable([{ id: 'a' }]);
    const [mine] = db.claim(db.read(), ago(0));
    expect(db.finish(mine!, { status: 'sent', sent_at: ago(0) })).toBe(true);
    expect(db.table.get('a')!.status).toBe('sent');
    // A second finish of the same claim (or a late one) changes nothing.
    expect(db.finish(mine!, { status: 'failed' })).toBe(false);
    expect(db.table.get('a')!.status).toBe('sent');
  });

  it('releases a claim whose run died after the lease, and never one inside it', () => {
    const db = fakeTable([{ id: 'a' }, { id: 'b' }]);
    db.claim([{ id: 'a', attempts: 0 }], ago(CLAIM_LEASE_SEC + 1));
    db.claim([{ id: 'b', attempts: 0 }], ago(CLAIM_LEASE_SEC - 1));
    expect(db.release(NOW)).toBe(1);
    expect(db.table.get('a')).toMatchObject({ status: 'failed', attempts: 1, sent_at: null, last_error: 'claim_expired' });
    expect(db.table.get('b')).toMatchObject({ status: 'sending', attempts: 1 });
  });

  it('lets the dead run neither finish nor overwrite the claim that replaced it', () => {
    const db = fakeTable([{ id: 'a' }]);
    const [dead] = db.claim(db.read(), ago(CLAIM_LEASE_SEC + 60));
    db.release(NOW);
    const [next] = db.claim(db.read(), ago(0));
    expect(next).toMatchObject({ id: 'a', attempts: 2 });
    expect(db.finish(dead!, { status: 'failed', last_error: 'late' })).toBe(false);
    expect(db.finish(next!, { status: 'sent' })).toBe(true);
    expect(db.table.get('a')).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('stops retrying a row that kills the worker every time, after the last try', () => {
    const db = fakeTable([{ id: 'a' }]);
    for (let i = 0; i < MAX; i++) {
      expect(db.claim(db.read(), ago(CLAIM_LEASE_SEC + 60))).toHaveLength(1);
      db.release(NOW);
    }
    expect(db.table.get('a')).toMatchObject({ status: 'failed', attempts: MAX });
    expect(db.read()).toEqual([]);
  });
});

describe('claim groups', () => {
  it('groups rows by the attempts they were read with, fewest first', () => {
    const rows = [
      { id: 'a', attempts: 2 },
      { id: 'b', attempts: 0 },
      { id: 'c', attempts: 2 },
      { id: 'd', attempts: 4 },
    ];
    expect(claimGroups(rows, MAX)).toEqual([
      { attempts: 0, ids: ['b'] },
      { attempts: 2, ids: ['a', 'c'] },
      { attempts: 4, ids: ['d'] },
    ]);
  });

  it('claims a row read twice once, and leaves out rows with no tries left or no usable count', () => {
    const rows = [
      { id: 'a', attempts: 0 },
      { id: 'a', attempts: 0 },
      { id: 'b', attempts: MAX },
      { id: 'c', attempts: -1 },
      { id: 'd', attempts: 1.5 },
      { id: 'e', attempts: Number.NaN },
    ];
    expect(claimGroups(rows, MAX)).toEqual([{ attempts: 0, ids: ['a'] }]);
    expect(claimGroups([], MAX)).toEqual([]);
  });

  it('sends what it won in the order it planned, as the claim returned it', () => {
    const planned = [
      { id: 'x', attempts: 0 },
      { id: 'y', attempts: 1 },
      { id: 'z', attempts: 0 },
    ];
    const claimed = [
      { id: 'z', attempts: 1 },
      { id: 'x', attempts: 1 },
      { id: 'stranger', attempts: 1 },
    ];
    expect(claimedInPlanOrder(planned, claimed)).toEqual([
      { id: 'x', attempts: 1 },
      { id: 'z', attempts: 1 },
    ]);
  });

  it('holds a claim longer than any run can live, and counts the lease back from now', () => {
    // The edge runtime's wall-clock limit is 400 s on a paid plan (150 s free).
    expect(CLAIM_LEASE_SEC).toBeGreaterThan(400);
    expect(Date.parse(leaseCutoffIso(NOW))).toBe(NOW - CLAIM_LEASE_SEC * 1000);
  });
});

// ── An offer that is already over is not pushed (review DS-2, server half) ──────────────────────

describe('an offer push goes out only while the offer is open to that rider', () => {
  const RIDER = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const D2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const BATCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const ahead = new Date(NOW + 40_000).toISOString();

  const pushRow = (vars: Record<string, unknown>) => ({ ...offer(5, { expires_in_seconds: 75, ...vars }), recipient_id: RIDER });
  const delivery = (over: Partial<OfferDelivery> = {}): OfferDelivery => ({
    id: D1,
    batch_id: null,
    status: 'assigned',
    driver_id: RIDER,
    accepted_at: null,
    offer_expires_at: ahead,
    ...over,
  });

  it('is open while the delivery is offered to this rider, unanswered, before it expires', () => {
    expect(offerIsOpen(pushRow({ delivery_id: D1 }), [delivery()], NOW)).toBe(true);
  });

  it('is over once the rider accepted, it went to someone else, it expired or it left the offer', () => {
    const row = pushRow({ delivery_id: D1 });
    expect(offerIsOpen(row, [delivery({ accepted_at: ago(1), offer_expires_at: null })], NOW)).toBe(false);
    expect(offerIsOpen(row, [delivery({ driver_id: OTHER })], NOW)).toBe(false);
    expect(offerIsOpen(row, [delivery({ offer_expires_at: ago(1) })], NOW)).toBe(false);
    expect(offerIsOpen(row, [delivery({ offer_expires_at: null })], NOW)).toBe(false);
    for (const status of ['pending', 'dispatching', 'cancelled', 'picked_up']) {
      expect(offerIsOpen(row, [delivery({ status, driver_id: status === 'pending' ? null : RIDER })], NOW)).toBe(false);
    }
    expect(offerIsOpen(row, [], NOW)).toBe(false);
  });

  it('keeps a stack open while any of its stops is still offered to the rider', () => {
    const row = pushRow({ delivery_id: D1, batch_id: BATCH });
    const firstGone = delivery({ batch_id: BATCH, status: 'cancelled' });
    const second = delivery({ id: D2, batch_id: BATCH });
    expect(offerIsOpen(row, [firstGone, second], NOW)).toBe(true);
    expect(offerIsOpen(row, [firstGone, { ...second, driver_id: OTHER }], NOW)).toBe(false);
    // Another stack's open stop says nothing about this one.
    expect(offerIsOpen(row, [firstGone, { ...second, batch_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }], NOW)).toBe(false);
  });

  it('cannot tell, and so does not skip, a row that names no delivery', () => {
    expect(offerIsOpen(pushRow({ delivery_id: undefined }), [delivery()], NOW)).toBeNull();
    expect(offerIsOpen(pushRow({ delivery_id: 'd-1' }), [delivery()], NOW)).toBeNull();
    expect(offerIsOpen({ ...other('order_delivered', 5), recipient_id: RIDER }, [delivery()], NOW)).toBeNull();
  });

  it('reads only UUIDs from the row, so the ids are safe in the delivery query', () => {
    expect(offerTarget(pushRow({ delivery_id: D1, batch_id: BATCH }))).toEqual({ deliveryId: D1, batchId: BATCH });
    expect(offerTarget(pushRow({ delivery_id: D1, batch_id: 'x),id.not.is.null' }))).toEqual({ deliveryId: D1, batchId: null });
    expect(offerTarget(pushRow({ delivery_id: `${D1},x` }))).toBeNull();
  });
});

// ── Offers first (review CONC-7) ─────────────────────────────────────────────────────────────────

describe('what a call asks the worker to do', () => {
  it('sends offers only when asked for exactly that, and runs in full otherwise', () => {
    expect(runScope({ scope: 'offers' })).toBe('offers');
    for (const body of [null, undefined, {}, { source: 'pg_cron' }, { scope: 'all' }, { scope: 'OFFERS' }, 'offers', ['offers']]) {
      expect(runScope(body)).toBe('all');
    }
  });
});
