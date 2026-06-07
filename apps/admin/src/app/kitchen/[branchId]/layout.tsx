import { requireBranchRole } from '@/lib/auth';
import { AccessDenied } from '@/components/access-denied';

const KITCHEN_ROLES = ['kitchen', 'owner', 'manager'] as const;

interface Props {
  params: Promise<{ branchId: string }>;
  children: React.ReactNode;
}

export default async function KitchenLayout({ params, children }: Props) {
  const { branchId } = await params;
  const { branch, membership } = await requireBranchRole(
    branchId,
    KITCHEN_ROLES,
    `/kitchen/${branchId}`,
  );

  if (!membership) {
    return (
      <AccessDenied
        title="No kitchen access"
        reason={`Your account can't open the kitchen display for ${branch.name}.`}
      />
    );
  }

  // Force the dark, fullscreen kitchen aesthetic regardless of the app theme.
  return <div className="dark min-h-dynamic-screen bg-background text-foreground">{children}</div>;
}
