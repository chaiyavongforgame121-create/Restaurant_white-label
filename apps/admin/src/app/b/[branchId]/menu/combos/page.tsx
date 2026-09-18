import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { CombosManager } from './_components/combos-manager';
import { COMBO_SELECT, MENU_ITEM_SELECT, type ComboMenuItem, type ComboRecord } from './_components/combo-draft';

interface Props {
  params: Promise<{ branchId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('menuExtras');
  return { title: t('combos.metaTitle') };
}

export default async function CombosPage({ params }: Props) {
  const { branchId } = await params;
  const t = await getTranslations('menuExtras');

  // Only the sidebar link was gated. Anyone else who typed the URL got an editor whose every
  // write failed on RLS.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/menu/combos`);
  if (!can('menu.manage')) {
    return (
      <AccessDenied
        title={t('combos.accessDenied.title')}
        reason={t('combos.accessDenied.reason', { branch: branch.name })}
      />
    );
  }

  const [combosRes, itemsRes, branchRes] = await Promise.all([
    supabase
      .from('combo_sets')
      .select(COMBO_SELECT)
      .eq('branch_id', branchId)
      .order('display_order')
      .order('created_at')
      .order('id'),
    // Every dish of this branch, hidden and sold-out ones included: a combo can still hold one,
    // and the editor has to show it (with why it holds the deal up) so it can be removed.
    supabase.from('menu_items').select(MENU_ITEM_SELECT).eq('branch_id', branchId).order('name'),
    supabase.from('branches').select('settings').eq('id', branchId).maybeSingle(),
  ]);

  // A failed read used to render as "No combos yet". Log the raw text; the merchant gets a banner.
  const failures = [
    ['combo_sets', combosRes.error],
    ['menu_items', itemsRes.error],
    ['branches', branchRes.error],
  ].filter(([, err]) => !!err);
  for (const [what, err] of failures) console.error(`[combos] read ${what} failed`, err);

  const settings = (branchRes.data?.settings ?? {}) as Record<string, unknown>;

  return (
    <CombosManager
      branchId={branchId}
      currency={typeof settings.currency === 'string' && settings.currency ? settings.currency : 'USD'}
      loadFailed={failures.length > 0}
      initialCombos={(combosRes.data ?? []) as ComboRecord[]}
      initialMenuItems={(itemsRes.data ?? []) as ComboMenuItem[]}
    />
  );
}
