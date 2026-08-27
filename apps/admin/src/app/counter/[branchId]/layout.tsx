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
    return (
      <AccessDenied
        title="No counter access"
        reason={`Your account doesn't have counter access for ${branch.name}. Ask your manager to invite you as a cashier, server or manager.`}
      />
    );
  }

  return <>{children}</>;
}
