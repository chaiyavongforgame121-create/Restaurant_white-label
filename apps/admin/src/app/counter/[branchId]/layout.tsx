import { requireBranchRole } from '@/lib/auth';
import { AccessDenied } from '@/components/access-denied';

const COUNTER_ROLES = ['owner', 'manager', 'cashier', 'staff'] as const;

interface Props {
  params: Promise<{ branchId: string }>;
  children: React.ReactNode;
}

export default async function CounterLayout({ params, children }: Props) {
  const { branchId } = await params;
  const { branch, membership } = await requireBranchRole(
    branchId,
    COUNTER_ROLES,
    `/counter/${branchId}`,
  );

  if (!membership) {
    return (
      <AccessDenied
        title="No counter access"
        reason={`Your account doesn't have counter access for ${branch.name}. Ask your manager to invite you as cashier or manager.`}
      />
    );
  }

  return <>{children}</>;
}
