-- "Prep time" is also when a booked order reaches the kitchen (the owner's decision of 2026-11-16,
-- docs/ASAP-AND-SCHEDULING-2026-10-25.md §3). A booking went to the kitchen
-- branches.settings.schedule_lead_time_min minutes before its booked time ("Send to kitchen (minutes
-- before)" on the Scheduled orders card), a figure of its own beside prep_time_min ("Prep time" on
-- the Delivery card, the baseline kitchen time in customer ETAs). Two figures for one kitchen drift
-- apart: a prep time of 30 with a lead of 5 told the diner 30 minutes of cooking and gave the
-- kitchen 5. There is one figure now, so a new prep time moves the ETA and the kitchen time together.
--
-- THE RULE (the same in all three readers):
--   kitchen lead = prep + busy, at most 10080 (a week), where
--     prep = prep_time_min       if it is a whole number 0-10080, else 15;
--     busy = busy_extra_prep_min if it is a whole number 0-10080, else 0.
--   schedule_lead_time_min is no longer read. Busy is in it because a diner's ETA is prep + busy
--   (quote_delivery, heuristicEtaMin): while the kitchen is in busy mode a booking must reach it that
--   much earlier, and the release job, which reads the settings at every run, lets held bookings out
--   that much earlier on its own.
--   The readers: private.branch_kitchen_lead_min (below; release_scheduled_orders calls it),
--   kitchenLeadMin() in supabase/functions/place-order/kitchen-lead.ts (place-order decides "held"
--   at insert) and in packages/shared/src/utils/kitchen-lead.ts (the kitchen board, the counter, the
--   dashboard, the settings cards). All three run one case table
--   (supabase/functions/place-order/kitchen-lead.cases.ts, mirrored line by line in the SQL test).
--
-- 1. private.branch_kitchen_lead_min(jsonb) is re-created from its live definition
--    (pg_get_functiondef, 2026-11-16) with the new body and comment. The signature, the return type,
--    plpgsql, IMMUTABLE, PARALLEL SAFE, SECURITY INVOKER and the search_path are as live; CREATE OR
--    REPLACE keeps the owner and the grants, and the revoke of 20261025100000 is repeated so a stack
--    built from the migrations ends the same (no API role may call it). It still never raises,
--    whatever the settings hold.
--
-- 2. LEFT AS THEY ARE: private.release_scheduled_orders already reads the lead through this function.
--    patch_branch_settings keeps refusing a schedule_lead_time_min that is not a whole number 0-10080,
--    so an older admin that still saves one is not refused and nothing bad is stored; branches keep
--    the key, unread. busy_extra_prep_min stays 0-240 there, inside this rule's range.
--
-- Read live on 2026-11-16: no order is held, so no booking changes its kitchen time at deploy. A
-- branch whose saved lead differs from its prep time sends bookings to the kitchen at its prep time
-- (plus busy) from now on.
--
-- Deploy: this migration and place-order v11.12 together. place-order decides "held" at insert by
-- its copy and the release job lets the booking out by this one; while only one of them is out, they
-- differ by (old lead - new lead), so a booking reaches the kitchen that much earlier or later. It is
-- never lost: one that is not held is on the board at once, and a held one is let out by the first
-- minute run after its kitchen time. The admin reads the shared copy and follows when it deploys.
--
-- Rolled-back checks: supabase/tests/kitchen_lead_is_prep_time.sql (and
-- supabase/tests/scheduling_release.sql, whose release timing now leans on this rule).

begin;

-- PL/pgSQL rather than SQL on purpose: a LANGUAGE sql function is inlined, and the planner folds a
-- constant argument's casts before a CASE guard can skip them, so ('{"prep_time_min":"abc"}')
-- could raise at plan time. Here each value is cast only after it is known to be a number.
create or replace function private.branch_kitchen_lead_min(p_settings jsonb)
returns integer
language plpgsql
immutable
parallel safe
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_value   jsonb;
  v_minutes numeric;
  v_prep    integer := 15;
  v_busy    integer := 0;
begin
  -- -> on a non-object (null, an array, a scalar) is null, never an error.
  v_value := p_settings -> 'prep_time_min';
  if jsonb_typeof(v_value) = 'number' then
    v_minutes := v_value::numeric;
    if v_minutes >= 0 and v_minutes <= 10080 and v_minutes = trunc(v_minutes) then
      v_prep := v_minutes::integer;
    end if;
  end if;

  -- Busy mode's extra minutes, the same part of the diner's ETA.
  v_value := p_settings -> 'busy_extra_prep_min';
  if jsonb_typeof(v_value) = 'number' then
    v_minutes := v_value::numeric;
    if v_minutes >= 0 and v_minutes <= 10080 and v_minutes = trunc(v_minutes) then
      v_busy := v_minutes::integer;
    end if;
  end if;

  -- A week at most, the ceiling every reader shares (the sum of two valid parts can pass it).
  return least(v_prep + v_busy, 10080);
end
$function$;

comment on function private.branch_kitchen_lead_min(jsonb) is
  'Minutes before its booked time a scheduled order goes to the kitchen: the prep time (settings.prep_time_min '
  'if it is a whole number 0-10080, else 15) plus busy mode (busy_extra_prep_min if it is a whole number 0-10080, '
  'else 0), at most 10080. schedule_lead_time_min is not read. Never raises. Same rule as kitchenLeadMin() in '
  'packages/shared/src/utils/kitchen-lead.ts and supabase/functions/place-order/kitchen-lead.ts.';

-- As live (20261025100000): no API role may call it.
revoke all on function private.branch_kitchen_lead_min(jsonb) from public, anon, authenticated;

commit;
