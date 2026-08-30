'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Info, Star } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

export interface ExistingRating {
  /** Null while only the driver half of a two-step rating has been given. */
  food_stars: number | null;
  delivery_stars: number | null;
  comment: string | null;
  driver_comment?: string | null;
}

interface Props {
  orderId: string;
  branchId: string;
  orderStatus: string;
  /**
   * The rating already stored for this order. `undefined` means "not looked up
   * yet" — the modal stays shut until we actually know, so a slow lookup can
   * never re-ask someone who has already rated.
   */
  existingRating: ExistingRating | null | undefined;
  hasDriver: boolean;
  /** The rider being rated. order_ratings.driver_id was never set by this component, so
   *  every star the customer gave attached to nobody and no rider average could move. */
  driverId?: string | null;
  /** QR-transfer order the merchant has not confirmed payment for. Nothing is cooking — the
   *  kitchen board filters these out — so the customer may still call it off themselves. */
  awaitingPayment?: boolean;
}

/**
 * `completed` is the only terminal value of the order status enum
 * (pending | confirmed | preparing | ready | out_for_delivery | completed |
 * cancelled | refunded). `delivered` belongs to the *deliveries* table and
 * never appears on an order, so an order is rateable only once completed —
 * never while it is still in flight, and never once cancelled/refunded.
 */
const RATEABLE_STATUSES = ['completed'];

/**
 * Customer-facing actions on the order tracking page:
 *  - Report an issue (once the food is out of the kitchen)
 *  - Rate the order (once completed, exactly once) — auto-opens as a required
 *    modal that can't be dismissed until the stars are submitted (a "skip"
 *    appears after a failed submit so an error can't lock the page)
 *
 * Self-serve "Edit instructions" and "Cancel order" were removed: a placed
 * order is worked by real people in a kitchen, so a change has to be agreed
 * with the restaurant rather than applied behind their back. Staff keep both
 * powers (admin Orders kebab, kitchen "Reject order").
 */
