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
import { getBrowserClient } from '@favornoms/database/client';
import {
  createKitchenStation,
  deleteKitchenStation,
  renameKitchenStation,
  reorderKitchenStations,
} from '@favornoms/database/queries';
import { Button, IconButton } from '@favornoms/ui';
import {
  NO_STATION,
  isBuiltInStation,
  stationLabel,
  stationNameClash,
  type BuiltInStationKey,
  type KitchenStation,
} from '@/lib/kitchen-stations';
import { STATION_NAME_MAX } from '../import/_components/csv-stations';
// The ordering rules are the categories' own: they need nothing but ids.
import { categoryIds, moveCategory, reconcileOrder, sameOrder } from './category-order';
import { MoveButtons } from './item-modifier-editor';
import { menuErrorKey, stationErrorKey } from './menu-errors';

/** As the Categories panel: three quick moves are one write, and "Saved" shows while still looking. */
const ORDER_SAVE_DELAY_MS = 700;

interface Props {
  branchId: string;
  /** The branch's stations in display order. */
  stations: KitchenStation[];
  /** Every dish's station, hidden dishes included: they move with their station too. */
  dishes: ReadonlyArray<{ station: string | null; hidden: boolean }>;
  /** Reloads the stations, categories and dishes from the database. */
  onChanged: () => Promise<void>;
  /** Also shown on the menu page, so it is still there once this panel closes. */
  onNotice: (message: string) => void;
}

/**
 * The branch's kitchen stations (docs/KITCHEN-STATIONS-2026-10-24.md): where each dish is made, and
 * the buttons the kitchen board filters by, in the order set here. Built like the Categories panel.
 *
 * A station's key never changes, so renaming one moves no dish and no ticket: the board shows the
 * new name on the same tickets. A built-in (hot, cold, bar, dessert, expo) has no name until the
 * merchant gives it one; until then, and again once the name is cleared, it shows its label in the
 * viewer's language.
 *
 * Deleting goes through delete_kitchen_station, which moves the station's dishes, and their tickets
 * on open orders, to the station picked here or to no station. The database refuses a plain delete.
 */
