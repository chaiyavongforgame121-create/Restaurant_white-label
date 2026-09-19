'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Banknote,
  Bell,
  BellOff,
  BellRing,
  Bike,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock,
  Hourglass,
  Package,
  RotateCcw,
  Timer,
  Truck,
  UserPlus,
  Wallet,
  X,
} from 'lucide-react';
import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { Badge, Card, EmptyState, cn } from '@favornoms/ui';
import { scopedKey, type WatchedBucket } from './alert-model';
import { useActionAlerts } from './use-action-alerts';

/** One line in Action Required, already in the reader's language. */
export interface ActionLine {
  key: string;
  title: string;
  /** Who it is for, as the customer typed it. */
  who?: string | null;
  /** Why it is here. May be empty when the pill already says it. */
  why: string;
  age: string;
  /** A wall-clock time for the row in the branch's zone, e.g. when a booking is due. */
  at?: string;
  /** A short state, drawn as a pill so it reads at a glance ("Accepted", "Not accepted"). */
  pill?: { label: string; tone: 'danger' | 'warning' | 'success' | 'info' | 'neutral' };
  /**
   * How loudly the row is drawn. `strong` needs a human now, `quiet` is only a heads-up.
   * Rows that do not say are `normal`, which is how every row looked before bookings.
   */
  weight?: 'strong' | 'normal' | 'quiet';
  /** The right-hand time is bad news (a booking past its time), not just a clock. */
  ageAlarm?: boolean;
  href: string;
}

/** The screen a bucket's "See all" link opens; each is its own sentence in the catalogue. */
export type BucketDestination =
  | 'orders'
  | 'bookings'
  | 'deliveries'
  | 'kitchen'
  | 'inventory'
  | 'drivers'
  | 'payouts';

/**
 * Icons by name. The buckets are built on the server and this component runs in the browser, and
 * a component cannot cross that line as a prop — a name can.
 */
const ICONS = {
  alertTriangle: AlertTriangle,
  banknote: Banknote,
  bike: Bike,
  calendarClock: CalendarClock,
  clock: Clock,
  hourglass: Hourglass,
  package: Package,
  rotateCcw: RotateCcw,
  timer: Timer,
  truck: Truck,
  userPlus: UserPlus,
  wallet: Wallet,
} as const;
export type BucketIcon = keyof typeof ICONS;

export interface ActionBucket {
  id: string;
  label: string;
  icon: BucketIcon;
  tone: 'danger' | 'warning' | 'info';
  /** Everything matching, which may be more than the rows carried here. */
  count: number;
  /**
   * How many of `count` are waiting on a human; the rest are listed so the owner can see them
   * coming (upcoming bookings). Printed as the bucket's own "N need you". Defaults to `count`.
   */
  attention?: number;
  /**
   * How many of `attention` no other bucket lists — the only ones added to "N things waiting on
   * you", so one order in two buckets (a late booking is also a late ticket) is one thing.
   * Defaults to `attention`.
   */
  addsToTotal?: number;
  /** The rows listed: the first few. */
  rows: ActionLine[];
  /** Every row key the page read for this bucket, listed or not: what the new-item alert watches. */
  keys: string[];
  href: string;
  destination: BucketDestination;
  /**
   * The read failed. Rendered instead of a count — never as a zero. Only the fact crosses to
   * the browser: the database's own text is for the server log (page.tsx writes it there), and
   * this component's props are serialized into the page for anyone to read.
   */
  failed?: boolean;
  /** The role or the plan puts this out of scope: dropped, not shown as "0". */
  hidden?: boolean;
}

const TONE_ICON: Record<ActionBucket['tone'], string> = {
  danger: 'bg-danger/10 text-danger',
  warning: 'bg-warning/15 text-warning',
  info: 'bg-info/15 text-info',
};
const TONE_BORDER: Record<ActionBucket['tone'], string> = {
  danger: 'border-danger/30',
  warning: 'border-warning/30',
  info: 'border-border',
};
const TONE_BADGE: Record<ActionBucket['tone'], 'danger' | 'warning' | 'info'> = {
  danger: 'danger',
  warning: 'warning',
  info: 'info',
};

/**
 * The part of this screen the owner called the most important: everything waiting on a
 * decision, ordered by how much it costs to ignore, each row saying why it is here and how
 * long it has waited, each row a link to the screen that can actually deal with it.
 *
 * Nothing acts in place. Approving a slip or re-dispatching a rider from here would mean a
 * second copy of that flow's RPC handling and its error copy, drifting from the screen that
 * owns it — which is the same trap two copies of a threshold would be.
 *
 * It runs in the browser because it has to notice change: the page is re-rendered on the server
 * whenever the branch's orders or deliveries move (AutoRefresh), and a row that was not here last
 * time is flagged in the alert colour with a "New" pill, announced once (toast, chime, tab title)
 * and left flagged until it is opened or has been on a visible screen for a few minutes. Colour is
 * never the only signal: the pill and the announcement say it in words.
 */
