-- =============================================================================
-- Favornoms — Flow Audit Fixes (DB)   ·   started 2026-06-07
-- =============================================================================
-- This project applies migrations via the Supabase MCP (`apply_migration`), so
-- there is no local supabase/migrations/ folder. These statements are the DB
-- fixes found during the cross-role flow audit. Apply each block either via
-- `mcp__supabase__apply_migration` (preferred — records it in schema history)
-- or by pasting into the Supabase SQL editor.
--
-- Each block is named like a migration and is safe to re-run (idempotent).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- FIX A — deliveries_sync_order_status  [CRITICAL · delivery-first]
-- -----------------------------------------------------------------------------
-- BUG: The driver app advances a delivery (deliveries.status) but nothing ever
-- propagated that to the parent orders.status. Result for the PRIMARY (delivery)
-- channel:
--   * customer order-tracking progress bar was stuck at 'ready' forever
--     (never reached out_for_delivery / completed),
--   * loyalty points were NEVER awarded (orders_on_complete_award_loyalty fires
--     only when orders.status becomes 'completed'),
--   * orders stayed "open" at 'ready', skewing completion metrics/reports.
-- A SECURITY DEFINER trigger is required because drivers have no RLS UPDATE grant
-- on public.orders, so the fix cannot live in client code.

create or replace function public.deliveries_sync_order_status()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if (TG_OP <> 'UPDATE') then
    return new;
  end if;
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'picked_up' then
    update public.orders
       set status = 'out_for_delivery'
     where id = new.order_id
       and status in ('confirmed','preparing','ready');

  elsif new.status = 'delivered' then
    update public.orders
       set status = 'completed',
           completed_at = coalesce(completed_at, now())
     where id = new.order_id
       and status <> 'completed';
  end if;

  return new;
end;
$$;

drop trigger if exists deliveries_sync_order_status on public.deliveries;
create trigger deliveries_sync_order_status
after update on public.deliveries
for each row execute function public.deliveries_sync_order_status();
-- APPLIED 2026-06-07 via MCP (migration deliveries_sync_order_status). Verified by live sim.


-- -----------------------------------------------------------------------------
-- FIX B — award-loyalty type 'earn' -> 'earned'  [CRITICAL · breaks ALL completions]
-- -----------------------------------------------------------------------------
-- BUG: orders_on_complete_award_loyalty() inserted loyalty_transactions.type='earn',
-- but CHECK loyalty_transactions_type_check allows only ('earned','redeemed','expired',
-- 'adjusted'). So ANY order reaching 'completed' with a customer_id raised a constraint
-- violation that rolled back the completion (pickup/dine-in bump AND delivery). Latent
-- because guest orders skip loyalty and (per FIX A) delivery orders never completed.
-- The corrected function body is in the live DB; the only change vs the original is the
-- single literal 'earn' -> 'earned' in the final INSERT. See migration
-- fix_award_loyalty_type_earned.
-- APPLIED 2026-06-07 via MCP. Verified by live sim: ready -> out_for_delivery ->
-- completed, loyalty_transactions 'earned' row created (100 pts on $100 subtotal).


-- -----------------------------------------------------------------------------
-- FIX C — cancel_order: allow 'kitchen' role (so kitchen Reject restores stock)
-- -----------------------------------------------------------------------------
-- BUG: the kitchen "Reject" button did a raw orders.update(status='cancelled'),
-- bypassing cancel_order() — so stock for track_stock items was never restored and no
-- reason was logged. The client now calls cancel_order(); this adds 'kitchen' to its
-- staff allow-list so kitchen staff are authorized to reject (a normal merchant action).
-- Full function re-created in the live DB with role IN ('owner','manager','cashier',
-- 'kitchen'); everything else (stock restore, reason log, guards) unchanged.
-- APPLIED 2026-06-07 via MCP (migration cancel_order_allow_kitchen_role). Client rewired
-- in apps/admin/src/app/kitchen/[branchId]/_components/kitchen-view.tsx.


-- -----------------------------------------------------------------------------
-- FIX D — onboarding default timezone Asia/Bangkok -> America/New_York  [minor]
-- -----------------------------------------------------------------------------
-- BUG: the onboarding wizard never passes p_timezone, so create_restaurant_with_branch's
-- default applied — and it was still the legacy Bangkok zone, giving every new US
-- restaurant the wrong timezone (skews reports/hours until manually fixed). Only the
-- function's DEFAULT changed.
-- APPLIED 2026-06-07 via MCP (migration onboarding_default_timezone_us).
