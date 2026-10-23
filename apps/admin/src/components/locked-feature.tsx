// Locked surface for a back-office screen whose feature is off.
//
// It never pretends the feature is broken, and it never sells anything: every feature is in
// the one plan (docs/PACKAGING-2026-10-24.md §1), so a locked screen only ever means the
// feature is switched off — by the merchant, and then the button goes to that switch, or for
// the whole restaurant, and then there is nothing to press. No price and no plan page.

import Link from 'next/link';
import { useLocale } from 'next-intl';
import { Lock, Settings } from 'lucide-react';
import { featureLabel, isUiLocale } from '@favornoms/shared';
import { Button, Card } from '@favornoms/ui';

interface Props {
  feature: string;
  /** Already translated by the caller: what is off, where, and who can change it. */
  description: string;
  /** Where the feature is switched back on, only when this viewer may do it. */
  action?: { href: string; label: string };
}

export function LockedFeature({ feature, description, action }: Props) {
  const localeValue = useLocale();
  const locale = isUiLocale(localeValue) ? localeValue : undefined;
  const label = featureLabel(feature, locale);
  return (
    <div className="container max-w-2xl py-16">
      <Card className="p-8 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
          <Lock className="h-6 w-6" />
        </span>
        <h1 className="mt-4 font-display text-2xl font-bold">{label}</h1>
        <p className="mx-auto mt-3 max-w-md text-muted-foreground">{description}</p>
        {action && (
          <Link href={action.href} className="mt-6 inline-block">
            <Button variant="gradient" leftIcon={<Settings className="h-4 w-4" />}>
              {action.label}
            </Button>
          </Link>
        )}
      </Card>
    </div>
  );
}
