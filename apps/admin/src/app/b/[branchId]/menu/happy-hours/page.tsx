import { getServerClient } from '@favornoms/database/server';
import { HappyHoursManager } from './_components/happy-hours-manager';

interface Props {
  params: Promise<{ branchId: string }>;
}

export const metadata = { title: 'Happy hours · Favornoms admin' };

export default async function HappyHoursPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
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
