'use client';

import * as React from 'react';
import { Flame, Leaf, Sparkles, Star, WheatOff } from 'lucide-react';
import { cn } from '../lib/cn';
import { useUiStrings, type UiStrings } from './ui-strings';

type DietaryTag = 'vegan' | 'halal' | 'spicy' | 'gluten-free' | 'new' | 'chef-pick';

const tagMap: Record<
  DietaryTag,
  {
    /** Which UiStrings entry names the tag in the active language. */
    label: keyof UiStrings;
    icon: React.ComponentType<{ className?: string }>;
    className: string;
  }
> = {
  vegan: { label: 'dietaryVegan', icon: Leaf, className: 'bg-emerald-100 text-emerald-700' },
  halal: { label: 'dietaryHalal', icon: Sparkles, className: 'bg-teal-100 text-teal-700' },
  spicy: { label: 'dietarySpicy', icon: Flame, className: 'bg-rose-100 text-rose-700' },
  'gluten-free': { label: 'dietaryGlutenFree', icon: WheatOff, className: 'bg-amber-100 text-amber-800' },
  new: { label: 'dietaryNew', icon: Sparkles, className: 'bg-primary/15 text-primary' },
  'chef-pick': { label: 'dietaryChefPick', icon: Star, className: 'bg-accent/20 text-accent-foreground' },
};

export function DietaryBadge({ tag, className }: { tag: DietaryTag; className?: string }) {
  const strings = useUiStrings();
  const cfg = tagMap[tag];
  const Icon = cfg.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        cfg.className,
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {strings[cfg.label]}
    </span>
  );
}
