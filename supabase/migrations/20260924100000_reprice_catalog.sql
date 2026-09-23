-- New prices, owner decision 2026-09-24 (docs/PACKAGING-2026-09-23.md §1, amended the next day):
--
--   Base            $170 once (first branch included)   $29 a month
--   Extra branch     $70 once per branch                $29 a month
--   Delivery          —  (no one-time fee any more)     +$30 a month per delivering branch
--
-- so a branch is $29 a month without delivery and $59 with it.
--
-- Only the catalog changes. Everything that prices reads billing_products: the plan page, the
-- landing page, request_package_change / billing_price_one_time (one-time), and
-- private.billing_compute, which prices the delivery line from the catalog on every recompute.
-- Updating delivery's monthly_price fires billing_products_recompute, so every restaurant that
-- holds delivery is re-billed at $30 per delivering branch straight away. Base and extra branch
-- stay $29 a month, so their subscription_items snapshots are already right.
--
-- One-time charges already recorded in billing_charges keep the amounts they were bought at:
-- they are history, not a price list. A pending request is re-priced by its merchant (or
-- decided as filed) — there are none open at the time of writing.

update public.billing_products
   set one_time_price = 170, monthly_price = 29, updated_at = now()
 where code = 'base';

update public.billing_products
   set one_time_price = 70, monthly_price = 29, updated_at = now()
 where code = 'extra_branch';

update public.billing_products
   set one_time_price = 0, monthly_price = 30, updated_at = now()
 where code = 'delivery';

-- Settle every restaurant once more, whatever it holds, so billing_entitlements.monthly_total is
-- the new arithmetic everywhere (the trigger above only reaches holders of the changed codes).
do $$
declare
  r record;
begin
  for r in select id from public.restaurants loop
    perform private.billing_compute(r.id);
  end loop;
end $$;
