'use client';

import * as React from 'react';
import { Card, cn } from '@favornoms/ui';

/**
 * The one tile every section uses. It was a private helper at the bottom of reports-view
 * when there were four of them; six sections would each have grown their own.
 */
export function Kpi({
  icon,
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** One short line under the number — where it came from, or why it reads oddly. */
  hint?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const toneClass = {
    neutral: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-danger/10 text-danger',
  }[tone];

  return (
    <Card className="flex items-center gap-3 p-4">
      <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', toneClass)}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-display text-xl font-bold tabular-nums">{value}</p>
        {hint ? <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{hint}</p> : null}
      </div>
    </Card>
  );
}
