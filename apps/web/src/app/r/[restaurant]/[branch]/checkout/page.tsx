import { getServerClient } from '@favornoms/database/server';
import { resolveStorefrontStatus, resolveTenant, storefrontNames } from '@/lib/tenant';
import { CheckoutView } from './_components/checkout-view';
import { OrderTypeGate } from '../_components/order-type-gate';
import { resolveScheduleDelivery } from '@/lib/schedule-delivery';
import { SuspendedStorefront } from '../_components/suspended-storefront';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function CheckoutPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const status = await resolveStorefrontStatus(tenant.branch.id);
  if (!status.entitled) {
    return <SuspendedStorefront brandName={storefrontNames(tenant).full} />;
  }
  // Sales tax is a branches COLUMN, not a settings key, so resolveTenant does not
  // carry it. Read it here: the summary must show the tax place-order will charge
  // from the first paint, not discover it a round-trip later.
  const supabase = await getServerClient();
  // Open right now: Pickup is always prepared immediately, so a closed branch cannot take one.
  const [{ data: taxRow }, { data: openNow }, scheduleDelivery] = await Promise.all([
    supabase.from('branches').select('sales_tax_rate').eq('id', tenant.branch.id).maybeSingle(),
    supabase.rpc('is_branch_open', { p_branch_id: tenant.branch.id }),
    resolveScheduleDelivery(supabase, tenant.branch.id, status),
  ]);
  const base = `/r/${restaurant}/${branch}`;
  // Deep links reach checkout without passing the menu — same gate, same rules.
  return (
    <>
      <OrderTypeGate
        branchId={tenant.branch.id}
        branchName={tenant.branch.name}
        canDeliver={scheduleDelivery.canDeliver}
      />
      <CheckoutView
        branchId={tenant.branch.id}
        base={base}
        canDeliver={scheduleDelivery.canDeliver}
        // Only an explicit false: a failed read must not block ordering, and place-order still
        // refuses a pickup at a closed branch.
        pickupOpenNow={openNow !== false}
        ordersPaused={scheduleDelivery.paused}
        canUseCard={status.card_payment}
        // Both money inputs mirror place-order's `?? 0` fallback: a branch with
        // neither configured is charged nothing, so it must be shown nothing.
        salesTaxRate={Number(taxRow?.sales_tax_rate ?? 0)}
        serviceFeePercent={Number(tenant.branch.settings.serviceFeePercent ?? 0)}
        // The branch's own hours and scheduling policy, so the picker offers times the
        // server will actually accept instead of any moment the diner's clock can express.
        scheduling={{
          enabled: status.scheduling_enabled,
          timezone: status.timezone,
          openingHours: status.opening_hours,
          minLeadMinutes: status.schedule_min_lead_min,
          maxDays: status.schedule_max_days,
          slotMinutes: status.schedule_slot_minutes,
          // Every storefront delivery is booked, so its slots must sit inside delivery hours too.
          deliveryWindows: status.delivery_hours_on ? status.delivery_windows : null,
        }}
      />
    </>
  );
}
