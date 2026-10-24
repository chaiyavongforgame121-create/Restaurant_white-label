-- "Send to kitchen (minutes before)" really works (owner request 2026-10-25,
-- docs/ASAP-AND-SCHEDULING-2026-10-25.md §3).
--
-- branches.settings.schedule_lead_time_min is how long before its booked time a scheduled order
-- reaches the kitchen: place-order holds it (held = true) and the minute cron job
-- private.release_scheduled_orders lets it out at scheduled_for - lead. A booking for 11:30 with 5
-- reaches the kitchen at 11:25. The two functions re-created below were copied from their live
-- definitions (pg_get_functiondef on 2026-10-25) with the same arguments, owner, grants,
-- SECURITY DEFINER and search_path; only the lines named here changed.
--
-- 1. ONE RESOLVER. private.branch_kitchen_lead_min(settings): schedule_lead_time_min if it is a
--    whole number 0-10080 (a week), else prep_time_min if that is, else 15. The same rule is
--    kitchenLeadMin() in packages/shared/src/utils/kitchen-lead.ts (the kitchen board, the
--    counter, the dashboard, the settings card) and in supabase/functions/place-order/
--    kitchen-lead.ts (the hold); kitchen-lead.test.ts pins the two copies to each other and to
--    this function's keys, ceiling and default. It never raises, whatever the settings hold.
--
-- 2. ONE BAD VALUE NO LONGER STOPS EVERY RELEASE. The job read the lead with
--    (settings->>'schedule_lead_time_min')::int, for every branch in one statement: a single 7.5
--    or "abc" on any branch made the cast raise, the job failed every minute, and no branch's
--    bookings reached the kitchen at all. It reads the resolver now; that branch falls back to its
--    prep time or 15 and every other branch is untouched.
--
-- 3. RELEASE ONLY WHAT THE KITCHEN WILL MAKE. The job let out every held order whose time had
--    come, cancelled, completed and refunded ones included, each with an 'order_released' row in
--    the outbox. It releases orders in an active status (pending, confirmed, preparing, ready)
--    only; anything else stays held, as it was.
--
-- 4. patch_branch_settings REFUSES A BAD LEAD OR PREP TIME, so neither can be saved again:
--    schedule_lead_time_min and prep_time_min, when the patch sets them, must be whole numbers from
--    0 to 10080 (a JSON number; "15" is refused). Otherwise P0001 'invalid_lead_time' or
--    'invalid_prep_time', with a hint naming the rule, and nothing is written. A JSON null still
--    removes the key. The permission checks come first, as before, and everything else is
--    unchanged. Existing values are not touched: the resolver reads a bad one as the default.
--
-- 5. THE RELEASE CRON JOB IS IN THE REPO. 'release-scheduled-orders' (every minute,
--    select private.release_scheduled_orders()) existed only in the live database (job 6), so a
--    stack built from the migrations never released a booking. It is created when missing and put
--    back to that schedule and command when it differs; a job that already matches (live) is left
--    as it is, with its id and history. Never a second one.
--
-- Rolled-back checks: supabase/tests/scheduling_release.sql.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. private.branch_kitchen_lead_min
-- ---------------------------------------------------------------------------------------------

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
  v_key     text;
  v_value   jsonb;
  v_minutes numeric;
begin
  foreach v_key in array array['schedule_lead_time_min', 'prep_time_min'] loop
    -- -> on a non-object (null, an array, a scalar) is null, never an error.
    v_value := p_settings -> v_key;
    if jsonb_typeof(v_value) = 'number' then
      v_minutes := v_value::numeric;
      if v_minutes >= 0 and v_minutes <= 10080 and v_minutes = trunc(v_minutes) then
        return v_minutes::integer;
      end if;
    end if;
  end loop;
  return 15;
end
$function$;

comment on function private.branch_kitchen_lead_min(jsonb) is
  'Minutes before its booked time a scheduled order goes to the kitchen: settings.schedule_lead_time_min '
  'if it is a whole number 0-10080, else prep_time_min if that is, else 15. Never raises. Same rule as '
  'kitchenLeadMin() in packages/shared/src/utils/kitchen-lead.ts and supabase/functions/place-order/kitchen-lead.ts.';

