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

  // Force the light, warm "Sunset" kitchen aesthetic regardless of the app theme.
  // The board paints its own full-height surface; this cream backstop matches it
  // so any overscroll/safe-area shows the same warm tone (never the dark app shell).
  return <div className="min-h-dynamic-screen" style={{ background: '#FCF3EA' }}>{children}</div>;
}
