// Locked surface for a feature the restaurant has not bought.
//
// This is the honest version of a paywall: it never pretends the feature is
// broken, it says what it costs and links to the one page that can change it.
// Digital Signage and AI Voice are additionally not built yet (owner decision,
// 2026-07-25) — `comingSoon` says so rather than implying the money would
// unlock something today.

import Link from 'next/link';
import { Lock, Sparkles } from 'lucide-react';
import { featureLabel } from '@favornoms/shared';
import { Badge, Button, Card } from '@favornoms/ui';

interface Props {
  branchId: string;
  feature: string;
  /** Add-on price per month, if the feature is sold as one. */
  price?: number;
  addonName?: string;
  description?: string;
  comingSoon?: boolean;
}

export function LockedFeature({
  branchId,
  feature,
  price,
  addonName,
  description,
  comingSoon,
}: Props) {
  return (
    <div className="container max-w-2xl py-16">
      <Card className="p-8 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
          <Lock className="h-6 w-6" />
        </span>
        <h1 className="mt-4 font-display text-2xl font-bold">{featureLabel(feature)}</h1>
        {comingSoon && (
          <Badge variant="warning" className="mt-2">
            Coming soon
          </Badge>
        )}
        <p className="mx-auto mt-3 max-w-md text-muted-foreground">
          {description ??
            `${featureLabel(feature)} is part of the ${addonName ?? 'AI Suite'} add-on and is not included in your current package.`}
        </p>
        {price !== undefined && (
          <p className="mt-4 font-display text-3xl font-bold">
            +${price}
            <span className="ml-1 text-sm font-normal text-muted-foreground">/month</span>
          </p>
        )}
        <Link href={`/b/${branchId}/settings/plan`} className="mt-6 inline-block">
          <Button variant="gradient" leftIcon={<Sparkles className="h-4 w-4" />}>
            View packages
          </Button>
        </Link>
      </Card>
    </div>
  );
}