revoke all on function private.branch_kitchen_lead_min(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. private.release_scheduled_orders (live body; the lead and the status filter changed)
-- ---------------------------------------------------------------------------------------------

create or replace function private.release_scheduled_orders()
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
begin
  for r in
    select o.id, o.branch_id, o.order_number, o.scheduled_for
    from public.orders o
    join public.branches b on b.id = o.branch_id
    where o.held = true
      and o.scheduled_for is not null
      -- Only what the kitchen will make: a cancelled, completed or refunded booking stays held.
      and o.status = any (array['pending', 'confirmed', 'preparing', 'ready']::public.order_status[])
      -- The safe resolver, not a raw ::int cast: one branch's bad value no longer fails the job
      -- for every branch.
      and o.scheduled_for - make_interval(mins => private.branch_kitchen_lead_min(b.settings)) <= now()
    for update of o skip locked
  loop
    update public.orders set held = false where id = r.id;
    insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
    values (r.branch_id, 'staff', r.branch_id, 'in_app', 'order_released',
            jsonb_build_object('order_id', r.id, 'order_number', r.order_number, 'scheduled_for', r.scheduled_for));
  end loop;
end;
$function$;

revoke all on function private.release_scheduled_orders() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. public.patch_branch_settings (live body; the lead and prep time checks added)
-- ---------------------------------------------------------------------------------------------

create or replace function public.patch_branch_settings(p_branch_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  -- The kitchen's operations keys. Keep in step with v_ops_keys in
  -- private.guard_branch_privileged_columns().
  v_ops_keys constant text[] := array['orders_paused', 'busy_extra_prep_min'];
  -- What a caller without branch.settings is answered with: the ops keys plus the two the board
  -- reads for its scheduled-ticket clocks. Keep in step with OPS_SETTING_KEYS (kitchen-model.ts).
  v_board_keys constant text[] := array['orders_paused', 'busy_extra_prep_min', 'prep_time_min', 'schedule_lead_time_min'];
  v_can_settings boolean;
  v_can_ops      boolean;
  v_key          text;
  v_value        jsonb;
  v_minutes      numeric;
  v_set          jsonb  := '{}'::jsonb;
  v_remove       text[] := '{}'::text[];
  v_new          jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'invalid_patch'
      using errcode = '22023', hint = 'The patch must be a JSON object of settings keys.';
  end if;

  v_can_settings := private.staff_has_capability(p_branch_id, 'branch.settings');
  v_can_ops := v_can_settings or private.staff_has_capability(p_branch_id, 'kitchen.access');

  -- Every key needs at least one of the two, and so does the empty patch, which answers with the
  -- settings: without this check it read the settings of any branch, an inactive one included.
  if not v_can_ops then
    raise exception 'not_authorized'
      using errcode = '42501',
            hint = 'Branch settings need kitchen access or the branch settings permission at this branch.';
  end if;

  for v_key, v_value in select e.key, e.value from jsonb_each(p_patch) e loop
    if v_key = any (v_ops_keys) then
      if v_key = 'orders_paused' and jsonb_typeof(v_value) not in ('boolean', 'null') then
        raise exception 'invalid_setting_value'
          using errcode = '22023', hint = 'orders_paused must be true or false.';
      end if;

      if v_key = 'busy_extra_prep_min' and jsonb_typeof(v_value) <> 'null' then
        if jsonb_typeof(v_value) <> 'number' then
          raise exception 'invalid_setting_value'
            using errcode = '22023', hint = 'busy_extra_prep_min must be a whole number of minutes.';
        end if;
        v_minutes := v_value::numeric;
        if v_minutes < 0 or v_minutes > 240 or v_minutes <> trunc(v_minutes) then
          raise exception 'invalid_setting_value'
            using errcode = '22023', hint = 'busy_extra_prep_min must be a whole number from 0 to 240.';
        end if;
      end if;
    elsif not v_can_settings then
      raise exception 'not_authorized'
        using errcode = '42501',
              hint = 'Changing branch settings needs the branch settings permission at this branch.';
    end if;

    -- The kitchen lead and the prep time: whole minutes from 0 to a week, the only values
    -- private.branch_kitchen_lead_min (the release job), place-order's hold and the screens take.
    -- A value outside that was read differently by each of them (7.5 stopped the release job for
    -- every branch; place-order read "abc" as NaN and held nothing). A null still removes the key.
    if v_key in ('schedule_lead_time_min', 'prep_time_min') and jsonb_typeof(v_value) <> 'null' then
      if jsonb_typeof(v_value) = 'number' then
        v_minutes := v_value::numeric;
      else
        v_minutes := -1;  -- not a number: refused below like any other bad value
      end if;
      if v_minutes < 0 or v_minutes > 10080 or v_minutes <> trunc(v_minutes) then
        raise exception using
          message = case when v_key = 'prep_time_min' then 'invalid_prep_time' else 'invalid_lead_time' end,
          errcode = 'P0001',
          hint = v_key || ' must be a whole number of minutes from 0 to 10080.';
      end if;
    end if;

    if jsonb_typeof(v_value) = 'null' then
      v_remove := v_remove || v_key;
    else
      v_set := v_set || jsonb_build_object(v_key, v_value);
    end if;
  end loop;

  -- Nothing to change: answer with the current settings instead of writing the row (which would
  -- bump updated_at and the storefront version for nothing).
  if v_set = '{}'::jsonb and cardinality(v_remove) = 0 then
    select coalesce(b.settings, '{}'::jsonb) into v_new from public.branches b where b.id = p_branch_id;
    if not found then
      raise exception 'branch_not_found' using errcode = 'P0002';
    end if;
  else
    -- One statement: under a concurrent write the row is re-read after the lock is taken, so the
    -- merge always lands on the latest settings, never on a snapshot.
    update public.branches b
       set settings = (case when jsonb_typeof(b.settings) = 'object' then b.settings else '{}'::jsonb end
                       || v_set) - v_remove
     where b.id = p_branch_id
    returning b.settings into v_new;

    if not found then
      raise exception 'branch_not_found' using errcode = 'P0002';
    end if;
  end if;

  if v_can_settings then
    return v_new;
  end if;
  return coalesce(
    (select jsonb_object_agg(e.key, e.value)
       from jsonb_each(case when jsonb_typeof(v_new) = 'object' then v_new else '{}'::jsonb end) e
      where e.key = any (v_board_keys)),
    '{}'::jsonb);
end;
$function$;

comment on function public.patch_branch_settings(uuid, jsonb) is
  'Merge keys into branches.settings (a JSON null removes the key) and return the new settings. '
  'orders_paused / busy_extra_prep_min need kitchen.access or branch.settings; every other key needs branch.settings. '
  'schedule_lead_time_min and prep_time_min must be whole numbers 0-10080 (invalid_lead_time / invalid_prep_time).';

-- As live: authenticated and the service role.
revoke all on function public.patch_branch_settings(uuid, jsonb) from public, anon;
grant execute on function public.patch_branch_settings(uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. The release cron job
-- ---------------------------------------------------------------------------------------------

do $cron$
begin
  -- A job of that name with another schedule, command or switched off is put back (unschedule by
  -- name, then schedule below, as the other cron migrations do). One that matches is not touched.
  if exists (select 1 from cron.job
              where jobname = 'release-scheduled-orders'
                and (schedule <> '* * * * *'
                     or btrim(command) <> 'select private.release_scheduled_orders()'
                     or not active)) then
    perform cron.unschedule('release-scheduled-orders');
  end if;

  if not exists (select 1 from cron.job where jobname = 'release-scheduled-orders') then
    perform cron.schedule('release-scheduled-orders', '* * * * *', 'select private.release_scheduled_orders()');
  end if;
end
$cron$;

commit;
