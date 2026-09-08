import Link from 'next/link';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { Badge, Card } from '@favornoms/ui';

export interface OverviewTile {
  label: string;
  value: string;
  href: string;
  /** Second line under the number: what the number is made of, or why it is zero. */
  sub?: string | null;
  /** undefined when there is no baseline — the badge then hides rather than claiming 0%. */
  delta?: number;
  deltaLabel?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'primary' | 'accent' | 'warning' | 'success';
}

const TONES: Record<OverviewTile['tone'], string> = {
  primary: 'bg-primary/10 text-primary',
  accent: 'bg-accent/20 text-accent-foreground',
  warning: 'bg-warning/15 text-warning',
  success: 'bg-success/15 text-success',
};

/**
 * The four numbers the owner opens the back office for. Every one of them is a link:
 * a tile that reports a queue and cannot take you to it is a dead end, and the four
 * hardcoded "Quick actions" this replaced were the only way to reach any of these screens
 * from here.
 */
export function OverviewTiles({ tiles }: { tiles: OverviewTile[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 px-2 sm:grid-cols-2 lg:grid-cols-4 lg:px-0">
      {tiles.map((t) => {
        const Icon = t.icon;
        return (
          <Link
            key={t.label}
            href={t.href}
            className="focus-ring block rounded-2xl transition-shadow hover:shadow-soft"
          >
            <Card className="h-full p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{t.label}</p>
                  <p className="mt-1 font-display text-3xl font-bold">{t.value}</p>
                  {t.delta != null && (
                    <>
                      <Badge variant={t.delta >= 0 ? 'success' : 'danger'} className="mt-2">
                        {t.delta >= 0 ? (
                          <ArrowUpRight className="h-3 w-3" />
                        ) : (
                          <ArrowDownRight className="h-3 w-3" />
                        )}
                        {Math.abs(t.delta).toFixed(1)}%
                      </Badge>
                      {t.deltaLabel && (
                        <p className="mt-1 text-[10px] text-muted-foreground">{t.deltaLabel}</p>
                      )}
                    </>
                  )}
                  {t.sub && <p className="mt-2 text-[11px] text-muted-foreground">{t.sub}</p>}
                </div>
                <div className={`grid h-10 w-10 place-items-center rounded-xl ${TONES[t.tone]}`}>
                  <Icon className="h-5 w-5" />
                </div>
              </div>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
