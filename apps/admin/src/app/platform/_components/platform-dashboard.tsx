'use client';

// Tenant health ledger — an index that answers one question, "which tenant needs
// me?", and a drawer that carries everything else.
//
// The old table answered "how many branches does this restaurant have", which is
// never the question — a lapsed tenant read `1 / 1`, the healthiest-looking row
// on the page, while its storefront served the suspended screen to every
// customer. Rows now sort by severity so the tenants that need an operator float
// to the top without anyone clicking a filter.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Search } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { setRestaurantPackage } from '@favornoms/database/queries';
import { PLAN_BASE, formatCurrency, packageMonthlyTotal, type BillingProduct } from '@favornoms/shared';
import { Button, Card, EmptyState } from '@favornoms/ui';
import { PlatformNav } from './platform-nav';
import { ConfirmDialog, reactivateCopy, suspendCopy, type ConfirmCopy } from './confirm-dialog';
import { TenantDrawer } from './tenant-drawer';
import { TenantIndexHeader, TenantIndexRow } from './tenant-row';
import {
  conversionSelection,
  renewalSelection,
  resolvePrimaryAction,
  tenantHealth,
  type BranchLite,
  type PrimaryAction,
  type TenantHealth,
  type TenantRow,
} from './tenant-health';

const INPUT_CLS =
  'h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none transition-colors focus-visible:border-primary';

type FilterKey = 'all' | 'attention' | 'offline' | 'live';

// Named after the two switches this page can prove from its own query. Whether a
// diner can order right now also depends on hours, closures and the kitchen
// pause, which only the drawer probes — so a broader label here would lie the
// moment an owner sets business hours.
const FILTERS: { value: FilterKey; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'offline', label: 'Billing or access off' },
  { value: 'live', label: 'Live' },
];

const matchesFilter = (h: TenantHealth, f: FilterKey) =>
  f === 'all' ? true : f === 'attention' ? h.severity > 0 : f === 'offline' ? h.offline : h.severity === 0;

