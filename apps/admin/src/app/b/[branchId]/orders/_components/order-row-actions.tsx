'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FileText, MoreHorizontal, Pencil, RefreshCcw, XCircle } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { formatCurrency, formatUnitPrice, sortOrderLines, sumMoney } from '@favornoms/shared';
import { Button, Card, IconButton, Portal, cn } from '@favornoms/ui';
import { orderErrorKey, type OrderAction } from './order-errors';
import { lineUnitPrice, refundLineAmount } from './order-lines';
import {
  cardRefundErrorKey,
  checkRefundAmount,
  keepIdempotencyKey,
  type CardPaymentState,
  type CardPaymentSummary,
  type CardRefundErrorBody,
  type CardRefundLine,
} from './card-refund';
import {
  cancelOrderWithCardRefund,
  loadCardPayment,
  newIdempotencyKey,
  requestCardRefund,
  type CardRefundSuccess,
} from './card-refund-client';
import { useIntlLocale } from './order-labels';

interface Props {
  orderId: string;
  orderTotal: number;
  orderStatus: string;
  /** orders.customer_notes as the list already read it, so the dialog can open on it. */
  customerNotes?: string | null;
  /** The order's Stripe card payment as the list read it, or null for cash, transfer and cards
   *  taken on the restaurant's own terminal. The dialogs re-read it when they open. */
  card?: CardPaymentSummary | null;
  currency?: string;
}

/**
 * Written to orders.cancellation_reason and status_history, which other screens and the
 * diner's own order page print. It is data, so it stays English whatever language the
 * operator reads the back office in.
 */
const ADMIN_CANCEL_REASON = 'Admin canceled';

/** The RPCs raise bare postgres exception names; a merchant reads a sentence instead. */
function useOrderError() {
  const t = useTranslations('orders');
  return (action: OrderAction, raw: string) => {
    console.error(`[orders] ${action} failed`, raw);
    return t(`errors.${orderErrorKey(action, raw)}`);
  };
}

/** What a refused or unanswered stripe-refund call means, in the reader's language. */
function useCardRefundError(currency: string) {
  const t = useTranslations('orders');
  return (res: { status: number | null; body: CardRefundErrorBody | null }) =>
    t(`cardRefund.errors.${cardRefundErrorKey(res.status, res.body)}`, {
      amount: formatCurrency(res.body?.refundable ?? 0, currency),
    });
}

/** The card payment a dialog works from, read fresh when it opens. */
interface CardLoad {
  loading: boolean;
  failed: boolean;
  state: CardPaymentState | null;
}

const CARD_LOADING: CardLoad = { loading: true, failed: false, state: null };

