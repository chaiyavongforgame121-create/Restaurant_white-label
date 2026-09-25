'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Armchair, ChevronDown, MapPin, MessageSquareText } from 'lucide-react';
import { formatPhone, formatCurrency } from '@favornoms/shared';
import { Badge, Card, cn } from '@favornoms/ui';
import { OrderReceiptButton } from './order-receipt-sheet';
import { OrderRowActions } from './order-row-actions';
import type { CardPaymentSummary } from './card-refund';
import { useIntlLocale, useOrderLabels } from './order-labels';
import {
  ALLERGY_RE,
  countItems,
  hasSpecialRequests,
  isRemovedOption,
  modifierLabel,
  parseLineModifiers,
  summarizeLines,
  type OrderLine,
} from './order-lines';

// The row is a client component because "show me what they ordered" is a toggle, and a
// <tr> cannot be wrapped in <details>. Everything it needs comes down from the server page
// already fetched, so opening a row costs no round trip — unlike the receipt drawer, which
// stays lazy because it also reads payments and tax_invoices.

export interface OrderRowData {
  id: string;
  order_number: string;
  channel: string;
  status: string;
  total: number;
  customer_name: string | null;
  customer_phone: string | null;
  created_at: string;
  scheduled_for: string | null;
  held: boolean;
  awaiting_payment: boolean;
  /** What the diner typed at checkout (dine-in gets a "Table N — …" prefix from the storefront). */
  customer_notes: string | null;
  /** Staff-only note; nothing in the back office writes it yet, the kitchen board shows it. */
  kitchen_notes: string | null;
  /** tables.display_name, else "Table <table_number>", for dine-in and QR orders. */
  table_label: string | null;
  /** delivery_address.notes — the "Delivery instructions" field on the storefront. */
  delivery_notes: string | null;
  lines: OrderLine[];
  /** The order's Stripe card payment and what has gone back on it, or null for cash, transfer
   *  and cards taken on the restaurant's own terminal (and for readers without payments.view). */
  card: CardPaymentSummary | null;
}

export interface OrderRowContext {
  branchName: string;
  branchAddress: string | null;
  currency: string;
  canViewReceipt: boolean;
  canPrintReceipt: boolean;
}

/** `intlLocale` is the reader's language as an Intl tag (see useIntlLocale). */
const fmtWhen = (iso: string, intlLocale: string) =>
  new Date(iso).toLocaleString(intlLocale, {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });

const fmtDay = (iso: string, intlLocale: string) =>
  new Date(iso).toLocaleString(intlLocale, { month: 'short', day: 'numeric' });

const fmtTime = (iso: string, intlLocale: string) =>
  new Date(iso).toLocaleString(intlLocale, { hour: 'numeric', minute: '2-digit' });

const statusVariant = (status: string): React.ComponentProps<typeof Badge>['variant'] => {
  if (status === 'pending') return 'muted';
  if (['confirmed', 'preparing'].includes(status)) return 'warning';
  if (['ready', 'out_for_delivery'].includes(status)) return 'default';
  if (status === 'completed') return 'success';
  return 'danger';
};

// A QR or online card order is invisible to the kitchen until the money is confirmed, so say
// so here rather than leaving it looking like an untouched ticket.
function AwaitingPill({ card }: { card: CardPaymentSummary | null }) {
  const t = useTranslations('orders');
  // One word, one line. The sentence this used to spell out broke into four stacked
  // fragments in a column narrow enough to fit the rest of the table, and the full
  // meaning is a hover away. A card order waits on the diner's card, not on a slip.
  return (
    <span
      title={card && !card.paid ? t('row.unpaidCardHint') : t('row.unpaidHint')}
      className="bg-warning/15 text-warning mt-1 inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold"
    >
      {t('row.unpaid')}
    </span>
  );
}

/**
 * Where the card money stands, when it is not simply "paid": a refund Stripe is still working
 * on, part or all of it given back, or, on a closed order, card money nobody has refunded. Since
 * 20260925120000 no one can close a paid card order without its refund, so that last case is an
 * order closed before then, or one whose refund Stripe later failed; it comes before "part
 * refunded" because it is the one the owner has to act on.
 */
