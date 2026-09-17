import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ForgotPasswordView } from './_components/forgot-password-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth');
  return { title: t('metadata.forgotPasswordTitle') };
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordView />;
}
