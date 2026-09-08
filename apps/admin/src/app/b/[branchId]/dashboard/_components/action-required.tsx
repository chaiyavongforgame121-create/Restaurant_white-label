import Link from 'next/link';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { Badge, Card, EmptyState } from '@favornoms/ui';
import type { ActionRow } from './action-model';

export interface ActionBucket {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'danger' | 'warning' | 'info';
  /** Everything matching, which may be more than the rows carried here. */
  count: number;
  rows: ActionRow[];
  href: string;
  hrefLabel: string;
  /** A read that failed. Rendered instead of a count — never as a zero. */
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
  const visible = buckets.filter((b) => !b.hidden);
  const shown = visible.filter((b) => b.error || b.count > 0);
  const total = shown.reduce((n, b) => n + (b.error ? 0 : b.count), 0);
  const failing = shown.filter((b) => b.error).length;

  return (
    <section className="mt-8 px-2 lg:px-0">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-semibold">Action required</h2>
        <p className="text-sm text-muted-foreground">
          {shown.length === 0
            ? 'Everything checked, nothing outstanding'
            : failing > 0 && total === 0
              ? `${failing} check${failing === 1 ? '' : 's'} could not run`
              : `${total} thing${total === 1 ? '' : 's'} waiting on you`}
        </p>
      </header>

      {shown.length === 0 ? (
        <Card className="p-2">
          {/* Naming what was checked is the whole point: a bare "All clear" over white
              space is exactly what reads as a screen that failed to load. */}
          <EmptyState
            icon={<CheckCircle2 className="h-8 w-8" />}
            title="Nothing needs you right now"
            description={`Checked ${listLabels(visible.map((b) => b.label.toLowerCase()))}.`}
          />
          <p className="pb-4 text-center text-xs text-muted-foreground">Checked at {checkedAt}</p>
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
                    Couldn’t check {bucket.label.toLowerCase()} — {bucket.error}
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
                        See all {bucket.count} in {bucket.hrefLabel} →
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

/** 'a, b and c' — the checks that actually ran, so "nothing needs you" can be believed. */
function listLabels(labels: string[]): string {
  if (labels.length === 0) return 'nothing';
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
