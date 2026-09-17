'use client';

// One tenant, one selectable row, one code path at every width.
//
// This is a button list rather than a <table>: the index carries three fields
// and its only interaction is "select", so a real <tr> would cost either a
// non-keyboard-reachable onClick, a stretched-link overlay, or two tab stops per
// row. A `hidden md:grid` header above wears the thead classes so it still reads
// as a table at desktop. Everything an operator could want to DO is in the drawer,
// except the one repair a broken tenant needs — that stays inline.

import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronRight,
  Clock,
  CreditCard,
  PauseCircle,
  Play,
  RefreshCw,
} from 'lucide-react';
import { Badge, Button, cn } from '@favornoms/ui';
import { usePlatformText } from './platform-text';
import {
  money,
  type ChipIcon,
  type HealthChip,
  type PrimaryAction,
  type Rail,
  type TenantHealth,
  type TenantRow,
} from './tenant-health';

const CHIP_ICON: Record<ChipIcon, React.ComponentType<{ className?: string }>> = {
  billing: CreditCard,
  clock: Clock,
  ban: Ban,
  pause: PauseCircle,
  check: Check,
};

const RAIL_CLS: Record<Rail, string> = {
  danger: 'border-l-danger',
  warning: 'border-l-warning',
  none: 'border-l-transparent',
};

const ROW_GRID =
  'grid grid-cols-1 gap-1 md:grid-cols-[minmax(0,1fr)_16rem_8rem_1.5rem] md:items-center md:gap-4';

export function TenantIndexHeader() {
  const t = useTranslations('platform.index');
  return (
    <div
      aria-hidden
      className={cn(
        ROW_GRID,
        'hidden border-l-4 border-l-transparent bg-muted/50 px-5 py-3 text-xs uppercase tracking-wider text-muted-foreground md:grid',
      )}
    >
      <span>{t('restaurant')}</span>
      <span>{t('billingAccess')}</span>
      <span>{t('branches')}</span>
      <span />
    </div>
  );
}

export function TenantIndexRow({
  row,
  health,
  action,
  actionBusy,
  actionDone,
  error,
  onOpen,
  onAction,
}: {
  row: TenantRow;
  health: TenantHealth;
  action: PrimaryAction | null;
  actionBusy: boolean;
  actionDone: boolean;
  error: string | null;
  onOpen: (id: string, trigger: HTMLElement) => void;
  onAction: (row: TenantRow, action: PrimaryAction) => void;
}) {
  const p = usePlatformText();
  const { t, text } = p;
  return (
    <li className={cn('border-l-4 border-t border-border/40', RAIL_CLS[health.rail])}>
      <button
        type="button"
        onClick={(e) => onOpen(row.id, e.currentTarget)}
        // Every lamp, not just the first: a screen-reader user hearing only
        // "Suspended" would never learn the subscription had also lapsed, which
        // is the difference between Restore fixing it and Restore doing nothing.
        aria-label={t('index.rowLabel', {
          name: row.name,
          lamps: p.list(health.lamps.map((l) => text(l.label))),
          branchCount: text(health.branchCount),
          qualifier: text(health.branchQualifier),
        })}
        className={cn(
          ROW_GRID,
          // Not `focus-ring`: its ring-offset-2 draws OUTSIDE the row, and the
          // parent Card is overflow-hidden, so the keyboard ring was clipped
          // away on the left and right edges. Inset keeps it on-screen.
          'w-full px-5 py-4 text-left transition-colors hover:bg-muted/30',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        )}
      >
        <span className="min-w-0">
          {/* min-w-0 again on the flex line: without it the truncating name is a
              flex item with an auto min-width and refuses to shrink, so a long
              name pushes the Franchise badge out of the row instead. */}
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate font-display text-base font-bold">{row.name}</span>
            {row.franchise && (
              <Badge variant="muted" className="px-2 py-0.5 text-[10px]">
                {t('index.franchise')}
              </Badge>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {t.rich('index.slugLine', {
              slug: row.slug,
              plan: p.plan(row.ent.planCode),
              price: money(row.ent.monthlyTotal),
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </span>
        </span>

        <span className="min-w-0">
          <span className="flex flex-wrap gap-1.5">
            {health.lamps.map((lamp) => (
              <Lamp key={lamp.label.key} chip={lamp} label={text(lamp.label)} />
            ))}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">{text(health.clause)}</span>
        </span>

        <span className="text-xs text-muted-foreground">
          <span className="block md:font-medium md:text-foreground">{text(health.branchCount)}</span>
          <span className="block">{text(health.branchQualifier)}</span>
        </span>

        <ChevronRight className="hidden h-4 w-4 shrink-0 text-muted-foreground md:block" aria-hidden />
      </button>

      {/* A broken tenant explains itself and offers its repair without a click;
          everything calmer stays two lines and button-free, so the button is the
          alarm rather than furniture. A paid store about to lapse counts as broken
          here: the repair is only cheap BEFORE the storefront goes dark. */}
      {(health.severity >= 3 || health.expiringSoon) && health.reason && (
        <div className="flex flex-col gap-2 px-5 pb-4 md:flex-row md:items-start md:justify-between">
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <AlertTriangle
              className={cn(
                'mt-px h-3.5 w-3.5 shrink-0',
                health.rail === 'danger' ? 'text-danger' : 'text-warning',
              )}
              aria-hidden
            />
            {health.reason.map(text).join(' ')}
          </p>
          {action && (
            <div className="flex shrink-0 flex-col gap-1 md:items-end">
              <Button
                size="sm"
                variant="soft"
                loading={actionBusy}
                onClick={() => onAction(row, action)}
                leftIcon={<ActionIcon kind={action.kind} />}
              >
                {text(action.label)}
              </Button>
              {actionDone && (
                <span role="status" className="flex items-center gap-1 text-xs text-success">
                  <Check className="h-3.5 w-3.5" aria-hidden /> {t('index.reactivated')}
                </span>
              )}
              {error && (
                <p
                  role="alert"
                  className="rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger md:text-right"
                >
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// The icon carries the meaning as well as the colour, so the two off-switches
// stay distinguishable in greyscale and for colour-blind operators.
function Lamp({ chip, label }: { chip: HealthChip; label: string }) {
  const Icon = CHIP_ICON[chip.icon];
  return (
    <Badge variant={chip.variant} className="px-2 py-0.5 text-[10px]">
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </Badge>
  );
}

function ActionIcon({ kind }: { kind: PrimaryAction['kind'] }) {
  if (kind === 'restore') return <Play className="h-3.5 w-3.5" aria-hidden />;
  if (kind === 'extend') return <RefreshCw className="h-3.5 w-3.5" aria-hidden />;
  return <CreditCard className="h-3.5 w-3.5" aria-hidden />;
}
