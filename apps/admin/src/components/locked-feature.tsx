// Locked surface for a feature the restaurant has not bought.
//
// This is the honest version of a paywall: it never pretends the feature is
// broken, it says what it costs and links to the one page that can change it.
// Digital Signage and AI Voice are additionally not built yet (owner decision,
// 2026-07-25) — `comingSoon` says so rather than implying the money would
// unlock something today.

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Lock, Sparkles } from 'lucide-react';
import { featureLabel, isUiLocale } from '@favornoms/shared';
import { Badge, Button, Card } from '@favornoms/ui';

interface Props {
  branchId: string;
  feature: string;
  /** Add-on price per month, if the feature is sold as one. */
  price?: number;
  /** The add-on's product name (e.g. "AI Suite"); shown as it is. */
  addonName?: string;
  /** Already translated by the caller. */
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
  const t = useTranslations('shell');
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
        {comingSoon && (
          <Badge variant="warning" className="mt-2">
            {t('lockedFeature.comingSoon')}
          </Badge>
        )}
        <p className="mx-auto mt-3 max-w-md text-muted-foreground">
          {description ??
            t('lockedFeature.notInPackage', {
              feature: label,
              addon: addonName ?? featureLabel('ai_suite', locale),
            })}
        </p>
        {price !== undefined && (
          <p className="mt-4 font-display text-3xl font-bold">
            {/* The price stays a plain string: money is US-formatted in every language. */}
            {t.rich('addon.pricePerMonth', {
              price: String(price),
              unit: (chunks) => <span className="ml-1 text-sm font-normal text-muted-foreground">{chunks}</span>,
            })}
          </p>
        )}
        <Link href={`/b/${branchId}/settings/plan`} className="mt-6 inline-block">
          <Button variant="gradient" leftIcon={<Sparkles className="h-4 w-4" />}>
            {t('lockedFeature.viewPackages')}
          </Button>
        </Link>
      </Card>
    </div>
  );
}
