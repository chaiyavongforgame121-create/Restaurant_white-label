'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Edit3, GripVertical, Trash2 } from 'lucide-react';
import type { MenuCategory, MenuItem } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, IconButton } from '@favornoms/ui';
import {
  categoryIds,
  categoryOrderPayload,
  moveCategory,
  nextDisplayOrder,
  reconcileOrder,
  sameOrder,
} from './category-order';
import { categoryDeleteErrorKey, menuErrorKey } from './menu-errors';

export const CATEGORY_EMOJIS = ['🍔', '🍕', '🥗', '🍟', '🥤', '🍰', '🍣', '🌮', '🍜', '☕', '🍦', '🍗', '🥪', '🍳'];

/**
 * How long after the last drop the new order is written. Long enough that dragging three
 * categories into place is one write, short enough that the merchant sees "Saved" while still
 * looking at the panel. It must stay a single call: see category-order.ts on the statement
 * timeout the open-order triggers impose.
 */
const ORDER_SAVE_DELAY_MS = 700;

interface Props {
  branchId: string;
  categories: MenuCategory[];
  /** Every dish at the branch, hidden ones included: they move with their category too. */
  items: MenuItem[];
  /** Reloads categories and dishes from the database. */
  onChanged: () => Promise<void>;
  /** Also shown on the menu page, so it is still there once this panel closes. */
  onNotice: (message: string) => void;
}

/**
 * Every category of the branch, including empty ones, which the grid does not show at all — so
 * this is the only place a stray test or misspelt category can be found and removed.
 *
 * It is also where the order diners see is set. Reorder mode can do it too, but the merchant who
 * wants to move "Drinks" below "Desserts" opens "Categories", so the handles are here.
 *
 * Deleting goes through delete_menu_category: a category that still holds dishes is only deleted
 * together with moving them to another category, and happy hours aimed at it keep discounting the
 * same dishes. A plain DELETE would leave those dishes with no category, off every menu.
 */