function CardRefundPill({
  card,
  status,
  currency,
}: {
  card: CardPaymentSummary | null;
  status: string;
  currency: string;
}) {
  const t = useTranslations('orders');
  if (!card || !card.paid) return null;
  const cls = 'mt-1 inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold';
  // The bank has taken the payment back through a dispute: there is nothing to refund, only a
  // dispute to answer in the branch's Stripe Dashboard, so that is what the row says.
  if (card.disputed) {
    return (
      <span title={t('row.cardDisputedHint')} className={cn(cls, 'bg-warning/15 text-warning')}>
        {t('row.cardDisputed')}
      </span>
    );
  }
  if (card.refundPending > 0) {
    return (
      <span
        title={t('row.refundPendingHint', { amount: formatCurrency(card.refundPending, currency) })}
        className={cn(cls, 'bg-warning/15 text-warning')}
      >
        {t('row.refundPending')}
      </span>
    );
  }
  if ((status === 'cancelled' || status === 'refunded') && card.refundable > 0) {
    return (
      <span
        title={t('row.cardNotRefundedHint', { amount: formatCurrency(card.refundable, currency) })}
        className={cn(cls, 'bg-danger/10 text-danger')}
      >
        {t('row.cardNotRefunded')}
      </span>
    );
  }
  if (card.refunded > 0 && card.refundable > 0) {
    return (
      <span
        title={t('row.refundedHint', { amount: formatCurrency(card.refunded, currency) })}
        className={cn(cls, 'bg-muted text-foreground')}
      >
        {t('row.partRefunded')}
      </span>
    );
  }
  if (card.refunded > 0 && status !== 'refunded') {
    return (
      <span
        title={t('row.refundedHint', { amount: formatCurrency(card.refunded, currency) })}
        className={cn(cls, 'bg-muted text-foreground')}
      >
        {t('row.cardRefunded')}
      </span>
    );
  }
  return null;
}

function ItemsToggle({
  order: o,
  open,
  onToggle,
  panelId,
}: {
  order: OrderRowData;
  open: boolean;
  onToggle: () => void;
  panelId: string;
}) {
  const t = useTranslations('orders');
  const { shown, more } = summarizeLines(o.lines);
  const summary = more > 0 ? t('row.summaryMore', { items: shown, count: more }) : shown;
  const flagged = hasSpecialRequests(o.lines, [
    o.customer_notes,
    o.kitchen_notes,
    o.delivery_notes,
  ]);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      className="focus-ring hover:bg-muted -mx-2 flex max-w-[9rem] items-start gap-1.5 rounded-lg px-2 py-1 text-left"
    >
      <ChevronDown
        aria-hidden
        className={cn(
          'text-muted-foreground mt-0.5 h-4 w-4 shrink-0 transition-transform',
          open && 'rotate-180',
        )}
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 font-medium">
          {t('row.items', { count: countItems(o.lines) })}
          {flagged && (
            <MessageSquareText
              role="img"
              aria-label={t('row.hasRequests')}
              className="text-warning h-3.5 w-3.5"
            />
          )}
        </span>
        <span className="text-muted-foreground block truncate text-xs" title={summary}>
          {summary || t('row.noLineItems')}
        </span>
      </span>
    </button>
  );
}

