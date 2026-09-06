'use client';

import * as React from 'react';
import { AlertTriangle, Armchair, ChevronDown, MapPin, MessageSquareText } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { Badge, Card, cn } from '@favornoms/ui';
import { OrderReceiptButton } from './order-receipt-sheet';
import { OrderRowActions } from './order-row-actions';
import {
  ALLERGY_RE,
  hasSpecialRequests,
  isRemovedOption,
  itemsLabel,
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
}

export interface OrderRowContext {
  branchName: string;
  branchAddress: string | null;
  currency: string;
  canViewReceipt: boolean;
  canPrintReceipt: boolean;
}

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });

const statusVariant = (status: string): React.ComponentProps<typeof Badge>['variant'] => {
  if (status === 'pending') return 'muted';
  if (['confirmed', 'preparing'].includes(status)) return 'warning';
  if (['ready', 'out_for_delivery'].includes(status)) return 'default';
  if (status === 'completed') return 'success';
  return 'danger';
};

// A QR order is invisible to the kitchen until the money is confirmed, so say so here
// rather than leaving it looking like an untouched ticket.
function AwaitingPill() {
  return (
    <span className="bg-warning/15 text-warning ml-2 rounded-full px-2 py-0.5 text-[11px] font-semibold">
      Waiting for customer payment
    </span>
  );
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
  const summary = summarizeLines(o.lines);
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
      className="focus-ring hover:bg-muted -mx-2 flex max-w-[22rem] items-start gap-1.5 rounded-lg px-2 py-1 text-left"
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
          {itemsLabel(o.lines)}
          {flagged && (
            <MessageSquareText
              role="img"
              aria-label="Has options or notes"
              className="text-warning h-3.5 w-3.5"
            />
          )}
        </span>
        <span className="text-muted-foreground block truncate text-xs" title={summary}>
          {summary || 'No line items'}
        </span>
      </span>
    </button>
  );
}

/** The full breakdown: every line with its options and note, then the order-level notes. */
export function OrderLinesPanel({ order: o, currency }: { order: OrderRowData; currency: string }) {
  const notes: Array<{ label: string; text: string; Icon: typeof MessageSquareText }> = [];
  if (o.table_label) notes.push({ label: 'Table', text: o.table_label, Icon: Armchair });
  if (o.customer_notes?.trim()) {
    notes.push({ label: 'Customer note', text: o.customer_notes.trim(), Icon: MessageSquareText });
  }
  if (o.kitchen_notes?.trim()) {
    notes.push({ label: 'Kitchen note', text: o.kitchen_notes.trim(), Icon: MessageSquareText });
  }
  if (o.delivery_notes?.trim()) {
    notes.push({ label: 'Delivery instructions', text: o.delivery_notes.trim(), Icon: MapPin });
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
      <ul className="divide-border/50 border-border/60 bg-card divide-y rounded-xl border">
        {o.lines.length === 0 && (
          <li className="text-muted-foreground px-4 py-3 text-sm">
            No line items were recorded for this order.
          </li>
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
                      Combo
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
                key={n.label}
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
  const [open, setOpen] = React.useState(false);
  const panelId = `order-lines-${o.id}`;
  return (
    <>
      <tr className="border-border/40 hover:bg-muted/30 border-t">
        <td className="px-5 py-3 font-mono text-xs">{o.order_number}</td>
        <td className="px-5 py-3 capitalize">{o.channel.replace('_', ' ')}</td>
        <td className="px-5 py-3">
          <p className="font-medium">{o.customer_name ?? '—'}</p>
          <p className="text-muted-foreground text-xs">{o.customer_phone ?? ''}</p>
        </td>
        <td className="px-5 py-3">
          <ItemsToggle
            order={o}
            open={open}
            onToggle={() => setOpen((v) => !v)}
            panelId={panelId}
          />
        </td>
        <td className="text-muted-foreground px-5 py-3">
          {fmtWhen(o.created_at)}
          {o.awaiting_payment && <AwaitingPill />}
          {/* Without this a pre-order looks like it needs cooking now:
              it sits at pending/confirmed and only its created_at showed. */}
          {o.scheduled_for && (
            <span className="text-foreground mt-0.5 block text-xs font-medium">
              {o.held ? 'Scheduled' : 'Due'} {fmtWhen(o.scheduled_for)}
            </span>
          )}
        </td>
        <td className="font-display text-primary px-5 py-3 text-right text-base font-semibold">
          {formatCurrency(o.total, ctx.currency)}
        </td>
        <td className="px-5 py-3 text-center">
          <Badge variant={statusVariant(o.status)}>{o.status.replace('_', ' ')}</Badge>
        </td>
        <td className="px-5 py-3">
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
            />
          </div>
        </td>
      </tr>
      {open && (
        <tr id={panelId} className="bg-muted/20">
          <td colSpan={8} className="px-5 pb-4 pt-1">
            <OrderLinesPanel order={o} currency={ctx.currency} />
          </td>
        </tr>
      )}
    </>
  );
}

export function OrderMobileCard({ order: o, ctx }: { order: OrderRowData; ctx: OrderRowContext }) {
  const [open, setOpen] = React.useState(false);
  const panelId = `order-lines-m-${o.id}`;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-muted-foreground font-mono text-xs">{o.order_number}</p>
          <p className="mt-1 font-semibold">{o.customer_name ?? 'Walk-in'}</p>
          <p className="text-muted-foreground text-xs capitalize">{o.channel.replace('_', ' ')}</p>
          {o.awaiting_payment && <AwaitingPill />}
          {o.scheduled_for && (
            <p className="mt-1 text-xs font-medium">
              {o.held ? 'Scheduled' : 'Due'} {fmtWhen(o.scheduled_for)}
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="font-display text-primary text-lg font-bold">
            {formatCurrency(o.total, ctx.currency)}
          </p>
          <Badge variant={statusVariant(o.status)} className="mt-1">
            {o.status.replace('_', ' ')}
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
