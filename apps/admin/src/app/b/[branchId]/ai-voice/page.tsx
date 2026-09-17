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
  const feature = featureLabel('ai_voice', isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);
  return { title: t('lockedFeature.metaTitle', { feature }) };
}

// Sold, not built — see the note in ../signage/page.tsx.
export default async function AiVoicePage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const ent = await getEntitlementsForBranch(supabase, branchId);
  const t = await getTranslations('misc');

  if (!hasFeature(ent, 'ai_voice')) {
    return (
      <LockedFeature
        branchId={branchId}
        feature="ai_voice"
        addonName="AI Suite"
        price={59}
        comingSoon
        description={t('lockedFeature.aiVoiceLocked')}
      />
    );
  }

  return (
    <LockedFeature
      branchId={branchId}
      feature="ai_voice"
      comingSoon
      description={t('lockedFeature.aiVoiceIncluded')}
    />
  );
}
