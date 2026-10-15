import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ConfirmLinkView } from './_components/confirm-link-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth');
  return { title: t('metadata.confirmLinkTitle') };
}

export default function ConfirmLinkPage() {
  return <ConfirmLinkView />;
}
