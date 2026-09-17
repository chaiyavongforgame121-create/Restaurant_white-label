import { getTranslations } from 'next-intl/server';
import { listTableStates } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { FloorBoard } from './_components/floor-board';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function TablesPage({ params }: Props) {
  const { branchId } = await params;
  // counter.access, not branch.settings: working the floor is the cashier's and the
  // server's job, and it is the same right the RPCs behind these buttons check. Printing
  // the codes stays with the owner, over on /qr/tables.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/tables`);

  if (!can('counter.access')) {
    const t = await getTranslations('tables');
    return (
      <AccessDenied
        title={t('accessDenied.title')}
        reason={t('accessDenied.reason', { branch: branch.name })}
      />
    );
  }

  const { tables, sessions } = await listTableStates(supabase, branchId);

  return (
    <FloorBoard
      branchId={branchId}
      branchName={branch.name}
      initialTables={tables}
      initialSessions={sessions}
      canSettle={can('counter.access')}
      canVoid={can('payments.decide')}
      canSetup={can('branch.settings')}
    />
  );
}
