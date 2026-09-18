'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ArchiveRestore, ChevronDown, ChevronUp, Package, Plus, Trash2 } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card, cn, IconButton, QuantityStepper, useConfirm } from '@favornoms/ui';
import {
  COMBO_SELECT,
  EMPTY_DRAFT,
  MENU_ITEM_SELECT,
  dishState,
  draftAfterRefetch,
  draftFromCombo,
  draftProblems,
  listPriceTotal,
  moveEntry,
  normalizeDraft,
  parsePrice,
  sameDraft,
  saveComboArgs,
  type ComboDraft,
  type ComboDraftItem,
  type ComboMenuItem,
  type ComboRecord,
  type DraftProblem,
} from './combo-draft';
import { comboErrorKey } from './combo-errors';
import { ComboPhotoUpload } from './combo-photo-upload';

interface Props {
  branchId: string;
  currency: string;
  /** A server read failed: the list below may be incomplete. */
  loadFailed: boolean;
  initialCombos: ComboRecord[];
  /** Every dish of this branch, hidden ones included, as the page read them. */
  initialMenuItems: ComboMenuItem[];
}

/** The card of a combo that has not been created yet. */
const NEW_KEY = 'new';

const inputCls =
  'focus-ring w-full rounded-lg border border-border bg-background px-3 py-2 text-sm aria-[invalid=true]:border-destructive';

