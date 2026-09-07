import { listTableStates } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { FloorBoard } from '@/app/b/[branchId]/tables/_components/floor-board';

interface Props {
  params: Promise<{ branchId: string }>;
}

/**
 * The floor, from the till.
 *
 * The same board as the back office, imported rather than copied — the same cross-surface
 * reuse the counter's Recent orders already makes of OrderReceiptButton. A cashier settling
 * a table must be looking at exactly what a manager is looking at; two implementations of
 * "what does table 7 owe" is how the drawer and the books start disagreeing.
 *
 * The counter layout has already refused anyone without counter.access, so this only has to
 * ask which of the finer rights the caller holds.
 */
export default async function CounterTablesPage({ params }: Props) {
  const { branchId } = await params;
  const { supabase, branch, can } = await getBranchAccess(branchId, `/counter/${branchId}/tables`);
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
