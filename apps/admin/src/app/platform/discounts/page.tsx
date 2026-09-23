import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getServerClient } from '@favornoms/database/server';
import {
  isPlatformAdmin,
  listBillingProducts,
  listBillingRequests,
  listDiscountCodes,
  listDiscountRedemptions,
  type DiscountRedemption,
} from '@favornoms/database/queries';
import { PlatformAccessDenied } from '../_components/platform-nav';
import { DiscountsManager } from './_components/discounts-manager';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('platformBilling');
  return { title: t('discounts.metaTitle') };
}

export default async function PlatformDiscountsPage() {
  const supabase = await getServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/platform/discounts');

  // Server-side gate. Every RPC below refuses a non-admin anyway, but a denied
  // read resolves to an empty list, which would render as "no codes yet".
  if (!(await isPlatformAdmin(supabase))) return <PlatformAccessDenied />;

  // The whole catalog, withdrawn products included: a code written months ago may
  // name one, and its chip should still say what it was rather than a bare slug.
  //
  // The pending requests are read too. A code's use is RESERVED the moment a merchant sends
  // a request with it (request_package_change), kept when the request is approved and given
  // back when it is rejected or replaced — so a redemption row tied to a request that is
  // still pending is money promised, not money given away yet, and the card says which.
  // The server marks each row itself; the pending list is what answers for a read that does
  // not carry that mark (see isReservedUse()).
  const [codes, catalog, pending] = await Promise.all([
    listDiscountCodes(supabase),
    listBillingProducts(supabase, true),
    listBillingRequests(supabase, 'pending'),
  ]);

  // platform_list_discount_redemptions takes one code id, so the rows are fetched
  // per code — but only for codes that have actually been used. redemption_count
  // is the counter the redemption ledger itself maintains, so a code sitting at
  // zero cannot have rows to miss.
  const used = codes.filter((c) => c.redemption_count > 0);
  const lists = await Promise.all(used.map((c) => listDiscountRedemptions(supabase, c.id)));
  const redemptions: Record<string, DiscountRedemption[]> = {};
  used.forEach((c, i) => {
    redemptions[c.id] = lists[i] ?? [];
  });

  return (
    <DiscountsManager
      codes={codes}
      redemptions={redemptions}
      pendingRequestIds={pending.map((r) => r.id)}
      catalog={catalog}
      nowMs={Date.now()}
    />
  );
}
