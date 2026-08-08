'use client';

// The full truth about one tenant, and every action on it.
//
// This is the only place that claims "what a diner sees right now": the verdict
// needs hours, closures and the kitchen pause as well as the two platform
// switches, and the hours half costs an is_branch_open() probe. The index cannot
// afford that per row, so it names its column after the two switches it can
// prove and the drawer answers the rest on demand.

import * as React from 'react';
import Link from 'next/link';
import {
  Ban,
  Check,
  Clock,
  CreditCard,
  ExternalLink,
  PauseCircle,
  Play,
  RefreshCw,
  Store,
} from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { featureLabel, hasFeature, ownsFeature, FEATURE_KEYS } from '@favornoms/shared';
import { Badge, Button, Sheet, Skeleton, buttonVariants, cn } from '@favornoms/ui';
import {
  branchVerdict,
  fmtDate,
  money,
  needsOpenProbe,
  storefrontUrl,
  type BranchLite,
  type BranchVerdict,
  type ChipIcon,
  type OpenNow,
  type PrimaryAction,
  type TenantHealth,
  type TenantRow,
} from './tenant-health';

const VERDICT_ICON: Record<ChipIcon, React.ComponentType<{ className?: string }>> = {
  billing: CreditCard,
  clock: Clock,
  ban: Ban,
  pause: PauseCircle,
  check: Check,
};

