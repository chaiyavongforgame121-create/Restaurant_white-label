'use client';

import * as React from 'react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import { Minus, Plus } from 'lucide-react';
import {
  DEFAULT_UI_LOCALE,
  defaultSelections,
  flattenSelections,
  formatCurrency,
  isUiLocale,
  modifierDelta,
  toggleOption,
  validateSelections,
  type MenuItem,
  type ModifierGroup,
  type SelectedModifier,
} from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { listItemModifierGroups } from '@favornoms/database/queries';
import { Button, Sheet } from '@favornoms/ui';

interface Props {
  /** The item being configured, or null when the sheet is closed. */
  item: MenuItem | null;
  onClose: () => void;
  onAdd: (args: {
    item: MenuItem;
    quantity: number;
    notes: string;
    modifiers: SelectedModifier[];
    unitPrice: number;
  }) => void;
}

/**
 * The till's item sheet.
 *
 * Tapping a tile used to add the item at its base price on the spot, so nothing at the
 * counter could take "no pickles" or "extra shot" -- the options existed on the item and
 * only the storefront ever asked about them. The rules come from @favornoms/shared, the
 * same module the diner's sheet uses, so the two cannot price a burger differently.
 *
 * It is still a till: Enter adds, Escape closes, and the quantity stepper is reachable
 * without leaving the keyboard, because the queue does not stop while a cashier hunts for
 * a button.
 */
export function CounterItemSheet({ item, onClose, onAdd }: Props) {
  const t = useTranslations('counter');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const [groups, setGroups] = React.useState<ModifierGroup[]>([]);
  const [selections, setSelections] = React.useState<Record<string, string[]>>({});
  const [qty, setQty] = React.useState(1);
  const [notes, setNotes] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);

  React.useEffect(() => {
    if (!item) return undefined;
    // A second tap while the first item's groups are in flight must not paint that item's
    // options over this one.
    let cancelled = false;
    setQty(1);
    setNotes('');
    setGroups([]);
    setSelections({});
    setLoadError(false);
    setLoading(true);
    void (async () => {
      try {
        const rows = await listItemModifierGroups(getBrowserClient(), item.id);
        if (cancelled) return;
        setGroups(rows);
        setSelections(defaultSelections(rows));
      } catch {
        if (cancelled) return;
        // Adding at the base price is still the right fallback -- refusing the sale because
        // a modifier lookup failed is worse than a ticket with no options on it.
        setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item]);

  const delta = React.useMemo(() => modifierDelta(groups, selections), [groups, selections]);
  const problem = React.useMemo(
    () => validateSelections(groups, selections, locale),
    [groups, selections, locale],
  );
  const unitPrice = (item?.price ?? 0) + delta;
  const lineTotal = Math.round(unitPrice * qty * 100) / 100;
  const soldOut = !!item?.outOfStock;
  const blocked = loading || !!problem || soldOut;

  const commit = React.useCallback(() => {
    if (!item || blocked) return;
    onAdd({
      item,
      quantity: qty,
      notes: notes.trim(),
      modifiers: flattenSelections(groups, selections),
      unitPrice,
    });
    onClose();
  }, [item, blocked, onAdd, qty, notes, groups, selections, unitPrice, onClose]);

  // Enter from anywhere in the sheet adds the line. The notes box is exempt so a cashier
  // can type a second line into it; Ctrl+Enter adds from there.
  React.useEffect(() => {
    if (!item) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const el = e.target as HTMLElement | null;
      if (el?.tagName === 'TEXTAREA' && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      commit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [item, commit]);

  return (
    <Sheet
      open={!!item}
      onClose={onClose}
      side="right"
      title={item?.name ?? t('item.fallbackTitle')}
      ariaLabel={item ? t('sheet.addAria', { name: item.name }) : t('item.addItemAria')}
    >
      {item && (
        <div className="space-y-4 px-5 pb-8">
          {item.imageUrl && (
            <div className="relative aspect-[16/9] overflow-hidden rounded-2xl">
              <Image
                src={item.imageUrl}
                alt={item.name}
                fill
                sizes="(max-width:640px) 100vw, 28rem"
                className="object-cover"
              />
            </div>
          )}

          <div>
            <p className="font-display text-primary text-2xl font-bold">
              {formatCurrency(item.price)}
            </p>
            {item.description && (
              <p className="text-muted-foreground mt-1 text-sm">{item.description}</p>
            )}
          </div>

          {soldOut && (
            <p role="alert" className="bg-danger/10 text-danger rounded-xl px-3 py-2 text-sm">
              {t('item.soldOut')}
            </p>
          )}
          {loadError && (
            <p role="alert" className="bg-warning/10 text-warning rounded-xl px-3 py-2 text-sm">
              {t('item.loadError')}
            </p>
          )}
          {loading && <p className="text-muted-foreground text-sm">{t('item.loadingOptions')}</p>}

          {groups.map((g) => {
            const picked = selections[g.id] ?? [];
            return (
              <fieldset key={g.id} className="border-border rounded-2xl border p-3">
                <legend className="px-1 text-sm font-semibold">
                  {g.name}
                  <span className="text-muted-foreground ml-2 text-xs font-normal">
                    {g.max_select > 1
                      ? t(g.is_required ? 'item.requiredUpTo' : 'item.optionalUpTo', { max: g.max_select })
                      : t(g.is_required ? 'item.required' : 'item.optional')}
                  </span>
                </legend>
                <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
                  {g.options.map((o) => {
                    const on = picked.includes(o.id);
                    return (
                      <button
                        key={o.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setSelections((curr) => ({
                            ...curr,
                            [g.id]: toggleOption(g, curr, o.id),
                          }))
                        }
                        className={`focus-ring flex min-h-11 items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-sm ${
                          on ? 'border-primary bg-primary/10 font-semibold' : 'border-border bg-card'
                        }`}
                      >
                        <span>{o.name}</span>
                        {o.price_delta !== 0 && (
                          <span className="text-muted-foreground shrink-0 tabular-nums">
                            {o.price_delta > 0 ? '+' : '−'}
                            {formatCurrency(Math.abs(o.price_delta))}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">{t('sheet.note')}</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={300}
              placeholder={t('item.notePlaceholder')}
              className="focus-ring border-border bg-background w-full rounded-xl border px-3 py-2 text-sm"
            />
          </label>

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t('sheet.quantity')}</span>
            <div className="border-border flex items-center gap-1 rounded-xl border p-1">
              <button
                type="button"
                aria-label={t('sheet.fewer')}
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                className="focus-ring hover:bg-muted grid h-10 w-10 place-items-center rounded-lg"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="w-10 text-center text-lg font-semibold tabular-nums">{qty}</span>
              <button
                type="button"
                aria-label={t('sheet.more')}
                onClick={() => setQty((q) => Math.min(99, q + 1))}
                className="focus-ring hover:bg-muted grid h-10 w-10 place-items-center rounded-lg"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          {problem && (
            <p role="alert" className="text-warning text-sm">
              {problem}
            </p>
          )}

          <Button variant="gradient" size="xl" fullWidth disabled={blocked} onClick={commit}>
            {t('sheet.add', { qty, total: formatCurrency(lineTotal) })}
          </Button>
        </div>
      )}
    </Sheet>
  );
}
