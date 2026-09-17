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
import { usePlatformText, type PlatformText } from './platform-text';
import {
  branchVerdict,
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
  const p = usePlatformText();
  const { t, text } = p;
  const openNow = useOpenProbe(open ? row.id : null, branches, nowMs);
  const actionRef = React.useRef<HTMLButtonElement>(null);
  const firstLinkRef = React.useRef<HTMLAnchorElement>(null);
  const anyActive = branches.some((b) => b.is_active);

  // Land on the recommended repair, so the common fix is Tab → Enter → Enter.
  // A healthy tenant has no repair, so focus falls to the first Back office link.
  React.useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => (actionRef.current ?? firstLinkRef.current)?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [open, row.id]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      side="right"
      title={row.name}
      ariaLabel={t('drawer.ariaLabel', { name: row.name })}
    >
      <div className="space-y-5 px-5 pb-8">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            {t.rich('drawer.meta', {
              slug: row.slug,
              loyalty: loyaltyLabel(row.loyaltyScope, p),
              date: p.date(row.createdAt),
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </p>
          {row.franchise && (
            <Badge variant="muted" className="px-2 py-0.5 text-[10px]">
              {t('index.franchise')}
            </Badge>
          )}
        </div>

        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground">
            {t('drawer.dinerTitle')}
          </h3>
          {branches.length === 0 ? (
            <p className="rounded-xl border border-border/60 p-3 text-sm text-muted-foreground">
              {t('drawer.noBranches')}
            </p>
          ) : (
            branches.map((b, i) => (
              <BranchBlock
                key={b.id}
                branch={b}
                verdict={branchVerdict(b, nowMs, openNow[b.id] ?? null)}
                storefront={storefrontUrl(siteBase, row.slug, b)}
                linkRef={i === 0 ? firstLinkRef : undefined}
                p={p}
              />
            ))
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground">
            {t('drawer.switchesTitle')}
          </h3>

          <SwitchRow
            icon={<Ban className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
            label={t('drawer.accessLabel')}
            state={accessState(branches, p)}
            consequence={t('drawer.accessConsequence')}
          >
            <Button
              ref={action?.kind === 'restore' ? actionRef : undefined}
              size="sm"
              variant={anyActive ? 'ghost' : 'primary'}
              disabled={branches.length === 0}
              title={branches.length === 0 ? t('drawer.noBranchesToSuspend') : undefined}
              onClick={() => onSuspend(row)}
              leftIcon={anyActive ? <Ban className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            >
              {anyActive ? t('drawer.suspend') : t('drawer.restore')}
            </Button>
          </SwitchRow>

          <SwitchRow
            icon={<CreditCard className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
            label={t('drawer.subscriptionLabel')}
            state={billingState(row, health, p)}
            consequence={t('drawer.subscriptionConsequence')}
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
                  {text(action.label)}
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
                {t('drawer.manageSubscription')}
              </Link>
              {actionDone && (
                <span role="status" className="flex items-center gap-1 text-xs text-success">
                  <Check className="h-3.5 w-3.5" aria-hidden /> {t('index.reactivated')}
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

        <Package row={row} health={health} p={p} />

        {health.reason && (
          <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
            {health.reason.map(text).join(' ')}
          </p>
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
  p,
}: {
  branch: BranchLite;
  verdict: BranchVerdict | null;
  storefront: string;
  linkRef?: React.Ref<HTMLAnchorElement>;
  p: PlatformText;
}) {
  const { t, text } = p;
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
        <Badge variant={verdict.variant} className="px-2 py-0.5 text-[10px]" title={text(verdict.hint)}>
          <Icon className="h-3 w-3" aria-hidden />
          {text(verdict.label)}
        </Badge>
      ) : (
        <Skeleton className="h-5 w-24" />
      )}
      <p className="text-xs text-muted-foreground">
        {verdict ? text(verdict.why) : t('drawer.checkingHours')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          ref={linkRef}
          href={`/b/${branch.id}/dashboard`}
          prefetch={false}
          aria-label={t('drawer.openBackOffice', { name: branch.name })}
          className={buttonVariants({ size: 'sm', variant: 'soft' })}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          {t('drawer.backOffice')}
        </Link>
        <a
          href={storefront}
          target="_blank"
          rel="noreferrer"
          aria-label={t('drawer.openStorefront', { name: branch.name })}
          className={buttonVariants({ size: 'sm', variant: 'ghost' })}
        >
          <Store className="h-3.5 w-3.5" aria-hidden />
          {t('drawer.storefront')}
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

function Package({ row, health, p }: { row: TenantRow; health: TenantHealth; p: PlatformText }) {
  const { t, locale } = p;
  const { ent } = row;
  const overQuota = ent.branchesUsed > ent.branchSeats;
  // billing_compute never clears features on expiry, so a dead tenant still
  // carries a full grant blob. Split it rather than painting it as provisioned.
  const live = FEATURE_KEYS.filter((k) => hasFeature(ent, k));
  const dormant = FEATURE_KEYS.filter((k) => ownsFeature(ent, k) && !hasFeature(ent, k));

  return (
    <section className="space-y-3">
      <h3 className="text-xs uppercase tracking-wider text-muted-foreground">{t('drawer.package.title')}</h3>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">{t('drawer.package.plan')}</dt>
          <dd className="font-semibold">{p.plan(ent.planCode)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('drawer.package.monthly')}</dt>
          <dd className="font-semibold tabular-nums">{money(ent.monthlyTotal)}</dd>
        </div>
        <div>
          {/* Not "Renews": nothing renews by itself, the store goes dark on this date. */}
          <dt className="text-xs text-muted-foreground">
            {health.entitled ? t('drawer.package.paidThrough') : t('drawer.package.lapsed')}
          </dt>
          <dd className="font-semibold tabular-nums">{p.date(ent.entitledThrough ?? ent.trialEndsAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('drawer.package.seats')}</dt>
          <dd className={cn('font-semibold tabular-nums', overQuota && 'text-danger')}>
            {ent.branchesUsed}/{ent.branchSeats}
            {overQuota && (
              <span className="ml-1 text-xs font-normal">{t('drawer.package.overQuota')}</span>
            )}
          </dd>
        </div>
      </dl>

      {live.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {live.map((k) => (
            <Badge key={k} variant="accent" className="px-2 py-0.5 text-[10px]">
              {featureLabel(k, locale)}
            </Badge>
          ))}
        </div>
      )}

      {health.entitled && !hasFeature(ent, 'delivery') && (
        <p className="rounded-xl bg-warning/10 px-3 py-2 text-xs text-warning">
          {t('drawer.package.noDelivery')}
        </p>
      )}

      {dormant.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">{t('drawer.package.dormant')}</p>
          <div className="flex flex-wrap gap-1.5">
            {dormant.map((k) => (
              <Badge key={k} variant="muted" className="px-2 py-0.5 text-[10px] line-through opacity-60">
                {featureLabel(k, locale)}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// The stored scope ('branch' | 'brand') stays as it is; only its label is translated.
function loyaltyLabel(scope: string, { t }: PlatformText): string {
  if (scope === 'branch') return t('drawer.loyalty.branch');
  if (scope === 'brand') return t('drawer.loyalty.brand');
  return t('drawer.loyalty.other', { scope });
}

function accessState(branches: BranchLite[], { t }: PlatformText): string {
  const total = branches.length;
  if (total === 0) return t('drawer.accessState.noBranches');
  const active = branches.filter((b) => b.is_active).length;
  if (active === total) return t('drawer.accessState.allActive', { count: total });
  if (active === 0) return t('drawer.accessState.allSuspended', { count: total });
  return t('drawer.accessState.partlySuspended', { suspended: total - active, total });
}

function billingState(row: TenantRow, health: TenantHealth, p: PlatformText): string {
  const { t } = p;
  const plan = p.plan(row.ent.planCode);
  if (!health.entitled) {
    const lapsed = row.ent.entitledThrough ?? row.ent.trialEndsAt;
    return lapsed
      ? t('drawer.billingState.expired', { date: p.date(lapsed), plan })
      : t('drawer.billingState.noSubscription');
  }
  return t('drawer.billingState.current', { status: p.text(health.billing.label), plan });
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
