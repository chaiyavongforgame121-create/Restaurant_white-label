import { getTranslations } from 'next-intl/server';
import { DocumentsView } from '../_components/documents-view';

export async function generateMetadata() {
  const t = await getTranslations('profile');
  return { title: t('documents.metaTitle') };
}

export default function DriverDocumentsPage() {
  return <DocumentsView />;
}
