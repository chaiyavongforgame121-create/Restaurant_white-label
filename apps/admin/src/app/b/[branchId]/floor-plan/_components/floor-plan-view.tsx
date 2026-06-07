'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Edit, Plus } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

type Status = 'open' | 'occupied' | 'dirty' | 'reserved';

interface Table {
  id: string;
  table_number: string;
  display_name: string | null;
  capacity: number;
  zone: string | null;
  status: Status;
  pos_x: number;
  pos_y: number;
  pos_w: number;
  pos_h: number;
  shape: 'square' | 'round' | 'rect';
  open_orders: number;
}

const GRID_COLS = 12;
const GRID_ROWS = 10;
const STATUS_COLORS: Record<Status, string> = {
  open: 'bg-success/15 border-success/50 text-success',
  occupied: 'bg-warning/15 border-warning/50 text-warning',
  dirty: 'bg-muted text-muted-foreground border-border',
  reserved: 'bg-primary/15 border-primary/50 text-primary',
};

interface Props {
  branchId: string;
  initial: Table[];
}

export function FloorPlanView({ branchId, initial }: Props) {
  const router = useRouter();
  const [tables, setTables] = React.useState(initial);
  const [editing, setEditing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<Table | null>(null);

  const refetch = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('v_branch_floor_plan')
      .select('id, table_number, display_name, capacity, zone, status, pos_x, pos_y, pos_w, pos_h, shape, open_orders')
      .eq('branch_id', branchId);
    setTables((data ?? []) as Table[]);
  };

  const updateTable = async (id: string, patch: Partial<Table>) => {
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase.from('tables').update(patch).eq('id', id);
    if (upErr) { setError(upErr.message); return; }
    setTables((curr) => curr.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const moveTo = (table: Table, x: number, y: number) => {
    updateTable(table.id, { pos_x: Math.max(0, Math.min(GRID_COLS - table.pos_w, x)), pos_y: Math.max(0, Math.min(GRID_ROWS - table.pos_h, y)) });
  };

  const addTable = async () => {
    const num = window.prompt('Table number / label (e.g. "12", "Patio A")');
    if (!num) return;
    const cap = window.prompt('Seats?', '4');
    if (cap === null) return;
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('tables').insert({
      branch_id: branchId,
      table_number: num,
      capacity: Math.max(1, Number(cap) || 4),
      is_active: true,
      pos_x: 0,
      pos_y: 0,
      pos_w: 1,
      pos_h: 1,
    });
    if (insErr) { setError(insErr.message); return; }
    refetch();
    router.refresh();
  };

  const cycleStatus = (table: Table) => {
    const order: Status[] = ['open', 'occupied', 'dirty', 'reserved'];
    const next = order[(order.indexOf(table.status) + 1) % order.length]!;
    updateTable(table.id, { status: next });
  };

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">Floor plan</h1>
          <p className="mt-1 text-muted-foreground">
            Drag tables around in edit mode. Tap a table to cycle status (open → occupied → dirty → reserved).
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant={editing ? 'gradient' : 'outline'} onClick={() => setEditing((e) => !e)} leftIcon={<Edit className="h-4 w-4" />}>
            {editing ? 'Done editing' : 'Edit layout'}
          </Button>
          <Button variant="gradient" onClick={addTable} leftIcon={<Plus className="h-4 w-4" />}>
            New table
          </Button>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      <div className="mb-3 flex flex-wrap gap-2 px-2 lg:px-0 text-xs">
        {(Object.keys(STATUS_COLORS) as Status[]).map((s) => (
          <Badge key={s} className={`${STATUS_COLORS[s]} border`}>
            {s}
          </Badge>
        ))}
      </div>

      <Card className="overflow-hidden p-3">
        <div
          className="relative grid w-full"
          style={{
            gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
            gridAutoRows: 'minmax(64px, 1fr)',
            gap: '6px',
            minHeight: `${GRID_ROWS * 64}px`,
          }}
        >
          {/* Grid hover cells */}
          {editing && Array.from({ length: GRID_COLS * GRID_ROWS }).map((_, i) => {
            const x = i % GRID_COLS;
            const y = Math.floor(i / GRID_COLS);
            return (
              <div
                key={`cell-${i}`}
                onClick={() => picked && moveTo(picked, x, y)}
                className="rounded-lg border border-dashed border-border/40 hover:bg-primary/10"
                style={{ gridColumn: x + 1, gridRow: y + 1 }}
              />
            );
          })}

          {tables.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => (editing ? setPicked(t) : cycleStatus(t))}
              style={{
                gridColumn: `${t.pos_x + 1} / span ${t.pos_w}`,
                gridRow: `${t.pos_y + 1} / span ${t.pos_h}`,
              }}
              className={`focus-ring relative flex flex-col items-center justify-center gap-1 border-2 px-2 py-1 text-center font-semibold transition-shadow hover:shadow-warm ${
                STATUS_COLORS[t.status] ?? STATUS_COLORS.open
              } ${t.shape === 'round' ? 'rounded-full aspect-square' : 'rounded-xl'} ${
                picked?.id === t.id ? 'ring-4 ring-primary' : ''
              }`}
            >
              <span className="text-sm">{t.display_name ?? t.table_number}</span>
              <span className="text-[10px] opacity-70">{t.capacity}p · {t.status}</span>
              {t.open_orders > 0 && (
                <span className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                  {t.open_orders}
                </span>
              )}
            </button>
          ))}
        </div>
      </Card>

      {editing && picked && (
        <Card className="mt-4 p-4">
          <p className="text-sm">
            <strong>{picked.display_name ?? picked.table_number}</strong> selected. Click any empty grid cell to move it.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => { updateTable(picked.id, { shape: 'square' }); setPicked({ ...picked, shape: 'square' }); }}>Square</Button>
            <Button size="sm" variant="outline" onClick={() => { updateTable(picked.id, { shape: 'round' }); setPicked({ ...picked, shape: 'round' }); }}>Round</Button>
            <Button size="sm" variant="outline" onClick={() => { updateTable(picked.id, { shape: 'rect', pos_w: 2 }); setPicked({ ...picked, shape: 'rect', pos_w: 2 }); }}>2-wide</Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Done</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