export function OrderRowActions({
  orderId,
  orderTotal,
  orderStatus,
  customerNotes,
  card = null,
  currency = 'USD',
}: Props) {
  const t = useTranslations('orders');
  const errorText = useOrderError();
  const cardErrorText = useCardRefundError(currency);
  const money = (n: number) => formatCurrency(n, currency);
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [refundOpen, setRefundOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [notesOpen, setNotesOpen] = React.useState(false);
  const [notesDraft, setNotesDraft] = React.useState('');
  const [invoiceMsg, setInvoiceMsg] = React.useState<string | null>(null);
  // Cancelling a paid card order refunds it first. The key is made once per opening of the
  // dialog and kept across retries of that one cancel, so a second press after a lost answer
  // gets Stripe's first refund back instead of a second one. The refunded amount is kept once
  // Stripe has made it, so the button stops promising a refund that has already happened.
  const [cancelCard, setCancelCard] = React.useState<CardLoad>(CARD_LOADING);
  const cancelKeyRef = React.useRef('');
  const cancelRefundedRef = React.useRef<number | null>(null);

  // Use canonical order_status values ('cancelled' two L's, 'completed' — there is no
  // 'canceled'/'delivered' for orders) so terminal-state orders don't offer dead actions.
  //
  // A closed order is still offered a refund while its card payment sits with the restaurant.
  // The database no longer lets anyone close a paid card order without its refund
  // (20260925120000), so this is for orders closed before that, and for one whose refund Stripe
  // later failed.
  const cardStillHeld = !!card && card.paid && card.refundable > 0;
  const canRefund = !['cancelled', 'refunded'].includes(orderStatus) || cardStillHeld;
  const canCancel = !['cancelled', 'refunded', 'completed'].includes(orderStatus);
  // admin_edit_order_notes accepts pending, confirmed and preparing; the menu offered two
  // of the three, so a ticket already on the pass could not be corrected.
  const canEdit = ['pending', 'confirmed', 'preparing'].includes(orderStatus);
  // issue_tax_invoice raises 'order_not_completed' outside these three, so offering it on a
  // pending or cancelled row was an error waiting to be clicked. Viewing the receipt is a
  // separate button and stays available on every order.
  const canIssueReceipt = ['confirmed', 'ready', 'completed'].includes(orderStatus);

  // admin_edit_order_notes writes orders.customer_notes — the note the diner typed at
  // checkout and the one the kitchen ticket prints. The dialog used to open empty under
  // the heading "Internal notes", so every save silently replaced that request with
  // whatever staff typed, or with nothing at all.
  const saveNotes = async () => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('admin_edit_order_notes', {
      p_order_id: orderId,
      p_notes: notesDraft,
    });
    setBusy(false);
    if (rpcErr) { setError(errorText('editNote', rpcErr.message)); return; }
    setNotesOpen(false);
    router.refresh();
  };

  const openCancel = () => {
    setOpen(false);
    setError(null);
    cancelKeyRef.current = newIdempotencyKey();
    cancelRefundedRef.current = null;
    setCancelCard(CARD_LOADING);
    setCancelOpen(true);
    // Read fresh, not from the list: a diner may have paid since the page loaded, and cancelling
    // a paid order without its refund would keep their money for food that is never made.
    void loadCardPayment(orderId).then(({ state, error: failed }) =>
      setCancelCard({ loading: false, failed, state }),
    );
  };

  const cancelRefundDue =
    cancelCard.state && cancelCard.state.paid ? cancelCard.state.refundable : 0;

  const doCancel = async () => {
    setBusy(true);
    setError(null);
    // Refund first, cancel second, and both on the server when the card needs it: the database
    // refuses to cancel a paid card order before its refund, so cancelOrderWithCardRefund asks
    // stripe-refund to refund the rest and cancel in one go. A cash or transfer order is a plain
    // cancel_order. Refunded but not cancelled is the safe half-way state: the money is back and
    // pressing again only retries the cancel, because nothing is left to refund.
    const outcome = await cancelOrderWithCardRefund({
      orderId,
      reason: ADMIN_CANCEL_REASON,
      idempotencyKey: cancelKeyRef.current,
    });
    setBusy(false);
    if (!outcome.ok) {
      if (outcome.stage === 'refund') {
        if (!keepIdempotencyKey(outcome.status)) cancelKeyRef.current = newIdempotencyKey();
        setError(`${cardErrorText(outcome)} ${t('cardRefund.notCancelled')}`);
        return;
      }
      const why = errorText('cancel', outcome.code);
      if (outcome.stage === 'cancelAfterRefund') {
        cancelRefundedRef.current = outcome.amount;
        setError(t('cardRefund.refundedNotCancelled', { amount: money(outcome.amount), reason: why }));
        // The refund went through: the list must show it even if the operator gives up here.
        router.refresh();
        return;
      }
      const refunded = cancelRefundedRef.current;
      setError(refunded ? t('cardRefund.refundedNotCancelled', { amount: money(refunded), reason: why }) : why);
      return;
    }
    setCancelOpen(false);
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
    // The RPC raises bare postgres exception names. Left alone they surface as
    // "order_not_completed", which reads like a crash rather than a rule.
    if (rpcErr) { setError(errorText('issueInvoice', rpcErr.message)); return; }
    const inv = data as { invoice_number?: string } | null;
    setOpen(false);
    setInvoiceMsg(
      inv?.invoice_number
        ? t('actions.invoiceIssued', { number: inv.invoice_number })
        : t('actions.invoiceIssuedNoNumber'),
    );
    router.refresh();
  };

  let cancelBody: string;
  if (cancelCard.loading) cancelBody = t('cardRefund.checking');
  else if (!cancelCard.state) cancelBody = t('actions.cancelDialog.body');
  else if (!cancelCard.state.paid) cancelBody = t('actions.cancelDialog.bodyCardUnpaid');
  // A formal dispute took the money back through the diner's bank, so the cancel refunds nothing
  // (the database and stripe-refund skip it); saying "already refunded" would be wrong too.
  else if (cancelCard.state.disputed) cancelBody = t('actions.cancelDialog.bodyCardDisputed');
  else if (cancelRefundDue > 0) cancelBody = t('actions.cancelDialog.bodyCard', { amount: money(cancelRefundDue) });
  else cancelBody = t('actions.cancelDialog.bodyCardNothingLeft');

  return (
    <>
      <IconButton
        label={t('actions.menu')}
        size="sm"
        onClick={() => {
          // The menu now shows its own errors, so a failed "Issue receipt" must not
          // greet the next order the operator opens the menu on.
          setError(null);
          setOpen((o) => !o);
        }}
      >
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>

      {/* Everything below opens from the sticky actions cell, and sticky with a z-index is
          a stacking context: inline, the menu and these dialogs could rise no higher than
          that one cell, so every later row's sticky cell and the ACTIONS header painted
          over them. Each is portalled on its own, only while open, so a closed row leaves
          nothing behind in <body>. */}
      {open && (
        <Portal>
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
                    <RefreshCcw className="h-4 w-4" />{' '}
                    {orderStatus === 'cancelled' || orderStatus === 'refunded'
                      ? t('actions.refundCard')
                      : t('actions.issueRefund')}
                  </button>
                )}
                {canCancel && (
                  <button
                    type="button"
                    onClick={openCancel}
                    disabled={busy}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                  >
                    <XCircle className="h-4 w-4" /> {t('actions.cancelOrder')}
                  </button>
                )}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setError(null);
                      setNotesDraft(customerNotes ?? '');
                      setNotesOpen(true);
                    }}
                    disabled={busy}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <Pencil className="h-4 w-4" /> {t('actions.editNote')}
                  </button>
                )}
                {canIssueReceipt && (
                  <button
                    type="button"
                    onClick={issueTaxInvoice}
                    disabled={busy}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <FileText className="h-4 w-4" /> {t('actions.issueReceipt')}
                  </button>
                )}
                {error && (
                  <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
                    {error}
                  </p>
                )}
              </Card>
            </div>
          </div>
        </Portal>
      )}

      {refundOpen && (
        <Portal>
          <RefundDialog
            orderId={orderId}
            orderTotal={orderTotal}
            orderStatus={orderStatus}
            currency={currency}
            onClose={() => setRefundOpen(false)}
            onRefunded={() => { setRefundOpen(false); setOpen(false); router.refresh(); }}
          />
        </Portal>
      )}

      {cancelOpen && (
        <Portal>
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => !busy && setCancelOpen(false)}
          >
            <Card className="w-full max-w-sm space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
              <h2 className="font-display text-lg font-semibold">{t('actions.cancelDialog.title')}</h2>
              <p className="text-sm text-muted-foreground" role={cancelCard.loading ? 'status' : undefined}>
                {cancelBody}
              </p>
              {cancelCard.failed && (
                <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {t('cardRefund.loadFailed')}
                </p>
              )}
              {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setCancelOpen(false)} disabled={busy}>
                  {t('actions.cancelDialog.keep')}
                </Button>
                <Button
                  variant="danger"
                  onClick={doCancel}
                  loading={busy}
                  // Unknown whether the card was paid means unknown whether a refund is owed.
                  disabled={cancelCard.loading || cancelCard.failed}
                >
                  {cancelRefundDue > 0 && cancelRefundedRef.current === null
                    ? t('actions.cancelDialog.confirmRefund')
                    : t('actions.cancelDialog.confirm')}
                </Button>
              </div>
            </Card>
          </div>
        </Portal>
      )}

      {notesOpen && (
        <Portal>
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => !busy && setNotesOpen(false)}
          >
            <Card className="w-full max-w-md space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
              <h2 className="font-display text-lg font-semibold">{t('actions.noteDialog.title')}</h2>
              <p className="text-xs text-muted-foreground">{t('actions.noteDialog.body')}</p>
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                rows={3}
                autoFocus
                placeholder={t('actions.noteDialog.placeholder')}
                className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              />
              {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setNotesOpen(false)}>
                  {t('actions.noteDialog.cancel')}
                </Button>
                <Button variant="gradient" onClick={saveNotes} loading={busy}>
                  {t('actions.noteDialog.save')}
                </Button>
              </div>
            </Card>
          </div>
        </Portal>
      )}

      {invoiceMsg && (
        <Portal>
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setInvoiceMsg(null)}
          >
            <Card className="w-full max-w-sm space-y-3 p-5 text-center" onClick={(e) => e.stopPropagation()}>
              <p className="text-sm font-medium text-success">{invoiceMsg}</p>
              <Button variant="gradient" fullWidth onClick={() => setInvoiceMsg(null)}>
                {t('actions.done')}
              </Button>
            </Card>
          </div>
        </Portal>
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
  /** The options' share of subtotal: a line's unit is unit_price plus this per unit. */
  modifier_total: number | null;
  /** Read for the menu order the dialog lists lines in (sortOrderLines). */
  modifiers?: unknown;
  category_position?: number | null;
  item_position?: number | null;
  created_at?: string;
}

