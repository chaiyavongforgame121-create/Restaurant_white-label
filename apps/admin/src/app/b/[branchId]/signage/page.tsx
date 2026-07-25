import { getServerClient } from '@favornoms/database/server';
import { getEntitlementsForBranch } from '@favornoms/database/queries';
import { hasFeature } from '@favornoms/shared';
import { LockedFeature } from '@/components/locked-feature';

interface Props {
  params: Promise<{ branchId: string }>;
}

export const metadata = { title: 'Digital Signage · Favornoms' };

// Sold, not built (owner decision 2026-07-25). The entitlement is real — the
// surface behind it is deliberately a placeholder, so an entitled restaurant
// sees "coming soon" rather than a 404 that reads like a bug.
export default async function SignagePage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const ent = await getEntitlementsForBranch(supabase, branchId);

  if (!hasFeature(ent, 'digital_signage')) {
    return (
      <LockedFeature
        branchId={branchId}
        feature="digital_signage"
        addonName="AI Suite"
        price={59}
        comingSoon
        description="Menu boards and promo screens driven straight from your live menu. Part of the AI Suite add-on."
      />
    );
  }

  return (
    <LockedFeature
      branchId={branchId}
      feature="digital_signage"
      comingSoon
      description="Digital Signage is included in your package and is being built. We'll turn it on for you the moment it ships — no extra charge."
    />
  );
}
