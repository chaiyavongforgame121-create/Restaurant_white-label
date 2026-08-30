'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Info, Star } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

export interface ExistingRating {
  food_stars: number;
  delivery_stars: number | null;
  comment: string | null;
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
export function OrderActions({ orderId, branchId, orderStatus, existingRating, hasDriver }: Props) {
  // The window in which contacting the restaurant can still change anything —
  // once it is out for delivery or handed over, there is nothing left to alter.
  const canStillChange = ['pending', 'confirmed', 'preparing'].includes(orderStatus);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [foodStars, setFoodStars] = React.useState(0);
  const [deliveryStars, setDeliveryStars] = React.useState(0);
  const [comment, setComment] = React.useState('');
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
  const canRate = RATEABLE_STATUSES.includes(orderStatus) && !storedRating;
  const ratingModalOpen = canRate && ratingChecked && !skipped;

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

  const submitRating = async () => {
    // Guard as well as disable — a double-tap can fire twice before React
    // paints the disabled state, and the second insert would 23505.
    if (busy || foodStars === 0 || (hasDriver && deliveryStars === 0)) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { data: user } = await supabase.auth.getUser();
    if (!user.user) { setError('not_signed_in'); setBusy(false); return; }
    // Customer identity is per restaurant, so a user can have several customers
    // rows — resolve through the order's own customer link, never by user_id.
    const { data: orderRow } = await supabase
      .from('orders')
      .select('customer_id')
      .eq('id', orderId)
      .maybeSingle();
    if (!orderRow?.customer_id) { setError('no_customer'); setBusy(false); return; }
    const submission: ExistingRating = {
      food_stars: foodStars,
      delivery_stars: hasDriver ? deliveryStars : null,
      comment: comment || null,
    };
    const { error: insErr } = await supabase.from('order_ratings').insert({
      order_id: orderId,
      customer_id: orderRow.customer_id,
      branch_id: branchId,
      ...submission,
    });
    setBusy(false);
    if (insErr) {
      // unique(order_id) on order_ratings — one rating per order, forever. Say
      // so instead of flashing a thank-you for a write that never happened.
      if (insErr.code === '23505') {
        setError("You've already rated this order.");
        return;
      }
      setError(insErr.message);
      return;
    }
    setThanks(true);
    setTimeout(() => setJustRated(submission), 1800);
  };

  return (
    <>
    <Card className="space-y-3 p-5">
      {/* Replaces the old self-serve Edit/Cancel buttons — the kitchen has to
          agree to a change, so point people at the restaurant instead of
          silently rewriting an order someone may already be cooking. */}
      {canStillChange && (
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
                <div className="relative bg-gradient-warm p-6 text-white">
                  <div className="absolute inset-0 bg-noise opacity-30" />
                  <div className="relative">
                    <h3 className="font-display text-2xl font-bold">How was your order?</h3>
                    <p className="mt-1 text-sm text-white/85">
                      {hasDriver
                        ? 'Rate the food and your driver to finish up.'
                        : 'Rate the food to finish up.'}
                    </p>
                  </div>
                </div>
                <div className="space-y-4 p-6">
                  <BigStarRow label="Food" value={foodStars} onChange={setFoodStars} />
                  {hasDriver && (
                    <BigStarRow label="Your driver" value={deliveryStars} onChange={setDeliveryStars} />
                  )}
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Anything else you'd like to share? (optional)"
                    className="input min-h-24 py-3"
                    maxLength={500}
                  />
                  {error && (
                    <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
                  )}
                  <Button
                    variant="gradient"
                    size="lg"
                    fullWidth
                    onClick={submitRating}
                    loading={busy}
                    disabled={busy || foodStars === 0 || (hasDriver && deliveryStars === 0)}
                    leftIcon={<Star className="h-4 w-4" />}
                  >
                    Submit rating
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    {hasDriver ? 'Food and driver stars are required.' : 'Food stars are required.'}
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
        <StaticStarRow label="Food" value={rating.food_stars} />
        {rating.delivery_stars != null && (
          <StaticStarRow label="Your driver" value={rating.delivery_stars} />
        )}
      </div>
      {rating.comment && (
        <p className="mt-2 text-sm italic text-muted-foreground">&ldquo;{rating.comment}&rdquo;</p>
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
