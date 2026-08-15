import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-tight',
  {
    variants: {
      variant: {
        default: 'bg-primary/15 text-primary',
        solid: 'bg-primary text-primary-foreground shadow-soft',
        accent: 'bg-accent/20 text-accent-foreground',
        outline: 'border border-border bg-transparent text-foreground',
        success: 'bg-success/15 text-success',
        warning: 'bg-warning/15 text-warning',
        danger: 'bg-danger/15 text-danger',
        // Tenant-invariant blue. `default`/`solid`/`accent` all resolve to colours
        // ThemeProvider rewrites per branch, so they cannot carry status meaning.
        info: 'bg-info/15 text-info',
        muted: 'bg-muted text-muted-foreground',
        // `muted` on a card is a 1.11:1 tint — the pill reads as no pill at all.
        // This is the neutral to use when the background itself has to be visible.
        neutral: 'bg-foreground/10 text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