export function OrderActions({
  orderId,
  branchId,
  orderStatus,
  existingRating,
  hasDriver,
  driverId = null,
  awaitingPayment = false,
}: Props) {
  const router = useRouter();
  const [cancelling, setCancelling] = React.useState(false);
  // The window in which contacting the restaurant can still change anything —
  // once it is out for delivery or handed over, there is nothing left to alter.
  const canStillChange = ['pending', 'confirmed', 'preparing'].includes(orderStatus);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [foodStars, setFoodStars] = React.useState(0);
  const [deliveryStars, setDeliveryStars] = React.useState(0);
  const [comment, setComment] = React.useState('');
  const [driverComment, setDriverComment] = React.useState('');
  // One sheet asked for both scores and offered a single comment box, so anything written
  // about the rider was filed against the restaurant. Two sheets now, rider first, each
  // with its own words.
  const [step, setStep] = React.useState<'driver' | 'food'>('driver');
  // What we just wrote in this session — merged over the fetched row so the
  // stars flip to read-only the moment the insert lands.
  const [justRated, setJustRated] = React.useState<ExistingRating | null>(null);
  // Escape hatch: a failed submit must not trap the page behind the modal.
  const [skipped, setSkipped] = React.useState(false);
  // Brief in-modal thank-you before the modal closes for good.
  const [thanks, setThanks] = React.useState(false);

  const storedRating = justRated ?? existingRating ?? null;
  // `undefined` = the lookup hasn't answered yet. Until it does, asking for a
  // rating risks re-asking someone who already gave one (the insert would just
  // bounce off the unique(order_id) index anyway).
  const ratingChecked = existingRating !== undefined;
  // Each half is asked for independently, so a customer who gives the rider their stars and
  // then closes the tab has still rated the rider — and is asked only for the missing half
  // when they come back.
  const needsDriver = hasDriver && storedRating?.delivery_stars == null;
  const needsFood = storedRating?.food_stars == null;
  const canRate = RATEABLE_STATUSES.includes(orderStatus) && (needsDriver || needsFood);
  const ratingModalOpen = canRate && ratingChecked && !skipped;

  // Start on whichever half is outstanding; the rider always goes first when both are.
  React.useEffect(() => {
    if (!ratingChecked) return;
    setStep(needsDriver ? 'driver' : 'food');
  }, [ratingChecked, needsDriver]);

  React.useEffect(() => {
    if (!ratingModalOpen) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [ratingModalOpen]);

  const canReport = ['completed', 'out_for_delivery', 'ready'].includes(orderStatus);
  if (!canStillChange && !canRate && !canReport && !storedRating) return null;

  /** Resolve the customers row through the ORDER, never by user_id: identity is per
   *  restaurant, so one person can own several customers rows. */
  const resolveCustomerId = async (): Promise<string | null> => {
    const supabase = getBrowserClient();
    const { data: user } = await supabase.auth.getUser();
    if (!user.user) { setError('not_signed_in'); return null; }
    const { data: orderRow } = await supabase
      .from('orders')
      .select('customer_id')
      .eq('id', orderId)
      .maybeSingle();
    if (!orderRow?.customer_id) { setError('no_customer'); return null; }
    return orderRow.customer_id;
  };

  /** Upsert on order_id. The table is unique(order_id) and each step writes only its own
   *  columns, so the second step never disturbs the first — and a retry is harmless. */
  const saveHalf = async (patch: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const customerId = await resolveCustomerId();
    if (!customerId) { setBusy(false); return false; }
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase
      .from('order_ratings')
      .upsert(
        { order_id: orderId, customer_id: customerId, branch_id: branchId, ...patch },
        { onConflict: 'order_id' },
      );
    setBusy(false);
    if (upErr) {
      setError(upErr.message);
      return false;
    }
    return true;
  };

  const submitDriver = async () => {
    if (busy || deliveryStars === 0) return;
    // driver_id was simply never written. Every delivery star the customer had given
    // attached to no rider at all, which is why drivers.average_rating could not move even
    // once the sync trigger existed.
    const ok = await saveHalf({
      driver_id: driverId,
      delivery_stars: deliveryStars,
      driver_comment: driverComment || null,
    });
    if (!ok) return;
    setJustRated({
      food_stars: storedRating?.food_stars ?? null,
      delivery_stars: deliveryStars,
      comment: storedRating?.comment ?? null,
      driver_comment: driverComment || null,
    });
    // Straight on to the restaurant — the rider's half is banked either way.
    if (needsFood) setStep('food');
    else { setThanks(true); setTimeout(() => setSkipped(true), 1800); }
  };

  const submitFood = async () => {
    if (busy || foodStars === 0) return;
    const ok = await saveHalf({ food_stars: foodStars, comment: comment || null });
    if (!ok) return;
    const submission: ExistingRating = {
      food_stars: foodStars,
      delivery_stars: deliveryStars || storedRating?.delivery_stars || null,
      comment: comment || null,
      driver_comment: driverComment || storedRating?.driver_comment || null,
    };
    setThanks(true);
    setTimeout(() => setJustRated(submission), 1800);
  };

  return (
    <>
    <Card className="space-y-3 p-5">
      {/* Replaces the old self-serve Edit/Cancel buttons — the kitchen has to
          agree to a change, so point people at the restaurant instead of
          silently rewriting an order someone may already be cooking. */}
      {/* Self-cancel came back for exactly one case. The blanket removal was right while
          food might already be on the pass, but an unpaid QR order is not on the pass: the
          kitchen board filters awaiting_payment out, and cancel_order already permits the
          customer while the order is pending or confirmed. Waiting on hold to call off an
          order nobody has started is the wrong ask. */}
      {awaitingPayment && canStillChange && (
        <div className="space-y-2 rounded-2xl border border-border bg-muted/40 p-3">
          <p className="text-sm text-muted-foreground">
            Changed your mind? Nothing has been prepared yet — the restaurant has not
            confirmed your transfer, so you can still call this order off.
          </p>
          <Button
            variant="outline"
            size="md"
            fullWidth
            loading={cancelling}
            onClick={async () => {
              setCancelling(true);
              setError(null);
              const supabase = getBrowserClient();
              const { error: cancelErr } = await supabase.rpc('cancel_order', {
                p_order_id: orderId,
                p_reason: 'Cancelled by the customer before payment was confirmed.',
              });
              setCancelling(false);
              if (cancelErr) {
                setError(cancelErr.message);
                return;
              }
              router.refresh();
            }}
          >
            Cancel this order
          </Button>
        </div>
      )}
      {!awaitingPayment && canStillChange && (
        <div className="flex gap-2.5 rounded-2xl border border-border bg-muted/40 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Need to change or cancel this order? Please contact the restaurant
            directly — they can update it for you while it&apos;s still being prepared.
          </p>
        </div>
      )}
      {canReport && (
        <IssueReportButton orderId={orderId} branchId={branchId} />
      )}
      {storedRating && <SubmittedRating rating={storedRating} />}
      {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    </Card>

    {/* Required rating — no backdrop close, no X; submit unlocks once the stars are in. */}
    <AnimatePresence>
      {ratingModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, y: 48, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            className="relative w-full max-w-md overflow-hidden rounded-t-3xl bg-card shadow-2xl sm:mx-4 sm:rounded-3xl"
          >
            {thanks ? (
              <div className="grid place-items-center gap-2 p-10 text-center">
                <motion.span
                  initial={{ scale: 0.3, rotate: -20 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 14 }}
                  className="text-5xl"
                >
                  🎉
                </motion.span>
                <h3 className="font-display text-xl font-bold">Thank you!</h3>
                <p className="text-sm text-muted-foreground">
                  Your feedback helps the restaurant get even better.
                </p>
              </div>
            ) : (
              <>
                {/* Two sheets, one subject each. Both scores and one shared comment box on a
                    single sheet meant whatever the customer wrote landed against the
                    restaurant even when it was plainly about the rider. */}
                <div className="relative bg-gradient-warm p-6 text-white">
                  <div className="absolute inset-0 bg-noise opacity-30" />
                  <div className="relative">
                    <h3 className="font-display text-2xl font-bold">
                      {step === 'driver' ? 'How was your driver?' : 'How was the food?'}
                    </h3>
                    <p className="mt-1 text-sm text-white/85">
                      {step === 'driver'
                        ? needsFood
                          ? 'Rate your rider first — the restaurant is next.'
                          : 'Rate the rider who brought your order.'
                        : needsDriver || deliveryStars > 0
                          ? 'Last step — how was the food itself?'
                          : 'Rate the food to finish up.'}
                    </p>
                    {step === 'food' && hasDriver && (
                      <p className="mt-2 text-xs text-white/70">Step 2 of 2</p>
                    )}
                    {step === 'driver' && needsFood && (
                      <p className="mt-2 text-xs text-white/70">Step 1 of 2</p>
                    )}
                  </div>
                </div>
                <div className="space-y-4 p-6">
                  {step === 'driver' ? (
                    <>
                      <BigStarRow label="Your driver" value={deliveryStars} onChange={setDeliveryStars} />
                      <textarea
                        value={driverComment}
                        onChange={(e) => setDriverComment(e.target.value)}
                        placeholder="Anything to say about your driver? (optional)"
                        className="input min-h-24 py-3"
                        maxLength={500}
                      />
                    </>
                  ) : (
                    <>
                      <BigStarRow label="Food" value={foodStars} onChange={setFoodStars} />
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder="Anything to say about the food? (optional)"
                        className="input min-h-24 py-3"
                        maxLength={500}
                      />
                    </>
                  )}
                  {error && (
                    <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
                  )}
                  <Button
                    variant="gradient"
                    size="lg"
                    fullWidth
                    onClick={step === 'driver' ? submitDriver : submitFood}
                    loading={busy}
                    disabled={busy || (step === 'driver' ? deliveryStars === 0 : foodStars === 0)}
                    leftIcon={<Star className="h-4 w-4" />}
                  >
                    {step === 'driver' && needsFood ? 'Next — rate the restaurant' : 'Submit rating'}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    {step === 'driver' ? 'Driver stars are required.' : 'Food stars are required.'}
                  </p>
                  {/* Once a submit has failed, the modal must not hold the page hostage. */}
                  {error && (
                    <button
                      type="button"
                      onClick={() => setSkipped(true)}
                      className="focus-ring mx-auto block text-xs font-medium text-muted-foreground underline"
                    >
                      Skip for now
                    </button>
                  )}
                </div>
              </>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>

    <style jsx>{`
      .input { width: 100%; padding: 0 1rem; font-size: 16px; border-radius: 0.875rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
      .input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
    `}</style>
    </>
  );
}

/** Read-only echo of the one rating this order is allowed to have. */
function SubmittedRating({ rating }: { rating: ExistingRating }) {
  return (
    <div className="rounded-2xl border border-success/30 bg-success/5 p-3">
      <p className="text-sm font-semibold text-success">Thanks for your feedback!</p>
      <div className="mt-2 space-y-1">
        {/* Either half can stand alone now: the rider is rated in its own step and banked
            before the restaurant is even asked about. */}
        {rating.delivery_stars != null && (
          <StaticStarRow label="Your driver" value={rating.delivery_stars} />
        )}
        {rating.food_stars != null && <StaticStarRow label="Food" value={rating.food_stars} />}
      </div>
      {rating.driver_comment && (
        <p className="mt-2 text-sm italic text-muted-foreground">
          On your driver: &ldquo;{rating.driver_comment}&rdquo;
        </p>
      )}
      {rating.comment && (
        <p className="mt-2 text-sm italic text-muted-foreground">
          On the food: &ldquo;{rating.comment}&rdquo;
        </p>
      )}
    </div>
  );
}

function StaticStarRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-xs text-muted-foreground">{label}</span>
      <span className="text-base leading-none" aria-label={`${label}: ${value} out of 5 stars`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={n <= value ? 'text-amber-400' : 'text-muted-foreground/25'}>
            ★
          </span>
        ))}
      </span>
    </div>
  );
}

function BigStarRow({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div>
      <p className="text-sm font-semibold">{label}</p>
      <div className="mt-1.5 flex gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <motion.button
            key={n}
            type="button"
            whileTap={{ scale: 0.8 }}
            onClick={() => onChange(n)}
            className="focus-ring rounded-lg"
            aria-label={`${label}: ${n} star${n > 1 ? 's' : ''}`}
            aria-pressed={n <= value}
          >
            {/* Remount on select so the star pops in with a spring overshoot. */}
            <motion.span
              key={n <= value ? 'on' : 'off'}
              initial={{ scale: n <= value ? 0.4 : 1 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 500, damping: 14 }}
              className={`block text-4xl leading-none ${
                n <= value ? 'text-amber-400 drop-shadow-sm' : 'text-muted-foreground/25'
              }`}
            >
              ★
            </motion.span>
          </motion.button>
        ))}
      </div>
    </div>
  );
}

