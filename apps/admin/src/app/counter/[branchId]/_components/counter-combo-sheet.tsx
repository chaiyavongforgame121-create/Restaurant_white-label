'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Minus, Plus } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import type { ComboSet } from '@favornoms/database/queries';
import { Button, Sheet } from '@favornoms/ui';
import { ComboArt } from './combo-art';

interface Props {
  combo: ComboSet | null;
  /** The dishes' photos, shown when the combo has none of its own. */
  dishImages?: string[];
  /** False when a dish in it is switched off, 86'd or short of stock (v_active_combos). */
  available?: boolean;
  onClose: () => void;
  onAdd: (args: { combo: ComboSet; quantity: number; notes: string }) => void;
}

/**
 * The till's combo sheet.
 *
 * A combo has no options to pick, but it bundles several dishes at a price that is not the
 * sum of them, and the cashier is about to say that price out loud. So the sheet leads with
 * what is in the deal and what it saves against ringing the dishes up separately -- the
 * number a customer asks about when the poster says one thing and the till says another.
 */
export function CounterComboSheet({
  combo,
  dishImages = [],
  available = true,
  onClose,
  onAdd,
}: Props) {
  const t = useTranslations('counter');
  const [qty, setQty] = React.useState(1);
  const [notes, setNotes] = React.useState('');

  // Keyed on the id: a live menu refresh hands the sheet a fresh object for the same combo.
  const comboId = combo?.id ?? null;
  React.useEffect(() => {
    if (!comboId) return;
    setQty(1);
    setNotes('');
  }, [comboId]);

  const commit = React.useCallback(() => {
    if (!combo || !available) return;
    onAdd({ combo, quantity: qty, notes: notes.trim() });
    onClose();
  }, [combo, available, onAdd, qty, notes, onClose]);

  // Same keyboard contract as the item sheet: Enter adds, the note box keeps its own Enter.
  React.useEffect(() => {
    if (!combo) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const el = e.target as HTMLElement | null;
      if (el?.tagName === 'TEXTAREA' && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      commit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [combo, commit]);

  // Kept mounted with the sheet closed rather than returned early: Sheet owns the exit
  // animation, and unmounting it mid-close leaves the overlay on screen.
  const listTotal = combo
    ? combo.items.reduce((sum, it) => sum + it.list_price * it.quantity, 0)
    : 0;
  const saving = combo ? Math.round((listTotal - combo.total_price) * 100) / 100 : 0;
  const lineTotal = combo ? Math.round(combo.total_price * qty * 100) / 100 : 0;

  return (
    <Sheet
      open={!!combo}
      onClose={onClose}
      side="right"
      title={combo?.name ?? t('combo.fallbackTitle')}
      ariaLabel={combo ? t('sheet.addAria', { name: combo.name }) : t('combo.addComboAria')}
    >
      {combo && (
      <div className="space-y-4 px-5 pb-8">
        {(combo.image_url || dishImages.length > 0) && (
          <div className="relative aspect-[16/9] overflow-hidden rounded-2xl">
            <ComboArt combo={combo} dishImages={dishImages} sizes="(max-width:640px) 100vw, 28rem" />
          </div>
        )}

        <div>
          <p className="font-display text-primary text-2xl font-bold">
            {formatCurrency(combo.total_price)}
          </p>
          {combo.description && (
            <p className="text-muted-foreground mt-1 text-sm">{combo.description}</p>
          )}
        </div>

        {!available && (
          <p role="alert" className="bg-danger/10 text-danger rounded-xl px-3 py-2 text-sm">
            {t('combo.soldOut')}
          </p>
        )}

        <div className="border-border rounded-2xl border p-3">
          <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
            {t('combo.contents')}
          </p>
          <ul className="mt-2 space-y-1">
            {combo.items.map((it) => (
              <li key={it.menu_item_id} className="flex justify-between gap-3 text-sm">
                <span>
                  {it.quantity}× {it.item_name}
                  {/* Which dish is holding the deal up, so the cashier can offer a swap. */}
                  {it.is_available === false && (
                    <span className="text-danger ml-1.5 text-xs font-semibold">
                      {t('menu.soldOut')}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {formatCurrency(it.list_price * it.quantity)}
                </span>
              </li>
            ))}
          </ul>
          {saving > 0 && (
            <p className="border-border text-success mt-2 border-t pt-2 text-sm font-semibold">
              {t('combo.saves', {
                saving: formatCurrency(saving),
                listTotal: formatCurrency(listTotal),
              })}
            </p>
          )}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">{t('sheet.note')}</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={300}
            placeholder={t('combo.notePlaceholder')}
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

        <Button variant="gradient" size="xl" fullWidth disabled={!available} onClick={commit}>
          {t('sheet.add', { qty, total: formatCurrency(lineTotal) })}
        </Button>
      </div>
      )}
    </Sheet>
  );
}
