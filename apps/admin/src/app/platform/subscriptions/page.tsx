import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getServerClient } from '@favornoms/database/server';
import {
  isPlatformAdmin,
  listBillingProducts,
  listRestaurantSubscriptions,
  type BillingCharge,
} from '@favornoms/database/queries';
import { PlatformAccessDenied } from '../_components/platform-nav';
import type { PlatformBranchLite } from '../_components/platform-billing';
import { SubscriptionsManager } from './_components/subscriptions-manager';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('platformBilling');
  return { title: t('subscriptions.metaTitle') };
}

export default async function PlatformSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const supabase = await getServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/platform/subscriptions');
  if (!(await isPlatformAdmin(supabase))) return <PlatformAccessDenied />;

  const [{ q }, rows, catalog] = await Promise.all([
    searchParams,
    listRestaurantSubscriptions(supabase),
    listBillingProducts(supabase),
  ]);

  const ids = rows.map((r) => r.restaurant_id);

  // Setting a package now names the branches that deliver, so the picker needs
  // every branch — hidden ones included. A hidden branch still holds its
  // branch_addons row, and leaving it out of the list would quietly switch its
  // delivery off the next time anything on that card was saved.
  //
  // billing_charges is read straight off the table: the platform-admin policy is
  // the only select policy it has, and merchants reach it solely through
  // get_billing_overview.
  const [branchesRes, chargesRes] = await Promise.all([
    supabase
      .from('branches')
      .select('id, restaurant_id, name, is_active')
      .in('restaurant_id', ids)
      .order('created_at', { ascending: true }),
    supabase
      .from('billing_charges')
      .select(
        'id, restaurant_id, branch_id, code, amount, discount_code, discount_amount, net_amount, status, created_at',
      )
      .in('restaurant_id', ids)
      .order('created_at', { ascending: false }),
  ]);

  const branches: Record<string, PlatformBranchLite[]> = {};
  for (const b of branchesRes.data ?? []) {
    (branches[b.restaurant_id] ??= []).push({
      id: b.id,
      name: b.name,
      isActive: b.is_active,
    });
  }

  // A failed read stays null all the way to the card, which then says the ledger
  // could not be read. Rendering it as an empty history would tell an operator
  // that nothing has ever been paid — the one mistake that gets a merchant
  // charged twice for the same branch.
  let charges: Record<string, BillingCharge[]> | null = null;
  if (!chargesRes.error) {
    charges = {};
    for (const c of chargesRes.data ?? []) {
      (charges[c.restaurant_id] ??= []).push({
        id: c.id,
        code: c.code,
        branchId: c.branch_id,
        amount: Number(c.amount ?? 0),
        discountCode: c.discount_code,
        discountAmount: Number(c.discount_amount ?? 0),
        netAmount: Number(c.net_amount ?? 0),
        status: c.status,
        createdAt: c.created_at,
      });
    }
  }

  return (
    <SubscriptionsManager
      rows={rows}
      catalog={catalog}
      branches={branches}
      charges={charges}
      initialQuery={q ?? ''}
      nowMs={Date.now()}
    />
  );
}