export function StationManager({ branchId, stations, dishes, onChanged, onNotice }: Props) {
  const t = useTranslations('menu');
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [draftName, setDraftName] = React.useState('');
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  /** A station key, or NO_STATION, which can never be one. */
  const [moveTo, setMoveTo] = React.useState<string>(NO_STATION);
  const [newName, setNewName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);

  /** The order on screen. A drag or an arrow changes it at once; the database follows a moment later. */
  const [order, setOrder] = React.useState<KitchenStation[]>(stations);
  const orderRef = React.useRef(order);
  /** The order the database holds, so a settled list that already matches writes nothing. */
  const savedIds = React.useRef<string[]>(categoryIds(stations));
  /** Set by the first move: only then may a reload be merged instead of taken as it comes. */
  const dragged = React.useRef(false);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingOrder = React.useRef(false);
  /** False from the moment the panel unmounts, so the last write cannot set state on a ghost. */
  const live = React.useRef(true);
  const [orderState, setOrderState] = React.useState<'idle' | 'saving' | 'saved'>('idle');
  const [orderError, setOrderError] = React.useState<string | null>(null);

  const builtInLabel = (key: BuiltInStationKey) => t(`stations.${key}`);
  const labelOf = (station: KitchenStation) => stationLabel(station, order, builtInLabel);

  /** Logs the raw failure; the merchant gets a station sentence where there is one, else the menu's. */
  const errorText = (context: string, err: unknown) => {
    console.error(`[menu] ${context} failed`, err);
    const key = stationErrorKey(err);
    return key ? t(`stationManager.errors.${key}`) : t(`errors.${menuErrorKey(err)}`);
  };

  /** The ref is what the delayed write reads, so it is set on the same line as the state. */
  const applyOrder = (next: KitchenStation[]) => {
    orderRef.current = next;
    setOrder(next);
  };

  // A reload is the database's word on which stations exist and what they are called, and on their
  // order unless a move here has not reached it yet, in which case the screen is the newer truth.
  React.useEffect(() => {
    const next = dragged.current ? reconcileOrder(orderRef.current, stations) : stations;
    orderRef.current = next;
    setOrder(next);
    savedIds.current = categoryIds(stations);
  }, [stations]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * Writes the settled order: the whole list in one reorder_kitchen_stations call. The loop is for
   * a move made while the previous call was still in flight, which gets its own single call.
   */
  const flushOrder = React.useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    // A call is already running; it loops again for anything moved meanwhile.
    if (savingOrder.current) return;
    let wrote = false;
    while (!sameOrder(categoryIds(orderRef.current), savedIds.current)) {
      const list = orderRef.current;
      savingOrder.current = true;
      if (live.current) {
        setOrderState('saving');
        setOrderError(null);
      }
      try {
        await reorderKitchenStations(getBrowserClient(), branchId, categoryIds(list));
      } catch (err) {
        savingOrder.current = false;
        console.error('[menu] reorder_kitchen_stations failed', err);
        if (live.current) {
          setOrderState('idle');
          const key = stationErrorKey(err);
          setOrderError(key ? t(`stationManager.errors.${key}`) : t(`errors.${menuErrorKey(err)}`));
        }
        // A station was added or deleted elsewhere, and the function takes only the whole list. The
        // reload keeps this arrangement for the stations still there, so "Try again" sends it.
        if (stationErrorKey(err) === 'listChanged') await onChanged();
        return;
      }
      savingOrder.current = false;
      savedIds.current = categoryIds(list);
      wrote = true;
    }
    if (!wrote) return;
    if (live.current) {
      setOrderState('saved');
      setOrderError(null);
    }
    // The dish dialog behind this panel lists the stations in this order too.
    await onChanged();
  }, [branchId, onChanged, t]);

  const flushOrderRef = React.useRef(flushOrder);
  React.useEffect(() => {
    flushOrderRef.current = flushOrder;
  }, [flushOrder]);

  React.useEffect(() => {
    if (orderState !== 'saved') return;
    const timer = setTimeout(() => setOrderState('idle'), 4000);
    return () => clearTimeout(timer);
  }, [orderState]);

  // A tap on the backdrop or Escape closes this panel without asking, so a move still waiting out
  // its delay is written on the way out rather than lost.
  React.useEffect(() => {
    return () => {
      live.current = false;
      void flushOrderRef.current();
    };
  }, []);

  /** Shows a new order at once and writes it once the moves stop. */
  const reorderTo = (next: KitchenStation[]) => {
    if (next === orderRef.current) return;
    dragged.current = true;
    applyOrder(next);
    setError(null);
    setOrderError(null);
    setOrderState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void flushOrder();
    }, ORDER_SAVE_DELAY_MS);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    reorderTo(moveCategory(orderRef.current, String(active.id), String(over.id)));
  };

  /** The arrows: for a phone, where a drag fights the scroll, and for anyone not dragging. */
  const moveBy = (id: string, dir: -1 | 1) => {
    const list = orderRef.current;
    const neighbour = list[list.findIndex((s) => s.id === id) + dir];
    if (!neighbour) return;
    reorderTo(moveCategory(list, id, neighbour.id));
  };

  // One write at a time: `busy` only disables buttons, and Enter in a field (or a held key) would
  // otherwise start a second insert before the first returns.
  const inFlight = React.useRef(false);
  const exclusive = async (context: string, run: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      // Rename, delete and add all reload the list. A move still waiting out its delay goes first,
      // or the database's old order would be painted back over it.
      await flushOrder();
      await run();
    } catch (err) {
      setError(errorText(context, err));
      // The list on screen was out of date: this station or the chosen target is gone, or dishes
      // were given the station meanwhile and the reloaded counts now offer the move-to picker.
      const key = stationErrorKey(err);
      if (key === 'notFound' || key === 'invalidTarget' || key === 'inUse') await onChanged();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const counts = React.useMemo(() => {
    const map = new Map<string, { total: number; hidden: number }>();
    for (const dish of dishes) {
      if (!dish.station) continue;
      const entry = map.get(dish.station) ?? { total: 0, hidden: 0 };
      entry.total += 1;
      if (dish.hidden) entry.hidden += 1;
      map.set(dish.station, entry);
    }
    return map;
  }, [dishes]);

  const done = (message: string) => {
    setStatus(message);
    onNotice(message);
  };

  const startRename = (station: KitchenStation) => {
    setDeletingId(null);
    setError(null);
    setStatus(null);
    setRenamingId(station.id);
    // A built-in that was never renamed opens empty, its label showing as the placeholder.
    setDraftName(station.name ?? '');
  };

  const startDelete = (station: KitchenStation) => {
    setRenamingId(null);
    setError(null);
    setStatus(null);
    setDeletingId(station.id);
    setMoveTo(order.find((s) => s.id !== station.id)?.key ?? NO_STATION);
  };

  /** The chosen target if it is still offered, else the first station offered. The list can change
   *  under an open panel, and a select whose value matches no option shows the first option while
   *  the state still holds the old value. */
  const moveTargetFor = (station: KitchenStation) => {
    const others = order.filter((s) => s.id !== station.id);
    if (moveTo === NO_STATION || others.some((s) => s.key === moveTo)) return moveTo;
    return others[0]?.key ?? NO_STATION;
  };

  /** `useDefault` takes a built-in back to its translated label. */
  const saveRename = (station: KitchenStation, useDefault = false) =>
    exclusive('rename station', async () => {
      const name = useDefault ? '' : draftName.trim();
      // Blank is how a built-in goes back to its label; any other station must keep a name.
      if (!name && !isBuiltInStation(station.key)) {
        setError(t('stationManager.nameRequired'));
        return;
      }
      // What it would show, the typed name or a built-in's own label, must not be another station's.
      // The database's unique index never sees a built-in with no name, so this is checked here.
      const shown = name || (isBuiltInStation(station.key) ? builtInLabel(station.key) : '');
      if (stationNameClash(shown, order, builtInLabel, station.id)) {
        setError(t('stationManager.errors.nameTaken'));
        return;
      }
      setError(null);
      // Throws station_not_found when no row changed: deleted elsewhere, or hidden by row-level
      // security from a role that may not edit the menu here.
      const saved = await renameKitchenStation(getBrowserClient(), station.id, name || null);
      setRenamingId(null);
      done(t('stationManager.saved', { name: stationLabel(saved, [saved], builtInLabel) }));
      await onChanged();
    });

  const confirmDelete = (station: KitchenStation, count: number) =>
    exclusive('delete_kitchen_station', async () => {
      const target = count > 0 ? moveTargetFor(station) : NO_STATION;
      const targetStation = order.find((s) => s.key === target && s.id !== station.id);
      setError(null);
      // "No station" is sent as a choice only when the sheet showed dishes and the merchant picked
      // it. A station shown unused goes without `clear`, so dishes given it since the list was read
      // are refused (station_in_use) rather than quietly cleared.
      const moved = await deleteKitchenStation(getBrowserClient(), station.id, targetStation?.key ?? null, {
        clear: count > 0 && target === NO_STATION,
      });
      const name = labelOf(station);
      setDeletingId(null);
      done(
        moved === 0
          ? t('stationManager.deleted', { name })
          : targetStation
            ? t('stationManager.deletedMoved', { name, count: moved, target: labelOf(targetStation) })
            : t('stationManager.deletedCleared', { name, count: moved }),
      );
      await onChanged();
    });

  const addStation = () =>
    exclusive('create station', async () => {
      const name = newName.trim();
      if (!name) return;
      setError(null);
      setStatus(null);
      // The database's unique index never sees a built-in with no name, so a "Bar" next to the
      // built-in bar is caught here.
      if (stationNameClash(name, order, builtInLabel)) {
        setError(t('stationManager.errors.nameTaken'));
        return;
      }
      // After the last station; the database gives it its key.
      const created = await createKitchenStation(getBrowserClient(), branchId, name);
      setNewName('');
      done(t('stationManager.added', { name: created.name ?? name }));
      await onChanged();
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('stationManager.intro')}</p>

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
          {t('stationManager.empty')}
        </p>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
            <p className="text-xs text-muted-foreground">{t('stationManager.order.hint')}</p>
            {orderState !== 'idle' && (
              <p
                role="status"
                className={`shrink-0 text-xs font-medium ${
                  orderState === 'saved' ? 'text-success' : 'text-muted-foreground'
                }`}
              >
                {orderState === 'saved' ? t('stationManager.order.saved') : t('stationManager.order.saving')}
              </p>
            )}
          </div>
          {orderError && (
            <div role="alert" className="space-y-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
              <p>{t('stationManager.order.failed', { reason: orderError })}</p>
              <Button type="button" size="sm" variant="ghost" onClick={() => void flushOrder()}>
                {t('stationManager.order.retry')}
              </Button>
            </div>
          )}

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={categoryIds(order)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2">
                {order.map((station, index) => {
                  const label = labelOf(station);
                  const defaultLabel = isBuiltInStation(station.key) ? builtInLabel(station.key) : null;
                  const count = counts.get(station.key) ?? { total: 0, hidden: 0 };
                  const others = order.filter((s) => s.id !== station.id);
                  const renaming = renamingId === station.id;
                  const deleting = deletingId === station.id;
                  return (
                    <SortableStationRow key={station.id} id={station.id}>
                      {(handleProps) => (
                        <>
                          <div className="flex items-center gap-2">
                            <button
                              {...handleProps}
                              type="button"
                              className="focus-ring shrink-0 cursor-grab touch-none rounded-md p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
                              aria-label={t('stationManager.order.drag', { name: label })}
                            >
                              <GripVertical className="h-4 w-4" />
                            </button>
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium">{label}</p>
                              <p className="text-xs text-muted-foreground">
                                {t('stationManager.dishCount', { count: count.total })}
                                {count.hidden > 0 && ` · ${t('stationManager.hiddenCount', { count: count.hidden })}`}
                              </p>
                            </div>
                            <MoveButtons
                              upLabel={t('stationManager.order.up', { name: label })}
                              downLabel={t('stationManager.order.down', { name: label })}
                              canMoveUp={index > 0}
                              canMoveDown={index < order.length - 1}
                              onMove={(dir) => moveBy(station.id, dir)}
                            />
                            <IconButton
                              label={t('stationManager.rename', { name: label })}
                              size="sm"
                              onClick={() => (renaming ? setRenamingId(null) : startRename(station))}
                              disabled={busy}
                            >
                              <Edit3 className="h-4 w-4" />
                            </IconButton>
                            <IconButton
                              label={t('stationManager.delete', { name: label })}
                              size="sm"
                              className="text-danger"
                              onClick={() => (deleting ? setDeletingId(null) : startDelete(station))}
                              disabled={busy}
                            >
                              <Trash2 className="h-4 w-4" />
                            </IconButton>
                          </div>

                          {renaming && (
                            <div className="mt-3 space-y-2 border-t border-border pt-3">
                              <StationNameInput
                                value={draftName}
                                onChange={setDraftName}
                                onSubmit={() => void saveRename(station)}
                                placeholder={defaultLabel ?? t('stationManager.namePlaceholder')}
                              />
                              {defaultLabel && (
                                <p className="text-xs text-muted-foreground">
                                  {t('stationManager.builtInHint', { label: defaultLabel })}
                                </p>
                              )}
                              <div className="flex flex-wrap gap-2">
                                <Button type="button" size="sm" onClick={() => void saveRename(station)} loading={busy}>
                                  {t('stationManager.save')}
                                </Button>
                                {defaultLabel && station.name && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void saveRename(station, true)}
                                    disabled={busy}
                                  >
                                    {t('stationManager.useDefault', { label: defaultLabel })}
                                  </Button>
                                )}
                                <Button type="button" size="sm" variant="ghost" onClick={() => setRenamingId(null)} disabled={busy}>
                                  {t('stationManager.cancel')}
                                </Button>
                              </div>
                            </div>
                          )}

                          {deleting && (
                            <div className="mt-3 space-y-3 border-t border-border pt-3">
                              {count.total === 0 ? (
                                <p className="text-sm">{t('stationManager.deleteUnused', { name: label })}</p>
                              ) : (
                                <>
                                  <p className="text-sm">
                                    {t('stationManager.deleteMove', { name: label, count: count.total })}
                                  </p>
                                  <label className="block text-sm font-medium">
                                    {t('stationManager.moveTo')}
                                    <select
                                      value={moveTargetFor(station)}
                                      onChange={(e) => setMoveTo(e.target.value)}
                                      className="input mt-1 w-full"
                                      disabled={busy}
                                    >
                                      <option value={NO_STATION}>{t('editor.stationNone')}</option>
                                      {others.map((s) => (
                                        <option key={s.id} value={s.key}>
                                          {labelOf(s)}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                </>
                              )}
                              <p className="text-xs text-muted-foreground">{t('stationManager.deleteHint')}</p>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="danger"
                                  onClick={() => void confirmDelete(station, count.total)}
                                  loading={busy}
                                >
                                  {count.total === 0
                                    ? t('stationManager.confirmDelete')
                                    : t('stationManager.confirmMoveDelete')}
                                </Button>
                                <Button type="button" size="sm" variant="ghost" onClick={() => setDeletingId(null)} disabled={busy}>
                                  {t('stationManager.cancel')}
                                </Button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </SortableStationRow>
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        </>
      )}

      <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
        <p className="text-sm font-semibold">{t('stationManager.addTitle')}</p>
        <StationNameInput
          value={newName}
          onChange={setNewName}
          onSubmit={() => void addStation()}
          placeholder={t('stationManager.namePlaceholder')}
        />
        <Button type="button" variant="soft" size="sm" onClick={() => void addStation()} loading={busy} disabled={!newName.trim()}>
          {t('stationManager.add')}
        </Button>
      </div>
    </div>
  );
}

/** The row dnd-kit moves; only the grip drags, so the rest of the row takes ordinary taps. */
function SortableStationRow({
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

/** A station's name, capped where kitchen_stations_name_check caps it; Enter submits. */
export function StationNameInput({
  value,
  onChange,
  onSubmit,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
}) {
  const t = useTranslations('menu');
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // Not while an input method is composing (Thai and Vietnamese keyboards), and not a held key.
        // Inside the dish form, Enter would otherwise save the whole dish.
        if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmit();
        }
      }}
      aria-label={t('stationManager.nameLabel')}
      placeholder={placeholder}
      maxLength={STATION_NAME_MAX}
      className="focus-ring h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 text-base"
    />
  );
}
