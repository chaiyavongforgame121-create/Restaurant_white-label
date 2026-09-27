import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getServerClient } from '@favornoms/database/server';
import { isPlatformAdmin, listPlatformBillingEvents } from '@favornoms/database/queries';
import { PlatformAccessDenied } from '../_components/platform-nav';
import { BillingSetupView } from './_components/billing-setup-view';
import { supabaseSecretsUrl, webhookEndpointFor } from './_components/setup-model';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('platformBilling');
  return { title: t('stripe.setup.metaTitle') };
}

// The platform's own Stripe (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §6): the setup
// checklist, the "Charge packages by card" switch, and the package-payment event log.
//
// Stripe's status is NOT read here. It comes from the stripe-billing edge function, which
// asks Stripe for the account on every call; reading it in the browser lets the checklist
// and its instructions render at once — they matter most exactly when that function is
// dormant or unreachable — and lets the switch refresh the status without a page load.
export default async function PlatformBillingSetupPage() {
  const supabase = await getServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/platform/billing-setup');

  // Server-side gate, like every platform page. The edge function checks the caller's
  // is_platform_admin claim itself, so this only decides what renders.
  if (!(await isPlatformAdmin(supabase))) return <PlatformAccessDenied />;

  // platform_billing_events leaves Connect's events (diners paying restaurants) out: this
  // page is about restaurants paying the platform. A failed read resolves to [], which
  // the table words neutrally ("nothing to show"), never as "no payment ever arrived".
  const events = await listPlatformBillingEvents(supabase, null, 30);

  const ids = [...new Set(events.map((e) => e.restaurantId).filter((id): id is string => Boolean(id)))];
  const restaurantNames: Record<string, string> = {};
  if (ids.length > 0) {
    const { data } = await supabase.from('restaurants').select('id, name').in('id', ids);
    for (const r of data ?? []) restaurantNames[r.id] = r.name;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return (
    <BillingSetupView
      events={events}
      restaurantNames={restaurantNames}
      webhookUrl={webhookEndpointFor(supabaseUrl)}
      secretsUrl={supabaseSecretsUrl(supabaseUrl)}
    />
  );
}
