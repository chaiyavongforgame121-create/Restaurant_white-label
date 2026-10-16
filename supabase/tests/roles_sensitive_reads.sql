-- Roles, sensitive reads (20261016110000_roles_sensitive_reads). A rolled-back script, not a migration.
--
-- Run from the repo root once the migration is applied:
--   SUPABASE_TELEMETRY_DISABLED=1 npx --yes supabase db query --linked \
--     --project-ref ayyfczidnzxetndiijmv -f supabase/tests/roles_sensitive_reads.sql
-- Before it is applied, put it after a "begin;" of your own and this file (without its own
-- "begin;" line) after it, in one transaction.
--
-- Everything happens inside one transaction that ends in ROLLBACK. Calls made on someone's behalf
-- through pg_temp.try_as also run in their own subtransaction, which is always rolled back, so the
-- deletes and updates below that a role is allowed to make never outlive their check. The only
-- writes kept until the final ROLLBACK are two staff rows that give the suite a manager.
--
-- People, all at the Hamburger branch of restaurant 3333 unless said (never owner@test.com: it is a
-- platform admin, so every check passes for it; try_as sends no app_metadata, so nobody here is one):
--   owner    chaiyavongboy1     owner row
--   admin    147d5c02           admin row scoped to Hamburger
--   cashier  cashier@test.com   cashier row
--   kitchen  a3333333           kitchen row
--   driver   driver@test.com    a rider approved at Hamburger, with deliveries delivered months ago
--   manager  customer@test.com  a manager row at Hamburger, added by this script
--   bobby    Bobby              a restaurant-wide manager row (branch_id null), added by this script
--
-- The result is one row per check with PASS/FAIL, then a summary row.

begin;

create temp table t_out (
  seq serial,
  check_name text,
  expected text,
  actual text,
  verdict text
) on commit drop;

-- Run statements as p_uid and report 'ok <last value>' or 'ERR <message>'. Always rolled back.
create or replace function pg_temp.try_as(p_uid uuid, p_sqls text[])
returns text
language plpgsql
as $$
declare
  s text;
  v_last text;
  v_msg text;
  v_det text;