function byListOrder(a: ComboRecord, b: ComboRecord): number {
  return a.display_order - b.display_order || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

/** The first four distinct photos of the dishes in a combo, in the combo's order. */
function dishPhotos(items: ComboDraftItem[], menuById: Map<string, ComboMenuItem>): string[] {
  const seen = new Set<string>();
  for (const it of items) {
    const url = menuById.get(it.menu_item_id)?.image_url;
    if (url) seen.add(url);
  }
  return [...seen].slice(0, 4);
}

/**
 * The combo editor.
 *
 * Each combo is a card with a draft: nothing is written until Save, which hands the whole card
 * (details, photo and dishes in order) to save_combo in one transaction. It used to write on
 * every keystroke -- the storefront republished "$3" on the way to "$30", fast typing lost
 * characters, and clearing a quantity to type a new one deleted the dish from the combo.
 * "Delete" archives: a combo that has been ordered cannot be removed (past orders point at it),
 * and the old delete failed silently for exactly those.
 */
export function CombosManager({ branchId, currency, loadFailed, initialCombos, initialMenuItems }: Props) {
  const t = useTranslations('menuExtras');
  const money = React.useCallback((n: number) => formatCurrency(n, currency), [currency]);
  const confirm = useConfirm();
  const [combos, setCombos] = React.useState(initialCombos);
  // Re-read with the combos: an 86, a restock or a new dish from the kitchen or the menu screen
  // used to stay invisible here (badges, "Sold out now", the add list) until a full reload.
  const [menuItems, setMenuItems] = React.useState(initialMenuItems);
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** A list-level write in flight: a reorder, or the id being archived or restored. */
  const [busy, setBusy] = React.useState<string | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const dirtyKeys = React.useRef(new Set<string>());

  const menuById = React.useMemo(() => new Map(menuItems.map((m) => [m.id, m])), [menuItems]);
  const live = React.useMemo(() => combos.filter((c) => !c.archived_at).sort(byListOrder), [combos]);
  const archived = React.useMemo(
    () =>
      combos
        .filter((c) => !!c.archived_at)
        .sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? '')),
    [combos],
  );

  // Raw PostgREST text is logged, never shown.
  const errorText = React.useCallback(
    (context: string, err: unknown) => {
      console.error(`[combos] ${context}`, err);
      return t(comboErrorKey(err));
    },
    [t],
  );

  // Unsaved cards survive a refetch, not a reload: ask before the tab closes on them.
  React.useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyKeys.current.size === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
  const setDirty = React.useCallback((key: string, dirty: boolean) => {
    if (dirty) dirtyKeys.current.add(key);
    else dirtyKeys.current.delete(key);
  }, []);

  /**
   * Re-reads the combos and the branch's dishes. `quiet` (the tab coming back into view) only
   * logs a failed read: nothing was written, so there is nothing for the merchant to retry.
   */
  const refetch = React.useCallback(
    async (quiet = false): Promise<boolean> => {
      const supabase = getBrowserClient();
      const [combosRes, itemsRes] = await Promise.all([
        supabase.from('combo_sets').select(COMBO_SELECT).eq('branch_id', branchId),
        supabase.from('menu_items').select(MENU_ITEM_SELECT).eq('branch_id', branchId).order('name'),
      ]);
      // Each list is taken when its own read worked; a failed one keeps what the page shows.
      if (!itemsRes.error) setMenuItems((itemsRes.data ?? []) as ComboMenuItem[]);
      if (!combosRes.error) setCombos((combosRes.data ?? []) as ComboRecord[]);
      const readErr = combosRes.error ?? itemsRes.error;
      if (readErr) {
        if (quiet) console.error('[combos] refresh', readErr);
        else setError(errorText('refetch', readErr));
      }
      // True when the combos themselves were re-read: the rows the cards compare their drafts to.
      return !combosRes.error;
    },
    [branchId, errorText],
  );

  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refetch]);

  const handleSaved = React.useCallback(
    async (key: string, id: string): Promise<boolean> => {
      setError(null);
      const ok = await refetch();
      if (key === NEW_KEY) {
        setCreating(false);
        setOpenKey(id);
      }
      return ok;
    },
    [refetch],
  );

  const move = async (index: number, dir: -1 | 1) => {
    const next = moveEntry(live, index, dir);
    if (next.every((c, i) => c.id === live[i]?.id)) return;
    const before = combos;
    const order = new Map(next.map((c, i) => [c.id, i]));
    setCombos((curr) => curr.map((c) => ({ ...c, display_order: order.get(c.id) ?? c.display_order })));
    setBusy('reorder');
    setError(null);
    const { error: rpcErr } = await getBrowserClient().rpc('reorder_combo_sets', {
      p_branch_id: branchId,
      p_combo_ids: next.map((c) => c.id),
    });
    setBusy(null);
    if (rpcErr) {
      setCombos(before);
      setError(errorText('reorder', rpcErr));
    }
  };

  const archive = async (combo: ComboRecord) => {
    const ok = await confirm({
      title: t('combos.deleteConfirm.title'),
      body: t('combos.deleteConfirm.body'),
      confirmLabel: t('combos.deleteConfirm.confirm'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(combo.id);
    setError(null);
    const { error: rpcErr } = await getBrowserClient().rpc('set_combo_archived', {
      p_combo_id: combo.id,
      p_archived: true,
    });
    if (rpcErr) {
      setBusy(null);
      setError(errorText('archive', rpcErr));
      return;
    }
    setDirty(combo.id, false);
    setOpenKey((k) => (k === combo.id ? null : k));
    await refetch();
    setBusy(null);
  };

  const restore = async (combo: ComboRecord) => {
    setBusy(combo.id);
    setError(null);
    const { error: rpcErr } = await getBrowserClient().rpc('set_combo_archived', {
      p_combo_id: combo.id,
      p_archived: false,
    });
    if (rpcErr) {
      setBusy(null);
      setError(errorText('restore', rpcErr));
      return;
    }
    // It comes back off sale at the end of the list, open, for the merchant to look over.
    if (await refetch()) setOpenKey(combo.id);
    setBusy(null);
  };

  const cardProps = { branchId, menuItems, menuById, money, errorText, setDirty, onSaved: handleSaved };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('combos.title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('combos.subtitle')}</p>
        </div>
        <Button
          variant="gradient"
          onClick={() => {
            setCreating(true);
            setOpenKey(NEW_KEY);
          }}
          disabled={creating}
          leftIcon={<Plus className="h-4 w-4" />}
        >
          {t('combos.newCombo')}
        </Button>
      </header>

      {loadFailed && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{t('combos.loadFailed')}</div>
      )}
      {error && (
        <div role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {creating && (
        <div className="mb-3 px-2 lg:px-0">
          <ComboCard
            {...cardProps}
            cardKey={NEW_KEY}
            combo={null}
            open
            onCancel={() => {
              setCreating(false);
              setOpenKey((k) => (k === NEW_KEY ? null : k));
            }}
          />
        </div>
      )}

      {live.length === 0 && !creating ? (
        <Card className="p-10 text-center text-muted-foreground">
          {t.rich('combos.empty', { strong: (chunks) => <strong>{chunks}</strong> })}
        </Card>
      ) : (
        <ul className="space-y-3 px-2 lg:px-0">
          {live.map((combo, index) => (
            <li key={combo.id}>
              <ComboCard
                {...cardProps}
                cardKey={combo.id}
                combo={combo}
                open={openKey === combo.id}
                onToggle={() => setOpenKey((k) => (k === combo.id ? null : combo.id))}
                onArchive={() => void archive(combo)}
                busy={busy === combo.id}
                position={{
                  index,
                  count: live.length,
                  disabled: busy !== null,
                  onMove: (dir) => void move(index, dir),
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <section className="mt-8 px-2 lg:px-0">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            className="focus-ring flex items-center gap-1 rounded-lg text-sm font-semibold text-muted-foreground"
          >
            {showArchived ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {t('combos.archivedTitle', { count: archived.length })}
          </button>
          {showArchived && (
            <>
              <p className="mt-1 text-xs text-muted-foreground">{t('combos.archivedHint')}</p>
              <ul className="mt-3 space-y-2">
                {archived.map((combo) => (
                  <li key={combo.id}>
                    <Card className="flex items-center gap-3 p-3">
                      <ComboThumb
                        photos={
                          combo.image_url
                            ? [combo.image_url]
                            : dishPhotos(draftFromCombo(combo).items, menuById)
                        }
                        className="h-10 w-14"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{combo.name}</p>
                        <p className="text-xs tabular-nums text-muted-foreground">{money(Number(combo.total_price))}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void restore(combo)}
                        disabled={busy !== null}
                        leftIcon={<ArchiveRestore className="h-4 w-4" />}
                      >
                        {t('combos.restore')}
                      </Button>
                    </Card>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** A combo's own photo, else its dishes' photos side by side, else a plain box icon. */
function ComboThumb({ photos, className }: { photos: string[]; className?: string }) {
  return (
    <div className={cn('relative shrink-0 overflow-hidden rounded-lg bg-muted', className)} aria-hidden>
      {photos.length === 0 ? (
        <div className="grid h-full w-full place-items-center">
          <Package className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
        </div>
      ) : (
        <div
          className={cn(
            'grid h-full w-full gap-px',
            photos.length >= 2 && 'grid-cols-2',
            photos.length >= 3 && 'grid-rows-2',
          )}
        >
          {photos.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={src}
              src={src}
              alt=""
              className={cn('h-full w-full object-cover', photos.length === 3 && i === 0 && 'row-span-2')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CardProps {
  cardKey: string;
  /** Null for the combo being created. */
  combo: ComboRecord | null;
  open: boolean;
  branchId: string;
  menuItems: ComboMenuItem[];
  menuById: Map<string, ComboMenuItem>;
  money: (n: number) => string;
  errorText: (context: string, err: unknown) => string;
  setDirty: (key: string, dirty: boolean) => void;
  /** Refetches the list; false when that read failed. */
  onSaved: (key: string, id: string) => Promise<boolean>;
  onToggle?: () => void;
  onCancel?: () => void;
  onArchive?: () => void;
  busy?: boolean;
  position?: { index: number; count: number; disabled: boolean; onMove: (dir: -1 | 1) => void };
}

function ComboCard({
  cardKey,
  combo,
  open,
  branchId,
  menuItems,
  menuById,
  money,
  errorText,
  setDirty,
  onSaved,
  onToggle,
  onCancel,
  onArchive,
  busy = false,
  position,
}: CardProps) {
  const t = useTranslations('menuExtras');
  const isNew = combo === null;
  const baseline = React.useMemo(() => (combo ? draftFromCombo(combo) : EMPTY_DRAFT), [combo]);
  const [draft, setDraft] = React.useState<ComboDraft>(baseline);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** Field problems are shown once a save was tried, not while the merchant is still typing. */
  const [showProblems, setShowProblems] = React.useState(false);
  const [savedFlash, setSavedFlash] = React.useState(false);
  const lastBaseline = React.useRef(baseline);
  /** What this card's last successful save sent, normalised, until the refetch after it lands. */
  const justSaved = React.useRef<ComboDraft | null>(null);

  // A refetch hands every card a fresh row. Take the new saved version unless this card holds
  // edits of its own, which stay until they are saved or discarded. The ref is read here, not in
  // the updater: React may run the updater on a later render, after the ref has been cleared.
  React.useEffect(() => {
    if (lastBaseline.current === baseline) return;
    const previous = lastBaseline.current;
    const saved = justSaved.current;
    setDraft((curr) => draftAfterRefetch(curr, previous, baseline, saved));
    justSaved.current = null;
    lastBaseline.current = baseline;
  }, [baseline]);

  const dirty = !sameDraft(draft, baseline);
  React.useEffect(() => setDirty(cardKey, dirty), [cardKey, dirty, setDirty]);
  React.useEffect(() => () => setDirty(cardKey, false), [cardKey, setDirty]);

  React.useEffect(() => {
    if (!savedFlash) return;
    const id = window.setTimeout(() => setSavedFlash(false), 2500);
    return () => window.clearTimeout(id);
  }, [savedFlash]);

  const problems = draftProblems(draft);
  const shows = (p: DraftProblem) => showProblems && problems.includes(p);
  const price = parsePrice(draft.price);
  const listTotal = listPriceTotal(draft.items, menuById);
  const states = draft.items.map((it) => dishState(menuById.get(it.menu_item_id), it.quantity));
  const blocked = states.some((s) => s !== 'ok');
  // What diners see right now: the saved combo, not the draft.
  const liveBlocked = baseline.items.some((it) => dishState(menuById.get(it.menu_item_id), it.quantity) !== 'ok');
  const photos = draft.imageUrl ? [draft.imageUrl] : dishPhotos(draft.items, menuById);
  const title = draft.name.trim() || t('combos.untitled');
  const fieldId = (name: string) => `combo-${cardKey}-${name}`;

  const update = (patch: Partial<ComboDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setSavedFlash(false);
  };
  const setItems = (fn: (items: ComboDraftItem[]) => ComboDraftItem[]) => {
    setDraft((d) => ({ ...d, items: fn(d.items) }));
    setSavedFlash(false);
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (saving) return;
    if (problems.length > 0) {
      setShowProblems(true);
      return;
    }
    setSaving(true);
    setError(null);
    const { data, error: rpcErr } = await getBrowserClient().rpc(
      'save_combo',
      saveComboArgs(branchId, combo?.id ?? null, draft),
    );
    if (rpcErr || !data) {
      setSaving(false);
      setError(errorText(isNew ? 'create combo' : 'save combo', rpcErr));
      return;
    }
    // Show what was saved the way the server stores it ("259" -> "259.00", names trimmed), so the
    // card matches the refetched row. Edits typed while saving are left alone, and stay unsaved.
    const sent = normalizeDraft(draft);
    setDraft((d) => (sameDraft(d, draft) ? sent : d));
    justSaved.current = sent;
    setShowProblems(false);
    if (!(await onSaved(cardKey, data))) justSaved.current = null;
    setSaving(false);
    setSavedFlash(true);
  };

  const discard = () => {
    setDraft(baseline);
    setShowProblems(false);
    setError(null);
  };

  const addable = menuItems.filter((m) => m.is_active && !draft.items.some((it) => it.menu_item_id === m.id));

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <ComboThumb photos={photos} className="h-14 w-20" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-display text-lg font-bold">{title}</h2>
            {isNew ? (
              <Badge variant="info">{t('combos.newBadge')}</Badge>
            ) : (
              <Badge variant={baseline.isActive ? 'success' : 'neutral'}>
                {baseline.isActive ? t('combos.statusOn') : t('combos.statusOff')}
              </Badge>
            )}
            {!isNew && baseline.isActive && liveBlocked && <Badge variant="warning">{t('combos.soldOutNow')}</Badge>}
            {!isNew && dirty && <Badge variant="accent">{t('combos.unsaved')}</Badge>}
            {savedFlash && !dirty && (
              <span role="status" className="text-xs font-semibold text-success">
                {t('combos.saved')}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            <span className="tabular-nums">{price !== null ? money(price) : '—'}</span>
            {' · '}
            {t('combos.itemCount', { count: draft.items.length })}
            {price !== null && listTotal > price && (
              <span className="ml-2 text-xs font-semibold text-success">
                {t('combos.saves', { amount: money(listTotal - price) })}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {position && (
            <>
              <IconButton
                size="sm"
                label={t('combos.moveUp', { name: title })}
                onClick={() => position.onMove(-1)}
                disabled={position.disabled || position.index === 0}
                className="disabled:opacity-30"
              >
                <ChevronUp className="h-4 w-4" />
              </IconButton>
              <IconButton
                size="sm"
                label={t('combos.moveDown', { name: title })}
                onClick={() => position.onMove(1)}
                disabled={position.disabled || position.index === position.count - 1}
                className="disabled:opacity-30"
              >
                <ChevronDown className="h-4 w-4" />
              </IconButton>
            </>
          )}
          {onToggle && (
            <Button variant="ghost" size="sm" onClick={onToggle} aria-expanded={open}>
              {open ? t('combos.close') : t('combos.edit')}
            </Button>
          )}
        </div>
      </div>

      {open && (
        <form onSubmit={save} className="mt-4 border-t border-border/60 pt-4" noValidate>
          <div className="grid gap-4 md:grid-cols-[minmax(0,240px)_1fr]">
            <div>
              <p className="mb-1.5 text-sm font-medium">{t('combos.image')}</p>
              <ComboPhotoUpload
                branchId={branchId}
                value={draft.imageUrl}
                onChange={(url) => update({ imageUrl: url })}
                aspect="aspect-[16/10]"
                label={t('combos.uploadImage')}
              />
              {!draft.imageUrl && <p className="mt-1 text-xs text-muted-foreground">{t('combos.imageHint')}</p>}
            </div>

            <div className="space-y-3">
              <div>
                <label htmlFor={fieldId('name')} className="mb-1 block text-sm font-medium">
                  {t('combos.name')}
                </label>
                <input
                  id={fieldId('name')}
                  value={draft.name}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder={t('combos.namePlaceholder')}
                  maxLength={120}
                  aria-invalid={shows('nameRequired')}
                  className={cn(inputCls, 'font-semibold')}
                />
                {shows('nameRequired') && (
                  <p className="mt-1 text-xs text-destructive">{t('combos.errors.nameRequired')}</p>
                )}
              </div>

              <div>
                <label htmlFor={fieldId('description')} className="mb-1 block text-sm font-medium">
                  {t('combos.description')}
                </label>
                <textarea
                  id={fieldId('description')}
                  value={draft.description}
                  onChange={(e) => update({ description: e.target.value })}
                  placeholder={t('combos.descriptionPlaceholder')}
                  maxLength={500}
                  rows={2}
                  className={inputCls}
                />
              </div>

              <div>
                <label htmlFor={fieldId('price')} className="mb-1 block text-sm font-medium">
                  {t('combos.price')}
                </label>
                <input
                  id={fieldId('price')}
                  value={draft.price}
                  onChange={(e) => update({ price: e.target.value })}
                  inputMode="decimal"
                  autoComplete="off"
                  aria-invalid={shows('priceInvalid')}
                  className={cn(inputCls, 'w-36 tabular-nums')}
                />
                {shows('priceInvalid') && (
                  <p className="mt-1 text-xs text-destructive">{t('combos.errors.priceInvalid')}</p>
                )}
                {draft.items.length > 0 &&
                  price !== null &&
                  (listTotal > price ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('combos.listTotal', { amount: money(listTotal) })}{' '}
                      <span className="font-semibold text-success">
                        {t('combos.saves', { amount: money(listTotal - price) })}
                      </span>
                    </p>
                  ) : (
                    <p className="mt-1 text-xs font-medium text-warning">
                      {t('combos.notCheaper', { list: money(listTotal), price: money(price) })}
                    </p>
                  ))}
              </div>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  // Switching off is always allowed; switching on needs a dish.
                  disabled={!draft.isActive && draft.items.length === 0}
                  onChange={(e) => update({ isActive: e.target.checked })}
                  className="mt-0.5"
                />
                <span>
                  {t('combos.onSaleLabel')}
                  {draft.items.length === 0 && (
                    <span className="block text-xs text-muted-foreground">{t('combos.onSaleNeedsItems')}</span>
                  )}
                </span>
              </label>
              {shows('emptyActive') && <p className="text-xs text-destructive">{t('combos.errors.emptyActive')}</p>}
            </div>
          </div>

          <div className="mt-5">
            <p className="text-sm font-semibold">{t('combos.dishes')}</p>
            {draft.items.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">{t('combos.noItems')}</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {draft.items.map((it, i) => {
                  const m = menuById.get(it.menu_item_id);
                  const state = states[i];
                  const name = m?.name ?? t('combos.unknownDish');
                  return (
                    <li
                      key={it.menu_item_id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
                    >
                      <ComboThumb photos={m?.image_url ? [m.image_url] : []} className="h-9 w-9" />
                      <div className="min-w-0 flex-1">
                        <p className={cn('truncate font-medium', state !== 'ok' && 'text-muted-foreground')}>{name}</p>
                        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {m && <span>{t('combos.each', { price: money(Number(m.price)) })}</span>}
                          {state === 'hidden' && <Badge variant="neutral">{t('combos.dishHidden')}</Badge>}
                          {state === 'soldOut' && <Badge variant="warning">{t('combos.dishSoldOut')}</Badge>}
                          {state === 'missing' && <Badge variant="danger">{t('combos.dishMissing')}</Badge>}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <IconButton
                          type="button"
                          size="sm"
                          label={t('combos.moveUp', { name })}
                          onClick={() => setItems((items) => moveEntry(items, i, -1))}
                          disabled={i === 0}
                          className="disabled:opacity-30"
                        >
                          <ChevronUp className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          type="button"
                          size="sm"
                          label={t('combos.moveDown', { name })}
                          onClick={() => setItems((items) => moveEntry(items, i, 1))}
                          disabled={i === draft.items.length - 1}
                          className="disabled:opacity-30"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </IconButton>
                        <div role="group" aria-label={t('combos.quantity', { name })}>
                          <QuantityStepper
                            value={it.quantity}
                            min={1}
                            size="sm"
                            onChange={(q) =>
                              setItems((items) =>
                                items.map((x) => (x.menu_item_id === it.menu_item_id ? { ...x, quantity: q } : x)),
                              )
                            }
                          />
                        </div>
                        <IconButton
                          type="button"
                          size="sm"
                          label={t('combos.removeDish', { name })}
                          onClick={() => setItems((items) => items.filter((x) => x.menu_item_id !== it.menu_item_id))}
                          className="text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {blocked && <p className="mt-2 text-xs font-medium text-warning">{t('combos.unavailableHint')}</p>}
            <AddItemPicker
              options={addable}
              money={money}
              onPick={(id) => setItems((items) => [...items, { menu_item_id: id, quantity: 1 }])}
            />
          </div>

          {error && (
            <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="submit" variant="gradient" disabled={saving || (!isNew && !dirty)}>
              {saving ? t('combos.saving') : isNew ? t('combos.create') : t('combos.save')}
            </Button>
            {isNew ? (
              <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
                {t('combos.cancel')}
              </Button>
            ) : (
              dirty && (
                <Button type="button" variant="ghost" onClick={discard} disabled={saving}>
                  {t('combos.discard')}
                </Button>
              )
            )}
            {onArchive && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onArchive}
                disabled={saving || busy}
                leftIcon={<Trash2 className="h-4 w-4" />}
                className="ml-auto text-destructive"
              >
                {t('combos.delete')}
              </Button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

function AddItemPicker({
  options,
  money,
  onPick,
}: {
  /** Dishes on the menu that are not in the combo yet. */
  options: ComboMenuItem[];
  money: (n: number) => string;
  onPick: (id: string) => void;
}) {
  const t = useTranslations('menuExtras.combos');
  if (options.length === 0) return null;
  return (
    <select
      value=""
      aria-label={t('addItem')}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
      className="focus-ring mt-2 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
    >
      <option value="">{t('addItem')}</option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {`${m.name} (${money(Number(m.price))})${dishState(m, 1) === 'soldOut' ? ` · ${t('dishSoldOut')}` : ''}`}
        </option>
      ))}
    </select>
  );
}
