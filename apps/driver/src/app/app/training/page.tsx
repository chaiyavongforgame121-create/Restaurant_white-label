import { getTranslations } from 'next-intl/server';
import { TrainingView } from './_components/training-view';

export async function generateMetadata() {
  const t = await getTranslations('onboarding');
  return { title: t('training.metaTitle') };
}

export default function TrainingPage() {
  return <TrainingView />;
}