export function PlatformDashboard({
  summary,
  rows,
  branches,
  nowMs,
  catalog,
  siteBase,
  loadError,
}: {
  summary: Record<string, number>;
  rows: TenantRow[];
  branches: BranchLite[];
  /** The server clock, so "3d left" renders identically on both sides. */
  nowMs: number;
  /** The live price list. Every quote on this page is priced from it at the
   *  point of use, so no button can name a number the RPC will not charge. */
  catalog: BillingProduct[];
  siteBase: string;
  /** Set when a child read failed, so a partial page says so instead of
   *  rendering "No branches" for every tenant on the platform. */
  loadError: string | null;
}) {
  const router = useRouter();
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<FilterKey>('all');
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ copy: ConfirmCopy; run: () => Promise<void> } | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [confirmError, setConfirmError] = React.useState<string | null>(null);
  const [actingId, setActingId] = React.useState<string | null>(null);
  const [actedId, setActedId] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<{ id: string; message: string } | null>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);

  const byRestaurant = React.useMemo(() => {
    const m = new Map<string, BranchLite[]>();
    for (const b of branches) {
      const list = m.get(b.restaurant_id) ?? [];
      list.push(b);
      m.set(b.restaurant_id, list);
    }
    return m;
  }, [branches]);

  // Price the exact package each button would buy, per tenant. A single
  // platform-wide "Base = $199" was wrong for every tenant that owns an add-on
  // or runs more than one branch, because conversionSelection carries both
  // forward — the button quoted $199 and the RPC charged more.
  const priceOf = React.useCallback(
    (selection: ReturnType<typeof renewalSelection>) =>
      catalog.length === 0 ? null : packageMonthlyTotal(selection, catalog),
    [catalog],
  );

  const scored = React.useMemo(
    () =>
      rows
        .map((row) => {
          const list = byRestaurant.get(row.id) ?? [];
          const health = tenantHealth(row, list, nowMs);
          const convertPrice =
            catalog.length === 0
              ? null
              : packageMonthlyTotal(conversionSelection(row, list.length), catalog);
          return {
            row,
            branches: list,
            health,
            action: resolvePrimaryAction(row, health, convertPrice),
          };
        })
        .sort((a, b) => b.health.severity - a.health.severity || a.row.name.localeCompare(b.row.name)),
    [rows, byRestaurant, nowMs, catalog],
  );

  const counts = React.useMemo(() => {
    const c: Record<FilterKey, number> = { all: scored.length, attention: 0, offline: 0, live: 0 };
    for (const s of scored) {
      if (s.health.severity > 0) c.attention += 1;
      if (s.health.offline) c.offline += 1;
      if (s.health.severity === 0) c.live += 1;
    }
    return c;
  }, [scored]);

  const entitledCount = scored.filter((s) => s.health.entitled).length;

  const needle = search.trim().toLowerCase();
  const visible = scored.filter(
    (s) =>
      matchesFilter(s.health, filter) &&
      (!needle ||
        s.row.name.toLowerCase().includes(needle) ||
        s.row.slug.toLowerCase().includes(needle)),
  );

  const opened = openId ? scored.find((s) => s.row.id === openId) : undefined;

  const openDrawer = (id: string, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    setRowError(null);
    setActedId(null);
    setOpenId(id);
  };

  // ConfirmDialog is not a Sheet, so it never enters Sheet's openSheetStack and
  // one Escape would otherwise close both. The drawer refuses to close while a
  // confirmation is up.
  const closeDrawer = () => {
    if (confirm) return;
    setOpenId(null);
    triggerRef.current?.focus();
  };

  const closeConfirm = () => {
    setConfirm(null);
    setConfirmError(null);
  };

  // try/finally is load-bearing: without it a throw inside run() left `busy`
  // latched true forever, which disables both buttons AND the close button — the
  // dialog became a modal the operator could not dismiss.
  const runConfirm = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    setConfirmError(null);
    try {
      await confirm.run();
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : 'Something went wrong. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  };

  // set_restaurant_suspended RETURNS void, so a denial is invisible unless the
  // error is read back and shown.
  const askSuspend = (row: TenantRow) => {
    const entry = scored.find((s) => s.row.id === row.id);
    if (!entry) return;
    setConfirmError(null);
    setConfirm({
      copy: suspendCopy(row, entry.branches, entry.health.entitled),
      run: async () => {
        const { error } = await getBrowserClient().rpc('set_restaurant_suspended', {
          p_restaurant_id: row.id,
          p_suspended: entry.branches.some((b) => b.is_active),
        });
        if (error) {
          setConfirmError(error.message);
          return;
        }
        closeConfirm();
        router.refresh();
      },
    });
  };

  // Re-send a package with a fresh period. billing_set_package recomputes the
  // dates from now(), which is the one thing a raw status flip cannot do — the
  // cron would re-expire that within 10 minutes.
  const applyPackage = async (row: TenantRow, selection: ReturnType<typeof renewalSelection>) => {
    setActingId(row.id);
    setActedId(null);
    setRowError(null);
    const res = await setRestaurantPackage(getBrowserClient(), row.id, selection, 'active', null);
    setActingId(null);
    if (res.ok !== true) {
      const message = res.error ?? 'Could not reactivate the subscription.';
      setRowError({ id: row.id, message });
      setConfirmError(message);
      return false;
    }
    setActedId(row.id);
    router.refresh();
    return true;
  };

  const runAction = (row: TenantRow, action: PrimaryAction) => {
    const entry = scored.find((s) => s.row.id === row.id);
    if (!entry) return;

    if (action.kind === 'restore') {
      askSuspend(row);
      return;
    }

    // A money write from a dashboard is gated the same way a suspend is: the
    // dialog names the plan, the price, the seat count and the new period end.
    const selection =
      action.kind === 'extend'
        ? renewalSelection(row, entry.branches.length)
        : conversionSelection(row, entry.branches.length);
    // Priced from the selection actually being sent, for both kinds.
    // ent.monthlyTotal is what the tenant pays TODAY and misses any seat the
    // renewal has to add to cover branches opened since.
    const monthly = priceOf(selection);
    setConfirmError(null);
    setConfirm({
      copy: reactivateCopy(
        row,
        entry.branches,
        action.kind,
        action.kind === 'extend' ? row.ent.planCode : PLAN_BASE,
        monthly,
        selection.branchSeats,
        nowMs,
      ),
      run: async () => {
        if (await applyPackage(row, selection)) closeConfirm();
      },
    });
  };

  const clearFilters = () => {
    setSearch('');
    setFilter('all');
  };

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-2">
        <h1 className="font-display text-3xl font-bold">Platform admin</h1>
        <p className="mt-1 text-muted-foreground">Cross-tenant operations dashboard.</p>
      </header>
      <PlatformNav />

      {/* A failed child read is indistinguishable from an empty result once it
          reaches the client, so every tenant would silently render "No branches
          · nothing to serve" — a healthy-looking lie. Say it out loud instead. */}
      {loadError && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-xl bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {loadError} Branch counts and storefront verdicts on this page are incomplete — reload
            before acting on them.
          </span>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Restaurants" value={String(scored.length)} />
        {/* Not `active_branches`: that counts is_active and ignores billing, so a
            dead tenant inflates the headline. This one counts entitlement, which
            is billing only — hence the name. */}
        <Stat label="Billing OK" value={`${entitledCount}/${scored.length}`} accent />
        <Stat
          label="Needs attention"
          value={String(counts.attention)}
          warn={counts.attention > 0}
          onSelect={counts.attention > 0 ? () => setFilter('attention') : undefined}
        />
        <Stat label="Orders today" value={String(summary.orders_today ?? 0)} />
        <Stat label="Revenue today" value={formatCurrency(Number(summary.revenue_today ?? 0))} />
        <Stat label="Drivers online" value={String(summary.drivers_online ?? 0)} />
      </div>

      <div className="mb-4 space-y-3">
        <label className="relative block">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search restaurants"
            aria-label="Search restaurants"
            className={`${INPUT_CLS} pl-9`}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={`focus-ring rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === f.value ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {f.label} ({counts[f.value]})
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Search className="h-7 w-7" aria-hidden />}
          title="No restaurants match"
          description="Try a different name or slug, or clear the filter."
          action={
            <Button variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <TenantIndexHeader />
          <ul>
            {visible.map((s) => (
              <TenantIndexRow
                key={s.row.id}
                row={s.row}
                health={s.health}
                action={s.action}
                actionBusy={actingId === s.row.id}
                actionDone={actedId === s.row.id}
                error={rowError?.id === s.row.id ? rowError.message : null}
                onOpen={openDrawer}
                onAction={runAction}
              />
            ))}
          </ul>
        </Card>
      )}

      {opened && (
        <TenantDrawer
          open
          row={opened.row}
          branches={opened.branches}
          health={opened.health}
          action={opened.action}
          actionBusy={actingId === opened.row.id}
          actionDone={actedId === opened.row.id}
          error={rowError?.id === opened.row.id ? rowError.message : null}
          nowMs={nowMs}
          siteBase={siteBase}
          onClose={closeDrawer}
          onAction={runAction}
          onSuspend={askSuspend}
        />
      )}

      {confirm && (
        <ConfirmDialog
          copy={confirm.copy}
          busy={busy}
          error={confirmError}
          onClose={closeConfirm}
          onConfirm={runConfirm}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  warn,
  onSelect,
}: {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
  onSelect?: () => void;
}) {
  const card = (
    <Card
      className={`h-full p-4 ${accent ? 'border-primary shadow-warm' : ''} ${onSelect ? 'transition hover:border-primary' : ''}`}
    >
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      {/* tabular-nums so the six figures line up instead of jittering, and a
          smaller phone size so "Billing OK 12/14" stops wrapping mid-fraction. */}
      <p
        className={`mt-1 font-display text-xl font-bold tabular-nums sm:text-2xl ${warn ? 'text-danger' : accent ? 'text-primary' : ''}`}
      >
        {value}
      </p>
    </Card>
  );
  if (!onSelect) return card;
  return (
    <button type="button" onClick={onSelect} className="focus-ring block h-full w-full rounded-2xl text-left">
      {card}
    </button>
  );
}
