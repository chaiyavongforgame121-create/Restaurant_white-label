'use client';

// Inline upsell shown in place of a settings panel the package does not include.
// Deliberately renders INSTEAD of the real editor rather than disabling it:
// a delivery fee schedule the tenant cannot sell is worse than no panel at all.

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Lock, Sparkles } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';

interface Props {
  branchId: string;
  /** Already translated by the caller. */
  title: string;
  price: number;
  description: string;
  bullets?: string[];
  /** Catalog code of the add-on this card sells (e.g. 'delivery'), pre-ticked on the plan page.
   *  Pass it: a translated title is no use to the plan page's match. */
  addon?: string;
}

export function AddonUpsellCard({ branchId, title, price, description, bullets = [], addon }: Props) {
  const t = useTranslations('shell.addon');
  // The button used to open the plan page bare, so a merchant who pressed "Add to my
  // package" on Delivery had to find and tick Delivery all over again. The plan page
  // matches `add` against the catalog's codes and names, which is why the title is a
  // safe fallback for a caller that does not pass the code.
  const href = `/b/${branchId}/settings/plan?add=${encodeURIComponent(addon ?? title)}`;
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
          {/* The price stays a plain string: money is US-formatted in every language. */}
          {t.rich('pricePerMonth', {
            price: String(price),
            unit: (chunks) => <span className="ml-1 text-sm font-normal text-muted-foreground">{chunks}</span>,
          })}
        </p>
        <Link href={href}>
          <Button size="sm" variant="gradient" leftIcon={<Sparkles className="h-4 w-4" />}>
            {t('addToPackage')}
          </Button>
        </Link>
      </div>
    </Card>
  );
}
