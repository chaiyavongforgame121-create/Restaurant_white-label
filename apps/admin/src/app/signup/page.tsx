import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SignupView } from './_components/signup-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth');
  return {
    title: t('metadata.signupTitle'),
    description: t('metadata.signupDescription'),
  };
}

export default function SignupPage() {
  return <SignupView />;
}
