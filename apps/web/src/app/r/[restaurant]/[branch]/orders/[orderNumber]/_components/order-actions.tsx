'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Pencil, Star, XCircle } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

interface Props {
  orderId: string;
  branchId: string;
  orderStatus: string;
  hasRating: boolean;
  hasDriver: boolean;
}

/**
 * Customer-facing actions on the order tracking page:
 *  - Cancel order (allowed while pending/confirmed)
 *  - Rate the order (after delivered/completed) — auto-opens as a required
 *    modal that can't be dismissed until the stars are submitted (a "skip"
 *    appears after a failed submit so an error can't lock the page)
 */
export function OrderActions({ orderId, branchId, orderStatus, hasRating, hasDriver }: Props) {
  const canCancel = ['pending', 'confirmed'].includes(orderStatus);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [foodStars, setFoodStars] = React.useState(0);
  const [deliveryStars, setDeliveryStars] = React.useState(0);
  const [comment, setComment] = React.useState('');
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [notesDraft, setNotesDraft] = React.useState('');
  // The server wiring passes hasRating, but the page can also be reloaded (or
  // the status flips live via realtime) after a rating exists — confirm against
  // order_ratings before auto-opening the modal so it never re-asks.
  const [ratedAlready, setRatedAlready] = React.useState(hasRating);
  const [ratingChecked, setRatingChecked] = React.useState(hasRating);
  // Escape hatch: a failed submit must not trap the page behind the modal.
  const [skipped, setSkipped] = React.useState(false);
  // Brief in-modal thank-you before the modal closes for good.
  const [thanks, setThanks] = React.useState(false);

  React.useEffect(() => {
    if (hasRating || !['delivered', 'completed'].includes(orderStatus)) return;
    let cancelled = false;
    const supabase = getBrowserClient();
    void supabase
      .from('order_ratings')
      .select('id')
      .eq('order_id', orderId)
      .maybeSingle()
      .then(({ data, error: checkErr }) => {
        if (cancelled) return;
        setRatedAlready(!!data);
        // A failed check can't tell us whether a rating exists — keep the
        // modal closed rather than re-asking (the insert would just 23505).
        setRatingChecked(!checkErr);
      });
    return () => {
      cancelled = true;
    };
  }, [orderId, orderStatus, hasRating]);

  const canRate = ['delivered', 'completed'].includes(orderStatus) && !ratedAlready;
  const ratingModalOpen = canRate && ratingChecked && !done && !skipped;

  React.useEffect(() => {
    if (!ratingModalOpen) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [ratingModalOpen]);

  const canReport = ['completed', 'delivered', 'out_for_delivery', 'ready'].includes(orderStatus);
  if (!canCancel && !canRate && !canReport && !done && !ratedAlready) return null;

  const doCancel = async () => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('cancel_order', {
      p_order_id: orderId,
      p_reason: 'Customer requested',
    });
    setBusy(false);
    setConfirmCancel(false);
    if (rpcErr) setError(rpcErr.message);
  };

  const saveNotes = async () => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('edit_pending_order', {
      p_order_id: orderId,
      p_customer_notes: notesDraft,
    });
    setBusy(false);
    setEditing(false);
    if (rpcErr) setError(rpcErr.message);
  };

  const submitRating = async () => {
    if (foodStars === 0 || (hasDriver && deliveryStars === 0)) return;
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
    const { error: insErr } = await supabase.from('order_ratings').insert({
      order_id: orderId,
      customer_id: orderRow.customer_id,
      branch_id: branchId,
      food_stars: foodStars,
      delivery_stars: hasDriver ? deliveryStars : null,
      comment: comment || null,
    });
    setBusy(false);
    if (insErr) {
      // unique(order_id) — rated in another tab/session; close out gracefully.
      if (insErr.code === '23505') { setDone(true); setRatedAlready(true); return; }
      setError(insErr.message);
      return;
    }
    setThanks(true);
    setTimeout(() => {
      setDone(true);
      setRatedAlready(true);
    }, 1800);
  };

  return (
    <>
    <Card className="space-y-3 p-5">
      {canCancel && !editing && !confirmCancel && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            fullWidth
            onClick={() => { setNotesDraft(''); setEditing(true); }}
            leftIcon={<Pencil className="h-4 w-4" />}
          >
            Edit instructions
          </Button>
          <Button
            variant="ghost"
            fullWidth
            onClick={() => setConfirmCancel(true)}
            leftIcon={<XCircle className="h-4 w-4" />}
          >
            Cancel order
          </Button>
        </div>
      )}
      {canCancel && editing && (
        <div className="space-y-2">
          <textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            placeholder="Add or update special instructions for this order…"
            className="input min-h-20 py-3"
            maxLength={500}
            autoFocus
          />
          <div className="flex gap-2">
            <Button variant="ghost" fullWidth onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="gradient" fullWidth onClick={saveNotes} loading={busy}>
              Save instructions
            </Button>
          </div>
        </div>
      )}
      {canCancel && confirmCancel && (
        <div className="space-y-2 rounded-2xl border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm font-semibold">Cancel this order?</p>
          <p className="text-xs text-muted-foreground">This can&apos;t be undone.</p>
          <div className="flex gap-2">
            <Button variant="outline" fullWidth onClick={() => setConfirmCancel(false)}>
              Keep order
            </Button>
            <Button variant="danger" fullWidth onClick={doCancel} loading={busy}>
              Yes, cancel
            </Button>
          </div>
        </div>
      )}
      {canReport && (
        <IssueReportButton orderId={orderId} branchId={branchId} />
      )}
      {(done || ratedAlready) && (
        <p className="rounded-xl bg-success/10 px-3 py-2 text-sm text-success">Thanks for your feedback!</p>
      )}
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
                        ? 'Rate the food and your delivery to finish up.'
                        : 'Rate the food to finish up.'}
                    </p>
                  </div>
                </div>
                <div className="space-y-4 p-6">
                  <BigStarRow label="Food" value={foodStars} onChange={setFoodStars} />
                  {hasDriver && (
                    <BigStarRow label="Delivery" value={deliveryStars} onChange={setDeliveryStars} />
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
                    disabled={foodStars === 0 || (hasDriver && deliveryStars === 0)}
                    leftIcon={<Star className="h-4 w-4" />}
                  >
                    Submit rating
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    {hasDriver ? 'Food and delivery stars are required.' : 'Food stars are required.'}
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