const CATEGORIES = [
  { value: 'missing_item', label: 'Missing an item' },
  { value: 'wrong_item', label: 'Wrong item received' },
  { value: 'quality', label: 'Food quality issue' },
  { value: 'delivery', label: 'Delivery problem' },
  { value: 'payment', label: 'Payment / billing' },
  { value: 'other', label: 'Other' },
] as const;

function IssueReportButton({ orderId, branchId }: { orderId: string; branchId: string }) {
  const [open, setOpen] = React.useState(false);
  const [category, setCategory] = React.useState<typeof CATEGORIES[number]['value']>('missing_item');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [ok, setOk] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = async () => {
    if (!message.trim()) {
      setErr('Please describe the issue.');
      return;
    }
    setBusy(true);
    setErr(null);
    const supabase = getBrowserClient();
    const { data: user } = await supabase.auth.getUser();
    let customerId: string | null = null;
    if (user.user) {
      const { data: c } = await supabase
        .from('customers')
        .select('id')
        .eq('user_id', user.user.id)
        .eq('branch_id', branchId)
        .maybeSingle();
      customerId = c?.id ?? null;
    }
    const { error: insErr } = await supabase.from('support_tickets').insert({
      order_id: orderId,
      branch_id: branchId,
      customer_id: customerId,
      category,
      message: message.trim(),
    });
    setBusy(false);
    if (insErr) {
      setErr(insErr.message);
      return;
    }
    setOk(true);
    setTimeout(() => { setOk(false); setOpen(false); setMessage(''); }, 2000);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold text-muted-foreground hover:bg-muted"
      >
        <AlertCircle className="h-4 w-4" />
        Report an issue
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <p className="font-display text-sm font-semibold">Report an issue</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="focus-ring text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as typeof CATEGORIES[number]['value'])}
        className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
      >
        {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Tell us what happened…"
        rows={3}
        maxLength={1000}
        className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
      />
      {err && <p className="text-xs text-destructive">{err}</p>}
      {ok ? (
        <p className="rounded-xl bg-success/10 px-3 py-2 text-sm text-success">Thanks — the restaurant has been notified.</p>
      ) : (
        <Button variant="gradient" fullWidth onClick={submit} loading={busy} leftIcon={<AlertCircle className="h-4 w-4" />}>
          Submit
        </Button>
      )}
    </div>
  );
}
