import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { getServerClient } from '@favornoms/database/server';
import { getEntitlementsForBranch } from '@favornoms/database/queries';
import { DEFAULT_UI_LOCALE, featureLabel, hasFeature, isUiLocale } from '@favornoms/shared';
import { LockedFeature } from '@/components/locked-feature';

interface Props {
  params: Promise<{ branchId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const [t, locale] = await Promise.all([getTranslations('misc'), getLocale()]);
  const feature = featureLabel('digital_signage', isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);
  return { title: t('lockedFeature.metaTitle', { feature }) };
}

// Sold, not built (owner decision 2026-07-25). The entitlement is real — the
// surface behind it is deliberately a placeholder, so an entitled restaurant
// sees "coming soon" rather than a 404 that reads like a bug.
export default async function SignagePage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const ent = await getEntitlementsForBranch(supabase, branchId);
  const t = await getTranslations('misc');

  if (!hasFeature(ent, 'digital_signage')) {
    return (
      <LockedFeature
        branchId={branchId}
        feature="digital_signage"
        addonName="AI Suite"
        price={59}
        comingSoon
        description={t('lockedFeature.signageLocked')}
      />
    );
  }

  return (
    <LockedFeature
      branchId={branchId}
      feature="digital_signage"
      comingSoon
      description={t('lockedFeature.signageIncluded')}
    />
  );
}
