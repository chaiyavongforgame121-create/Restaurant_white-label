import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { UpdatePasswordView } from './_components/update-password-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth');
  return { title: t('metadata.updatePasswordTitle') };
}

interface Props {
  searchParams: Promise<{ welcome?: string }>;
}

export default async function UpdatePasswordPage({ searchParams }: Props) {
  const { welcome } = await searchParams;
  return <UpdatePasswordView welcome={welcome === '1'} />;
}
