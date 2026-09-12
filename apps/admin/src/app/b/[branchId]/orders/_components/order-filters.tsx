'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bookmark, Search, Trash2, X } from 'lucide-react';
import { usePrompt } from '@favornoms/ui';

interface Props {
  defaultQ: string;
  defaultStatus: string;
  defaultChannel: string;
  defaultWhen: string;
  defaultRange: string;
  defaultFrom: string;
  defaultTo: string;
}

interface SavedView {
  id: string;
  name: string;
  q: string;
  status: string;
  channel: string;
  /** Older saved views predate this filter and have no `when`; they read as 'all'. */
  when?: string;
  /** Same again for the date range: an older view means "all time", not "today". */
  range?: string;
  from?: string;
  to?: string;
}

const SAVED_VIEW_KEY = 'admin-orders-saved-views';
const STATUSES = ['all', 'pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled', 'refunded'];
const CHANNELS = ['all', 'dine_in', 'pickup', 'delivery', 'qr_ordering'];
// Pre-orders are the one thing this page could not show: everything was sorted newest-first
// by created_at, so a booking for next week sank out of sight the day after it was taken.
const WHENS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All orders' },
  { value: 'scheduled', label: 'Scheduled — upcoming' },
  { value: 'held', label: 'Scheduled — not yet in kitchen' },
];
// Resolved against the branch's own calendar on the server, so "Today" means the day the
// merchant is standing in rather than the day the host machine happens to be having. Under
// a scheduled view the same window runs forwards, because that list is ordered by when the
// food is due rather than when the order was taken — so the labels say so.
const rangesFor = (when: string): Array<{ value: string; label: string }> =>
  when === 'all'
    ? [
        { value: 'all', label: 'All time' },
        { value: 'today', label: 'Today' },
        { value: '7d', label: 'Last 7 days' },
        { value: '30d', label: 'Last 30 days' },
        { value: 'custom', label: 'Custom…' },
      ]
    : [
        { value: 'all', label: 'Any date' },
        { value: 'today', label: 'Due today' },
        { value: '7d', label: 'Due within 7 days' },
        { value: '30d', label: 'Due within 30 days' },
        { value: 'custom', label: 'Custom…' },
      ];

