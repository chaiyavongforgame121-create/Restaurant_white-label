'use client';

// "Card (Stripe)" or "Manual": how a restaurant pays the platform. One component so the
// dashboard index, the drawer and the Subscriptions page cannot word or colour it apart.

import { useTranslations } from 'next-intl';
import { CreditCard, Landmark } from 'lucide-react';
import type { BillingRailInfo } from '@favornoms/database/queries';
import { Badge, cn } from '@favornoms/ui';
import { railKey } from './stripe-rail';

export function RailChip({ billing, className }: { billing: BillingRailInfo; className?: string }) {
  const t = useTranslations('platform.stripe.rail');
  const key = railKey(billing);
  const Icon = key === 'stripe' ? CreditCard : Landmark;
  return (
    // `info` is the tenant-invariant blue: the rail is a fact, not a status, so it must
    // not borrow the success/warning colours the health lamps beside it use.
    <Badge variant={key === 'stripe' ? 'info' : 'neutral'} className={cn('px-2 py-0.5 text-[10px]', className)}>
      <Icon className="h-3 w-3" aria-hidden />
      {t(key)}
    </Badge>
  );
}
