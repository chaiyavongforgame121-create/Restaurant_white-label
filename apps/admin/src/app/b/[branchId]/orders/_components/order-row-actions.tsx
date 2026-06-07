'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { FileText, MoreHorizontal, Pencil, RefreshCcw, XCircle } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card, IconButton } from '@favornoms/ui';

interface Props {
  orderId: string;
  orderTotal: number;
  orderStatus: string;
}

export function OrderRowActions({ orderId, orderTotal, orderStatus }: Props) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [refundOpen, setRefundOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canRefund = !['canceled', 'refunded'].includes(orderStatus);
  const canCancel = !['canceled', 'refunded', 'completed', 'delivered'].includes(orderStatus);
  const canEdit = ['pending', 'confirmed'].includes(orderStatus);

  const editNotes = async () => {
    const next = window.prompt('Update internal notes for this order:', '');
    if (next === null) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('admin_edit_order_notes', {
      p_order_id: orderId,
      p_notes: next,
    });
    setBusy(false);
    if (rpcErr) { setError(rpcErr.message); return; }
    setOpen(false);
    router.refresh();
  };

  const cancel = async () => {
    if (!confirm('Cancel this order?')) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('cancel_order', {
      p_order_id: orderId,
      p_reason: 'Admin canceled',
    });
    setBusy(false);
    if (rpcErr) { setError(rpcErr.message); return; }
    setOpen(false);
    router.refresh();
  };

  const issueTaxInvoice = async () => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { data, error: rpcErr } = await supabase.rpc('issue_tax_invoice', {
      p_order_id: orderId,
    });
    setBusy(false);
    if (rpcErr) { setError(rpcErr.message); return; }
    const inv = data as { invoice_number?: string } | null;
    alert(`Issued invoice ${inv?.invoice_number ?? '(unknown)'}`);
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <IconButton label="Actions" size="sm" onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>

      {open && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setOpen(false)}
        >
          <div className="fixed right-4 top-1/2 z-50 w-64 -translate-y-1/2" onClick={(e) => e.stopPropagation()}>
            <Card className="space-y-1 p-2">
              {canRefund && (
                <button
                  type="button"
                  onClick={() => setRefundOpen(true)}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <RefreshCcw className="h-4 w-4" /> Issue refund
                </button>
              )}
              {canCancel && (
                <button
                  type="button"
                  onClick={cancel}
                  disabled={busy}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                >
                  <XCircle className="h-4 w-4" /> Cancel order
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  onClick={editNotes}
                  disabled={busy}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <Pencil className="h-4 w-4" /> Edit notes
                </button>
              )}
              <button
                type="button"
                onClick={issueTaxInvoice}
                disabled={busy}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <FileText className="h-4 w-4" /> Issue receipt
              </button>
            </Card>
          </div>
        </div>
      )}

      {refundOpen && (
        <RefundDialog
          orderId={orderId}
          orderTotal={orderTotal}
          onClose={() => setRefundOpen(false)}
          onRefunded={() => { setRefundOpen(false); setOpen(false); router.refresh(); }}
        />
      )}
    </>
  );
}

interface OrderLine {
  id: string;
  item_name: string;
  unit_price: number;
  quantity: number;
  subtotal: number;
}

function RefundDialog({
  orderId,
  orderTotal,
  onClose,
  onRefunded,
}: {
  orderId: string;
  orderTotal: number;
  onClose: () => void;
  onRefunded: () => void;
}) {
  const [mode, setMode] = React.useState<'items' | 'amount'>('items');
  const [lines, setLines] = React.useState<OrderLine[] | null>(null);
  const [qty, setQty] = React.useState<Record<string, number>>({});
  const [customAmount, setCustomAmount] = React.useState(String(orderTotal.toFixed(2)));
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    (async () => {
      const supabase = getBrowserClient();
      const { data } = await supabase
        .from('order_items')
        .select('id, item_name, unit_price, quantity, subtotal')
        .eq('order_id', orderId);
      setLines((data ?? []) as OrderLine[]);
      const init: Record<string, number> = {};
      for (const l of (data ?? []) as OrderLine[]) init[l.id] = 0;
      setQty(init);
    })();
  }, [orderId]);

  const computedAmount = React.useMemo(() => {
    if (mode === 'amount') return Number(customAmount) || 0;
    if (!lines) return 0;
    return lines.reduce((s, l) => {
      const q = qty[l.id] ?? 0;
      return s + q * Number(l.unit_price);
    }, 0);
  }, [mode, customAmount, qty, lines]);

  const submit = async () => {
    if (computedAmount <= 0) {
      setError('Refund amount must be greater than zero.');
      return;
    }
    if (computedAmount > orderTotal + 0.001) {
      setError(`Refund cannot exceed the order total of $${orderTotal.toFixed(2)}.`);
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const breakdown =
      mode === 'items' && lines
        ? lines
            .filter((l) => (qty[l.id] ?? 0) > 0)
            .map((l) => ({ line_id: l.id, name: l.item_name, quantity: qty[l.id], unit_price: Number(l.unit_price) }))
        : null;
    const reasonText = [
      reason || null,
      breakdown && breakdown.length > 0
        ? `lines: ${breakdown.map((b) => `${b.quantity}× ${b.name}`).join(', ')}`
        : null,
    ]
      .filter(Boolean)
      .join(' — ') || null;
    const { error: rpcErr } = await supabase.rpc('refund_order', {
      p_order_id: orderId,
      p_amount: Math.round(computedAmount * 100) / 100,
      p_reason: reasonText,
    });
    setBusy(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    onRefunded();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <Card className="w-full max-w-lg space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-lg font-semibold">Issue refund</h2>

        <div className="flex rounded-full bg-muted p-1 text-sm font-semibold">
          <button
            type="button"
            onClick={() => setMode('items')}
            className={`focus-ring flex-1 rounded-full py-1.5 ${mode === 'items' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'}`}
          >
            By items
          </button>
          <button
            type="button"
            onClick={() => setMode('amount')}
            className={`focus-ring flex-1 rounded-full py-1.5 ${mode === 'amount' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'}`}
          >
            Custom amount
          </button>
        </div>

        {mode === 'items' ? (
          <div className="space-y-2">
            {lines === null ? (
              <p className="text-sm text-muted-foreground">Loading items…</p>
            ) : lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No items found for this order.</p>
            ) : (
              <ul className="space-y-2">
                {lines.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{l.item_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {l.quantity}× ${Number(l.unit_price).toFixed(2)} = ${Number(l.subtotal).toFixed(2)}
                      </p>
                    </div>
                    <label className="flex items-center gap-1 text-xs">
                      <span className="text-muted-foreground">Refund qty</span>
                      <input
                        type="number"
                        min={0}
                        max={l.quantity}
                        value={qty[l.id] ?? 0}
                        onChange={(e) =>
                          setQty((curr) => ({
                            ...curr,
                            [l.id]: Math.max(0, Math.min(l.quantity, Number(e.target.value) || 0)),
                          }))
                        }
                        className="focus-ring w-16 rounded-lg border border-border bg-background px-2 py-1 text-sm tabular-nums"
                      />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Amount (USD)</span>
            <input
              type="text"
              inputMode="decimal"
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-base"
            />
            <p className="mt-1 text-xs text-muted-foreground">Max ${orderTotal.toFixed(2)}</p>
          </label>
        )}

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Reason (optional)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
          />
        </label>

        {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
          <span className="text-sm text-muted-foreground">
            Refund total: <strong className="text-foreground">${computedAmount.toFixed(2)}</strong>
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="gradient" onClick={submit} loading={busy} disabled={computedAmount <= 0}>
              Issue refund
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