begin
  begin
    if p_uid is not null then
      perform set_config('request.jwt.claims',
        json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', p_uid::text, true);
      perform set_config('role', 'authenticated', true);
    end if;
    foreach s in array p_sqls loop
      execute s into v_last;
    end loop;
    raise exception using message = 'TRY_AS_OK', detail = coalesce(v_last, '');
  exception when others then
    get stacked diagnostics v_msg = message_text, v_det = pg_exception_detail;
    if v_msg = 'TRY_AS_OK' then
      return 'ok' || case when coalesce(v_det, '') <> '' then ' ' || v_det else '' end;
    end if;
    return 'ERR ' || v_msg;
  end;
end $$;

-- p_expected ending in '%' is a LIKE pattern.
create or replace function pg_temp.expect(p_check text, p_expected text, p_actual text)
returns void
language plpgsql
as $$
begin
  insert into t_out (check_name, expected, actual, verdict)
  values (p_check, p_expected, coalesce(p_actual, '<null>'),
          case when coalesce(p_actual, '<null>') = p_expected
                 or (right(p_expected, 1) = '%' and coalesce(p_actual, '<null>') like p_expected)
               then 'PASS' else 'FAIL' end);
end $$;

-- Set only the JWT claims (auth.uid()), keeping the session's own role.
create or replace function pg_temp.act_as(p_uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
end $$;

do $test$
declare
  c_rest    constant uuid := '33333333-3333-3333-3333-333333333333';
  c_ham     constant uuid := '44444444-4444-4444-4444-444444444444';
  c_ftt     constant uuid := 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';
  c_owner   constant uuid := '9467cf42-0a03-4abe-86d5-a2610ee15d0a';
  c_admin   constant uuid := '147d5c02-04e7-44af-8595-337605d785e6';
  c_cash    constant uuid := 'a2222222-2222-2222-2222-222222222222';
  c_kitchen constant uuid := 'a3333333-3333-3333-3333-333333333333';
  c_driver  constant uuid := 'a4444444-4444-4444-4444-444444444444';
  c_manager constant uuid := 'a1111111-1111-1111-1111-111111111111';
  c_bobby   constant uuid := '1e74fba1-cebf-46b1-a963-fb4915bd899d';
  v_drv uuid;
  v_del_old uuid;
  v_del_ham uuid;
  v_sched uuid;
  v_dba_drv uuid;
  v_appr_ham int;
  v_wd_ham int;
  v_audit_ham int;
  v_outbox_ham int;
  v_slip_path text;
  v_outbox_cash int;
  v_outbox_kitchen int;
  v_b boolean;
begin
  select id into v_drv from public.drivers where user_id = c_driver limit 1;
  select id into v_del_old from public.deliveries
   where driver_id = v_drv and status = 'delivered' and delivered_at < now() - interval '1 day'
   order by delivered_at limit 1;
  select id into v_del_ham from public.deliveries where branch_id = c_ham order by created_at limit 1;
  select id into v_sched from public.driver_schedules where branch_id = c_ham order by created_at limit 1;
  select driver_id into v_dba_drv from public.driver_branch_availability where branch_id = c_ham limit 1;
  select count(*) into v_appr_ham from public.driver_approvals where branch_id = c_ham;
  select count(*) into v_wd_ham from public.driver_withdrawals where branch_id = c_ham;
  select count(*) into v_audit_ham from public.audit_logs where branch_id = c_ham;
  select count(*) into v_outbox_ham from public.notifications_outbox where branch_id = c_ham;
  -- Rows addressed to the cashier or the cook themselves stay readable (notifications_recipient).
  select count(*) into v_outbox_cash from public.notifications_outbox o
    join public.staff_members sm on sm.id = o.recipient_id
   where o.recipient_type = 'staff' and o.branch_id = c_ham and sm.user_id = c_cash;
  select count(*) into v_outbox_kitchen from public.notifications_outbox o
    join public.staff_members sm on sm.id = o.recipient_id
   where o.recipient_type = 'staff' and o.branch_id = c_ham and sm.user_id = c_kitchen;
  select w.id::text || '/slip.jpg' into v_slip_path from public.driver_withdrawals w
   where w.branch_id = c_ham order by w.created_at limit 1;

  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status) values
    (c_manager, c_rest, c_ham, 'manager', 'active'),
    (c_bobby,   c_rest, null,  'manager', 'active');

  perform pg_temp.expect('fixtures present', 'true',
    (v_drv is not null and v_del_old is not null and v_del_ham is not null and v_sched is not null
     and v_dba_drv is not null and v_appr_ham > 0 and v_wd_ham > 0 and v_slip_path is not null)::text);

  -- 1. D7: the manager no longer administers riders --------------------------------------------
  perform pg_temp.expect('manager has no drivers.manage', 'false',
    exists (select 1 from public.role_capabilities where role = 'manager' and capability = 'drivers.manage')::text);
  perform pg_temp.expect('manager keeps delivery.manage', 'true',
    exists (select 1 from public.role_capabilities where role = 'manager' and capability = 'delivery.manage')::text);
  perform pg_temp.expect('manager: my_capabilities has no drivers.manage', 'ok false',
    pg_temp.try_as(c_manager, array[format(
      'select (''drivers.manage'' in (select public.my_capabilities(%L)))::text', c_ham)]));
  perform pg_temp.expect('manager cannot write rider approvals', 'ok 0',
    pg_temp.try_as(c_manager, array[format(
      'with u as (update public.driver_approvals set notes = notes where branch_id = %L returning 1)
       select count(*)::text from u', c_ham)]));
  perform pg_temp.expect('admin still writes rider approvals', format('ok %s', v_appr_ham),
    pg_temp.try_as(c_admin, array[format(
      'with u as (update public.driver_approvals set notes = notes where branch_id = %L returning 1)
       select count(*)::text from u', c_ham)]));

  -- 2. Riders' personal data -----------------------------------------------------------------
  perform pg_temp.expect('owner reads the rider row', 'ok 1',
    pg_temp.try_as(c_owner, array[format('select count(*)::text from public.drivers where id = %L', v_drv)]));
  perform pg_temp.expect('admin reads the rider row', 'ok 1',
    pg_temp.try_as(c_admin, array[format('select count(*)::text from public.drivers where id = %L', v_drv)]));
  perform pg_temp.expect('manager does not read the rider row', 'ok 0',
    pg_temp.try_as(c_manager, array[format('select count(*)::text from public.drivers where id = %L', v_drv)]));
  perform pg_temp.expect('cashier does not read the rider row', 'ok 0',
    pg_temp.try_as(c_cash, array[format('select count(*)::text from public.drivers where id = %L', v_drv)]));
  perform pg_temp.expect('kitchen does not read the rider row', 'ok 0',
    pg_temp.try_as(c_kitchen, array[format('select count(*)::text from public.drivers where id = %L', v_drv)]));
  perform pg_temp.expect('rider reads their own row', 'ok 1',
    pg_temp.try_as(c_driver, array[format('select count(*)::text from public.drivers where id = %L', v_drv)]));
  perform pg_temp.expect('kitchen: embedded rider is null on its deliveries', 'ok 0',
    pg_temp.try_as(c_kitchen, array[format(
      'select count(*)::text from public.deliveries d join public.drivers r on r.id = d.driver_id
        where d.branch_id = %L', c_ham)]));

  perform pg_temp.expect('kitchen: branch_rider_names names the rider', 'ok 1',
    pg_temp.try_as(c_kitchen, array[format(
      'select count(*)::text from public.branch_rider_names(%L, array[%L]::uuid[])', c_ham, v_drv)]));
  perform pg_temp.expect('cashier: branch_rider_names names the rider', 'ok 1',
    pg_temp.try_as(c_cash, array[format(
      'select count(*)::text from public.branch_rider_names(%L, array[%L]::uuid[])', c_ham, v_drv)]));
  perform pg_temp.expect('manager: branch_rider_names names the rider', 'ok 1',
    pg_temp.try_as(c_manager, array[format(
      'select count(*)::text from public.branch_rider_names(%L, array[%L]::uuid[])', c_ham, v_drv)]));
  perform pg_temp.expect('owner: branch_rider_names lists every approved rider', 'ok true',
    pg_temp.try_as(c_owner, array[format(
      'select ((select count(*) from public.branch_rider_names(%L))
               >= (select count(*) from public.driver_approvals where branch_id = %L and status = ''approved''))::text',
      c_ham, c_ham)]));
  perform pg_temp.expect('rider: branch_rider_names refused', 'ERR not_authorized',
    pg_temp.try_as(c_driver, array[format(
      'select count(*)::text from public.branch_rider_names(%L)', c_ham)]));
  perform pg_temp.expect('kitchen of Hamburger: branch_rider_names at Food Thai Thai refused', 'ERR not_authorized',
    pg_temp.try_as(c_kitchen, array[format(
      'select count(*)::text from public.branch_rider_names(%L)', c_ftt)]));
  perform pg_temp.expect('branch_rider_names returns id and name only', 'TABLE(driver_id uuid, full_name text)',
    pg_get_function_result('public.branch_rider_names(uuid,uuid[])'::regprocedure));
  perform pg_temp.expect('anon may not run branch_rider_names', 'false',
    has_function_privilege('anon', 'public.branch_rider_names(uuid,uuid[])', 'execute')::text);

  -- 3. Riders' withdrawals --------------------------------------------------------------------
  perform pg_temp.expect('owner reads Hamburger withdrawals', 'ok true',
    pg_temp.try_as(c_owner, array[format(
      'select (count(*) = %s)::text from public.driver_withdrawals where branch_id = %L', v_wd_ham, c_ham)]));
  perform pg_temp.expect('admin reads Hamburger withdrawals', 'ok true',
    pg_temp.try_as(c_admin, array[format(
      'select (count(*) = %s)::text from public.driver_withdrawals where branch_id = %L', v_wd_ham, c_ham)]));
  perform pg_temp.expect('manager does not read withdrawals', 'ok 0',
    pg_temp.try_as(c_manager, array[format(
      'select count(*)::text from public.driver_withdrawals where branch_id = %L', c_ham)]));
  perform pg_temp.expect('cashier does not read withdrawals', 'ok 0',
    pg_temp.try_as(c_cash, array[format(
      'select count(*)::text from public.driver_withdrawals where branch_id = %L', c_ham)]));
  perform pg_temp.expect('kitchen does not read withdrawals', 'ok 0',
    pg_temp.try_as(c_kitchen, array[format(
      'select count(*)::text from public.driver_withdrawals where branch_id = %L', c_ham)]));

  -- Their transfer slips (payout-slips storage policies ask staffs_withdrawal_folder).
  perform pg_temp.expect('owner may open a Hamburger payout slip', 'ok true',
    pg_temp.try_as(c_owner, array[format('select private.staffs_withdrawal_folder(%L)::text', v_slip_path)]));
  perform pg_temp.expect('admin may open a Hamburger payout slip', 'ok true',
    pg_temp.try_as(c_admin, array[format('select private.staffs_withdrawal_folder(%L)::text', v_slip_path)]));
  perform pg_temp.expect('manager may not open a payout slip', 'ok false',
    pg_temp.try_as(c_manager, array[format('select private.staffs_withdrawal_folder(%L)::text', v_slip_path)]));
  perform pg_temp.expect('cashier may not open a payout slip', 'ok false',
    pg_temp.try_as(c_cash, array[format('select private.staffs_withdrawal_folder(%L)::text', v_slip_path)]));
  perform pg_temp.expect('kitchen may not open a payout slip', 'ok false',
    pg_temp.try_as(c_kitchen, array[format('select private.staffs_withdrawal_folder(%L)::text', v_slip_path)]));

  -- Rider applications and review notes.
  perform pg_temp.expect('admin reads Hamburger rider applications', format('ok %s', v_appr_ham),
    pg_temp.try_as(c_admin, array[format(
      'select count(*)::text from public.driver_approvals where branch_id = %L', c_ham)]));
  perform pg_temp.expect('manager does not read rider applications', 'ok 0',
    pg_temp.try_as(c_manager, array[format(
      'select count(*)::text from public.driver_approvals where branch_id = %L', c_ham)]));
  perform pg_temp.expect('cashier does not read rider applications', 'ok 0',
    pg_temp.try_as(c_cash, array[format(
      'select count(*)::text from public.driver_approvals where branch_id = %L', c_ham)]));
  perform pg_temp.expect('kitchen does not read rider applications', 'ok 0',
    pg_temp.try_as(c_kitchen, array[format(
      'select count(*)::text from public.driver_approvals where branch_id = %L', c_ham)]));
  perform pg_temp.expect('rider still reads their own applications', 'ok true',
    pg_temp.try_as(c_driver, array[format(
      'select (count(*) > 0)::text from public.driver_approvals where driver_id = %L', v_drv)]));

  -- 4. Schedules, availability and deliveries: members read, delivery.manage writes -------------
  perform pg_temp.expect('cashier reads rider schedules', 'ok true',
    pg_temp.try_as(c_cash, array[format(
      'select (count(*) > 0)::text from public.driver_schedules where branch_id = %L', c_ham)]));
  perform pg_temp.expect('cashier cannot delete a rider schedule', 'ok 0',
    pg_temp.try_as(c_cash, array[format(
      'with d as (delete from public.driver_schedules where id = %L returning 1) select count(*)::text from d', v_sched)]));
  perform pg_temp.expect('cashier cannot add a rider schedule', 'ERR new row violates row-level security policy%',
    pg_temp.try_as(c_cash, array[format(
      'insert into public.driver_schedules (driver_id, branch_id, start_at, end_at)
       values (%L, %L, now() + interval ''1 day'', now() + interval ''1 day 2 hours'') returning id::text', v_drv, c_ham)]));
  perform pg_temp.expect('manager deletes a rider schedule', 'ok 1',
    pg_temp.try_as(c_manager, array[format(
      'with d as (delete from public.driver_schedules where id = %L returning 1) select count(*)::text from d', v_sched)]));

  perform pg_temp.expect('kitchen reads rider availability', 'ok true',
    pg_temp.try_as(c_kitchen, array[format(
      'select (count(*) > 0)::text from public.driver_branch_availability where branch_id = %L', c_ham)]));
  perform pg_temp.expect('kitchen cannot switch a rider''s availability', 'ok 0',
    pg_temp.try_as(c_kitchen, array[format(
      'with u as (update public.driver_branch_availability set mode = mode
                   where driver_id = %L and branch_id = %L returning 1) select count(*)::text from u', v_dba_drv, c_ham)]));
  perform pg_temp.expect('manager switches a rider''s availability', 'ok 1',
    pg_temp.try_as(c_manager, array[format(
      'with u as (update public.driver_branch_availability set mode = mode
                   where driver_id = %L and branch_id = %L returning 1) select count(*)::text from u', v_dba_drv, c_ham)]));

  perform pg_temp.expect('cashier reads deliveries', 'ok true',
    pg_temp.try_as(c_cash, array[format(
      'select (count(*) > 0)::text from public.deliveries where branch_id = %L', c_ham)]));
  perform pg_temp.expect('cashier cannot write a delivery', 'ok 0',
    pg_temp.try_as(c_cash, array[format(
      'with u as (update public.deliveries set pod_photo_url = pod_photo_url where id = %L returning 1)
       select count(*)::text from u', v_del_ham)]));
  perform pg_temp.expect('cashier cannot delete a delivery', 'ok 0',
    pg_temp.try_as(c_cash, array[format(
      'with d as (delete from public.deliveries where id = %L returning 1) select count(*)::text from d', v_del_ham)]));
  perform pg_temp.expect('manager writes a delivery', 'ok 1',
    pg_temp.try_as(c_manager, array[format(
      'with u as (update public.deliveries set pod_photo_url = pod_photo_url where id = %L returning 1)
       select count(*)::text from u', v_del_ham)]));

  -- 5. Subscription and invoice rows ------------------------------------------------------------
  perform pg_temp.expect('owner reads the subscription', 'ok 1',
    pg_temp.try_as(c_owner, array[format(
      'select count(*)::text from public.subscriptions where restaurant_id = %L', c_rest)]));
  perform pg_temp.expect('admin does not read the subscription', 'ok 0',
    pg_temp.try_as(c_admin, array[format(
      'select count(*)::text from public.subscriptions where restaurant_id = %L', c_rest)]));
  perform pg_temp.expect('restaurant-wide manager does not read the subscription', 'ok 0',
    pg_temp.try_as(c_bobby, array[format(
      'select count(*)::text from public.subscriptions where restaurant_id = %L', c_rest)]));
  perform pg_temp.expect('cashier does not read the subscription', 'ok 0',
    pg_temp.try_as(c_cash, array[format(
      'select count(*)::text from public.subscriptions where restaurant_id = %L', c_rest)]));
  perform pg_temp.expect('kitchen does not read the subscription', 'ok 0',
    pg_temp.try_as(c_kitchen, array[format(
      'select count(*)::text from public.subscriptions where restaurant_id = %L', c_rest)]));
  perform pg_temp.expect('cashier reads invoices without an error', 'ok 0',
    pg_temp.try_as(c_cash, array[format(
      'select count(*)::text from public.invoices where restaurant_id = %L', c_rest)]));
  perform pg_temp.expect('invoices_owner follows user_can_manage_billing', 'true',
    ((select qual from pg_policies where schemaname = 'public' and tablename = 'invoices'
       and policyname = 'invoices_owner') like '%user_can_manage_billing%')::text);
  perform pg_temp.expect('authenticated may run user_can_manage_billing (policies call it)', 'true',
    has_function_privilege('authenticated', 'private.user_can_manage_billing(uuid)', 'execute')::text);
  perform pg_temp.expect('owner: get_billing_overview still answers', 'ok%',
    pg_temp.try_as(c_owner, array[format(
      'select (public.get_billing_overview(%L) is not null)::text', c_rest)]));

  -- 6. Audit logs and the notification outbox ---------------------------------------------------
  perform pg_temp.expect('manager (reports.view) reads the branch''s audit rows', 'ok true',
    pg_temp.try_as(c_manager, array[format(
      'select (count(*) = %s)::text from public.audit_logs where branch_id = %L', v_audit_ham, c_ham)]));
  perform pg_temp.expect('cashier does not read audit rows', 'ok 0',
    pg_temp.try_as(c_cash, array[format(
      'select count(*)::text from public.audit_logs where branch_id = %L', c_ham)]));
  perform pg_temp.expect('kitchen does not read audit rows', 'ok 0',
    pg_temp.try_as(c_kitchen, array[format(
      'select count(*)::text from public.audit_logs where branch_id = %L', c_ham)]));
  perform pg_temp.expect('Hamburger manager does not read Food Thai Thai audit rows', 'ok 0',
    pg_temp.try_as(c_manager, array[format(
      'select count(*)::text from public.audit_logs where branch_id = %L', c_ftt)]));
  perform pg_temp.expect('admin reads the branch outbox', 'ok true',
    pg_temp.try_as(c_admin, array[format(
      'select (count(*) = %s)::text from public.notifications_outbox where branch_id = %L', v_outbox_ham, c_ham)]));
  perform pg_temp.expect('cashier does not read the branch outbox (only rows addressed to them)', format('ok %s', v_outbox_cash),
    pg_temp.try_as(c_cash, array[format(
      'select count(*)::text from public.notifications_outbox where branch_id = %L', c_ham)]));
  perform pg_temp.expect('kitchen does not read the branch outbox (only rows addressed to them)', format('ok %s', v_outbox_kitchen),
    pg_temp.try_as(c_kitchen, array[format(
      'select count(*)::text from public.notifications_outbox where branch_id = %L', c_ham)]));
  perform pg_temp.expect('cashier cannot queue a notification', 'ERR new row violates row-level security policy%',
    pg_temp.try_as(c_cash, array[format(
      'insert into public.notifications_outbox (branch_id, recipient_type, recipient_id, channel, template, variables)
       values (%L, ''staff'', %L, ''in_app'', ''delivery_failed_at_door'', ''{}''::jsonb) returning id::text', c_ham, c_ham)]));

  -- KT-2: the kitchen's settings answer carries the board's keys only (an empty patch writes nothing).
  perform pg_temp.expect('kitchen: patch_branch_settings answers with board keys only', 'ok true',
    pg_temp.try_as(c_kitchen, array[format(
      'select (select coalesce(bool_and(k = any (array[''orders_paused'',''busy_extra_prep_min'',''prep_time_min'',''schedule_lead_time_min''])), true)
                 from jsonb_object_keys(public.patch_branch_settings(%L, ''{}''::jsonb)) k)::text', c_ham)]));
  perform pg_temp.expect('owner: patch_branch_settings answers with the whole settings object', 'ok true',
    pg_temp.try_as(c_owner, array[format(
      'select (public.patch_branch_settings(%L, ''{}''::jsonb) = (select coalesce(settings, ''{}''::jsonb) from public.branches where id = %L))::text',
      c_ham, c_ham)]));
  perform pg_temp.expect('cashier: patch_branch_settings refused', 'ERR not_authorized',
    pg_temp.try_as(c_cash, array[format(
      'select public.patch_branch_settings(%L, ''{}''::jsonb)::text', c_ham)]));

  -- 7. Branch identity is branch settings (D8) --------------------------------------------------
  perform pg_temp.act_as(c_manager);
  v_b := private.user_manages_restaurant(c_rest);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('Hamburger manager does not manage the restaurant', 'false', v_b::text);
  perform pg_temp.act_as(c_bobby);
  v_b := private.user_manages_restaurant(c_rest);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('restaurant-wide manager manages the restaurant', 'true', v_b::text);
  perform pg_temp.act_as(c_owner);
  v_b := private.user_manages_restaurant(c_rest);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('owner row at one branch manages the restaurant', 'true', v_b::text);

  perform pg_temp.expect('admin changes the branch time zone', 'ok ' || c_ham,
    pg_temp.try_as(c_admin, array[format(
      'update public.branches
          set timezone = case when timezone = ''America/Chicago'' then ''America/New_York'' else ''America/Chicago'' end
        where id = %L returning id::text', c_ham)]));
  perform pg_temp.expect('manager cannot change the branch time zone', 'ERR branch_settings_required',
    pg_temp.try_as(c_manager, array[format(
      'update public.branches
          set timezone = case when timezone = ''America/Chicago'' then ''America/New_York'' else ''America/Chicago'' end
        where id = %L returning id::text', c_ham)]));
  perform pg_temp.expect('manager cannot change the tax rate', 'ERR branch_settings_required',
    pg_temp.try_as(c_manager, array[format(
      'update public.branches set sales_tax_rate = coalesce(sales_tax_rate, 0) + 0.01 where id = %L returning id::text', c_ham)]));
  perform pg_temp.expect('manager cannot rename the branch', 'ERR branch_settings_required',
    pg_temp.try_as(c_manager, array[format(
      'update public.branches set name = name || '' (test)'' where id = %L returning id::text', c_ham)]));
  perform pg_temp.expect('manager changes the opening hours', 'ok ' || c_ham,
    pg_temp.try_as(c_manager, array[format(
      'update public.branches set open_hours = coalesce(open_hours, ''{}''::jsonb) || ''{"roles_test": true}''::jsonb
        where id = %L returning id::text', c_ham)]));
  perform pg_temp.expect('Hamburger manager cannot touch Food Thai Thai', 'ok 0',
    pg_temp.try_as(c_manager, array[format(
      'with u as (update public.branches set open_hours = coalesce(open_hours, ''{}''::jsonb) || ''{"roles_test": true}''::jsonb
                   where id = %L returning 1) select count(*)::text from u', c_ftt)]));
  perform pg_temp.expect('cashier cannot update the branch row', 'ok 0',
    pg_temp.try_as(c_cash, array[format(
      'with u as (update public.branches set open_hours = coalesce(open_hours, ''{}''::jsonb) || ''{"roles_test": true}''::jsonb
                   where id = %L returning 1) select count(*)::text from u', c_ham)]));
  perform pg_temp.expect('kitchen pauses through patch_branch_settings', 'ok true',
    pg_temp.try_as(c_kitchen, array[format(
      'select (public.patch_branch_settings(%L, ''{"orders_paused": false}''::jsonb) ? ''orders_paused'')::text', c_ham)]));
  perform pg_temp.expect('kitchen sets busy mode directly', 'ok ' || c_ham,
    pg_temp.try_as(c_kitchen, array[format(
      'update public.branches set settings = coalesce(settings, ''{}''::jsonb) || ''{"busy_extra_prep_min": 5}''::jsonb
        where id = %L returning id::text', c_ham)]));
  perform pg_temp.expect('kitchen cannot rename the branch', 'ERR branch_settings_required',
    pg_temp.try_as(c_kitchen, array[format(
      'update public.branches set name = name || '' (test)'' where id = %L returning id::text', c_ham)]));
  perform pg_temp.expect('manager cannot move the branch', 'ERR not_authorized',
    pg_temp.try_as(c_manager, array[format(
      'select public.set_branch_location(%L, (select address from public.branches where id = %L))::text', c_ham, c_ham)]));
  perform pg_temp.expect('admin saves the branch location', 'ok ' || c_ham,
    pg_temp.try_as(c_admin, array[format(
      'select public.set_branch_location(%L, (select address from public.branches where id = %L)) ->> ''branch_id''', c_ham, c_ham)]));

  -- 8. DR-2: a rider's old jobs stop showing the customer's contact -----------------------------
  perform pg_temp.expect('window: delivered 30 min ago shows contact', 'true',
    private.driver_sees_customer_contact('delivered', now() - interval '30 minutes')::text);
  perform pg_temp.expect('window: delivered 3 h ago hides contact', 'false',
    private.driver_sees_customer_contact('delivered', now() - interval '3 hours')::text);
  perform pg_temp.expect('window: failed with no close time hides contact', 'false',
    private.driver_sees_customer_contact('failed', null)::text);
  perform pg_temp.expect('window: cancelled 1 h ago shows contact', 'true',
    private.driver_sees_customer_contact('cancelled', now() - interval '1 hour')::text);
  perform pg_temp.expect('window: a job in progress shows contact', 'true',
    private.driver_sees_customer_contact('picked_up', null)::text);
  perform pg_temp.expect('rider: an old delivered job says contact_hidden', 'ok true',
    pg_temp.try_as(c_driver, array[format(
      'select public.get_driver_order(%L) ->> ''contact_hidden''', v_del_old)]));
  perform pg_temp.expect('rider: an old delivered job has no phone, address or notes', 'ok true',
    pg_temp.try_as(c_driver, array[format(
      'select ((o ->> ''customer_phone'') is null and (o ->> ''delivery_address'') is null
               and (o ->> ''customer_notes'') is null)::text
         from (select public.get_driver_order(%L) as o) s', v_del_old)]));
  perform pg_temp.expect('rider: an old delivered job keeps its number and lines', 'ok true',
    pg_temp.try_as(c_driver, array[format(
      'select ((o ->> ''order_number'') is not null and jsonb_typeof(o -> ''order_items'') = ''array'')::text
         from (select public.get_driver_order(%L) as o) s', v_del_old)]));
  perform pg_temp.expect('cashier: get_driver_order refused', 'ERR not_a_driver',
    pg_temp.try_as(c_cash, array[format('select public.get_driver_order(%L)::text', v_del_old)]));

  -- Grants on the new helpers.
  perform pg_temp.expect('anon may not run staff_branch_ids_with_capability', 'false',
    has_function_privilege('anon', 'private.staff_branch_ids_with_capability(text)', 'execute')::text);
  perform pg_temp.expect('authenticated may run staff_branch_ids_with_capability (policies call it)', 'true',
    has_function_privilege('authenticated', 'private.staff_branch_ids_with_capability(text)', 'execute')::text);
  perform pg_temp.expect('authenticated may not run driver_sees_customer_contact', 'false',
    has_function_privilege('authenticated', 'private.driver_sees_customer_contact(public.delivery_status,timestamptz)', 'execute')::text);
end
$test$;

select seq, verdict, check_name, expected, actual from t_out
union all
select 999999, (select case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAILURES' end from t_out),
       format('%s checks, %s failed', count(*), count(*) filter (where verdict = 'FAIL')), null, null
  from t_out
order by 1;

rollback;
