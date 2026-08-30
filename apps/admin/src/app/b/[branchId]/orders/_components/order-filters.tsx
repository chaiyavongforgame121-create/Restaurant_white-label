'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bookmark, Search, Trash2, X } from 'lucide-react';

interface Props {
  defaultQ: string;
  defaultStatus: string;
  defaultChannel: string;
  defaultWhen: string;
}

interface SavedView {
  id: string;
  name: string;
  q: string;
  status: string;
  channel: string;
  /** Older saved views predate this filter and have no `when`; they read as 'all'. */
  when?: string;
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

export function OrderFilters({ defaultQ, defaultStatus, defaultChannel, defaultWhen }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
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

  const saveCurrentView = () => {
    const name = window.prompt('Name this view (e.g. "Today\'s deliveries"):');
    if (!name) return;
    const view: SavedView = {
      id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      q,
      status: defaultStatus,
      channel: defaultChannel,
      when: defaultWhen,
    };
    persistViews([view, ...savedViews]);
  };

  const applyView = (v: SavedView) => {
    setQ(v.q);
    const sp = new URLSearchParams();
    if (v.q) sp.set('q', v.q);
    if (v.status && v.status !== 'all') sp.set('status', v.status);
    if (v.channel && v.channel !== 'all') sp.set('channel', v.channel);
    if (v.when && v.when !== 'all') sp.set('when', v.when);
    router.replace(`${pathname}?${sp.toString()}`);
  };

  const removeView = (id: string) => {
    persistViews(savedViews.filter((v) => v.id !== id));
  };

  const pushParams = (next: { q?: string; status?: string; channel?: string; when?: string }) => {
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
