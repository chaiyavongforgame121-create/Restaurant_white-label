import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getBranchAccess } from '@/lib/capabilities';
import { PageAccessDenied } from '@/components/page-access-denied';
import { HappyHoursManager } from './_components/happy-hours-manager';

interface Props {
  params: Promise<{ branchId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('menuExtras');
  return { title: t('happyHours.metaTitle') };
}

export default async function HappyHoursPage({ params }: Props) {
  const { branchId } = await params;
  // happy_hours is written under user_manages_branch (owner, admin, manager); menu.manage is
  // held by exactly those roles, and a happy hour is a menu price. A cashier stays out.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/menu/happy-hours`);
  if (!can('menu.manage')) return <PageAccessDenied area="menu" branchName={branch.name} />;
  const [{ data: hours }, { data: items }, { data: categories }] = await Promise.all([
    supabase
      .from('happy_hours')
      .select('id, name, applies_to_item_ids, applies_to_category_ids, discount_type, discount_value, days_of_week, start_time, end_time, is_active, display_order')
      .eq('branch_id', branchId)
      .order('display_order')
      .order('start_time'),
    supabase.from('menu_items').select('id, name').eq('branch_id', branchId).eq('is_active', true).order('name'),
    supabase.from('menu_categories').select('id, name').eq('branch_id', branchId).order('display_order'),
  ]);

  return (
    <HappyHoursManager
      branchId={branchId}
      initialHours={(hours ?? []) as never[]}
      menuItems={(items ?? []) as never[]}
      categories={(categories ?? []) as never[]}
    />
  );
}
