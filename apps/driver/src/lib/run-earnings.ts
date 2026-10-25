/**
 * What the "Delivery complete!" screen says a run just put in the rider's balance. Pure, so the
 * arithmetic can be tested without a phone: the screen (app/active/_components/active-view.tsx)
 * only reads the rows and hands them here.
 *
 * Why it exists: that screen used to print deliveries.driver_earnings under "Earnings added", and
 * that column never includes the tip. accrue_driver_earnings credits pay AND the rider's tip share
 * to driver_earnings_ledger in the same transaction as "Mark as delivered", so a rider tipped
 * $6.26 on a $2.96 run was told $2.96 while Home and Earnings said $9.22.
 *
 * Sources, best first, per leg:
 *   1. driver_earnings_ledger: the credited record (base_pay + distance_pay, tip_net), the one
 *      Home, Earnings and History all read.
 *   2. deliveries (driver_earnings, net_tip): equal to the ledger by construction, for when the
 *      ledger read fails.
 *   3. What the phone already held for the job, for when both reads fail.
 * The full pre-split tip (tip_visible_total) only ever comes from the delivery itself, and is
 * null unless platform tips.mode was 'transparent' when the job was offered.
 */

/** PostgREST hands numerics back as strings on some drivers, hence the widened money type. */
type Money = number | string | null | undefined;

/** The columns the screen selects off driver_earnings_ledger. */
export interface LedgerLegRow {
  delivery_id: string;
  base_pay: Money;
  distance_pay: Money;
  tip_net: Money;
}

/** The columns the screen selects off deliveries. */
export interface DeliveryLegRow {
  id: string;
  driver_earnings: Money;
  net_tip: Money;
  tip_visible_total: Money;
}

/** A leg as the phone last held it (an ActiveDeliveryUI satisfies this). */
export interface SnapshotLeg {
  id: string;
  driverEarnings: number;
  netTip: number | null;
  tipFullVisible: number | null;
}

export interface CompletedRun {
  /** What the run itself paid: base_pay + distance_pay over every leg (any peak bonus included). */
  runPay: number;
  /** The rider's own share of the tips (tip_net), never the full order tip. */
  tip: number;
  /** runPay + tip: what reached the rider's balance. */
  total: number;
  /** The full pre-split tip, only when every leg carried one (tips.mode transparent); else null. */
  tipFull: number | null;
  /** How many orders the figures cover: 2 for a batch whose legs were both delivered. */
  orders: number;
}

/** Whole cents, so two legs never add up to $9.219999. Unreadable amounts count as nothing. */
function cents(value: Money): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function has(value: Money): boolean {
  return value != null && value !== '' && Number.isFinite(Number(value));
}

/**
 * Fold the delivered legs of one run into the figures the completion screen shows. `legIds` is
 * every leg the run covers; a leg found in none of the three sources is left out of the count
 * rather than shown as a free delivery.
 */
export function completedRun(input: {
  legIds: readonly string[];
  ledger?: readonly LedgerLegRow[] | null;
  deliveries?: readonly DeliveryLegRow[] | null;
  snapshots?: readonly SnapshotLeg[] | null;
}): CompletedRun {
  const ledger = new Map((input.ledger ?? []).map((r) => [r.delivery_id, r]));
  const deliveries = new Map((input.deliveries ?? []).map((r) => [r.id, r]));
  const snapshots = new Map((input.snapshots ?? []).map((r) => [r.id, r]));

  let payCents = 0;
  let tipCents = 0;
  let fullCents = 0;
  let fullKnown = true;
  let orders = 0;

  for (const id of new Set(input.legIds)) {
    const credited = ledger.get(id);
    const delivery = deliveries.get(id);
    const snapshot = snapshots.get(id);

    let pay: number;
    let tip: number;
    if (credited) {
      pay = cents(credited.base_pay) + cents(credited.distance_pay);
      tip = cents(credited.tip_net);
    } else if (delivery && has(delivery.driver_earnings)) {
      pay = cents(delivery.driver_earnings);
      tip = cents(delivery.net_tip);
    } else if (snapshot) {
      pay = cents(snapshot.driverEarnings);
      tip = cents(snapshot.netTip);
    } else {
      continue;
    }
    payCents += pay;
    // accrue_driver_earnings floors the tip at zero; so does this.
    tipCents += Math.max(0, tip);
    orders += 1;

    // One leg without a visible full tip (hidden mode, or a row we could not read) hides the
    // total: adding only the legs we can see would understate it and pass for the whole tip.
    const full = delivery ? delivery.tip_visible_total : snapshot?.tipFullVisible;
    if (has(full)) fullCents += cents(full);
    else fullKnown = false;
  }

  return {
    runPay: payCents / 100,
    tip: tipCents / 100,
    total: (payCents + tipCents) / 100,
    tipFull: fullKnown && orders > 0 ? fullCents / 100 : null,
    orders,
  };
}

/**
 * The "(your share of $Y)" amount, or null when it must not be shown: only when the full tip is
 * known (tips.mode transparent) and is more than the rider got. Equal means the whole tip is
 * theirs, which needs no footnote; the offer card's "(all yours)" is deliberately not repeated
 * here, since in hidden mode the phone cannot know that it is true.
 */
export function tipShareOf(run: Pick<CompletedRun, 'tip' | 'tipFull'>): number | null {
  if (run.tipFull == null) return null;
  return cents(run.tipFull) > cents(run.tip) ? run.tipFull : null;
}
