import { describe, expect, it } from 'vitest';
import { completedRun, tipShareOf, type SnapshotLeg } from './run-earnings';

// The delivery in the owner's screenshot (2026-10-24): 1.55 km, $2 base + $0.96 distance, a
// $6.26 tip all to the rider, tips.mode hidden. The screen said $2.96; the ledger credited $9.22.
const LEG_A = 'leg-a';
const LEG_B = 'leg-b';

const snapA: SnapshotLeg = { id: LEG_A, driverEarnings: 2.96, netTip: 6.26, tipFullVisible: null };

describe('completed run', () => {
  it('shows pay and tip separately and totals them, from the ledger', () => {
    const run = completedRun({
      legIds: [LEG_A],
      ledger: [{ delivery_id: LEG_A, base_pay: 2, distance_pay: 0.96, tip_net: 6.26 }],
      deliveries: [{ id: LEG_A, driver_earnings: 2.96, net_tip: 6.26, tip_visible_total: null }],
      snapshots: [snapA],
    });
    expect(run).toEqual({ runPay: 2.96, tip: 6.26, total: 9.22, tipFull: null, orders: 1 });
  });

  it('prefers the credited ledger over the delivery row (a peak bonus lands in distance_pay)', () => {
    const run = completedRun({
      legIds: [LEG_A],
      ledger: [{ delivery_id: LEG_A, base_pay: 2, distance_pay: 2.44, tip_net: 6.26 }],
      deliveries: [{ id: LEG_A, driver_earnings: 2.96, net_tip: 6.26, tip_visible_total: null }],
      snapshots: [snapA],
    });
    expect(run.runPay).toBe(4.44);
    expect(run.total).toBe(10.7);
  });

  it('reads PostgREST numerics handed back as strings', () => {
    const run = completedRun({
      legIds: [LEG_A],
      ledger: [{ delivery_id: LEG_A, base_pay: '2.00', distance_pay: '0.96', tip_net: '6.26' }],
    });
    expect(run).toMatchObject({ runPay: 2.96, tip: 6.26, total: 9.22, orders: 1 });
  });

  it('falls back to the delivery row when the ledger read failed', () => {
    const run = completedRun({
      legIds: [LEG_A],
      ledger: null,
      deliveries: [{ id: LEG_A, driver_earnings: 2.96, net_tip: 3.6, tip_visible_total: null }],
      snapshots: [snapA],
    });
    expect(run).toMatchObject({ runPay: 2.96, tip: 3.6, total: 6.56, orders: 1 });
  });

  it('falls back to what the phone held when both reads failed', () => {
    const run = completedRun({ legIds: [LEG_A], ledger: null, deliveries: null, snapshots: [snapA] });
    expect(run).toEqual({ runPay: 2.96, tip: 6.26, total: 9.22, tipFull: null, orders: 1 });
  });

  it('passes over a delivery row with no pay on it rather than calling the run free', () => {
    const run = completedRun({
      legIds: [LEG_A],
      deliveries: [{ id: LEG_A, driver_earnings: null, net_tip: null, tip_visible_total: null }],
      snapshots: [snapA],
    });
    expect(run.runPay).toBe(2.96);
  });

  it('reports no tip as zero, never as a negative', () => {
    const none = completedRun({
      legIds: [LEG_A],
      ledger: [{ delivery_id: LEG_A, base_pay: 2, distance_pay: 0.96, tip_net: 0 }],
    });
    expect(none).toMatchObject({ tip: 0, total: 2.96 });
    const negative = completedRun({
      legIds: [LEG_A],
      snapshots: [{ id: LEG_A, driverEarnings: 2.96, netTip: -1, tipFullVisible: null }],
    });
    expect(negative.tip).toBe(0);
    const missing = completedRun({
      legIds: [LEG_A],
      snapshots: [{ id: LEG_A, driverEarnings: 2.96, netTip: null, tipFullVisible: null }],
    });
    expect(missing.tip).toBe(0);
  });

  it('sums every delivered leg of a batch, in whole cents, and counts the orders', () => {
    const run = completedRun({
      legIds: [LEG_A, LEG_B, LEG_B],
      ledger: [
        { delivery_id: LEG_A, base_pay: 2, distance_pay: 0.1, tip_net: 0.1 },
        { delivery_id: LEG_B, base_pay: 2, distance_pay: 0.2, tip_net: 0.2 },
      ],
    });
    // 0.1 + 0.2 is 0.30000000000000004 in floating point.
    expect(run).toEqual({ runPay: 4.3, tip: 0.3, total: 4.6, tipFull: null, orders: 2 });
  });

  it('mixes sources per leg when only one leg made it into the ledger read', () => {
    const run = completedRun({
      legIds: [LEG_A, LEG_B],
      ledger: [{ delivery_id: LEG_B, base_pay: 2, distance_pay: 1, tip_net: 1 }],
      snapshots: [snapA],
    });
    expect(run).toMatchObject({ runPay: 5.96, tip: 7.26, total: 13.22, orders: 2 });
  });

  it('leaves out a leg found nowhere instead of counting it as a free order', () => {
    const run = completedRun({ legIds: [LEG_A, LEG_B], snapshots: [snapA] });
    expect(run.orders).toBe(1);
    expect(run.total).toBe(9.22);
  });

  it('carries the full tip only when every leg has one', () => {
    const both = completedRun({
      legIds: [LEG_A, LEG_B],
      deliveries: [
        { id: LEG_A, driver_earnings: 3, net_tip: 3.6, tip_visible_total: 7.19 },
        { id: LEG_B, driver_earnings: 3, net_tip: 2, tip_visible_total: 4 },
      ],
    });
    expect(both.tipFull).toBe(11.19);
    const oneHidden = completedRun({
      legIds: [LEG_A, LEG_B],
      deliveries: [
        { id: LEG_A, driver_earnings: 3, net_tip: 3.6, tip_visible_total: 7.19 },
        { id: LEG_B, driver_earnings: 3, net_tip: 2, tip_visible_total: null },
      ],
    });
    expect(oneHidden.tipFull).toBeNull();
  });

  it('takes the full tip from the delivery row, and from the phone only without one', () => {
    const fromRow = completedRun({
      legIds: [LEG_A],
      deliveries: [{ id: LEG_A, driver_earnings: 2.96, net_tip: 3.6, tip_visible_total: null }],
      snapshots: [{ ...snapA, tipFullVisible: 7.19 }],
    });
    expect(fromRow.tipFull).toBeNull();
    const fromPhone = completedRun({
      legIds: [LEG_A],
      ledger: [{ delivery_id: LEG_A, base_pay: 2, distance_pay: 0.96, tip_net: 3.6 }],
      snapshots: [{ ...snapA, tipFullVisible: 7.19 }],
    });
    expect(fromPhone.tipFull).toBe(7.19);
  });

  it('is an empty run when there is nothing to read at all', () => {
    expect(completedRun({ legIds: [] })).toEqual({
      runPay: 0,
      tip: 0,
      total: 0,
      tipFull: null,
      orders: 0,
    });
  });
});

describe('tip share footnote', () => {
  it('names the full tip when the rider got only part of it (transparent mode)', () => {
    expect(tipShareOf({ tip: 3.6, tipFull: 7.19 })).toBe(7.19);
  });

  it('says nothing in hidden mode, where the full tip is not the rider’s to see', () => {
    expect(tipShareOf({ tip: 3.6, tipFull: null })).toBeNull();
  });

  it('says nothing when the whole tip is the rider’s', () => {
    expect(tipShareOf({ tip: 6.26, tipFull: 6.26 })).toBeNull();
    // Float noise must not turn an equal split into a footnote.
    expect(tipShareOf({ tip: 0.1 + 0.2, tipFull: 0.3 })).toBeNull();
  });

  it('still names the full tip when the rider’s share of it was nothing', () => {
    expect(tipShareOf({ tip: 0, tipFull: 5 })).toBe(5);
  });

  it('says nothing for an order with no tip at all', () => {
    expect(tipShareOf({ tip: 0, tipFull: 0 })).toBeNull();
  });
});
