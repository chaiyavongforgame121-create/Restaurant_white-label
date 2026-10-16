-- Roles, core database rules (20261016100000_roles_core). A rolled-back script, not a migration.
--
-- Run from the repo root once the migration is applied:
--   SUPABASE_TELEMETRY_DISABLED=1 npx --yes supabase db query --linked \
--     --project-ref ayyfczidnzxetndiijmv -f supabase/tests/roles_core.sql
-- Before it is applied, put 20261016100000_roles_core.sql after a "begin;" of your own and this
-- file (without its own "begin;") after it, in one transaction.
--
-- Everything ends in ROLLBACK. Calls made on someone's behalf through pg_temp.try_as run in their
-- own subtransaction, which is always rolled back, so each check starts from the state the direct
-- statements (the service role's, no JWT) left. Each section runs in its own block: a section that
-- breaks reports one FAIL row and the others still run.
--
-- People at Coastal Grill / Hamburger (branch 4444…):
--   owner     restaurants.owner_user_id        every capability
--   owner2    an active owner row               every capability
--   admin     an active admin row at the branch no billing.manage
--   cashier   an active cashier row             orders.cancel, payments.verify, no orders.refund
--   kitchen   an active kitchen row             kitchen.access, no orders.cancel or orders.refund
--   manager   a manager row made here for a user with no staff rows anywhere
--   rider     a 'driver' staff row made here for another such user: a member of the branch with
--             neither kitchen.access nor counter.access
--
-- The result is one row per check with PASS/FAIL, then a summary row.

begin;

create temp table if not exists t_out (
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

-- An order at Hamburger with one payment of p_method/p_pay_status (none when p_method is null),
-- left at p_status. Written as the service role, so no rule here is in the way. The source is the
-- storefront ('web'), so a 'card' payment is a diner's online Stripe payment.
create or replace function pg_temp.order_with(p_number text, p_status text, p_method text, p_pay_status text)
returns uuid
language plpgsql
as $$
declare
  v_order uuid;
begin
  insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history, source)
  values (p_number, '44444444-4444-4444-4444-444444444444', 'pickup', 'pending', 10, 10, '[]', 'web')
  returning id into v_order;
  if p_method is not null then
    insert into public.payments (order_id, branch_id, amount, method, status, gateway)
    values (v_order, '44444444-4444-4444-4444-444444444444', 10, p_method,
            p_pay_status::payment_status, case when p_method = 'card' then 'stripe' end);
  end if;
  -- A cash payment confirms its order on insert; put the order where the check wants it.
  update public.orders set status = p_status::order_status where id = v_order and status::text <> p_status;
  return v_order;
end $$;

do $test$
declare
  c_branch constant uuid := '44444444-4444-4444-4444-444444444444';
  c_rest constant uuid := '33333333-3333-3333-3333-333333333333';
  v_owner uuid;
  v_owner2 uuid;
  v_admin uuid;
  v_cashier uuid;
  v_kitchen uuid;
  v_manager uuid;
  v_rider uuid;
  v_order uuid;
  v_pay uuid;
  v_item uuid;
  v_outsiders uuid[];
  v_q text;
begin
  select r.owner_user_id into v_owner from public.restaurants r where r.id = c_rest;
  select sm.user_id into v_owner2 from public.staff_members sm join auth.users u on u.id = sm.user_id
   where sm.restaurant_id = c_rest and sm.role = 'owner' and sm.status = 'active' and sm.user_id <> v_owner
     and not coalesce((u.raw_app_meta_data ->> 'is_platform_admin')::boolean, false)
   order by sm.created_at limit 1;
  select sm.user_id into v_admin from public.staff_members sm join auth.users u on u.id = sm.user_id
   where sm.branch_id = c_branch and sm.role = 'admin' and sm.status = 'active'
     and not exists (select 1 from public.staff_members o where o.user_id = sm.user_id and o.role = 'owner')
     and not coalesce((u.raw_app_meta_data ->> 'is_platform_admin')::boolean, false)
   order by sm.created_at limit 1;
  select sm.user_id into v_cashier from public.staff_members sm
   where sm.branch_id = c_branch and sm.role = 'cashier' and sm.status = 'active'
     and (select count(*) from public.staff_members o where o.user_id = sm.user_id and o.status = 'active') = 1
   order by sm.created_at limit 1;
  select sm.user_id into v_kitchen from public.staff_members sm
   where sm.branch_id = c_branch and sm.role = 'kitchen' and sm.status = 'active'
     and (select count(*) from public.staff_members o where o.user_id = sm.user_id and o.status = 'active') = 1
   order by sm.created_at limit 1;
  -- Two people who work nowhere, for the roles Coastal Grill has nobody in.
  select array_agg(x.id order by x.created_at, x.id)
    into v_outsiders
    from (select u.id, u.created_at from auth.users u
           where not exists (select 1 from public.staff_members sm where sm.user_id = u.id)
             and not exists (select 1 from public.restaurants r where r.owner_user_id = u.id)
             and not coalesce((u.raw_app_meta_data ->> 'is_platform_admin')::boolean, false)
           order by u.created_at, u.id limit 2) x;
  v_manager := v_outsiders[1];
  v_rider := v_outsiders[2];

  perform pg_temp.expect('fixtures: owner, owner row, admin, cashier, kitchen, two outsiders',
    'true true true true true true true',
    concat_ws(' ', (v_owner is not null)::text, (v_owner2 is not null)::text, (v_admin is not null)::text, (v_cashier is not null)::text,
              (v_kitchen is not null)::text, (v_manager is not null)::text, (v_rider is not null)::text));

  begin
    insert into public.staff_members (user_id, restaurant_id, branch_id, role, status, accepted_at)
    values (v_manager, c_rest, c_branch, 'manager', 'active', now());
  exception when others then
    perform pg_temp.expect('fixture: a manager row', 'ok', 'ERR ' || sqlerrm);
  end;
  begin
    insert into public.staff_members (user_id, restaurant_id, branch_id, role, status, accepted_at)
    values (v_rider, c_rest, c_branch, 'driver', 'active', now());
  exception when others then
    perform pg_temp.expect('fixture: a driver staff row', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 1. the cashier's new capabilities ---------------------------------------------------------
  begin
    perform pg_temp.expect('cashier rows include the back office, the dashboard and slip checks',
      'backoffice.access dashboard.view payments.verify',
      (select string_agg(capability, ' ' order by capability) from public.role_capabilities
        where role = 'cashier' and capability in ('backoffice.access', 'dashboard.view', 'payments.verify')));
    perform pg_temp.expect('my_capabilities hands them to a cashier at the branch', 'ok 3',
      pg_temp.try_as(v_cashier, array[format(
        'select count(*)::text from public.my_capabilities(%L) c where c in (''backoffice.access'', ''dashboard.view'', ''payments.verify'')',
        c_branch)]));
    perform pg_temp.expect('the cashier still has no orders.refund', 'ok 0',
      pg_temp.try_as(v_cashier, array[format(
        'select count(*)::text from public.my_capabilities(%L) c where c = ''orders.refund''', c_branch)]));
  exception when others then
    perform pg_temp.expect('section 1 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 2. cancel before payment -------------------------------------------------------------------
  begin
    v_q := 'select public.cancel_order(%L, ''roles core'')::text';

    v_order := pg_temp.order_with('TEST-RC-A', 'pending', null, null);
    perform pg_temp.expect('the cashier cancels an unpaid order', 'ok%',
      pg_temp.try_as(v_cashier, array[format(v_q, v_order)]));

    v_order := pg_temp.order_with('TEST-RC-B', 'confirmed', 'cash', 'pending');
    perform pg_temp.expect('the kitchen rejects a confirmed order whose cash is not taken yet', 'ok%',
      pg_temp.try_as(v_kitchen, array[format(v_q, v_order)]));
    perform pg_temp.expect('and so does the cashier', 'ok%',
      pg_temp.try_as(v_cashier, array[format(v_q, v_order)]));

    v_order := pg_temp.order_with('TEST-RC-C', 'confirmed', 'cash', 'completed');
    perform pg_temp.expect('the cashier cannot cancel an order paid in cash', 'ERR paid_order_needs_refund',
      pg_temp.try_as(v_cashier, array[format(v_q, v_order)]));
    perform pg_temp.expect('nor can the kitchen once it is past pending', 'ERR paid_order_needs_refund',
      pg_temp.try_as(v_kitchen, array[format(v_q, v_order)]));
    perform pg_temp.expect('a manager can', 'ok%',
      pg_temp.try_as(v_manager, array[format(v_q, v_order)]));
    perform pg_temp.expect('an admin can', 'ok%',
      pg_temp.try_as(v_admin, array[format(v_q, v_order)]));
    perform pg_temp.expect('the owner can', 'ok%',
      pg_temp.try_as(v_owner, array[format(v_q, v_order)]));
    perform pg_temp.expect('a refunded payment still counts as paid', 'ERR paid_order_needs_refund',
      pg_temp.try_as(v_cashier, array[format(v_q, pg_temp.order_with('TEST-RC-C2', 'confirmed', 'cash', 'refunded'))]));

    v_order := pg_temp.order_with('TEST-RC-D', 'pending', 'transfer', 'completed');
    perform pg_temp.expect('the kitchen may still reject a paid order nobody has accepted', 'ok%',
      pg_temp.try_as(v_kitchen, array[format(v_q, v_order)]));
    perform pg_temp.expect('the cashier may not, pending or not', 'ERR paid_order_needs_refund',
      pg_temp.try_as(v_cashier, array[format(v_q, v_order)]));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  begin
    v_q := 'select public.cancel_order(%L, ''roles core'')::text';
    -- A diner's online card payment: the cashier is told a manager must do it, not sent to a refund.
    v_order := pg_temp.order_with('TEST-RC-E', 'confirmed', 'card', 'completed');
    perform pg_temp.expect('a paid online card order: cashier', 'ERR paid_order_needs_refund',
      pg_temp.try_as(v_cashier, array[format(v_q, v_order)]));
    perform pg_temp.expect('a paid online card order: owner is sent to the refund', 'ERR card_refund_required',
      pg_temp.try_as(v_owner, array[format(v_q, v_order)]));
    perform pg_temp.expect('a paid online card order: kitchen after pending', 'ERR paid_order_needs_refund',
      pg_temp.try_as(v_kitchen, array[format(v_q, v_order)]));
    update public.orders set status = 'pending' where id = v_order;
    perform pg_temp.expect('a paid online card order: kitchen while pending is sent to the refund', 'ERR card_refund_required',
      pg_temp.try_as(v_kitchen, array[format(v_q, v_order)]));

    perform pg_temp.expect('a rider row cannot cancel', 'ERR not_authorized',
      pg_temp.try_as(v_rider, array[format(v_q, pg_temp.order_with('TEST-RC-A2', 'pending', null, null))]));
  exception when others then
    perform pg_temp.expect('section 2b ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 3. direct status writes ----------------------------------------------------------------------
  begin
    v_order := pg_temp.order_with('TEST-RC-F', 'pending', null, null);
    v_q := 'update public.orders set status = %L where id = %L returning status::text';
    perform pg_temp.expect('the cashier cannot cancel by writing the status', 'ERR status_needs_rpc:cancelled',
      pg_temp.try_as(v_cashier, array[format(v_q, 'cancelled', v_order)]));
    perform pg_temp.expect('nor can the owner mark it refunded that way', 'ERR status_needs_rpc:refunded',
      pg_temp.try_as(v_owner, array[format(v_q, 'refunded', v_order)]));
    perform pg_temp.expect('nor the kitchen cancel that way', 'ERR status_needs_rpc:cancelled',
      pg_temp.try_as(v_kitchen, array[format(v_q, 'cancelled', v_order)]));
    perform pg_temp.expect('the counter confirms a pending order (counter-view)', 'ok confirmed',
      pg_temp.try_as(v_cashier, array[format(
        'update public.orders set status = ''confirmed'' where id = %L and status = ''pending'' returning status::text', v_order)]));
    perform pg_temp.expect('the kitchen advances and undoes (kitchen-view)', 'ok confirmed',
      pg_temp.try_as(v_kitchen, array[
        format('update public.orders set status = ''confirmed'' where id = %L and branch_id = %L and status = ''pending'' returning status::text', v_order, c_branch),
        format('update public.orders set status = ''preparing'' where id = %L and branch_id = %L and status = ''confirmed'' returning status::text', v_order, c_branch),
        format('update public.orders set status = ''confirmed'' where id = %L and branch_id = %L and status = ''preparing'' returning status::text', v_order, c_branch)]));
    perform pg_temp.expect('a member with neither kitchen nor counter cannot move it', 'ERR not_authorized',
      pg_temp.try_as(v_rider, array[format(v_q, 'confirmed', v_order)]));
    perform pg_temp.expect('writing the same status again is not a move', 'ok pending',
      pg_temp.try_as(v_rider, array[format('update public.orders set status = status where id = %L returning status::text', v_order)]));
    perform pg_temp.expect('the service role still corrects a status', 'ok cancelled',
      pg_temp.try_as(null, array[format(v_q, 'cancelled', v_order)]));
    perform pg_temp.expect('cancel_order (a definer function) still writes it', 'ok cancelled',
      pg_temp.try_as(v_cashier, array[
        format('select public.cancel_order(%L, ''roles core'')::text', v_order),
        format('select status::text from public.orders where id = %L', v_order)]));
    perform pg_temp.expect('the trigger is in place, after the older status guards', 'orders_a_final_status_guard orders_b_card_refund_guard orders_block_unpaid_transfer orders_c_direct_status_needs_capability',
      (select string_agg(t.tgname, ' ' order by t.tgname collate "C") from pg_trigger t
        where t.tgrelid = 'public.orders'::regclass and not t.tgisinternal
          and t.tgname in ('orders_a_final_status_guard', 'orders_b_card_refund_guard', 'orders_block_unpaid_transfer',
                           'orders_c_direct_status_needs_capability')));
  exception when others then
    perform pg_temp.expect('section 3 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 4. transfer slips ------------------------------------------------------------------------------
  begin
    v_order := pg_temp.order_with('TEST-RC-G', 'pending', 'transfer', 'pending');
    select id into v_pay from public.payments where order_id = v_order;
    v_q := 'select public.decide_payment_proof(%L, %s, ''roles core'')::text';
    perform pg_temp.expect('the kitchen cannot approve a slip', 'ERR forbidden',
      pg_temp.try_as(v_kitchen, array[format(v_q, v_pay, 'true')]));
    perform pg_temp.expect('the cashier approves a waiting slip, the order moves on, the audit row is written',
      'ok completed confirmed 1',
      pg_temp.try_as(v_cashier, array[
        format(v_q, v_pay, 'true'),
        -- Read back as the admin: since 20261016110000 an audit row needs reports.view.
        'select set_config(''request.jwt.claims'', ' || quote_literal(json_build_object('sub', v_admin, 'role', 'authenticated')::text) || ', true)',
        format('select set_config(''request.jwt.claim.sub'', %L, true)', v_admin),
        format('select p.status::text || '' '' || o.status::text || '' '' ||
                       (select count(*) from public.audit_logs a where a.entity_id = p.id and a.action = ''payment_proof_approved'')
                  from public.payments p join public.orders o on o.id = p.order_id where p.id = %L', v_pay)]));
    perform pg_temp.expect('the cashier rejects a waiting slip and the order is cancelled', 'ok failed cancelled',
      pg_temp.try_as(v_cashier, array[
        format(v_q, v_pay, 'false'),
        format('select p.status::text || '' '' || o.status::text from public.payments p join public.orders o on o.id = p.order_id where p.id = %L', v_pay)]));
    perform pg_temp.expect('a manager approves a waiting slip', 'ok%',
      pg_temp.try_as(v_manager, array[format(v_q, v_pay, 'true')]));
    update public.payments set status = 'completed' where id = v_pay;
    perform pg_temp.expect('the cashier cannot change a slip already decided', 'ERR payment_not_pending',
      pg_temp.try_as(v_cashier, array[format(v_q, v_pay, 'false')]));
    perform pg_temp.expect('a manager still can', 'ok%',
      pg_temp.try_as(v_manager, array[format(v_q, v_pay, 'false')]));

    -- Taken cash: "rejecting" it would cancel a paid order without orders.refund.
    v_order := pg_temp.order_with('TEST-RC-H', 'confirmed', 'cash', 'completed');
    select id into v_pay from public.payments where order_id = v_order;
    perform pg_temp.expect('the cashier cannot reject a cash payment', 'ERR forbidden',
      pg_temp.try_as(v_cashier, array[format(v_q, v_pay, 'false')]));
    perform pg_temp.expect('the owner still decides any payment', 'ok%',
      pg_temp.try_as(v_owner, array[format(v_q, v_pay, 'true')]));
  exception when others then
    perform pg_temp.expect('section 4 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 5. the old money RPCs ------------------------------------------------------------------------
  begin
    v_q := format('select (public.get_branch_reports(%L, 7) ->> ''period_days'')', c_branch);
    perform pg_temp.expect('get_branch_reports: cashier', 'ERR not authorized to read reports for this branch',
      pg_temp.try_as(v_cashier, array[v_q]));
    perform pg_temp.expect('get_branch_reports: kitchen', 'ERR not authorized to read reports for this branch',
      pg_temp.try_as(v_kitchen, array[v_q]));
    perform pg_temp.expect('get_branch_reports: manager', 'ok 7', pg_temp.try_as(v_manager, array[v_q]));
    perform pg_temp.expect('get_branch_reports: owner', 'ok 7', pg_temp.try_as(v_owner, array[v_q]));

    v_q := format('select (count(*) > 0)::text from public.get_branch_payout_summary(%L, 8)', c_branch);
    perform pg_temp.expect('fixture: Hamburger has rider earnings in the last 8 weeks', 'ok true',
      pg_temp.try_as(v_owner, array[v_q]));
    perform pg_temp.expect('get_branch_payout_summary: admin sees them', 'ok true', pg_temp.try_as(v_admin, array[v_q]));
    perform pg_temp.expect('get_branch_payout_summary: cashier sees none', 'ok false', pg_temp.try_as(v_cashier, array[v_q]));
    perform pg_temp.expect('get_branch_payout_summary: kitchen sees none', 'ok false', pg_temp.try_as(v_kitchen, array[v_q]));
  exception when others then
    perform pg_temp.expect('section 5 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 6. toggle_item_availability ------------------------------------------------------------------
  begin
    select mi.id into v_item from public.menu_items mi where mi.branch_id = c_branch order by mi.created_at limit 1;
    v_q := format('select public.toggle_item_availability(%L, false)::text', v_item);
    perform pg_temp.expect('the cashier cannot switch a dish off', 'ERR not_authorized', pg_temp.try_as(v_cashier, array[v_q]));
    perform pg_temp.expect('a rider row cannot either', 'ERR not_authorized', pg_temp.try_as(v_rider, array[v_q]));
    perform pg_temp.expect('the kitchen can', 'ok false',
      pg_temp.try_as(v_kitchen, array[v_q, format('select is_active::text from public.menu_items where id = %L', v_item)]));
    perform pg_temp.expect('a manager can', 'ok false',
      pg_temp.try_as(v_manager, array[v_q, format('select is_active::text from public.menu_items where id = %L', v_item)]));
  exception when others then
    perform pg_temp.expect('section 6 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 7. Add branch is the owner's ----------------------------------------------------------------
  begin
    -- An invalid slug, refused right after the rule: nothing is created, and the answer says
    -- whether the caller got past it.
    v_q := format('select public.create_branch(%L, ''Roles core test'', ''!'')::text', c_rest);
    perform pg_temp.expect('an admin at the branch cannot add a branch', 'ERR not_authorized', pg_temp.try_as(v_admin, array[v_q]));
    perform pg_temp.expect('a manager cannot', 'ERR not_authorized', pg_temp.try_as(v_manager, array[v_q]));
    perform pg_temp.expect('the owner gets past the rule', 'ERR invalid_slug', pg_temp.try_as(v_owner, array[v_q]));
    perform pg_temp.expect('an owner row gets past the rule', 'ERR invalid_slug', pg_temp.try_as(v_owner2, array[v_q]));
  exception when others then
    perform pg_temp.expect('section 7 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 8. audit_logs ----------------------------------------------------------------------------------
  begin
    v_order := pg_temp.order_with('TEST-RC-K', 'completed', 'cash', 'completed');
    v_q := format('insert into public.audit_logs (branch_id, actor_type, action, entity_type, entity_id, metadata)
                   values (%L, ''staff'', ''refund'', ''order'', %L, ''{"amount": 10}'') returning 1', c_branch, v_order);
    perform pg_temp.expect('a cashier cannot forge a refund row', 'ERR permission denied for table audit_logs',
      pg_temp.try_as(v_cashier, array[v_q]));
    perform pg_temp.expect('nor can the owner', 'ERR permission denied for table audit_logs',
      pg_temp.try_as(v_owner, array[v_q]));
    perform pg_temp.expect('nor change or delete rows', 'ERR permission denied for table audit_logs',
      pg_temp.try_as(v_owner, array['update public.audit_logs set metadata = ''{}'' where false returning 1']));
    perform pg_temp.expect('grants: authenticated reads only, anon nothing it can write',
      'true false false false false false',
      concat_ws(' ', has_table_privilege('authenticated', 'public.audit_logs', 'SELECT')::text,
                has_table_privilege('authenticated', 'public.audit_logs', 'INSERT')::text,
                has_table_privilege('authenticated', 'public.audit_logs', 'UPDATE')::text,
                has_table_privilege('authenticated', 'public.audit_logs', 'DELETE')::text,
                has_table_privilege('anon', 'public.audit_logs', 'INSERT')::text,
                has_table_privilege('authenticated', 'public.audit_logs', 'TRUNCATE')::text));
    perform pg_temp.expect('audit_logs policies', 'audit_staff_read SELECT',
      (select string_agg(policyname || ' ' || cmd, ', ' order by policyname) from pg_policies
        where schemaname = 'public' and tablename = 'audit_logs'));
    perform pg_temp.expect('refund_order still writes its audit row and adds them up', 'ERR refund_exceeds_remaining:4.00',
      pg_temp.try_as(v_owner, array[
        format('select public.refund_order(%L, 6, ''roles core'')::text', v_order),
        format('select public.refund_order(%L, 5, ''roles core'')::text', v_order)]));
    -- Read back as the admin: since 20261016110000 an audit row needs reports.view, which the
    -- cashier does not hold.
    perform pg_temp.expect('the admin reads the refund row the owner wrote', 'ok 1',
      pg_temp.try_as(v_owner, array[
        format('select public.refund_order(%L, 6, ''roles core'')::text', v_order),
        'select set_config(''request.jwt.claims'', ' || quote_literal(json_build_object('sub', v_admin, 'role', 'authenticated')::text) || ', true)',
        format('select set_config(''request.jwt.claim.sub'', %L, true)', v_admin),
        format('select count(*)::text from public.audit_logs where entity_id = %L and action = ''refund''', v_order)]));
  exception when others then
    perform pg_temp.expect('section 8 ran', 'ok', 'ERR ' || sqlerrm);
  end;
end
$test$;

select seq, verdict, check_name, expected, actual from t_out
union all
select 999999, (select case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAILURES' end from t_out),
       format('%s checks, %s failed', count(*), count(*) filter (where verdict = 'FAIL')), null, null
  from t_out
order by 1;

rollback;
