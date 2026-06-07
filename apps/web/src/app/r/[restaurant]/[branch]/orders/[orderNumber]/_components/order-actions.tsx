'use client';

import * as React from 'react';
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
 *  - Rate the order (after delivered/completed)
 */
export function OrderActions({ orderId, branchId, orderStatus, hasRating, hasDriver }: Props) {
  const canCancel = ['pending', 'confirmed'].includes(orderStatus);
  const canRate = ['delivered', 'completed'].includes(orderStatus) && !hasRating;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [foodStars, setFoodStars] = React.useState(5);
  const [deliveryStars, setDeliveryStars] = React.useState(5);
  const [comment, setComment] = React.useState('');

  const canReport = ['completed', 'delivered', 'out_for_delivery', 'ready'].includes(orderStatus);
  if (!canCancel && !canRate && !canReport && !done) return null;

  const cancel = async () => {
    if (!confirm('Cancel this order?')) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('cancel_order', {
      p_order_id: orderId,
      p_reason: 'Customer requested',
    });
    setBusy(false);
    if (rpcErr) setError(rpcErr.message);
  };

  const editNotes = async () => {
    const next = window.prompt('Add or update special instructions for this order:', '');
    if (next === null) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('edit_pending_order', {
      p_order_id: orderId,
      p_customer_notes: next,
    });
    setBusy(false);
    if (rpcErr) setError(rpcErr.message);
  };

  const submitRating = async () => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { data: user } = await supabase.auth.getUser();
    if (!user.user) { setError('not_signed_in'); setBusy(false); return; }
    const { data: customer } = await supabase
      .from('customers')
      .select('id')
      .eq('user_id', user.user.id)
      .maybeSingle();
    if (!customer) { setError('no_customer'); setBusy(false); return; }
    const { error: insErr } = await supabase.from('order_ratings').insert({
      order_id: orderId,
      customer_id: customer.id,
      branch_id: branchId,
      food_stars: foodStars,
      delivery_stars: hasDriver ? deliveryStars : null,
      comment: comment || null,
    });
    setBusy(false);
    if (insErr) { setError(insErr.message); return; }
    setDone(true);
  };

  return (
    <Card className="space-y-3 p-5">
      {canCancel && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            fullWidth
            onClick={editNotes}
            loading={busy}
            leftIcon={<Pencil className="h-4 w-4" />}
          >
            Edit instructions
          </Button>
          <Button
            variant="ghost"
            fullWidth
            onClick={cancel}
            loading={busy}
            leftIcon={<XCircle className="h-4 w-4" />}
          >
            Cancel order
          </Button>
        </div>
      )}
      {canRate && !done && (
        <div className="space-y-3">
          <h3 className="font-display text-lg font-semibold">How was it?</h3>
          <RatingRow label="Food" value={foodStars} onChange={setFoodStars} />
          {hasDriver && <RatingRow label="Delivery" value={deliveryStars} onChange={setDeliveryStars} />}
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Tell the restaurant about your experience…"
            className="input min-h-24 py-3"
            maxLength={500}
          />
          <Button variant="gradient" fullWidth onClick={submitRating} loading={busy} leftIcon={<Star className="h-4 w-4" />}>
            Submit rating
          </Button>
        </div>
      )}
      {canReport && (
        <IssueReportButton orderId={orderId} branchId={branchId} />
      )}
      {done && <p className="rounded-xl bg-success/10 px-3 py-2 text-sm text-success">Thanks for your feedback!</p>}
      {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <style jsx>{`
        .input { width: 100%; padding: 0 1rem; font-size: 16px; border-radius: 0.875rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
        .input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
      `}</style>
    </Card>
  );
}

function RatingRow({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 text-sm font-medium">{label}</span>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={`text-2xl transition ${n <= value ? 'text-amber-400' : 'text-muted-foreground/30'}`}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
          >
            ★
          </button>
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
