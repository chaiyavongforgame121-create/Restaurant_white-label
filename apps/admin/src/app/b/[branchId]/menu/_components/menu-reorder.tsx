'use client';

import * as React from 'react';
import Image from 'next/image';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Save } from 'lucide-react';
import type { MenuCategory, MenuItem } from '@favornoms/shared';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

interface Props {
  branchId: string;
  categories: MenuCategory[];
  items: MenuItem[];
  onSaved?: () => void;
}

/**
 * Drag-and-drop reordering UI for menu categories + items.
 * Categories sort vertically. Items sort within their category panel.
 * Cross-category drag updates the item's category_id on save.
 *
 * Two-step UX: drag locally → "Save layout" button persists changes.
 */
export function MenuReorder({ branchId, categories: initCategories, items: initItems, onSaved }: Props) {
  const [categories, setCategories] = React.useState(initCategories);
  const [itemsByCat, setItemsByCat] = React.useState<Map<string, MenuItem[]>>(() => groupByCat(initItems));
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const allItems = React.useMemo(() => Array.from(itemsByCat.values()).flat(), [itemsByCat]);

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const onDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const activeKind = (active.data.current?.kind ?? '') as 'category' | 'item';
    const overKind = (over.data.current?.kind ?? '') as 'category' | 'item' | 'category-list';

    if (activeKind === 'category' && (overKind === 'category' || overKind === 'category-list')) {
      const oldIndex = categories.findIndex((c) => c.id === active.id);
      const newIndex = categories.findIndex((c) => c.id === over.id);
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
      setCategories(arrayMove(categories, oldIndex, newIndex));
      setDirty(true);
      return;
    }

    if (activeKind === 'item') {
      const activeCatId = (active.data.current?.catId ?? '') as string;
      const overCatId = (over.data.current?.catId ?? (over.id as string)) as string;
      if (!activeCatId || !overCatId) return;

      setItemsByCat((prev) => {
        const next = new Map(prev);
        const fromList = [...(next.get(activeCatId) ?? [])];
        const toList = activeCatId === overCatId ? fromList : [...(next.get(overCatId) ?? [])];
        const fromIdx = fromList.findIndex((i) => i.id === active.id);
        if (fromIdx < 0) return prev;
        const [moved] = fromList.splice(fromIdx, 1);
        const overIdx = toList.findIndex((i) => i.id === over.id);
        const insertAt = overIdx >= 0 ? overIdx : toList.length;
        toList.splice(insertAt, 0, { ...moved, categoryId: overCatId } as MenuItem);
        next.set(activeCatId, fromList);
        if (activeCatId !== overCatId) next.set(overCatId, toList);
        else next.set(activeCatId, toList);
        return next;
      });
      setDirty(true);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const supabase = getBrowserClient();

      // Categories
      const catOrders = categories.map((c, i) => ({ id: c.id, display_order: i }));
      const { error: catErr } = await supabase.rpc('reorder_menu_categories', {
        p_branch_id: branchId,
        p_orders: catOrders,
      });
      if (catErr) throw new Error(catErr.message);

      // Items per category — update category_id + display_order
      const itemPromises: Array<PromiseLike<unknown>> = [];
      for (const [catId, list] of itemsByCat) {
        list.forEach((item, i) => {
          const originalCat = initItems.find((it) => it.id === item.id)?.categoryId;
          if (originalCat !== catId) {
            itemPromises.push(
              supabase.rpc('set_menu_item_category', {
                p_branch_id: branchId,
                p_item_id: item.id,
                p_category_id: catId,
                p_display_order: i,
              }) as unknown as PromiseLike<unknown>,
            );
          }
        });
        const sameCatOrders = list.map((item, i) => ({ id: item.id, display_order: i }));
        itemPromises.push(
          supabase.rpc('reorder_menu_items', {
            p_branch_id: branchId,
            p_orders: sameCatOrders,
          }) as unknown as PromiseLike<unknown>,
        );
      }
      const results = await Promise.all(itemPromises);
      const firstError = results.find(
        (r) => (r as { error?: { message?: string } })?.error,
      ) as { error: { message: string } } | undefined;
      if (firstError?.error) throw new Error(firstError.error.message);

      setDirty(false);
      onSaved?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const activeItem = activeId ? allItems.find((i) => i.id === activeId) : null;
  const activeCategory = activeId ? categories.find((c) => c.id === activeId) : null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between rounded-2xl bg-card px-4 py-3 shadow-warm">
        <p className="text-sm text-muted-foreground">
          {dirty
            ? 'Unsaved changes — drag items between categories or up/down to reorder.'
            : 'Drag the handle to reorder categories and items.'}
        </p>
        <Button
          variant="gradient"
          onClick={save}
          loading={saving}
          disabled={!dirty}
          leftIcon={<Save className="h-4 w-4" />}
        >
          Save layout
        </Button>
      </div>
      {error && <p className="mb-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <SortableContext items={categories.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-4">
            {categories.map((cat) => (
              <SortableCategory key={cat.id} cat={cat} items={itemsByCat.get(cat.id) ?? []} />
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeItem ? <ItemRow item={activeItem} dragHandleProps={{}} dragging /> : null}
          {activeCategory ? (
            <Card className="flex items-center gap-2 p-3 opacity-80 shadow-warm">
              <GripVertical className="h-4 w-4 text-muted-foreground" />
              <span aria-hidden>{activeCategory.iconEmoji ?? '🍴'}</span>
              <span className="font-display font-semibold">{activeCategory.name}</span>
            </Card>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function SortableCategory({ cat, items }: { cat: MenuCategory; items: MenuItem[] }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cat.id,
    data: { kind: 'category' },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };
  return (
    <section ref={setNodeRef} style={style}>
      <Card className="overflow-hidden">
        <header className="flex items-center gap-2 border-b border-border/40 bg-muted/30 px-3 py-2">
          <button
            {...attributes}
            {...listeners}
            type="button"
            className="cursor-grab touch-none rounded-md p-1.5 text-muted-foreground hover:bg-background active:cursor-grabbing"
            aria-label="Drag category"
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <span aria-hidden>{cat.iconEmoji ?? '🍴'}</span>
          <h2 className="font-display text-lg font-semibold">{cat.name}</h2>
          <Badge variant="muted" className="ml-1">
            {items.length}
          </Badge>
        </header>
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <ul className="divide-y divide-border/40">
            {items.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-muted-foreground">
                Drop items here to add to this category
              </li>
            ) : (
              items.map((item) => <SortableItem key={item.id} item={item} catId={cat.id} />)
            )}
          </ul>
        </SortableContext>
      </Card>
    </section>
  );
}

function SortableItem({ item, catId }: { item: MenuItem; catId: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    data: { kind: 'item', catId },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };
  return (
    <li ref={setNodeRef} style={style}>
      <ItemRow item={item} dragHandleProps={{ ...attributes, ...listeners }} />
    </li>
  );
}

function ItemRow({
  item,
  dragHandleProps,
  dragging,
}: {
  item: MenuItem;
  dragHandleProps: Record<string, unknown>;
  dragging?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-3 py-2 ${dragging ? 'rounded-xl bg-card shadow-warm' : ''}`}>
      <button
        {...dragHandleProps}
        type="button"
        className="cursor-grab touch-none rounded-md p-1.5 text-muted-foreground hover:bg-muted active:cursor-grabbing"
        aria-label="Drag item"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      {item.imageUrl ? (
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg">
          <Image src={item.imageUrl} alt="" fill sizes="40px" className="object-cover" />
        </div>
      ) : (
        <div className="h-10 w-10 shrink-0 rounded-lg bg-muted" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.name}</p>
      </div>
      <span className="shrink-0 font-display text-sm font-bold text-primary">
        {formatCurrency(item.price)}
      </span>
    </div>
  );
}

function groupByCat(items: MenuItem[]): Map<string, MenuItem[]> {
  const map = new Map<string, MenuItem[]>();
  for (const item of items) {
    const list = map.get(item.categoryId) ?? [];
    list.push(item);
    map.set(item.categoryId, list);
  }
  return map;
}