/** The full breakdown: every line with its options and note, then the order-level notes. */
export function OrderLinesPanel({ order: o, currency }: { order: OrderRowData; currency: string }) {
  const t = useTranslations('orders');
  const notes: Array<{ id: string; label: string; text: string; Icon: typeof MessageSquareText }> = [];
  if (o.table_label) {
    notes.push({ id: 'table', label: t('row.notes.table'), text: o.table_label, Icon: Armchair });
  }
  if (o.customer_notes?.trim()) {
    notes.push({
      id: 'customer',
      label: t('row.notes.customer'),
      text: o.customer_notes.trim(),
      Icon: MessageSquareText,
    });
  }
  if (o.kitchen_notes?.trim()) {
    notes.push({
      id: 'kitchen',
      label: t('row.notes.kitchen'),
      text: o.kitchen_notes.trim(),
      Icon: MessageSquareText,
    });
  }
  if (o.delivery_notes?.trim()) {
    notes.push({
      id: 'delivery',
      label: t('row.notes.delivery'),
      text: o.delivery_notes.trim(),
      Icon: MapPin,
    });
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
      <ul className="divide-border/50 border-border/60 bg-card divide-y rounded-xl border">
        {o.lines.length === 0 && (
          <li className="text-muted-foreground px-3 py-3 text-sm">{t('row.noLinesRecorded')}</li>
        )}
        {o.lines.map((l) => {
          const mods = parseLineModifiers(l.modifiers);
          const note = l.notes?.trim();
          return (
            <li key={l.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
              <span className="font-display text-primary w-8 shrink-0 text-base font-semibold tabular-nums">
                {l.quantity}×
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {l.item_name}
                  {l.combo_id && (
                    <Badge variant="outline" className="ml-2">
                      {t('row.combo')}
                    </Badge>
                  )}
                </p>
                {mods.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {mods.map((m, i) => (
                      <span
                        key={i}
                        className={cn(
                          'rounded-md px-2 py-px text-xs',
                          isRemovedOption(m.name)
                            ? 'bg-danger/10 text-danger'
                            : 'bg-muted text-foreground',
                        )}
                      >
                        {modifierLabel(m, currency)}
                      </span>
                    ))}
                  </div>
                )}
                {note && (
                  <p
                    className={cn(
                      'mt-1 flex items-start gap-1 text-xs',
                      ALLERGY_RE.test(note) ? 'text-danger font-semibold' : 'text-warning',
                    )}
                  >
                    <MessageSquareText aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="whitespace-pre-wrap break-words">{note}</span>
                  </p>
                )}
              </div>
              <span className="font-display shrink-0 tabular-nums">
                {formatCurrency(Number(l.subtotal), currency)}
              </span>
            </li>
          );
        })}
      </ul>
      {notes.length > 0 && (
        <dl className="space-y-2 text-sm">
          {notes.map((n) => {
            const allergy = ALLERGY_RE.test(n.text);
            const Icon = allergy ? AlertTriangle : n.Icon;
            return (
              <div
                key={n.id}
                className={cn(
                  'rounded-xl px-3 py-2',
                  allergy ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-foreground',
                )}
              >
                <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider opacity-80">
                  <Icon aria-hidden className="h-3.5 w-3.5" /> {n.label}
                </dt>
                <dd className="mt-0.5 whitespace-pre-wrap break-words">{n.text}</dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

export function OrderTableRow({ order: o, ctx }: { order: OrderRowData; ctx: OrderRowContext }) {
  const t = useTranslations('orders');
  const labels = useOrderLabels();
  const intlLocale = useIntlLocale();
  const [open, setOpen] = React.useState(false);
  const panelId = `order-lines-${o.id}`;
  return (
    <>
      <tr className="border-border/40 hover:bg-muted/30 border-t">
        <td className="px-3 py-3 font-mono text-xs">{o.order_number}</td>
        <td className="px-3 py-3">{labels.channel(o.channel)}</td>
        <td className="px-3 py-3">
          <p className="font-medium">{o.customer_name ?? '—'}</p>
          <p className="text-muted-foreground text-xs">{o.customer_phone ? formatPhone(o.customer_phone) : ''}</p>
        </td>
        <td className="px-3 py-3">
          <ItemsToggle
            order={o}
            open={open}
            onToggle={() => setOpen((v) => !v)}
            panelId={panelId}
          />
        </td>
        <td className="text-muted-foreground px-3 py-3">
          {/* Stacked, not one string: "Sep 6, 10:22 PM" kept on a single line made this
              the third-widest column in a table with no room left for its own buttons,
              and letting it wrap broke the date after the comma, which reads as two
              separate facts. */}
          <span className="block whitespace-nowrap">{fmtDay(o.created_at, intlLocale)}</span>
          <span className="block whitespace-nowrap">{fmtTime(o.created_at, intlLocale)}</span>
          {o.awaiting_payment && <AwaitingPill card={o.card} />}
          <CardRefundPill card={o.card} status={o.status} currency={ctx.currency} />
          {/* Without this a pre-order looks like it needs cooking now:
              it sits at pending/confirmed and only its created_at showed. */}
          {o.scheduled_for && (
            <span className="text-foreground mt-0.5 block text-xs font-medium">
              <span className="block whitespace-nowrap">
                {t(o.held ? 'row.scheduledOn' : 'row.dueOn', {
                  date: fmtDay(o.scheduled_for, intlLocale),
                })}
              </span>
              <span className="block whitespace-nowrap">{fmtTime(o.scheduled_for, intlLocale)}</span>
            </span>
          )}
        </td>
        <td className="font-display text-primary px-3 py-3 text-right text-base font-semibold">
          {formatCurrency(o.total, ctx.currency)}
        </td>
        <td className="px-3 py-3 text-center">
          <Badge variant={statusVariant(o.status)}>{labels.status(o.status)}</Badge>
        </td>
        <td className="bg-card border-border/40 sticky right-0 z-10 w-px whitespace-nowrap border-l px-3 py-3">
          <div className="flex items-center justify-end gap-1">
            {ctx.canViewReceipt && (
              <OrderReceiptButton
                orderId={o.id}
                orderNumber={o.order_number}
                branchName={ctx.branchName}
                branchAddress={ctx.branchAddress}
                canPrint={ctx.canPrintReceipt}
                currency={ctx.currency}
              />
            )}
            <OrderRowActions
              orderId={o.id}
              orderTotal={o.total}
              orderStatus={o.status}
              customerNotes={o.customer_notes}
              card={o.card}
              currency={ctx.currency}
            />
          </div>
        </td>
      </tr>
      {open && (
        <tr id={panelId} className="bg-muted/20">
          <td colSpan={8} className="px-3 pb-4 pt-1">
            <OrderLinesPanel order={o} currency={ctx.currency} />
          </td>
        </tr>
      )}
    </>
  );
}

export function OrderMobileCard({ order: o, ctx }: { order: OrderRowData; ctx: OrderRowContext }) {
  const t = useTranslations('orders');
  const labels = useOrderLabels();
  const intlLocale = useIntlLocale();
  const [open, setOpen] = React.useState(false);
  const panelId = `order-lines-m-${o.id}`;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-muted-foreground font-mono text-xs">{o.order_number}</p>
          <p className="mt-1 font-semibold">{o.customer_name ?? t('row.walkIn')}</p>
          <p className="text-muted-foreground text-xs">{labels.channel(o.channel)}</p>
          {o.awaiting_payment && <AwaitingPill card={o.card} />}
          <CardRefundPill card={o.card} status={o.status} currency={ctx.currency} />
          {o.scheduled_for && (
            <p className="mt-1 text-xs font-medium">
              {t(o.held ? 'row.scheduledOn' : 'row.dueOn', {
                date: fmtWhen(o.scheduled_for, intlLocale),
              })}
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="font-display text-primary text-lg font-bold">
            {formatCurrency(o.total, ctx.currency)}
          </p>
          <Badge variant={statusVariant(o.status)} className="mt-1">
            {labels.status(o.status)}
          </Badge>
        </div>
      </div>
      <div className="border-border/40 mt-3 border-t pt-3">
        <ItemsToggle order={o} open={open} onToggle={() => setOpen((v) => !v)} panelId={panelId} />
        {open && (
          <div id={panelId} className="mt-2">
            <OrderLinesPanel order={o} currency={ctx.currency} />
          </div>
        )}
      </div>
      {/* The phone list carried no actions at all, so the receipt is the first
          thing on it a member of staff can actually open from a handset. */}
      {ctx.canViewReceipt && (
        <div className="border-border/40 mt-3 flex justify-end border-t pt-3">
          <OrderReceiptButton
            orderId={o.id}
            orderNumber={o.order_number}
            branchName={ctx.branchName}
            branchAddress={ctx.branchAddress}
            canPrint={ctx.canPrintReceipt}
            currency={ctx.currency}
          />
        </div>
      )}
    </Card>
  );
}