const REFUND_STATUS_TONE: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  succeeded: 'bg-success/15 text-success',
  failed: 'bg-danger/10 text-danger',
  canceled: 'bg-muted text-muted-foreground',
};

/** Every refund already made on the card payment, the failed ones too: an operator who sees
 *  only the total left cannot tell "refunded" from "tried and Stripe said no". */
function RefundHistory({ refunds, currency }: { refunds: CardRefundLine[]; currency: string }) {
  const t = useTranslations('orders');
  const intlLocale = useIntlLocale();
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('cardRefund.history')}
      </p>
      <ul className="divide-y divide-border/60 rounded-xl border border-border">
        {refunds.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="block text-xs text-muted-foreground">
                {new Date(r.createdAt).toLocaleString(intlLocale, { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
              {r.reason && <span className="block truncate text-xs" title={r.reason}>{r.reason}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="font-display tabular-nums">{formatCurrency(r.amount, currency)}</span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                  REFUND_STATUS_TONE[r.status] ?? 'bg-muted text-muted-foreground',
                )}
              >
                {t.has(`cardRefund.status.${r.status}`) ? t(`cardRefund.status.${r.status}`) : r.status}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RefundDialog({
  orderId,
  orderTotal,
  orderStatus,
  currency,
  onClose,
  onRefunded,
}: {
  orderId: string;
  orderTotal: number;
  orderStatus: string;
  currency: string;
  onClose: () => void;
  onRefunded: () => void;
}) {
  const t = useTranslations('orders');
  const errorText = useOrderError();
  const cardErrorText = useCardRefundError(currency);
  const money = (n: number) => formatCurrency(n, currency);
  const [mode, setMode] = React.useState<'items' | 'amount'>('items');
  const [lines, setLines] = React.useState<OrderLine[] | null>(null);
  const [qty, setQty] = React.useState<Record<string, number>>({});
  const [customAmount, setCustomAmount] = React.useState(String(orderTotal.toFixed(2)));
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [card, setCard] = React.useState<CardLoad>(CARD_LOADING);
  // One key per refund the operator means to make (see keepIdempotencyKey), and the Stripe
  // refund once it exists: after it, a retry only records the refund on the order.
  const keyRef = React.useRef(newIdempotencyKey());
  const sentRef = React.useRef<CardRefundSuccess | null>(null);
  const [sent, setSent] = React.useState<CardRefundSuccess | null>(null);
  const [done, setDone] = React.useState<CardRefundSuccess | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getBrowserClient();
      const [{ data }, cardRead] = await Promise.all([
        supabase
          .from('order_items')
          .select('id, item_name, unit_price, quantity, subtotal, modifier_total, modifiers, category_position, item_position, created_at')
          .eq('order_id', orderId),
        loadCardPayment(orderId),
      ]);
      if (cancelled) return;
      // The same menu order as the receipt drawer, so the line being refunded is easy to find.
      setLines(sortOrderLines((data ?? []) as OrderLine[]));
      const init: Record<string, number> = {};
      for (const l of (data ?? []) as OrderLine[]) init[l.id] = 0;
      setQty(init);
      setCard({ loading: false, failed: cardRead.error, state: cardRead.state });
      // A card order can give back only what is still on the card, which after an earlier
      // partial refund is less than the order total the box opened on.
      if (cardRead.state?.paid) setCustomAmount(cardRead.state.refundable.toFixed(2));
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const cardState = card.state;
  const isCard = cardState !== null;
  const maxAmount = cardState ? cardState.refundable : orderTotal;
  // Nothing may be sent while it is unknown whether the order was paid by card (the refund
  // would be recorded without the money moving), for a card payment that has not gone
  // through, or once the whole card payment is back with the diner.
  const blocked =
    card.loading || card.failed || (cardState !== null && (!cardState.paid || cardState.refundable <= 0));
  const locked = blocked || sent !== null || busy;

  const computedAmount = React.useMemo(() => {
    if (mode === 'amount') return Number(customAmount) || 0;
    if (!lines) return 0;
    // Each line gives back what that many units were charged, options included: the whole
    // line is its own subtotal, part of it is priced as a line of its own (refundLineAmount).
    // quantity × unit_price left the options out and re-rounded a happy-hour unit.
    return sumMoney(lines.map((l) => refundLineAmount(l, qty[l.id] ?? 0)));
  }, [mode, customAmount, qty, lines]);

  // After Stripe has made the refund, closing the dialog must still refresh the list.
  const close = () => (sentRef.current ? onRefunded() : onClose());

  const submit = async () => {
    const stripeDone = sentRef.current;
    if (!stripeDone) {
      const check = checkRefundAmount(computedAmount, maxAmount);
      if (check === 'amountZero') {
        setError(t('refund.amountZero'));
        return;
      }
      if (check === 'amountTooHigh') {
        setError(
          isCard
            ? t('cardRefund.amountTooHigh', { amount: money(maxAmount) })
            : t('refund.amountTooHigh', { total: money(orderTotal) }),
        );
        return;
      }
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
    // Stored in status_history and audit_logs, so the machine-written part stays English;
    // the reason itself is whatever the operator typed.
    const reasonText = [
      reason || null,
      breakdown && breakdown.length > 0
        ? `lines: ${breakdown.map((b) => `${b.quantity}× ${b.name}`).join(', ')}`
        : null,
    ]
      .filter(Boolean)
      .join(' — ') || null;
    let amount = Math.round(computedAmount * 100) / 100;

    // A card order's money goes back through Stripe, on the branch's own account, BEFORE the
    // order is marked: refund_order alone only ever changed the status, so it told the owner
    // the diner had their money back when nothing had moved. If Stripe says no, nothing below
    // runs and the order stays as it was.
    let refunded = stripeDone;
    if (isCard && !refunded) {
      const res = await requestCardRefund({ orderId, amount, reason: reasonText, idempotencyKey: keyRef.current });
      if (!res.ok) {
        if (!keepIdempotencyKey(res.status)) keyRef.current = newIdempotencyKey();
        setBusy(false);
        setError(cardErrorText(res));
        return;
      }
      refunded = res.data;
      sentRef.current = res.data;
      setSent(res.data);
    }
    if (refunded) amount = refunded.amount;

    // The order's status and the audit trail, as today. A closed order keeps its status: a
    // cancelled one is already out of the kitchen and the money figures, and "refunded" would put
    // it back; a refunded one is only getting back a card refund Stripe failed the first time.
    if (orderStatus !== 'cancelled' && orderStatus !== 'refunded') {
      const { error: rpcErr } = await supabase.rpc('refund_order', {
        p_order_id: orderId,
        p_amount: amount,
        p_reason: reasonText,
      });
      if (rpcErr) {
        setBusy(false);
        const why = errorText('refund', rpcErr.message);
        // The money has moved; only the order's own record is behind. The button now retries
        // that record alone, never Stripe.
        setError(refunded ? t('cardRefund.orderNotUpdated', { amount: money(refunded.amount), reason: why }) : why);
        return;
      }
    }
    setBusy(false);
    if (refunded) {
      setDone(refunded);
      return;
    }
    onRefunded();
  };

  if (done) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onRefunded}>
        <Card className="w-full max-w-sm space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
          <h2 className="font-display text-lg font-semibold">{t('refund.title')}</h2>
          <p role="status" className="text-sm font-medium text-success">
            {done.stripe_status === 'succeeded'
              ? t('cardRefund.sentSucceeded', { amount: money(done.amount) })
              : t('cardRefund.sentPending', { amount: money(done.amount) })}
          </p>
          {!done.recorded && <p className="text-xs text-muted-foreground">{t('cardRefund.notRecordedYet')}</p>}
          <Button variant="gradient" fullWidth onClick={onRefunded}>
            {t('actions.done')}
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !busy && close()}
    >
      <Card className="max-h-[90vh] w-full max-w-lg space-y-3 overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-lg font-semibold">
          {isCard ? t('cardRefund.title') : t('refund.title')}
        </h2>

        {card.loading && (
          <p role="status" className="text-sm text-muted-foreground">{t('cardRefund.checking')}</p>
        )}
        {card.failed && (
          <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{t('cardRefund.loadFailed')}</p>
        )}
        {cardState && !cardState.paid && (
          <p className="rounded-xl bg-muted px-3 py-2 text-sm">{t('cardRefund.notPaidYet')}</p>
        )}
        {cardState && cardState.paid && (
          <div className="space-y-1 rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm">
            <p>{t('cardRefund.paidBy', { amount: money(cardState.amount) })}</p>
            {cardState.refunded > 0 && (
              <p className="text-muted-foreground">{t('cardRefund.alreadyRefunded', { amount: money(cardState.refunded) })}</p>
            )}
            {cardState.refundPending > 0 && (
              <p className="text-warning">{t('cardRefund.waitingOnStripe', { amount: money(cardState.refundPending) })}</p>
            )}
            <p className="font-medium">
              {cardState.disputed
                ? t('cardRefund.disputed')
                : cardState.refundable > 0
                  ? t('cardRefund.refundableNow', { amount: money(cardState.refundable) })
                  : t('cardRefund.nothingLeft')}
            </p>
            <p className="text-xs text-muted-foreground">{t('cardRefund.whereItGoes')}</p>
          </div>
        )}
        {cardState && cardState.refunds.length > 0 && (
          <RefundHistory refunds={cardState.refunds} currency={currency} />
        )}

        {!blocked && (
          <>
            <div className="flex rounded-full bg-muted p-1 text-sm font-semibold">
              <button
                type="button"
                onClick={() => setMode('items')}
                disabled={locked}
                className={`focus-ring flex-1 rounded-full py-1.5 ${mode === 'items' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'}`}
              >
                {t('refund.byItems')}
              </button>
              <button
                type="button"
                onClick={() => setMode('amount')}
                disabled={locked}
                className={`focus-ring flex-1 rounded-full py-1.5 ${mode === 'amount' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'}`}
              >
                {t('refund.customAmount')}
              </button>
            </div>

            {mode === 'items' ? (
              <div className="space-y-2">
                {lines === null ? (
                  <p className="text-sm text-muted-foreground">{t('refund.loadingItems')}</p>
                ) : lines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('refund.noItems')}</p>
                ) : (
                  <ul className="space-y-2">
                    {lines.map((l) => (
                      <li key={l.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{l.item_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {l.quantity}× {formatUnitPrice(lineUnitPrice(l), currency)} = {money(Number(l.subtotal))}
                          </p>
                        </div>
                        <label className="flex items-center gap-1 text-xs">
                          <span className="text-muted-foreground">{t('refund.refundQty')}</span>
                          <input
                            type="number"
                            min={0}
                            max={l.quantity}
                            value={qty[l.id] ?? 0}
                            disabled={locked}
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
                <span className="mb-1.5 block text-sm font-medium">{t('refund.amountLabel')}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={customAmount}
                  disabled={locked}
                  onChange={(e) => setCustomAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                  className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-base"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('refund.max', { amount: money(maxAmount) })}
                </p>
              </label>
            )}

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">{t('refund.reason')}</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={locked}
                rows={2}
                className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
          </>
        )}

        {error && <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
          <span className="text-sm text-muted-foreground">
            {!blocked &&
              t.rich('refund.total', {
                amount: money(sent ? sent.amount : computedAmount),
                strong: (chunks) => <strong className="text-foreground">{chunks}</strong>,
              })}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t('refund.cancel')}
            </Button>
            {!blocked && (
              <Button
                variant="gradient"
                onClick={submit}
                loading={busy}
                disabled={!sent && computedAmount <= 0}
              >
                {sent ? t('cardRefund.retryRecord') : t('refund.submit')}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
