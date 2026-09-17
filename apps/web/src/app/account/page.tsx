import { getTranslations } from 'next-intl/server';
import { AccountView } from './_components/account-view';

export async function generateMetadata() {
  const t = await getTranslations('help');
  return { title: t('account.metaTitle') };
}

export default function AccountPage() {
  return <AccountView />;
}
