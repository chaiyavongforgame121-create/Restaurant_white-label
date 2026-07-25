import { getServerClient } from '@favornoms/database/server';
import { getEntitlementsForBranch } from '@favornoms/database/queries';
import { hasFeature } from '@favornoms/shared';
import { LockedFeature } from '@/components/locked-feature';

interface Props {
  params: Promise<{ branchId: string }>;
}

export const metadata = { title: 'AI Voice Assistant · Favornoms' };

// Sold, not built — see the note in ../signage/page.tsx.
export default async function AiVoicePage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const ent = await getEntitlementsForBranch(supabase, branchId);

  if (!hasFeature(ent, 'ai_voice')) {
    return (
      <LockedFeature
        branchId={branchId}
        feature="ai_voice"
        addonName="AI Suite"
        price={59}
        comingSoon
        description="An AI assistant that answers the phone and takes orders. Part of the AI Suite add-on."
      />
    );
  }

  return (
    <LockedFeature
      branchId={branchId}
      feature="ai_voice"
      comingSoon
      description="AI Voice is included in your package and is being built. We'll turn it on for you the moment it ships — no extra charge."
    />
  );
}