export function TenantDrawer({
  open,
  row,
  branches,
  health,
  action,
  actionBusy,
  actionDone,
  error,
  nowMs,
  siteBase,
  onClose,
  onAction,
  onSuspend,
}: {
  open: boolean;
  row: TenantRow;
  branches: BranchLite[];
  health: TenantHealth;
  action: PrimaryAction | null;
  actionBusy: boolean;
  actionDone: boolean;
  error: string | null;
  nowMs: number;
  siteBase: string;
  onClose: () => void;
  onAction: (row: TenantRow, action: PrimaryAction) => void;
  onSuspend: (row: TenantRow) => void;
}) {
  const openNow = useOpenProbe(open ? row.id : null, branches, nowMs);
  const actionRef = React.useRef<HTMLButtonElement>(null);
  const firstLinkRef = React.useRef<HTMLAnchorElement>(null);
  const anyActive = branches.some((b) => b.is_active);

  // Land on the recommended repair, so the common fix is Tab → Enter → Enter.
  // A healthy tenant has no repair, so focus falls to the first Back office link.
  React.useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => (actionRef.current ?? firstLinkRef.current)?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [open, row.id]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      side="right"
      title={row.name}
      ariaLabel={`${row.name} tenant details`}
    >
      <div className="space-y-5 px-5 pb-8">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{row.slug}</span> · {row.loyaltyScope} loyalty · added{' '}
            {fmtDate(row.createdAt)}
          </p>
          {row.franchise && (
            <Badge variant="muted" className="px-2 py-0.5 text-[10px]">
              Franchise
            </Badge>
          )}
        </div>

        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground">
            What a diner sees right now
          </h3>
          {branches.length === 0 ? (
            <p className="rounded-xl border border-border/60 p-3 text-sm text-muted-foreground">
              This restaurant has no branches, so there is nothing for a diner to find.
            </p>
          ) : (
            branches.map((b, i) => (
              <BranchBlock
                key={b.id}
                branch={b}
                verdict={branchVerdict(b, nowMs, openNow[b.id] ?? null)}
                storefront={storefrontUrl(siteBase, row.slug, b)}
                linkRef={i === 0 ? firstLinkRef : undefined}
              />
            ))
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground">The two off-switches</h3>

          <SwitchRow
            icon={<Ban className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
            label="Platform access"
            state={accessState(branches)}
            consequence="Off = the storefront URL returns 404."
          >
            <Button
              ref={action?.kind === 'restore' ? actionRef : undefined}
              size="sm"
              variant={anyActive ? 'ghost' : 'primary'}
              disabled={branches.length === 0}
              title={branches.length === 0 ? 'No branches to suspend' : undefined}
              onClick={() => onSuspend(row)}
              leftIcon={anyActive ? <Ban className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            >
              {anyActive ? 'Suspend' : 'Restore'}
            </Button>
          </SwitchRow>

          <SwitchRow
            icon={<CreditCard className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
            label="Subscription"
            state={billingState(row, health)}
            consequence="Off = the storefront shows the suspended screen."
          >
            <div className="flex flex-col items-end gap-1.5">
              {action && action.kind !== 'restore' && (
                <Button
                  ref={actionRef}
                  size="sm"
                  variant={action.kind === 'extend' ? 'soft' : 'primary'}
                  loading={actionBusy}
                  onClick={() => onAction(row, action)}
                  leftIcon={
                    action.kind === 'extend' ? (
                      <RefreshCw className="h-3.5 w-3.5" />
                    ) : (
                      <CreditCard className="h-3.5 w-3.5" />
                    )
                  }
                >
                  {action.label}
                </Button>
              )}
              {/* buttonVariants on the anchor itself: a <button> nested inside an
                  <a> is invalid HTML and gives screen readers two overlapping
                  controls for one destination. */}
              <Link
                href={`/platform/subscriptions?q=${encodeURIComponent(row.slug)}`}
                prefetch={false}
                className={buttonVariants({ size: 'sm', variant: 'ghost' })}
              >
                Manage subscription
              </Link>
              {actionDone && (
                <span role="status" className="flex items-center gap-1 text-xs text-success">
                  <Check className="h-3.5 w-3.5" aria-hidden /> Reactivated
                </span>
              )}
              {error && (
                <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">
                  {error}
                </p>
              )}
            </div>
          </SwitchRow>
        </section>

        <Package row={row} health={health} />

        {health.reason && (
          <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">{health.reason}</p>
        )}
      </div>
    </Sheet>
  );
}

function BranchBlock({
  branch,
  verdict,
  storefront,
  linkRef,
}: {
  branch: BranchLite;
  verdict: BranchVerdict | null;
  storefront: string;
  linkRef?: React.Ref<HTMLAnchorElement>;
}) {
  const Icon = verdict ? VERDICT_ICON[verdict.icon] : null;
  return (
    <div
      className={cn(
        'space-y-2 rounded-xl border p-3',
        verdict?.variant === 'danger'
          ? 'border-danger/40 bg-danger/5'
          : verdict?.variant === 'warning'
            ? 'border-warning/40 bg-warning/10'
            : 'border-border/60',
      )}
    >
      {/* Never truncated and never sliced — a long branch name wraps instead. */}
      <p className="break-words font-display text-base font-semibold">{branch.name}</p>
      {verdict && Icon ? (
        <Badge variant={verdict.variant} className="px-2 py-0.5 text-[10px]" title={verdict.hint}>
          <Icon className="h-3 w-3" aria-hidden />
          {verdict.label}
        </Badge>
      ) : (
        <Skeleton className="h-5 w-24" />
      )}
      <p className="text-xs text-muted-foreground">{verdict?.why ?? 'Checking business hours…'}</p>
      <div className="flex flex-wrap gap-2">
        <Link
          ref={linkRef}
          href={`/b/${branch.id}/dashboard`}
          prefetch={false}
          aria-label={`Open ${branch.name} back office`}
          className={buttonVariants({ size: 'sm', variant: 'soft' })}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          Back office
        </Link>
        <a
          href={storefront}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${branch.name} storefront in a new tab`}
          className={buttonVariants({ size: 'sm', variant: 'ghost' })}
        >
          <Store className="h-3.5 w-3.5" aria-hidden />
          Storefront
        </a>
      </div>
    </div>
  );
}

function SwitchRow({
  icon,
  label,
  state,
  consequence,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  state: string;
  consequence: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-border/60 p-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-semibold">
          {icon}
          {label}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{state}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{consequence}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Package({ row, health }: { row: TenantRow; health: TenantHealth }) {
  const { ent } = row;
  const overQuota = ent.branchesUsed > ent.branchSeats;
  // billing_compute never clears features on expiry, so a dead tenant still
  // carries a full grant blob. Split it rather than painting it as provisioned.
  const live = FEATURE_KEYS.filter((k) => hasFeature(ent, k));
  const dormant = FEATURE_KEYS.filter((k) => ownsFeature(ent, k) && !hasFeature(ent, k));

  return (
    <section className="space-y-3">
      <h3 className="text-xs uppercase tracking-wider text-muted-foreground">Package</h3>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Plan</dt>
          <dd className="font-semibold">{ent.planCode}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Monthly</dt>
          <dd className="font-semibold tabular-nums">{money(ent.monthlyTotal)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{health.entitled ? 'Renews' : 'Lapsed'}</dt>
          <dd className="font-semibold tabular-nums">
            {fmtDate(ent.entitledThrough ?? ent.trialEndsAt)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Seats</dt>
          <dd className={cn('font-semibold tabular-nums', overQuota && 'text-danger')}>
            {ent.branchesUsed}/{ent.branchSeats}
            {overQuota && (
              <span className="ml-1 text-xs font-normal">over quota — unenforced, billed short</span>
            )}
          </dd>
        </div>
      </dl>

      {live.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {live.map((k) => (
            <Badge key={k} variant="accent" className="px-2 py-0.5 text-[10px]">
              {featureLabel(k)}
            </Badge>
          ))}
        </div>
      )}

      {health.entitled && !hasFeature(ent, 'delivery') && (
        <p className="rounded-xl bg-warning/10 px-3 py-2 text-xs text-warning">
          Base does not include delivery — the order-type gate hides it and delivery orders are rejected.
        </p>
      )}

      {dormant.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Granted, inactive while unpaid</p>
          <div className="flex flex-wrap gap-1.5">
            {dormant.map((k) => (
              <Badge key={k} variant="muted" className="px-2 py-0.5 text-[10px] line-through opacity-60">
                {featureLabel(k)}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function accessState(branches: BranchLite[]): string {
  const total = branches.length;
  if (total === 0) return 'No branches';
  const active = branches.filter((b) => b.is_active).length;
  if (active === total) return `All ${total} branch${total === 1 ? '' : 'es'} active`;
  if (active === 0) return total === 1 ? 'Suspended' : `All ${total} branches suspended`;
  return `${total - active} of ${total} suspended`;
}

function billingState(row: TenantRow, health: TenantHealth): string {
  if (!health.entitled) {
    const lapsed = row.ent.entitledThrough ?? row.ent.trialEndsAt;
    return lapsed ? `Expired ${fmtDate(lapsed)} · ${row.ent.planCode}` : 'No subscription';
  }
  return `${health.billing.label} · ${row.ent.planCode}`;
}

/**
 * is_branch_open() encodes same-day, overnight-evening and after-midnight
 * windows in the branch's own timezone, so the answer comes from the database
 * rather than a TypeScript re-implementation. Only branches whose verdict is
 * genuinely undecided are asked — with no hours configured, none are.
 */
function useOpenProbe(tenantId: string | null, branches: BranchLite[], nowMs: number) {
  const [openNow, setOpenNow] = React.useState<Record<string, OpenNow>>({});

  // Keyed on the qualifying set, not just the tenant: Restore/Extend inside the
  // drawer flips is_active / entitled_through and makes previously-skipped
  // branches probe-worthy without remounting, so a tenant-only dep left the
  // operator staring at "Checking business hours…" on the branches they had
  // just repaired — the one panel that tells them it worked.
  const probeKey = React.useMemo(
    () =>
      branches
        .filter((b) => needsOpenProbe(b, nowMs))
        .map((b) => b.id)
        .sort()
        .join('|'),
    [branches, nowMs],
  );

  React.useEffect(() => {
    if (!tenantId) return;
    const targets = branches.filter((b) => needsOpenProbe(b, nowMs));
    if (targets.length === 0) return;
    let cancelled = false;
    const client = getBrowserClient();
    // allSettled, not all: one branch whose RPC rejects used to strand the whole
    // batch on a permanent skeleton. And a `data` of null with an error set is
    // NOT "closed" — `data === true` alone reported every failure as a closed
    // restaurant. Failures now resolve to 'unknown' and say so.
    void Promise.allSettled(
      targets.map(async (b) => {
        const { data, error } = await client.rpc('is_branch_open', { p_branch_id: b.id });
        return [b.id, error ? 'unknown' : data === true] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      // Merge, not replace: a later probe covers only the branches that newly
      // qualified, so overwriting would blank the answers already on screen.
      setOpenNow((prev) => ({
        ...prev,
        ...Object.fromEntries(
          results.map((r, i) =>
            r.status === 'fulfilled' ? r.value : ([targets[i]!.id, 'unknown'] as const),
          ),
        ),
      }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, probeKey]);

  return openNow;
}
