'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

interface HappyHour {
  id: string;
  name: string;
  applies_to_item_ids: string[];
  applies_to_category_ids: string[];
  discount_type: 'percent' | 'fixed';
  discount_value: number | string;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  is_active: boolean;
}

interface MenuItem { id: string; name: string }
interface Category { id: string; name: string }

interface Props {
  branchId: string;
  initialHours: HappyHour[];
  menuItems: MenuItem[];
  categories: Category[];
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function HappyHoursManager({ branchId, initialHours, menuItems, categories }: Props) {
  const router = useRouter();
  const [hours, setHours] = React.useState(initialHours);
  const [error, setError] = React.useState<string | null>(null);

  const refetch = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('happy_hours')
      .select('id, name, applies_to_item_ids, applies_to_category_ids, discount_type, discount_value, days_of_week, start_time, end_time, is_active')
      .eq('branch_id', branchId)
      .order('start_time');
    setHours((data ?? []) as HappyHour[]);
    router.refresh();
  };

  const createNew = async () => {
    const name = window.prompt('Promotion name (e.g. "Happy hour", "Lunch special")');
    if (!name) return;
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('happy_hours').insert({
      branch_id: branchId,
      name,
      discount_type: 'percent',
      discount_value: 20,
      days_of_week: [1, 2, 3, 4, 5],
      start_time: '15:00',
      end_time: '18:00',
      is_active: true,
    });
    if (insErr) {
      setError(insErr.message);
      return;
    }
    refetch();
  };

  const update = async (id: string, patch: Partial<HappyHour>) => {
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase.from('happy_hours').update(patch).eq('id', id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setHours((curr) => curr.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this happy hour?')) return;
    const supabase = getBrowserClient();
    await supabase.from('happy_hours').delete().eq('id', id);
    refetch();
  };

  const toggleDay = (h: HappyHour, day: number) => {
    const next = h.days_of_week.includes(day)
      ? h.days_of_week.filter((d) => d !== day)
      : [...h.days_of_week, day].sort();
    update(h.id, { days_of_week: next });
  };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">Happy hours</h1>
          <p className="mt-1 text-muted-foreground">
            Time-windowed discounts on items or whole categories.
          </p>
        </div>
        <Button variant="gradient" onClick={createNew} leftIcon={<Plus className="h-4 w-4" />}>
          New happy hour
        </Button>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {hours.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">No happy hours yet.</Card>
      ) : (
        <ul className="space-y-3 px-2 lg:px-0">
          {hours.map((h) => {
            const appliedItems = menuItems.filter((m) => h.applies_to_item_ids.includes(m.id));
            const appliedCats = categories.filter((c) => h.applies_to_category_ids.includes(c.id));
            const appliesToAll = h.applies_to_item_ids.length === 0 && h.applies_to_category_ids.length === 0;
            return (
              <li key={h.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <input
                          value={h.name}
                          onChange={(e) => update(h.id, { name: e.target.value })}
                          className="focus-ring rounded-lg border border-border bg-background px-2 py-1 font-display text-lg font-bold"
                        />
                        <Badge variant={h.is_active ? 'success' : 'muted'}>{h.is_active ? 'Active' : 'Paused'}</Badge>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                        <label className="flex items-center gap-1">
                          <select
                            value={h.discount_type}
                            onChange={(e) => update(h.id, { discount_type: e.target.value as 'percent' | 'fixed' })}
                            className="focus-ring rounded-lg border border-border bg-background px-2 py-1"
                          >
                            <option value="percent">% off</option>
                            <option value="fixed">$ off</option>
                          </select>
                          <input
                            type="number"
                            step="0.01"
                            value={String(h.discount_value)}
                            onChange={(e) => update(h.id, { discount_value: e.target.value as never })}
                            className="focus-ring w-20 rounded-lg border border-border bg-background px-2 py-1 tabular-nums"
                          />
                        </label>
                        <label className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">From</span>
                          <input
                            type="time"
                            value={h.start_time.slice(0, 5)}
                            onChange={(e) => update(h.id, { start_time: e.target.value })}
                            className="focus-ring rounded-lg border border-border bg-background px-2 py-1"
                          />
                        </label>
                        <label className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">to</span>
                          <input
                            type="time"
                            value={h.end_time.slice(0, 5)}
                            onChange={(e) => update(h.id, { end_time: e.target.value })}
                            className="focus-ring rounded-lg border border-border bg-background px-2 py-1"
                          />
                        </label>
                        <label className="ml-auto flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={h.is_active}
                            onChange={(e) => update(h.id, { is_active: e.target.checked })}
                          /> Active
                        </label>
                      </div>

                      <div className="mt-3 flex items-center gap-1">
                        {DAY_LABELS.map((lbl, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => toggleDay(h, i)}
                            className={`focus-ring h-7 w-9 rounded text-xs font-semibold ${
                              h.days_of_week.includes(i)
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {lbl}
                          </button>
                        ))}
                      </div>

                      <div className="mt-3 text-xs text-muted-foreground">
                        Applies to:{' '}
                        {appliesToAll ? (
                          <strong>all menu items</strong>
                        ) : (
                          <>
                            {appliedItems.length > 0 && <span>{appliedItems.length} item{appliedItems.length === 1 ? '' : 's'}</span>}
                            {appliedCats.length > 0 && <span>{appliedItems.length > 0 ? ', ' : ''}{appliedCats.length} categor{appliedCats.length === 1 ? 'y' : 'ies'}</span>}
                          </>
                        )}
                        <ScopePicker h={h} menuItems={menuItems} categories={categories} onChange={update} />
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(h.id)}
                      leftIcon={<Trash2 className="h-4 w-4" />}
                    >
                      Delete
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ScopePicker({
  h,
  menuItems,
  categories,
  onChange,
}: {
  h: HappyHour;
  menuItems: MenuItem[];
  categories: Category[];
  onChange: (id: string, patch: Partial<HappyHour>) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="focus-ring ml-2 text-primary underline"
      >
        {open ? 'Hide' : 'Edit'}
      </button>
      {open && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <p className="mb-1 font-semibold text-foreground">Items</p>
            <div className="max-h-32 overflow-y-auto rounded-lg border border-border bg-card p-1">
              {menuItems.map((m) => (
                <label key={m.id} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={h.applies_to_item_ids.includes(m.id)}
                    onChange={(e) =>
                      onChange(h.id, {
                        applies_to_item_ids: e.target.checked
                          ? [...h.applies_to_item_ids, m.id]
                          : h.applies_to_item_ids.filter((x) => x !== m.id),
                      })
                    }
                  />
                  {m.name}
                </label>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1 font-semibold text-foreground">Categories</p>
            <div className="rounded-lg border border-border bg-card p-1">
              {categories.map((c) => (
                <label key={c.id} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={h.applies_to_category_ids.includes(c.id)}
                    onChange={(e) =>
                      onChange(h.id, {
                        applies_to_category_ids: e.target.checked
                          ? [...h.applies_to_category_ids, c.id]
                          : h.applies_to_category_ids.filter((x) => x !== c.id),
                      })
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