export function OrderFilters({
  defaultQ,
  defaultStatus,
  defaultChannel,
  defaultWhen,
  defaultRange,
  defaultFrom,
  defaultTo,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const prompt = usePrompt();
  const [q, setQ] = React.useState(defaultQ);
  const [savedViews, setSavedViews] = React.useState<SavedView[]>([]);

  React.useEffect(() => {
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(SAVED_VIEW_KEY) : null;
      if (raw) setSavedViews(JSON.parse(raw));
    } catch {
      // ignore
    }
  }, []);

  const persistViews = (next: SavedView[]) => {
    setSavedViews(next);
    try {
      window.localStorage.setItem(SAVED_VIEW_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const saveCurrentView = async () => {
    const name = await prompt({
      title: 'Name this view',
      body: 'The filters set right now are kept on this device, ready to reapply in one click.',
      placeholder: "Today's deliveries",
      confirmLabel: 'Save view',
      required: true,
    });
    if (!name) return;
    const view: SavedView = {
      id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      q,
      status: defaultStatus,
      channel: defaultChannel,
      when: defaultWhen,
      range: defaultRange,
      from: defaultFrom,
      to: defaultTo,
    };
    persistViews([view, ...savedViews]);
  };

  // This builds a FRESH URLSearchParams, so any key it forgets is silently dropped —
  // applying a saved view would look like the filter simply not sticking.
  const applyView = (v: SavedView) => {
    setQ(v.q);
    const sp = new URLSearchParams();
    if (v.q) sp.set('q', v.q);
    if (v.status && v.status !== 'all') sp.set('status', v.status);
    if (v.channel && v.channel !== 'all') sp.set('channel', v.channel);
    if (v.when && v.when !== 'all') sp.set('when', v.when);
    if (v.range && v.range !== 'all') sp.set('range', v.range);
    if (v.range === 'custom') {
      if (v.from) sp.set('from', v.from);
      if (v.to) sp.set('to', v.to);
    }
    router.replace(`${pathname}?${sp.toString()}`);
  };

  const removeView = (id: string) => {
    persistViews(savedViews.filter((v) => v.id !== id));
  };

  const pushParams = (next: {
    q?: string;
    status?: string;
    channel?: string;
    when?: string;
    range?: string;
    from?: string;
    to?: string;
  }) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v && v !== 'all') sp.set(k, v); else sp.delete(k);
    }
    router.replace(`${pathname}?${sp.toString()}`);
  };

  // Debounced search
  React.useEffect(() => {
    if (q === defaultQ) return;
    const t = setTimeout(() => pushParams({ q }), 300);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="space-y-2">
      {savedViews.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground">Saved:</span>
          {savedViews.map((v) => (
            <span key={v.id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs">
              <button
                type="button"
                onClick={() => applyView(v)}
                className="focus-ring font-semibold hover:underline"
              >
                {v.name}
              </button>
              <button
                type="button"
                onClick={() => removeView(v.id)}
                className="focus-ring text-muted-foreground hover:text-destructive"
                aria-label={`Remove saved view ${v.name}`}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[14rem] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search order # / customer / phone…"
          className="focus-ring w-full rounded-xl border border-border bg-background px-9 py-2 text-sm"
        />
        {q && (
          <button
            type="button"
            onClick={() => { setQ(''); pushParams({ q: '' }); }}
            className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 hover:bg-muted"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <select
        value={defaultStatus}
        onChange={(e) => pushParams({ status: e.target.value })}
        className="focus-ring rounded-xl border border-border bg-background px-3 py-2 text-sm"
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>{s === 'all' ? 'All statuses' : s.replace('_', ' ')}</option>
        ))}
      </select>
      <select
        value={defaultChannel}
        onChange={(e) => pushParams({ channel: e.target.value })}
        className="focus-ring rounded-xl border border-border bg-background px-3 py-2 text-sm"
      >
        {CHANNELS.map((c) => (
          <option key={c} value={c}>{c === 'all' ? 'All channels' : c.replace('_', ' ')}</option>
        ))}
      </select>
      <select
        value={defaultWhen}
        onChange={(e) => pushParams({ when: e.target.value })}
        className="focus-ring rounded-xl border border-border bg-background px-3 py-2 text-sm"
        aria-label="Scheduled orders"
      >
        {WHENS.map((w) => (
          <option key={w.value} value={w.value}>{w.label}</option>
        ))}
      </select>
      <select
        value={defaultRange}
        onChange={(e) =>
          pushParams(
            // Clearing from/to when leaving Custom is load-bearing: pushParams deletes on an
            // empty string, so stale dates cannot outlive the mode that owned them.
            e.target.value === 'custom'
              ? { range: 'custom' }
              : { range: e.target.value, from: '', to: '' },
          )
        }
        className="focus-ring rounded-xl border border-border bg-background px-3 py-2 text-sm"
        aria-label="Date range"
      >
        {rangesFor(defaultWhen).map((r) => (
          <option key={r.value} value={r.value}>{r.label}</option>
        ))}
      </select>
      {defaultRange === 'custom' && (
        <span className="flex items-center gap-1.5">
          <input
            type="date"
            value={defaultFrom}
            max={defaultTo || undefined}
            onChange={(e) => pushParams({ from: e.target.value })}
            className="focus-ring rounded-xl border border-border bg-background px-2 py-2 text-sm"
            aria-label="From date"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            value={defaultTo}
            min={defaultFrom || undefined}
            onChange={(e) => pushParams({ to: e.target.value })}
            className="focus-ring rounded-xl border border-border bg-background px-2 py-2 text-sm"
            aria-label="To date"
          />
        </span>
      )}
      <button
        type="button"
        onClick={saveCurrentView}
        className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-muted"
      >
        <Bookmark className="h-3.5 w-3.5" /> Save view
      </button>
      </div>
    </div>
  );
}
