import { getTranslations } from 'next-intl/server';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';

interface Props {
  params: Promise<{ branchId: string }>;
  children: React.ReactNode;
}

export default async function CounterLayout({ params, children }: Props) {
  const { branchId } = await params;
  const { branch, can } = await getBranchAccess(branchId, `/counter/${branchId}`);

  if (!can('counter.access')) {
    const t = await getTranslations('counter');
    return (
      <AccessDenied
        title={t('access.title')}
        reason={t('access.reason', { branch: branch.name })}
      />
    );
  }

  return <>{children}</>;
}