export function CategoryManager({ branchId, categories, items, onChanged, onNotice }: Props) {
  const t = useTranslations('menu');
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [draftName, setDraftName] = React.useState('');
  const [draftEmoji, setDraftEmoji] = React.useState('');
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [moveTo, setMoveTo] = React.useState('');
  const [newName, setNewName] = React.useState('');
  const [newEmoji, setNewEmoji] = React.useState('🍽️');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);

  /** The order on screen. Dragging changes it at once; the database follows a moment later. */
  const [order, setOrder] = React.useState<MenuCategory[]>(categories);
  const orderRef = React.useRef(order);
  /** The order the database holds, so a settled list that already matches writes nothing. */
  const savedIds = React.useRef<string[]>(categoryIds(categories));
  /** Set by the first drop: only then may a reload be merged instead of taken as it comes. */
  const dragged = React.useRef(false);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingOrder = React.useRef(false);
  /** False from the moment the panel unmounts, so the last write cannot set state on a ghost. */
  const live = React.useRef(true);
  const [orderState, setOrderState] = React.useState<'idle' | 'saving' | 'saved'>('idle');
  const [orderError, setOrderError] = React.useState<string | null>(null);

  /** The ref is what the delayed write reads, so it is set on the same line as the state. */
  const applyOrder = (next: MenuCategory[]) => {
    orderRef.current = next;
    setOrder(next);
  };

  // A reload is the database's word on which categories exist — and on their order, unless a drag
  // here has not reached it yet, in which case the arrangement on screen is the newer truth.
  React.useEffect(() => {
    const next = dragged.current ? reconcileOrder(orderRef.current, categories) : categories;
    orderRef.current = next;
    setOrder(next);
    savedIds.current = categoryIds(categories);
  }, [categories]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * Writes the settled order, once. Everything the merchant dragged goes in a single
   * reorder_menu_categories call that renumbers the whole branch in one statement; the loop is
   * for a drop that landed while the previous call was still in flight, which gets its own single
   * call rather than one per drag.
   */
  const flushOrder = React.useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    // A call is already running; it re-reads the list when it returns.
    if (savingOrder.current) return;
    let wrote = false;
    while (!sameOrder(categoryIds(orderRef.current), savedIds.current)) {
      const list = orderRef.current;
      savingOrder.current = true;
      if (live.current) {
        setOrderState('saving');
        setOrderError(null);
      }
      const { error: rpcErr } = await getBrowserClient().rpc('reorder_menu_categories', {
        p_branch_id: branchId,
        p_orders: categoryOrderPayload(list),
      });
      savingOrder.current = false;
      if (rpcErr) {
        // Raw database text is for the log; the merchant gets a translated sentence and a retry.
        console.error('[menu] reorder_menu_categories failed', rpcErr);
        if (live.current) {
          setOrderState('idle');
          setOrderError(t(`errors.${menuErrorKey(rpcErr)}`));
        }
        return;
      }
      savedIds.current = categoryIds(list);
      wrote = true;
    }
    if (!wrote) return;
    if (live.current) {
      setOrderState('saved');
      setOrderError(null);
    }
    // The menu page behind this panel lists its sections in this order too.
    await onChanged();
  }, [branchId, onChanged, t]);

  const flushOrderRef = React.useRef(flushOrder);
  React.useEffect(() => {
    flushOrderRef.current = flushOrder;
  }, [flushOrder]);

  // "Order saved" is the proof the drag landed, but it should not sit there for the rest of the
  // shift; the list itself is the record afterwards.
  React.useEffect(() => {
    if (orderState !== 'saved') return;
    const timer = setTimeout(() => setOrderState('idle'), 4000);
    return () => clearTimeout(timer);
  }, [orderState]);

  // Nothing asks before this panel closes — a tap on the backdrop or Escape is enough — so a drag
  // still waiting out its delay is written on the way out rather than lost.
  React.useEffect(() => {
    return () => {
      live.current = false;
      void flushOrderRef.current();
    };
  }, []);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const next = moveCategory(orderRef.current, String(active.id), String(over.id));
    if (next === orderRef.current) return;
    dragged.current = true;
    applyOrder(next);
    setError(null);
    setOrderError(null);
    // Said straight away: the drop is the action, and the write follows it.
    setOrderState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void flushOrder();
    }, ORDER_SAVE_DELAY_MS);
  };

  // One write at a time. `busy` only disables buttons; Enter in a field (or a held key) would
  // otherwise start a second insert before the first returns and create the category twice.
  const inFlight = React.useRef(false);
  const exclusive = async (run: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      // Rename, delete and add all reload the list. A drag still waiting out its delay goes
      // first, or the database's old order would be painted back over it.
      await flushOrder();
      await run();
    } catch (err) {
      failed('category change', err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const counts = React.useMemo(() => {
    const map = new Map<string, { total: number; hidden: number }>();
    for (const item of items) {
      if (!item.categoryId) continue;
      const entry = map.get(item.categoryId) ?? { total: 0, hidden: 0 };
      entry.total += 1;
      if (item.isActive === false) entry.hidden += 1;
      map.set(item.categoryId, entry);
    }
    return map;
  }, [items]);

  const done = (message: string) => {
    setStatus(message);
    onNotice(message);
  };

  const failed = (context: string, err: unknown) => {
    console.error(`[menu] ${context} failed`, err);
    setError(t(`errors.${menuErrorKey(err)}`));
  };

  const startRename = (cat: MenuCategory) => {
    setDeletingId(null);
    setError(null);
    setStatus(null);
    setRenamingId(cat.id);
    setDraftName(cat.name);
    setDraftEmoji(cat.iconEmoji ?? '');
  };

  const startDelete = (cat: MenuCategory) => {
    setRenamingId(null);
    setError(null);
    setStatus(null);
    setDeletingId(cat.id);
    setMoveTo(order.find((c) => c.id !== cat.id)?.id ?? '');
  };

  /** The chosen target if it is still offered, else the first one offered. The list changes under
   *  an open panel (a category added below, or deleted elsewhere), and a select whose value matches
   *  no option shows the first option while the state still holds the old value. */
  const moveTargetFor = (cat: MenuCategory) => {
    const others = order.filter((c) => c.id !== cat.id);
    return others.find((c) => c.id === moveTo) ?? others[0];
  };

  const saveRename = (cat: MenuCategory) =>
    exclusive(async () => {
      const name = draftName.trim();
      if (!name) {
        setError(t('categories.nameRequired'));
        return;
      }
      setError(null);
      // `.select()` so an update that row-level security quietly skipped is not reported as saved.
      const { data, error: dbErr } = await getBrowserClient()
        .from('menu_categories')
        .update({ name, icon_emoji: draftEmoji.trim() || null })
        .eq('id', cat.id)
        .select('id');
      if (dbErr) {
        failed('rename category', dbErr);
        return;
      }
      if (!data?.length) {
        setError(t('categories.errors.unchanged'));
        // Most likely deleted elsewhere: show the list as it is now.
        await onChanged();
        return;
      }
      setRenamingId(null);
      done(t('categories.saved', { name }));
      await onChanged();
    });

  const confirmDelete = (cat: MenuCategory, count: number) =>
    exclusive(async () => {
      const target = count > 0 ? moveTargetFor(cat) : undefined;
      if (count > 0 && !target) {
        setError(t('categories.errors.invalidTarget'));
        return;
      }
      setError(null);
      const { data, error: rpcErr } = await getBrowserClient().rpc('delete_menu_category', {
        p_category_id: cat.id,
        ...(target ? { p_move_items_to: target.id } : {}),
      });
      if (rpcErr) {
        const key = categoryDeleteErrorKey(rpcErr);
        if (!key) {
          failed('delete_menu_category', rpcErr);
          return;
        }
        console.error('[menu] delete_menu_category refused', rpcErr);
        setError(
          key === 'usedByHappyHour'
            ? t('categories.errors.usedByHappyHour', { names: rpcErr.details ?? '' })
            : t(`categories.errors.${key}`),
        );
        // The list was out of date: a dish was added to it, or this category or the target is gone.
        if (key === 'notEmpty' || key === 'notFound' || key === 'invalidTarget') await onChanged();
        return;
      }
      const moved = Number((data as { moved_items?: number } | null)?.moved_items ?? 0);
      setDeletingId(null);
      done(
        target && moved > 0
          ? t('categories.deletedMoved', { name: cat.name, count: moved, target: target.name })
          : t('categories.deleted', { name: cat.name }),
      );
      await onChanged();
    });

  const addCategory = () =>
    exclusive(async () => {
      const name = newName.trim();
      if (!name) return;
      setError(null);
      setStatus(null);
      const { error: dbErr } = await getBrowserClient()
        .from('menu_categories')
        .insert({
          branch_id: branchId,
          name,
          icon_emoji: newEmoji.trim() || null,
          // Last, whether or not a drag has already renumbered the branch from 0.
          display_order: nextDisplayOrder(orderRef.current),
          is_active: true,
        });
      if (dbErr) {
        failed('create category', dbErr);
        return;
      }
      setNewName('');
      setNewEmoji('🍽️');
      done(t('categories.added', { name }));
      await onChanged();
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('categories.intro')}</p>

      {status && (
        <p role="status" className="rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {order.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          {t('categories.empty')}
        </p>
      ) : (
        <>
          {/* Said where the dragging happens: this list is not an index, it is the menu. */}
          <div className="flex items-start justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
            <p className="text-xs text-muted-foreground">{t('categories.order.hint')}</p>
            {orderState !== 'idle' && (
              <p
                role="status"
                className={`shrink-0 text-xs font-medium ${
                  orderState === 'saved' ? 'text-success' : 'text-muted-foreground'
                }`}
              >
                {orderState === 'saved' ? t('categories.order.saved') : t('categories.order.saving')}
              </p>
            )}
          </div>
          {orderError && (
            <div role="alert" className="space-y-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
              <p>{t('categories.order.failed', { reason: orderError })}</p>
              <Button type="button" size="sm" variant="ghost" onClick={() => void flushOrder()}>
                {t('categories.order.retry')}
              </Button>
            </div>
          )}

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={categoryIds(order)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2">
                {order.map((cat) => {
                  const count = counts.get(cat.id) ?? { total: 0, hidden: 0 };
                  const others = order.filter((c) => c.id !== cat.id);
                  const renaming = renamingId === cat.id;
                  const deleting = deletingId === cat.id;
                  return (
                    <SortableCategoryRow key={cat.id} id={cat.id}>
                      {(handleProps) => (
                        <>
                          <div className="flex items-center gap-2">
                            <button
                              {...handleProps}
                              type="button"
                              className="focus-ring shrink-0 cursor-grab touch-none rounded-md p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
                              aria-label={t('categories.order.drag', { name: cat.name })}
                            >
                              <GripVertical className="h-4 w-4" />
                            </button>
                            <span className="text-2xl" aria-hidden>
                              {cat.iconEmoji ?? '🍴'}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium">{cat.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {t('categories.itemCount', { count: count.total })}
                                {count.hidden > 0 && ` · ${t('categories.hiddenCount', { count: count.hidden })}`}
                              </p>
                            </div>
                            <IconButton
                              label={t('categories.rename', { name: cat.name })}
                              size="sm"
                              onClick={() => (renaming ? setRenamingId(null) : startRename(cat))}
                              disabled={busy}
                            >
                              <Edit3 className="h-4 w-4" />
                            </IconButton>
                            <IconButton
                              label={t('categories.delete', { name: cat.name })}
                              size="sm"
                              className="text-danger"
                              onClick={() => (deleting ? setDeletingId(null) : startDelete(cat))}
                              disabled={busy}
                            >
                              <Trash2 className="h-4 w-4" />
                            </IconButton>
                          </div>

                          {renaming && (
                            <div className="mt-3 space-y-2 border-t border-border pt-3">
                              <EmojiAndName
                                emoji={draftEmoji}
                                name={draftName}
                                onEmoji={setDraftEmoji}
                                onName={setDraftName}
                                onSubmit={() => void saveRename(cat)}
                              />
                              <div className="flex gap-2">
                                <Button type="button" size="sm" onClick={() => void saveRename(cat)} loading={busy}>
                                  {t('categories.save')}
                                </Button>
                                <Button type="button" size="sm" variant="ghost" onClick={() => setRenamingId(null)} disabled={busy}>
                                  {t('categories.cancel')}
                                </Button>
                              </div>
                            </div>
                          )}

                          {deleting && (
                            <div className="mt-3 space-y-3 border-t border-border pt-3">
                              {count.total === 0 ? (
                                <p className="text-sm">{t('categories.deleteEmpty', { name: cat.name })}</p>
                              ) : others.length === 0 ? (
                                <p className="text-sm">
                                  {t('categories.deleteNoTarget', { name: cat.name, count: count.total })}
                                </p>
                              ) : (
                                <>
                                  <p className="text-sm">
                                    {t('categories.deleteMove', { name: cat.name, count: count.total })}
                                  </p>
                                  <label className="block text-sm font-medium">
                                    {t('categories.moveTo')}
                                    <select
                                      value={moveTargetFor(cat)?.id ?? ''}
                                      onChange={(e) => setMoveTo(e.target.value)}
                                      className="input mt-1 w-full"
                                      disabled={busy}
                                    >
                                      {others.map((c) => (
                                        <option key={c.id} value={c.id}>
                                          {c.iconEmoji} {c.name}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <p className="text-xs text-muted-foreground">{t('categories.deleteMoveHint')}</p>
                                </>
                              )}
                              <div className="flex flex-wrap gap-2">
                                {(count.total === 0 || others.length > 0) && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="danger"
                                    onClick={() => void confirmDelete(cat, count.total)}
                                    loading={busy}
                                  >
                                    {count.total === 0 ? t('categories.confirmDelete') : t('categories.confirmMoveDelete')}
                                  </Button>
                                )}
                                <Button type="button" size="sm" variant="ghost" onClick={() => setDeletingId(null)} disabled={busy}>
                                  {t('categories.cancel')}
                                </Button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </SortableCategoryRow>
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        </>
      )}

      <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
        <p className="text-sm font-semibold">{t('categories.addTitle')}</p>
        <EmojiAndName
          emoji={newEmoji}
          name={newName}
          onEmoji={setNewEmoji}
          onName={setNewName}
          onSubmit={() => void addCategory()}
        />
        <Button type="button" variant="soft" size="sm" onClick={() => void addCategory()} loading={busy} disabled={!newName.trim()}>
          {t('categories.add')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The row dnd-kit moves. The handle props go on the grip button alone, so the rest of the row —
 * rename, delete, and the panels they open — still takes ordinary taps, and a merchant scrolling
 * the list on a phone does not drag a category by accident.
 */
function SortableCategoryRow({
  id,
  children,
}: {
  id: string;
  children: (handleProps: Record<string, unknown>) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border border-border bg-card p-3 ${isDragging ? 'relative z-10' : ''}`}
    >
      {children({ ...attributes, ...listeners })}
    </li>
  );
}

function EmojiAndName({
  emoji,
  name,
  onEmoji,
  onName,
  onSubmit,
}: {
  emoji: string;
  name: string;
  onEmoji: (value: string) => void;
  onName: (value: string) => void;
  onSubmit: () => void;
}) {
  const t = useTranslations('menu');
  return (
    <>
      <div className="flex items-center gap-2">
        <input
          value={emoji}
          onChange={(e) => onEmoji(e.target.value)}
          aria-label={t('categories.iconLabel')}
          maxLength={4}
          className="focus-ring h-11 w-14 shrink-0 rounded-xl border border-border bg-background text-center text-xl"
        />
        <input
          value={name}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={(e) => {
            // Not while an input method is composing (Thai and Vietnamese keyboards), and not a held key.
            if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit();
            }
          }}
          aria-label={t('categories.nameLabel')}
          placeholder={t('categories.namePlaceholder')}
          className="focus-ring h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-base"
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CATEGORY_EMOJIS.map((em) => (
          <button
            key={em}
            type="button"
            onClick={() => onEmoji(em)}
            className={`h-8 w-8 rounded-lg border text-base ${emoji === em ? 'border-primary bg-primary/10' : 'border-border'}`}
          >
            {em}
          </button>
        ))}
      </div>
    </>
  );
}