export function ActionRequired({
  branchId,
  buckets,
  checkedAt,
}: {
  branchId: string;
  buckets: ActionBucket[];
  /** Branch-local wall clock of the render, so "all clear" is dated. */
  checkedAt: string;
}) {
  const t = useTranslations('dashboard');
  const rawLocale = useLocale();
  const intlLocale = intlLocaleFor(isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE);
  const visible = buckets.filter((b) => !b.hidden);
  const shown = visible.filter((b) => b.failed || b.count > 0);
  const total = shown.reduce(
    (n, b) => n + (b.failed ? 0 : (b.addsToTotal ?? b.attention ?? b.count)),
    0,
  );
  const upcoming = shown.reduce((n, b) => n + (b.failed ? 0 : b.count), 0);
  const failing = shown.filter((b) => b.failed).length;
  const checked = visible.map((b) => b.label.toLocaleLowerCase(intlLocale));

  const watched: WatchedBucket[] = visible.map((b) => ({
    id: b.id,
    ok: !b.failed,
    keys: b.keys,
    total: b.count,
  }));
  const alerts = useActionAlerts(branchId, watched);
  const labelOf = new Map(buckets.map((b) => [b.id, b.label]));

  return (
    <section
      id="action-required"
      aria-labelledby="action-required-title"
      className="mt-8 scroll-mt-4 px-2 lg:px-0"
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <h2 id="action-required-title" className="font-display text-xl font-semibold">
            {t('action.title')}
          </h2>
          {alerts.freshCount > 0 && (
            <span className="relative inline-flex">
              {alerts.pulsing && (
                <span
                  aria-hidden
                  className="absolute inset-0 animate-ping rounded-full bg-danger/40"
                />
              )}
              <Badge variant="danger" className="relative">
                <BellRing className="h-3 w-3" aria-hidden />
                {t('alerts.newCount', { count: alerts.freshCount })}
              </Badge>
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm text-muted-foreground">
            {shown.length === 0
              ? t('action.allClear')
              : failing > 0 && total === 0
                ? t('action.checksFailed', { count: failing })
                : total === 0
                  ? t('action.upcomingOnly', { count: upcoming })
                  : t('action.waiting', { count: total })}
          </p>
          {alerts.freshCount > 0 && (
            <button
              type="button"
              onClick={alerts.markAllSeen}
              className="focus-ring rounded-lg px-2 py-1 text-xs font-semibold text-primary hover:underline"
            >
              {t('alerts.markSeen')}
            </button>
          )}
          <SoundToggle
            on={alerts.sound.on}
            locked={alerts.sound.locked}
            onToggle={alerts.sound.toggle}
          />
        </div>
      </header>

      {shown.length === 0 ? (
        <Card className="p-2">
          {/* Naming what was checked is the whole point: a bare "All clear" over white
              space is exactly what reads as a screen that failed to load. */}
          <EmptyState
            icon={<CheckCircle2 className="h-8 w-8" />}
            title={t('action.emptyTitle')}
            description={
              checked.length === 0
                ? t('action.checkedNothing')
                : t('action.checkedList', { list: listLabels(checked, intlLocale) })
            }
          />
          <p className="pb-4 text-center text-xs text-muted-foreground">
            {t('action.checkedAt', { time: checkedAt })}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((bucket) => {
            const Icon = ICONS[bucket.icon];
            const newHere = alerts.freshByBucket[bucket.id] ?? 0;
            const bucketFresh = bucket.keys
              .map((k) => scopedKey(bucket.id, k))
              .filter((k) => alerts.fresh.has(k));
            const attention = bucket.attention ?? bucket.count;
            return (
              <Card
                key={bucket.id}
                className={cn(
                  'overflow-hidden transition-shadow duration-700',
                  TONE_BORDER[bucket.tone],
                  newHere > 0 && 'border-danger/50 ring-2 ring-danger/30',
                )}
              >
                <Link
                  href={bucket.href}
                  onClick={() => alerts.markSeen(bucketFresh)}
                  className="focus-ring flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
                >
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${TONE_ICON[bucket.tone]}`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{bucket.label}</span>
                    {!bucket.failed && attention > 0 && attention < bucket.count && (
                      <span className="block text-xs font-medium text-warning">
                        {t('action.needYou', { count: attention })}
                      </span>
                    )}
                  </span>
                  {newHere > 0 && (
                    <Badge variant="danger">{t('alerts.newCount', { count: newHere })}</Badge>
                  )}
                  {!bucket.failed && (
                    <Badge variant={TONE_BADGE[bucket.tone]}>{bucket.count}</Badge>
                  )}
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>

                {bucket.failed ? (
                  // A failed read must never wear the empty state's clothes: "0 slips to
                  // approve" and "we could not ask" are opposite instructions.
                  <p
                    role="alert"
                    className="mx-4 mb-4 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning"
                  >
                    {t('action.checkFailed')}
                  </p>
                ) : (
                  <>
                    {bucket.rows.length > 0 && (
                      <ul className="border-t border-border">
                        {bucket.rows.map((row) => {
                          const key = scopedKey(bucket.id, row.key);
                          return (
                            <li key={row.key} className="border-b border-border last:border-b-0">
                              <Row
                                row={row}
                                fresh={alerts.fresh.has(key)}
                                newLabel={t('alerts.newBadge')}
                                onOpen={() => alerts.markSeen([key])}
                              />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {bucket.count > bucket.rows.length && (
                      <Link
                        href={bucket.href}
                        onClick={() => alerts.markSeen(bucketFresh)}
                        className="focus-ring block px-4 py-2.5 text-xs font-semibold text-primary hover:underline"
                      >
                        {t(`action.seeAll.${bucket.destination}`, { count: bucket.count })}
                      </Link>
                    )}
                  </>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Always in the DOM, so a screen reader is already listening when something arrives: a
          live region that is mounted together with its message is often not announced at all. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-end sm:inset-x-auto sm:right-6"
      >
        {alerts.toast && (
          <div className="pointer-events-auto flex w-full max-w-sm animate-fade-in items-start gap-3 rounded-2xl border border-danger/40 bg-card p-4 shadow-warm">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger">
              <BellRing className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {t('alerts.toast', { count: alerts.toast.count })}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {listLabels(
                  alerts.toast.buckets.map((id) => labelOf.get(id) ?? id),
                  intlLocale,
                )}
              </p>
              <a
                href="#action-required"
                onClick={alerts.dismissToast}
                className="focus-ring mt-2 inline-block rounded text-xs font-semibold text-primary hover:underline"
              >
                {t('alerts.view')}
              </a>
            </div>
            <button
              type="button"
              onClick={alerts.dismissToast}
              aria-label={t('alerts.dismiss')}
              title={t('alerts.dismiss')}
              className="focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function Row({
  row,
  fresh,
  newLabel,
  onOpen,
}: {
  row: ActionLine;
  fresh: boolean;
  newLabel: string;
  onOpen: () => void;
}) {
  const weight = row.weight ?? 'normal';
  return (
    <Link
      href={row.href}
      onClick={onOpen}
      className={cn(
        // The tint fades out rather than snapping off, so a flag that expires while someone
        // is reading does not look like the row jumped.
        'focus-ring flex items-baseline justify-between gap-3 px-4 py-2.5 transition-colors duration-1000',
        fresh ? 'bg-danger/10 hover:bg-danger/15' : 'hover:bg-muted/50',
        // An inset bar rather than a border, so a strong row lines up with its neighbours.
        fresh
          ? 'shadow-[inset_3px_0_0_0_hsl(var(--danger))]'
          : weight === 'strong' && 'shadow-[inset_3px_0_0_0_hsl(var(--warning))]',
      )}
    >
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        {fresh && (
          <Badge variant="danger" className="self-center">
            {newLabel}
          </Badge>
        )}
        <span
          className={cn(
            'text-sm',
            weight === 'quiet' ? 'font-medium text-muted-foreground' : 'font-semibold',
          )}
        >
          {row.title}
        </span>
        {row.who && (
          <span className={cn('text-sm', weight === 'quiet' && 'text-muted-foreground')}>
            {row.who}
          </span>
        )}
        {row.pill && (
          <Badge variant={row.pill.tone} className="self-center">
            {row.pill.label}
          </Badge>
        )}
        {row.why && (
          <span
            className={cn(
              'text-sm',
              weight === 'strong' ? 'font-medium text-warning' : 'text-muted-foreground',
            )}
          >
            {row.why}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        {row.at && (
          <span
            className={cn(
              'block whitespace-nowrap text-sm tabular-nums',
              weight === 'quiet' ? 'text-muted-foreground' : 'font-semibold',
            )}
          >
            {row.at}
          </span>
        )}
        {row.age && (
          <span
            className={cn(
              'block whitespace-nowrap text-xs tabular-nums',
              row.ageAlarm ? 'font-semibold text-danger' : 'text-muted-foreground',
            )}
          >
            {row.age}
          </span>
        )}
      </span>
    </Link>
  );
}

/**
 * The dashboard's own mute. Off stays off on this device (localStorage). On but not yet allowed —
 * the browser keeps sound locked until the page has had a click or a key press — it says so rather
 * than staying quietly silent, and any click on the page (this one included) unlocks it.
 */
function SoundToggle({
  on,
  locked,
  onToggle,
}: {
  on: boolean;
  locked: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('dashboard');
  const label = on ? t('alerts.soundOn') : t('alerts.soundOff');
  return (
    <span className="flex items-center gap-2">
      {locked && (
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {t('alerts.soundLocked')}
        </span>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={on}
        aria-label={t('alerts.soundToggle')}
        title={locked ? `${label} · ${t('alerts.soundLocked')}` : label}
        className={cn(
          'focus-ring grid h-8 w-8 place-items-center rounded-lg border border-border',
          on ? 'text-foreground hover:bg-muted' : 'text-muted-foreground hover:bg-muted',
        )}
      >
        {on ? <Bell className="h-4 w-4" aria-hidden /> : <BellOff className="h-4 w-4" aria-hidden />}
      </button>
    </span>
  );
}

/** 'a, b and c' in the reader's language — the checks that actually ran. */
function listLabels(labels: string[], intlLocale: string): string {
  return new Intl.ListFormat(intlLocale, { style: 'long', type: 'conjunction' }).format(labels);
}
