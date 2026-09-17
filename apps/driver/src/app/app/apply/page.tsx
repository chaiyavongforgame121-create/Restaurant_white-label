import { getTranslations } from 'next-intl/server';
import { ApplyView } from './_components/apply-view';

export async function generateMetadata() {
  const t = await getTranslations('onboarding');
  return { title: t('apply.metaTitle') };
}

export default function ApplyPage() {
  return <ApplyView />;
}
