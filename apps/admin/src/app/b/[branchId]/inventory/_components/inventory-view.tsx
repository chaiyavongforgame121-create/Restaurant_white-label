'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Package, Plus, Trash } from 'lucide-react';
import { DEFAULT_UI_LOCALE, formatCurrency, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

interface MenuItem {
  id: string;
  name: string;
  image_url: string | null;
  price: number | string;
  track_stock: boolean;
  stock_quantity: number | null;
  low_stock_threshold: number | null;
  is_active: boolean;
}

interface LowStock {
  id: string;
  name: string;
  stock_quantity: number;
  low_stock_threshold: number;
}

interface LogEntry {
  id: string;
  menu_item_id: string;
  created_at: string;
}

interface Restock extends LogEntry {
  delta: number;
  cost_per_unit: number | string | null;
  supplier: string | null;
  notes: string | null;
}

interface Waste extends LogEntry {
  quantity: number;
  reason: string;
  notes: string | null;
}

interface Props {
  branchId: string;
  items: MenuItem[];
  lowStock: LowStock[];
  restocks: Restock[];
  waste: Waste[];
}

/** Stored in waste_log.reason — the values stay English; only the label is translated. */
const WASTE_REASONS = ['expired', 'spoiled', 'spilled', 'damaged', 'staff_meal', 'other'];

const WASTE_REASON_KEYS: Record<string, string> = {
  expired: 'expired',
  spoiled: 'spoiled',
  spilled: 'spilled',
  damaged: 'damaged',
  staff_meal: 'staffMeal',
  other: 'other',
};

/** low_stock_threshold is `integer NOT NULL default 5`; the default is mirrored here. */
const DEFAULT_LOW_STOCK_THRESHOLD = 5;

type DbErrorKey = 'permissionDenied' | 'network' | 'invalidValue' | 'generic';

/** Raw PostgREST text never reaches the merchant: known codes get a translated sentence. */
function dbErrorKey(err: { code?: string; message?: string }): DbErrorKey {
  const message = err.message ?? '';
  if (err.code === '42501' || /row-level security|permission denied/i.test(message)) return 'permissionDenied';
  if (/failed to fetch|networkerror|network request failed/i.test(message)) return 'network';
  if (err.code && /^(22|23)/.test(err.code)) return 'invalidValue';
  return 'generic';
}

function useWasteReasonLabel() {
  const t = useTranslations('inventory.reasons');
  // A reason written by something older than this list is shown as it was stored.
  return (reason: string) => {
    const key = WASTE_REASON_KEYS[reason];
    return key ? t(key) : reason.replace('_', ' ');
  };
}

export function InventoryView({ branchId, items, lowStock, restocks, waste }: Props) {
  const t = useTranslations('inventory');
  const rawLocale = useLocale();
  const intlLocale = intlLocaleFor(isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE);
  const reasonLabel = useWasteReasonLabel();
  const router = useRouter();
  const [restockOpen, setRestockOpen] = React.useState<MenuItem | null>(null);
  const [wasteOpen, setWasteOpen] = React.useState<MenuItem | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [savingIds, setSavingIds] = React.useState<string[]>([]);
  const [pendingTracking, setPendingTracking] = React.useState<Record<string, boolean>>({});
  const errorRef = React.useRef<HTMLDivElement | null>(null);

  const trackable = items.filter((i) => i.track_stock);
  const total = trackable.length;
  const lowCount = lowStock.length;

  const itemById = React.useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  // The banner sits above a table that runs for pages on a real menu, so the merchant who
  // clicked a checkbox near the bottom had already scrolled past the only place the
  // rejection was reported — which is most of why this read as a dead control.
  React.useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [error]);

  // Turning tracking off only shows up in the row as an em dash, so the confirmation is
  // what tells the merchant the count was cleared. It should not sit there all shift.
  React.useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  // The checkbox is bound straight to the server row and router.refresh() is a round-trip,
  // so between the click and the repaint the box would show the old value again — the same
  // flicker the failing write produced. Hold the merchant's choice until the refreshed row
  // agrees with it, or the item is gone.
  React.useEffect(() => {
    setPendingTracking((cur) => {
      const next: Record<string, boolean> = {};
      for (const [id, on] of Object.entries(cur)) {
        const row = itemById.get(id);
        if (row && row.track_stock !== on) next[id] = on;
      }
      return Object.keys(next).length === Object.keys(cur).length ? cur : next;
    });
  }, [itemById]);

  const toggleTracking = async (item: MenuItem, on: boolean) => {
    const quantity = on ? (item.stock_quantity ?? 0) : null;
    setSavingIds((cur) => [...cur, item.id]);
    setPendingTracking((cur) => ({ ...cur, [item.id]: on }));
    const supabase = getBrowserClient();
    const { data, error: upErr } = await supabase
      .from('menu_items')
      .update({
        track_stock: on,
        stock_quantity: quantity,
        // low_stock_threshold is NOT NULL. Unticking used to send null here, Postgres threw
        // 23502 and rolled the whole statement back, so track_stock never changed and the
        // box snapped straight back: tracking could be turned on but never off. Keep the
        // merchant's own threshold so re-ticking restores the number they chose.
        low_stock_threshold: item.low_stock_threshold ?? DEFAULT_LOW_STOCK_THRESHOLD,
      })
      .eq('id', item.id)
      // An update that matches no row — the item was deleted, or RLS refused the write —
      // comes back 204 with no error, which is indistinguishable from a save that worked.
      .select('id')
      .maybeSingle();
    setSavingIds((cur) => cur.filter((id) => id !== item.id));
    if (upErr || !data) {
      setPendingTracking((cur) => {
        const next = { ...cur };
        delete next[item.id];
        return next;
      });
      setNotice(null);
      if (upErr) console.error('[inventory] toggle tracking failed', upErr);
      setError(
        upErr
          ? t('tracking.failed', { name: item.name, reason: t(`errors.${dbErrorKey(upErr)}`) })
          : t('tracking.notSaved', { name: item.name }),
      );
      return;
    }
    setError(null);
    setNotice(
      !on
        ? t('tracking.off', { name: item.name })
        : (quantity ?? 0) > 0
          ? t('tracking.on', { name: item.name, count: quantity ?? 0 })
          : t('tracking.onEmpty', { name: item.name }),
    );
    router.refresh();
  };

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Stat label={t('stats.tracked')} value={String(total)} />
          <Stat label={t('stats.lowStock')} value={String(lowCount)} tone={lowCount > 0 ? 'warning' : 'muted'} />
        </div>
      </header>

      {error && (
        <div ref={errorRef} role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {notice && (
        <div role="status" className="mb-4 rounded-xl bg-success/10 px-4 py-3 text-sm text-success">{notice}</div>
      )}

      {lowCount > 0 && (
        <Card className="mb-6 border-warning/40 bg-warning/5 p-5">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <AlertTriangle className="h-5 w-5 text-warning" /> {t('lowStock.title')}
          </h2>
          <ul className="mt-3 space-y-2">
            {lowStock.map((l) => (
              <li key={l.id} className="flex items-center justify-between rounded-lg border border-border bg-card p-3 text-sm">
                <span>
                  <strong>{l.name}</strong>
                  <span className="ml-2 text-muted-foreground">
                    {t('lowStock.detail', { left: l.stock_quantity, threshold: l.low_stock_threshold })}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="gradient"
                  onClick={() => {
                    const it = itemById.get(l.id);
                    if (it) setRestockOpen(it);
                  }}
                  leftIcon={<Plus className="h-3.5 w-3.5" />}
                >
                  {t('actions.restock')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mb-6 overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-5 py-3">{t('table.item')}</th>
              <th className="px-5 py-3 text-center">{t('table.trackStock')}</th>
              <th className="px-5 py-3 text-right">{t('table.stock')}</th>
              <th className="px-5 py-3 text-right">{t('table.threshold')}</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} className="border-t border-border/40">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    {it.image_url ? (
                      <span
                        className="h-10 w-10 shrink-0 rounded-lg bg-muted bg-cover bg-center"
                        style={{ backgroundImage: `url(${it.image_url})` }}
                      />
                    ) : (
                      <span className="grid h-10 w-10 place-items-center rounded-lg bg-muted">
                        <Package className="h-4 w-4 text-muted-foreground" />
                      </span>
                    )}
                    <div>
                      <p className="font-medium">{it.name}</p>
                      <p className="text-xs text-muted-foreground">{formatCurrency(Number(it.price))}</p>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3 text-center">
                  <input
                    type="checkbox"
                    checked={pendingTracking[it.id] ?? it.track_stock}
                    disabled={savingIds.includes(it.id)}
                    onChange={(e) => toggleTracking(it, e.target.checked)}
                    className="h-4 w-4 accent-primary disabled:opacity-50"
                  />
                </td>
                <td className="px-5 py-3 text-right tabular-nums">
                  {it.track_stock ? (it.stock_quantity ?? 0) : '—'}
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                  {it.track_stock ? (it.low_stock_threshold ?? DEFAULT_LOW_STOCK_THRESHOLD) : '—'}
                </td>
                <td className="px-5 py-3 text-right">
                  {it.track_stock && (
                    <div className="inline-flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setRestockOpen(it)} leftIcon={<Plus className="h-3.5 w-3.5" />}>
                        {t('actions.restock')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setWasteOpen(it)} leftIcon={<Trash className="h-3.5 w-3.5" />}>
                        {t('actions.waste')}
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('restocks.title')}</h2>
          {restocks.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('restocks.empty')}</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {restocks.slice(0, 10).map((r) => {
                const it = itemById.get(r.menu_item_id);
                return (
                  <li key={r.id} className="flex items-center justify-between border-b border-border/40 pb-2 last:border-0">
                    <span>
                      <strong>+{r.delta}</strong>{' '}
                      <span className="text-muted-foreground">{it?.name ?? '?'}</span>
                      {r.supplier && <span className="text-xs text-muted-foreground"> · {r.supplier}</span>}
                    </span>
                    <span className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString(intlLocale)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('waste.title')}</h2>
          {waste.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('waste.empty')}</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {waste.slice(0, 10).map((w) => {
                const it = itemById.get(w.menu_item_id);
                return (
                  <li key={w.id} className="flex items-center justify-between border-b border-border/40 pb-2 last:border-0">
                    <span>
                      <strong>-{w.quantity}</strong>{' '}
                      <span className="text-muted-foreground">{it?.name ?? '?'}</span>
                      {' · '}
                      <Badge variant="muted">{reasonLabel(w.reason)}</Badge>
                    </span>
                    <span className="text-xs text-muted-foreground">{new Date(w.created_at).toLocaleString(intlLocale)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {restockOpen && (
        <RestockDialog
          branchId={branchId}
          item={restockOpen}
          onClose={() => setRestockOpen(null)}
          onSaved={() => {
            setRestockOpen(null);
            router.refresh();
          }}
        />
      )}
      {wasteOpen && (
        <WasteDialog
          branchId={branchId}
          item={wasteOpen}
          onClose={() => setWasteOpen(null)}
          onSaved={() => {
            setWasteOpen(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warning' | 'muted' }) {
  return (
    <div className={`rounded-2xl px-4 py-2 text-center ${tone === 'warning' ? 'bg-warning/10' : 'bg-muted/40'}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-display text-xl font-bold">{value}</p>
    </div>
  );
}

function RestockDialog({ branchId, item, onClose, onSaved }: { branchId: string; item: MenuItem; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('inventory');
  const [delta, setDelta] = React.useState('10');
  const [cost, setCost] = React.useState('');
  const [supplier, setSupplier] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const d = Number(delta);
    if (!Number.isFinite(d) || d <= 0) { setError(t('errors.positiveQuantity')); return; }
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('restock_log').insert({
      branch_id: branchId,
      menu_item_id: item.id,
      delta: d,
      cost_per_unit: cost ? Number(cost) : null,
      supplier: supplier || null,
      notes: notes || null,
    });
    setBusy(false);
    if (insErr) {
      console.error('[inventory] restock failed', insErr);
      setError(t(`errors.${dbErrorKey(insErr)}`));
      return;
    }
    onSaved();
  };

  return (
    <ModalShell title={t('restockDialog.title', { name: item.name })} onClose={onClose}>
      <Field label={t('restockDialog.quantity')}>
        <input type="number" min={1} value={delta} onChange={(e) => setDelta(e.target.value)} className="modal-input" />
      </Field>
      <Field label={t('restockDialog.cost')}>
        <input type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} className="modal-input" />
      </Field>
      <Field label={t('restockDialog.supplier')}>
        <input value={supplier} onChange={(e) => setSupplier(e.target.value)} className="modal-input" />
      </Field>
      <Field label={t('restockDialog.notes')}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="modal-input" />
      </Field>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onClose}>{t('restockDialog.cancel')}</Button>
        <Button variant="gradient" onClick={submit} loading={busy}>{t('restockDialog.submit')}</Button>
      </div>
    </ModalShell>
  );
}

function WasteDialog({ branchId, item, onClose, onSaved }: { branchId: string; item: MenuItem; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('inventory');
  const reasonLabel = useWasteReasonLabel();
  const [qty, setQty] = React.useState('1');
  const [reason, setReason] = React.useState('expired');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) { setError(t('errors.positiveQuantity')); return; }
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('waste_log').insert({
      branch_id: branchId,
      menu_item_id: item.id,
      quantity: q,
      reason,
      notes: notes || null,
    });
    setBusy(false);
    if (insErr) {
      console.error('[inventory] waste log failed', insErr);
      setError(t(`errors.${dbErrorKey(insErr)}`));
      return;
    }
    onSaved();
  };

  return (
    <ModalShell title={t('wasteDialog.title', { name: item.name })} onClose={onClose}>
      <Field label={t('wasteDialog.quantity')}>
        <input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} className="modal-input" />
      </Field>
      <Field label={t('wasteDialog.reason')}>
        <select value={reason} onChange={(e) => setReason(e.target.value)} className="modal-input">
          {WASTE_REASONS.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
        </select>
      </Field>
      <Field label={t('wasteDialog.notes')}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="modal-input" />
      </Field>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onClose}>{t('wasteDialog.cancel')}</Button>
        <Button variant="gradient" onClick={submit} loading={busy}>{t('wasteDialog.submit')}</Button>
      </div>
    </ModalShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-md space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        {children}
        <style jsx>{`
          .modal-input { width: 100%; padding: 0.5rem 0.75rem; font-size: 14px; border-radius: 0.625rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
          .modal-input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
        `}</style>
      </Card>
    </div>
  );
}
