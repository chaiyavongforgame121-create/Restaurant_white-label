'use client';

// Inline upsell shown in place of a settings panel the package does not include.
// Deliberately renders INSTEAD of the real editor rather than disabling it:
// a delivery fee schedule the tenant cannot sell is worse than no panel at all.

import Link from 'next/link';
import { Lock, Sparkles } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';

interface Props {
  branchId: string;
  title: string;
  price: number;
  description: string;
  bullets?: string[];
}

export function AddonUpsellCard({ branchId, title, price, description, bullets = [] }: Props) {
  return (
    <Card className="border-dashed p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Lock className="h-5 w-5 text-muted-foreground" /> {title}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      {bullets.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
          {bullets.map((b) => (
            <li key={b}>• {b}</li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <p className="font-display text-2xl font-bold">
          +${price}
          <span className="ml-1 text-sm font-normal text-muted-foreground">/month</span>
        </p>
        <Link href={`/b/${branchId}/settings/plan`}>
          <Button size="sm" variant="gradient" leftIcon={<Sparkles className="h-4 w-4" />}>
            Add to my package
          </Button>
        </Link>
      </div>
    </Card>
  );
}
