import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { Badge, Card, EmptyState } from '@favornoms/ui';

/** One line in Action Required, already in the reader's language. */
export interface ActionLine {
  key: string;
  title: string;
  why: string;
  age: string;
  href: string;
}

/** The screen a bucket's "See all" link opens; each is its own sentence in the catalogue. */
export type BucketDestination =
  | 'orders'
  | 'deliveries'
  | 'kitchen'
  | 'inventory'
  | 'drivers'
  | 'payouts';

export interface ActionBucket {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'danger' | 'warning' | 'info';
  /** Everything matching, which may be more than the rows carried here. */
  count: number;
  rows: ActionLine[];
  href: string;
  destination: BucketDestination;
  /**
   * A read that failed. Rendered instead of a count — never as a zero. The raw text is for
   * the server log only; the merchant is told the check could not run.
   */
  error?: string | null;
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
 */
export function ActionRequired({
  buckets,
  checkedAt,
}: {
  buckets: ActionBucket[];
  /** Branch-local wall clock of the render, so "all clear" is dated. */
  checkedAt: string;
}) {
  const t = useTranslations('dashboard');
  const rawLocale = useLocale();
  const intlLocale = intlLocaleFor(isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE);
  const visible = buckets.filter((b) => !b.hidden);
  const shown = visible.filter((b) => b.error || b.count > 0);
  const total = shown.reduce((n, b) => n + (b.error ? 0 : b.count), 0);
  const failing = shown.filter((b) => b.error).length;
  const checked = visible.map((b) => b.label.toLocaleLowerCase(intlLocale));

  return (
    <section className="mt-8 px-2 lg:px-0">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-semibold">{t('action.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {shown.length === 0
            ? t('action.allClear')
            : failing > 0 && total === 0
              ? t('action.checksFailed', { count: failing })
              : t('action.waiting', { count: total })}
        </p>
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
            const Icon = bucket.icon;
            return (
              <Card key={bucket.id} className={`overflow-hidden ${TONE_BORDER[bucket.tone]}`}>
                <Link
                  href={bucket.href}
                  className="focus-ring flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
                >
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${TONE_ICON[bucket.tone]}`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="flex-1 text-sm font-semibold">{bucket.label}</span>
                  {!bucket.error && (
                    <Badge variant={TONE_BADGE[bucket.tone]}>{bucket.count}</Badge>
                  )}
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>

                {bucket.error ? (
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
                        {bucket.rows.map((row) => (
                          <li key={row.key} className="border-b border-border last:border-b-0">
                            <Link
                              href={row.href}
                              className="focus-ring flex items-baseline justify-between gap-3 px-4 py-2.5 hover:bg-muted/50"
                            >
                              <span className="min-w-0">
                                <span className="text-sm font-semibold">{row.title}</span>
                                <span className="ml-2 text-sm text-muted-foreground">
                                  {row.why}
                                </span>
                              </span>
                              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                {row.age}
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                    {bucket.count > bucket.rows.length && (
                      <Link
                        href={bucket.href}
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
    </section>
  );
}

/** 'a, b and c' in the reader's language — the checks that actually ran. */
function listLabels(labels: string[], intlLocale: string): string {
  return new Intl.ListFormat(intlLocale, { style: 'long', type: 'conjunction' }).format(labels);
}
