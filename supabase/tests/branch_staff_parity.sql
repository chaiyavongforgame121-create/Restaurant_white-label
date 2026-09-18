-- Branch staff parity: who may do what, on which branch. A rolled-back script, not a migration.
--
-- Run from the repo root:
--   SUPABASE_TELEMETRY_DISABLED=1 npx --yes supabase db query --linked \
--     --project-ref ayyfczidnzxetndiijmv -f supabase/tests/branch_staff_parity.sql
--
-- Everything happens inside one transaction that ends in ROLLBACK: the fixtures (orders, a
-- delivery, dishes, a combo, shifts) and every call made on someone's behalf. Each call also runs
-- in its own subtransaction that is always rolled back (pg_temp.try_as), so one person's cancel
-- cannot turn the next person's attempt into "already cancelled".
--
-- People (Coastal Grill; every staff row names Hamburger, Food Thai Thai has none of its own):
--   owner    chaiyavongboy1  owner row at Hamburger, not a platform admin
--   bb       bb@bb.com       admin row at Hamburger only
--   cashier  cashier@test    cashier row at Hamburger
--   kitchen  kitchen@test    kitchen row at Hamburger
--   customer customer@test   a diner
-- Expected: the owner passes on both branches; bb, cashier and kitchen pass on Hamburger within
-- their capabilities and are refused on Food Thai Thai; the diner only touches their own order.
--
-- The result is one row per check with PASS/FAIL, then a summary row.

begin;

create temp table t_out (
  seq serial,
  check_name text,
  who text,
  branch text,
  expected text,
  actual text,
  verdict text
) on commit drop;

-- Run statements as p_uid (null: as the session user) and report 'ok <last value>' or
-- 'ERR <message>'. The work is always rolled back.
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

-- Functions and policies that still compare a staff row's branch_id with a branch literally, with
-- no owner / restaurant-wide arm and no shared helper: the bug that refused the owner at every new
-- branch, now twice. Heuristic, statement by statement: a statement that reads staff_members,
-- compares that table's branch_id, and has neither an owner arm (role = 'owner'), a
-- restaurant-wide arm (branch_id is null) nor one of the private helpers. Writes to staff_members
-- are not checks and are skipped.
create or replace function pg_temp.lint_branch_pinned()
returns setof text
language plpgsql
as $$
declare
  r record;
  chunk text;
  a text;
  v_hit boolean;
begin
  for r in
    select 'fn ' || n.nspname || '.' || p.proname as name, p.prosrc as src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prosrc ~* 'staff_members'
    union all
    select 'policy ' || tablename || '.' || policyname,
           coalesce(qual, '') || ' ; ' || coalesce(with_check, '')
      from pg_policies
     where (coalesce(qual, '') || coalesce(with_check, '')) ~* 'staff_members'
  loop
    foreach chunk in array regexp_split_to_array(r.src, ';') loop
      continue when chunk !~* 'staff_members';
      continue when chunk ~* '(update|insert\s+into|delete\s+from)\s+(public\.)?staff_members';
      continue when chunk ~* 'role\s*=\s*''owner''|branch_id\s+is\s+null|staff_has_capability|user_manages_branch|user_branch_ids|staff_row_for_branch|user_has_role_in_branch';
      v_hit := chunk ~* 'staff_members\.branch_id\s*='
            or chunk ~* 'select\s+(staff_members\.)?branch_id\s+from\s+(public\.)?staff_members';
      for a in select lower(m[1]) from regexp_matches(chunk, 'staff_members\s+(?:as\s+)?([a-z_][a-z0-9_]*)', 'gi') m loop
        if a in ('where', 'on', 'join', 'left', 'inner', 'set', 'group', 'order', 'limit', 'using',
                 'for', 'union', 'cross', 'returning', 'values', 'and', 'or') then
          v_hit := v_hit or chunk ~* '(^|[^.a-z0-9_])branch_id\s*=';
        else
          v_hit := v_hit or chunk ~* ('(^|[^a-z0-9_])' || a || '\.branch_id\s*=');
        end if;
      end loop;
      if v_hit then
        return next r.name;
        exit;
      end if;
    end loop;
  end loop;
end $$;

create or replace function pg_temp.expect(p_check text, p_who text, p_branch text, p_expected text, p_actual text)
returns void
language sql
as $$
  insert into t_out (check_name, who, branch, expected, actual, verdict)
  values (p_check, p_who, p_branch, p_expected, p_actual,
          case when p_actual like p_expected || '%' then 'PASS' else 'FAIL' end);
$$;

do $test$
declare
  c_rest    constant uuid := '33333333-3333-3333-3333-333333333333';
  c_ham     constant uuid := '44444444-4444-4444-4444-444444444444';
  c_ftt     constant uuid := 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';
  c_owner   constant uuid := '9467cf42-0a03-4abe-86d5-a2610ee15d0a';
  c_bb      constant uuid := '147d5c02-04e7-44af-8595-337605d785e6';
  c_cashier constant uuid := 'a2222222-2222-2222-2222-222222222222';
  c_kitchen constant uuid := 'a3333333-3333-3333-3333-333333333333';
  c_cust    constant uuid := 'a1111111-1111-1111-1111-111111111111';
  -- Silom Flagship, a branch of another tenant (Somtam Zab).
  c_other_branch constant uuid := '22222222-2222-2222-2222-222222222222';

  v_people  jsonb := jsonb_build_object('owner', c_owner, 'bb', c_bb, 'cashier', c_cashier,
                                        'kitchen', c_kitchen, 'customer', c_cust);
  -- Expected outcome per person on [Hamburger, Food Thai Thai], by capability family.
  v_expect  jsonb := jsonb_build_object(
    -- orders.cancel or kitchen.access
    'cancel',  jsonb_build_object('owner', '["ok","ok"]', 'bb', '["ok","ERR not_authorized"]',
                 'cashier', '["ok","ERR not_authorized"]', 'kitchen', '["ok","ERR not_authorized"]',
                 'customer', '["ERR not_authorized","ERR not_authorized"]'),
    -- orders.refund (refund_order, issue_tax_invoice)
    'refund',  jsonb_build_object('owner', '["ok","ok"]', 'bb', '["ok","ERR not_authorized"]',
                 'cashier', '["ERR not_authorized","ERR not_authorized"]',
                 'kitchen', '["ERR not_authorized","ERR not_authorized"]',
                 'customer', '["ERR not_authorized","ERR not_authorized"]'),
    -- kitchen.access
    'recall',  jsonb_build_object('owner', '["ok","ok"]', 'bb', '["ok","ERR not_authorized"]',
                 'cashier', '["ERR not_authorized","ERR not_authorized"]',
                 'kitchen', '["ok","ERR not_authorized"]',
                 'customer', '["ERR not_authorized","ERR not_authorized"]'),
    -- menu.manage, reports.view, drivers.manage: owner/admin/manager
    'manage',  jsonb_build_object('owner', '["ok","ok"]', 'bb', '["ok","ERR not_authorized"]',
                 'cashier', '["ERR not_authorized","ERR not_authorized"]',
                 'kitchen', '["ERR not_authorized","ERR not_authorized"]',
                 'customer', '["ERR not_authorized","ERR not_authorized"]'),
    -- delivery.manage (requeue_failed_delivery says 'forbidden')
    'requeue', jsonb_build_object('owner', '["ok","ok"]', 'bb', '["ok","ERR forbidden"]',
                 'cashier', '["ERR forbidden","ERR forbidden"]', 'kitchen', '["ERR forbidden","ERR forbidden"]',
                 'customer', '["ERR forbidden","ERR forbidden"]'),
    -- any active staff row covering the branch
    'clock',   jsonb_build_object('owner', '["ok","ok"]', 'bb', '["ok","ERR not_staff_at_branch"]',
                 'cashier', '["ok","ERR not_staff_at_branch"]', 'kitchen', '["ok","ERR not_staff_at_branch"]',
                 'customer', '["ERR not_staff_at_branch","ERR not_staff_at_branch"]')
  );

  v_branches uuid[] := array[c_ham, c_ftt];
  v_bname    text[] := array['Hamburger', 'FoodThaiThai'];
  i int;
  b uuid;
  who text;
  uid uuid;
  e text;

  v_pending  uuid[] := array[null, null]::uuid[];
  v_ready    uuid[] := array[null, null]::uuid[];
  v_done     uuid[] := array[null, null]::uuid[];
  v_deliv    uuid[] := array[null, null]::uuid[];
  v_cat      uuid[] := array[null, null]::uuid[];
  o uuid;
  d uuid;
  v_order_seq int := 0;

  v_cust_row uuid;
  v_other_cust uuid;
  v_cust_order uuid;
  v_cust_late uuid;
  v_other_order uuid;

  v_owner_row uuid;
  v_bb_row uuid;
  v_cashier_row uuid;
  v_shift uuid;
  v_cshift uuid;
  v_res text;

  -- stock
  v_a uuid;
  v_b uuid;
  v_combo uuid;
  v_sorder uuid;
  v_lorder uuid;
  v_rorder uuid;
  v_rlate uuid;
  v_pay uuid;
  v_qa int;
  v_qb int;
begin
  select id into v_owner_row from public.staff_members where user_id = c_owner and restaurant_id = c_rest and role = 'owner';
  select id into v_bb_row from public.staff_members where user_id = c_bb and restaurant_id = c_rest;
  select id into v_cashier_row from public.staff_members where user_id = c_cashier and restaurant_id = c_rest;

  -- Nobody starts the test on the clock.
  update public.staff_shifts set clocked_out_at = now()
   where clocked_out_at is null
     and staff_member_id in (select id from public.staff_members where user_id in (c_owner, c_bb, c_cashier, c_kitchen));

  -- Fixtures: per branch a walk-in pending order, a ready order, a completed order, a failed delivery.
  for i in 1..2 loop
    b := v_branches[i];
    v_order_seq := v_order_seq + 1;
    insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
    values ('T-PARITY-P' || i, b, 'pickup', 'pending', 10, 10, '[]')
    returning id into o;
    v_pending[i] := o;

    insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
    values ('T-PARITY-R' || i, b, 'pickup', 'ready', 10, 10,
            jsonb_build_array(jsonb_build_object('status', 'ready', 'at', now())))
    returning id into o;
    v_ready[i] := o;

    insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
    values ('T-PARITY-C' || i, b, 'pickup', 'completed', 10, 10, '[]')
    returning id into o;
    v_done[i] := o;

    insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
    values ('T-PARITY-D' || i, b, 'pickup', 'ready', 10, 10, '[]')
    returning id into o;
    insert into public.deliveries (order_id, branch_id, status, failed_reason)
    values (o, b, 'failed', 'parity test')
    returning id into d;
    v_deliv[i] := d;

    v_cat[i] := (select mc.id from public.menu_categories mc where mc.branch_id = b order by mc.display_order limit 1);
  end loop;

  -- The matrix.
  foreach who in array array['owner', 'bb', 'cashier', 'kitchen', 'customer'] loop
    uid := (v_people ->> who)::uuid;
    for i in 1..2 loop
      b := v_branches[i];

      e := (v_expect -> 'cancel' ->> who)::jsonb ->> (i - 1);
      perform pg_temp.expect('cancel_order', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select public.cancel_order(%L, %L)::text', v_pending[i], 'parity')]));

      e := (v_expect -> 'refund' ->> who)::jsonb ->> (i - 1);
      perform pg_temp.expect('refund_order', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select public.refund_order(%L, 1, %L)::text', v_done[i], 'parity')]));
      perform pg_temp.expect('issue_tax_invoice', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select (public.issue_tax_invoice(%L)).invoice_number', v_done[i])]));

      e := (v_expect -> 'recall' ->> who)::jsonb ->> (i - 1);
      perform pg_temp.expect('recall_order', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select public.recall_order(%L)::text', v_ready[i])]));

      e := (v_expect -> 'manage' ->> who)::jsonb ->> (i - 1);
      perform pg_temp.expect('reorder_menu_categories', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select public.reorder_menu_categories(%L, %L::jsonb)::text', b,
          jsonb_build_array(jsonb_build_object('id', v_cat[i], 'display_order', 0)))]));
      perform pg_temp.expect('reorder_menu_items', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select public.reorder_menu_items(%L, %L::jsonb)::text', b, '[]')]));
      perform pg_temp.expect('set_menu_item_category', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select public.set_menu_item_category(%L, gen_random_uuid(), %L, 0)::text', b, v_cat[i])]));
      perform pg_temp.expect('duplicate_menu_category', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select public.duplicate_menu_category(%L)::text', v_cat[i])]));
      perform pg_temp.expect('forecast_orders', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select jsonb_array_length(public.forecast_orders(%L))::text', b)]));
      perform pg_temp.expect('get_sales_tax_report', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select (public.get_sales_tax_report(%L, now() - interval %L, now()))->>%L', b, '30 days', 'total_gross')]));
      perform pg_temp.expect('tip_pool_distribution', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select count(*)::text from public.tip_pool_distribution(%L, now() - interval %L, now())', b, '7 days')]));
      perform pg_temp.expect('mark_driver_payout_paid', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select (public.mark_driver_payout_paid(%L, gen_random_uuid(), current_date))->>%L', b, 'marked_paid')]));

      e := (v_expect -> 'requeue' ->> who)::jsonb ->> (i - 1);
      perform pg_temp.expect('requeue_failed_delivery', who, v_bname[i], e,
        pg_temp.try_as(uid, array[format('select public.requeue_failed_delivery(%L)::text', v_deliv[i])]));

      -- Clock in, see the shift, clock out: my_open_shift names the row the shift was opened with.
      e := (v_expect -> 'clock' ->> who)::jsonb ->> (i - 1);
      perform pg_temp.expect('clock_in/my_open_shift/clock_out', who, v_bname[i], e,
        pg_temp.try_as(uid, array[
          format('select public.clock_in(%L)::text', b),
          format('select case when public.my_open_shift(%L) is null then %L end', b, 'my_open_shift returned null'),
          'select public.clock_out(null)::text',
          format('select coalesce(public.my_open_shift(%L)::text, %L)', b, 'closed')]));
    end loop;
  end loop;

  -- Attribution: the caller's row for the branch, exact branch first, then owner row.
  perform pg_temp.expect('staff_row_for_branch', 'owner', 'FoodThaiThai', 'ok ' || v_owner_row,
    pg_temp.try_as(c_owner, array[format('select private.staff_row_for_branch(%L)::text', c_ftt)]));
  perform pg_temp.expect('staff_row_for_branch', 'bb', 'Hamburger', 'ok ' || v_bb_row,
    pg_temp.try_as(c_bb, array[format('select private.staff_row_for_branch(%L)::text', c_ham)]));
  perform pg_temp.expect('staff_row_for_branch (none)', 'bb', 'FoodThaiThai', 'ok',
    pg_temp.try_as(c_bb, array[format('select coalesce(private.staff_row_for_branch(%L)::text, %L)', c_ftt, '')]));
  perform pg_temp.expect('my_open_shift.staff_member_id', 'owner', 'FoodThaiThai', 'ok ' || v_owner_row,
    pg_temp.try_as(c_owner, array[
      format('select public.clock_in(%L)::text', c_ftt),
      format('select public.my_open_shift(%L)->>%L', c_ftt, 'staff_member_id')]));
  perform pg_temp.expect('clock_in while on shift elsewhere', 'owner', 'FoodThaiThai', 'ERR clocked_in_elsewhere',
    pg_temp.try_as(c_owner, array[
      format('select public.clock_in(%L)::text', c_ham),
      format('select public.clock_in(%L)::text', c_ftt)]));

  -- Counter payment at Food Thai Thai is stamped with the owner's row, not "any row, limit 1".
  insert into public.payments (order_id, branch_id, amount, method, status)
  values (v_pending[2], c_ftt, 10, 'cash', 'pending')
  returning id into v_pay;
  perform pg_temp.expect('record_counter_payment confirmed_by', 'owner', 'FoodThaiThai', 'ok ' || v_owner_row,
    pg_temp.try_as(c_owner, array[
      format('select public.record_counter_payment(%L)::text', v_pending[2]),
      format('select confirmed_by::text from public.payments where id = %L', v_pay)]));
  perform pg_temp.expect('record_counter_payment', 'bb', 'FoodThaiThai', 'ERR forbidden',
    pg_temp.try_as(c_bb, array[format('select public.record_counter_payment(%L)::text', v_pending[2])]));

  -- A suspended member is refused even at their own branch.
  update public.staff_members set status = 'suspended' where id = v_bb_row;
  perform pg_temp.expect('cancel_order (suspended)', 'bb', 'Hamburger', 'ERR not_authorized',
    pg_temp.try_as(c_bb, array[format('select public.cancel_order(%L)::text', v_pending[1])]));
  perform pg_temp.expect('clock_in (suspended)', 'bb', 'Hamburger', 'ERR not_staff_at_branch',
    pg_temp.try_as(c_bb, array[format('select public.clock_in(%L)::text', c_ham)]));
  update public.staff_members set status = 'active' where id = v_bb_row;

  -- The diner: their own order yes, a walk-in order or someone else's no.
  select id into v_cust_row from public.customers where user_id = c_cust and branch_id = c_ham limit 1;
  select id into v_other_cust from public.customers
   where branch_id = c_ham and user_id is distinct from c_cust order by created_at limit 1;
  if v_cust_row is not null then
    insert into public.orders (order_number, branch_id, channel, status, subtotal, total, customer_id, status_history)
    values ('T-PARITY-MINE', c_ham, 'pickup', 'pending', 10, 10, v_cust_row, '[]') returning id into v_cust_order;
    insert into public.orders (order_number, branch_id, channel, status, subtotal, total, customer_id, status_history)
    values ('T-PARITY-LATE', c_ham, 'pickup', 'preparing', 10, 10, v_cust_row, '[]') returning id into v_cust_late;
    perform pg_temp.expect('cancel own pending order', 'customer', 'Hamburger', 'ok',
      pg_temp.try_as(c_cust, array[format('select public.cancel_order(%L)::text', v_cust_order)]));
    perform pg_temp.expect('cancel own order once cooking', 'customer', 'Hamburger', 'ERR too_late_for_customer_cancel',
      pg_temp.try_as(c_cust, array[format('select public.cancel_order(%L)::text', v_cust_late)]));
  else
    perform pg_temp.expect('cancel own pending order', 'customer', 'Hamburger', 'skipped', 'skipped (no customers row)');
  end if;
  if v_other_cust is not null then
    insert into public.orders (order_number, branch_id, channel, status, subtotal, total, customer_id, status_history)
    values ('T-PARITY-THEIRS', c_ham, 'pickup', 'pending', 10, 10, v_other_cust, '[]') returning id into v_other_order;
    perform pg_temp.expect('cancel someone else''s order', 'customer', 'Hamburger', 'ERR not_authorized',
      pg_temp.try_as(c_cust, array[format('select public.cancel_order(%L)::text', v_other_order)]));
  end if;
  perform pg_temp.expect('cancel walk-in order (NULL hole)', 'customer', 'Hamburger', 'ERR not_authorized',
    pg_temp.try_as(c_cust, array[format('select public.cancel_order(%L)::text', v_pending[1])]));
  -- 20260918200000_isolation_leftovers dropped edit_pending_order (no caller, and every call failed
  -- on order_items.name). The check below runs for as long as the function exists.
  if to_regprocedure('public.edit_pending_order(uuid,jsonb)') is not null then
  perform pg_temp.expect('edit_pending_order on walk-in order', 'customer', 'Hamburger', 'ERR not_your_order',
    pg_temp.try_as(c_cust, array[format('select public.edit_pending_order(%L, %L::jsonb)::text', v_pending[1], '[]')]));
  else
    perform pg_temp.expect('edit_pending_order is dropped', 'customer', 'Hamburger', 'dropped', 'dropped');
  end if;
  perform pg_temp.expect('refund_order null amount', 'owner', 'Hamburger', 'ERR invalid_refund_amount',
    pg_temp.try_as(c_owner, array[format('select public.refund_order(%L, null)::text', v_done[1])]));

  -- RLS: shift reads follow staff.timelog wherever the row was created; inserts need a row
  -- that covers the branch.
  insert into public.staff_shifts (staff_member_id, branch_id, shift_role, clocked_in_at)
  values (v_owner_row, c_ftt, 'general', now() - interval '2 hours')
  returning id into v_shift;
  perform pg_temp.expect('staff_shifts read at FTT', 'owner', 'FoodThaiThai', 'ok true',
    pg_temp.try_as(c_owner, array[format('select (count(*) >= 1)::text from public.staff_shifts where branch_id = %L', c_ftt)]));
  perform pg_temp.expect('clock_out of someone else''s shift', 'bb', 'Hamburger', 'ERR shift_not_found',
    pg_temp.try_as(c_bb, array[format('select public.clock_out(%L)::text', v_shift)]));
  perform pg_temp.expect('clock_out of own shift at FTT', 'owner', 'FoodThaiThai', 'ok',
    pg_temp.try_as(c_owner, array[format('select public.clock_out(%L)::text', v_shift)]));
  perform pg_temp.expect('staff_shifts read at FTT', 'bb', 'FoodThaiThai', 'ok 0',
    pg_temp.try_as(c_bb, array[format('select count(*)::text from public.staff_shifts where branch_id = %L', c_ftt)]));
  -- Shift writes belong to the time-log keeper (staff.timelog at the shift's branch) and must stay
  -- with a staff row that covers the branch; open shifts come only from clock_in.
  perform pg_temp.expect('staff_shifts insert closed shift at FTT', 'owner', 'FoodThaiThai', 'ok',
    pg_temp.try_as(c_owner, array[format(
      'insert into public.staff_shifts (staff_member_id, branch_id, clocked_in_at, clocked_out_at) values (%L, %L, now() - interval %L, now()) returning 1',
      v_owner_row, c_ftt, '3 hours')]));
  perform pg_temp.expect('staff_shifts insert open shift (clock_in only)', 'owner', 'FoodThaiThai', 'ERR new row violates row-level security',
    pg_temp.try_as(c_owner, array[format(
      'insert into public.staff_shifts (staff_member_id, branch_id) values (%L, %L) returning 1', v_owner_row, c_ftt)]));
  perform pg_temp.expect('staff_shifts insert closed shift at FTT', 'bb', 'FoodThaiThai', 'ERR new row violates row-level security',
    pg_temp.try_as(c_bb, array[format(
      'insert into public.staff_shifts (staff_member_id, branch_id, clocked_in_at, clocked_out_at) values (%L, %L, now() - interval %L, now()) returning 1',
      v_bb_row, c_ftt, '3 hours')]));
  perform pg_temp.expect('staff_shifts insert backdated own shift', 'cashier', 'Hamburger', 'ERR new row violates row-level security',
    pg_temp.try_as(c_cashier, array[format(
      'insert into public.staff_shifts (staff_member_id, branch_id, clocked_in_at, clocked_out_at) values (%L, %L, now() - interval %L, now()) returning 1',
      v_cashier_row, c_ham, '40 hours')]));

  insert into public.staff_shifts (staff_member_id, branch_id, shift_role, clocked_in_at, clocked_out_at)
  values (v_cashier_row, c_ham, 'general', now() - interval '5 hours', now() - interval '1 hour')
  returning id into v_cshift;
  perform pg_temp.expect('cashier moves own shift to FTT, 40h longer', 'cashier', 'Hamburger', 'ok 0',
    pg_temp.try_as(c_cashier, array[format(
      'with u as (update public.staff_shifts set branch_id = %L, clocked_in_at = clocked_in_at - interval %L where id = %L returning 1) select count(*)::text from u',
      c_ftt, '40 hours', v_cshift)]));
  perform pg_temp.expect('cashier moves own shift to another restaurant', 'cashier', 'Hamburger', 'ok 0',
    pg_temp.try_as(c_cashier, array[format(
      'with u as (update public.staff_shifts set branch_id = %L where id = %L returning 1) select count(*)::text from u',
      c_other_branch, v_cshift)]));
  perform pg_temp.expect('keeper fixes cashier shift times', 'owner', 'Hamburger', 'ok 1',
    pg_temp.try_as(c_owner, array[format(
      'with u as (update public.staff_shifts set clocked_in_at = clocked_in_at + interval %L where id = %L returning 1) select count(*)::text from u',
      '30 minutes', v_cshift)]));
  perform pg_temp.expect('keeper fixes cashier shift times', 'bb', 'Hamburger', 'ok 1',
    pg_temp.try_as(c_bb, array[format(
      'with u as (update public.staff_shifts set clocked_in_at = clocked_in_at + interval %L where id = %L returning 1) select count(*)::text from u',
      '30 minutes', v_cshift)]));
  perform pg_temp.expect('keeper moves Hamburger cashier shift to FTT', 'owner', 'FoodThaiThai', 'ERR new row violates row-level security',
    pg_temp.try_as(c_owner, array[format(
      'update public.staff_shifts set branch_id = %L where id = %L', c_ftt, v_cshift)]));
  perform pg_temp.expect('keeper moves shift to another restaurant', 'owner', 'SilomFlagship', 'ERR new row violates row-level security',
    pg_temp.try_as(c_owner, array[format(
      'update public.staff_shifts set branch_id = %L where id = %L', c_other_branch, v_cshift)]));
  perform pg_temp.expect('keeper moves shift to FTT', 'bb', 'FoodThaiThai', 'ERR new row violates row-level security',
    pg_temp.try_as(c_bb, array[format(
      'update public.staff_shifts set branch_id = %L where id = %L', c_ftt, v_cshift)]));
  perform pg_temp.expect('clock_in serialises per person', 'system', 'all', 'ok true',
    pg_temp.try_as(null, array[
      'select (prosrc ~ ''pg_advisory_xact_lock'')::text from pg_proc where oid = ''public.clock_in(uuid,text)''::regprocedure']));
  perform pg_temp.expect('tax_invoice_sequence read at FTT', 'owner', 'FoodThaiThai', 'ok 1',
    pg_temp.try_as(c_owner, array[
      format('select (public.issue_tax_invoice(%L)).invoice_number', v_done[2]),
      format('select count(*)::text from public.tax_invoice_sequence where branch_id = %L', c_ftt)]));

  -- No function or policy compares a staff row's branch literally any more.
  perform pg_temp.expect('lint: branch-pinned staff checks', 'system', 'all', 'none',
    coalesce((select string_agg(x, ', ' order by x) from pg_temp.lint_branch_pinned() x), 'none'));

  -- Stock comes back exactly once on cancel: two lines of the same dish plus two combo lines (one
  -- with the combo_contents snapshot, one without) at Food Thai Thai.
  insert into public.menu_items (branch_id, name, price, track_stock, stock_quantity, low_stock_threshold, is_active)
  values (c_ftt, 'Parity dish A', 5, true, 20, 0, true) returning id into v_a;
  insert into public.menu_items (branch_id, name, price, track_stock, stock_quantity, low_stock_threshold, is_active)
  values (c_ftt, 'Parity dish B', 5, true, 20, 0, true) returning id into v_b;
  insert into public.combo_sets (branch_id, name, total_price, is_active)
  values (c_ftt, 'Parity combo', 12, true) returning id into v_combo;
  insert into public.combo_items (combo_id, menu_item_id, quantity) values (v_combo, v_a, 1), (v_combo, v_b, 2);

  insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
  values ('T-PARITY-STOCK', c_ftt, 'pickup', 'pending', 10, 10, '[]') returning id into v_sorder;
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal)
  values (v_sorder, v_a, 'Parity dish A', 5, 1, 5),
         (v_sorder, v_a, 'Parity dish A', 5, 2, 10);
  insert into public.order_items (order_id, menu_item_id, combo_id, item_name, unit_price, quantity, subtotal, combo_contents)
  values (v_sorder, null, v_combo, 'Parity combo', 12, 2, 24, null),
         (v_sorder, null, v_combo, 'Parity combo', 12, 1, 12,
          jsonb_build_array(jsonb_build_object('menu_item_id', v_a, 'quantity', 1),
                            jsonb_build_object('menu_item_id', v_b, 'quantity', 2)));
  -- Taken: A = 1 + 2 + 2x1 + 1x1 = 6, B = 2x2 + 1x2 = 6.
  select stock_quantity into v_qa from public.menu_items where id = v_a;
  select stock_quantity into v_qb from public.menu_items where id = v_b;
  perform pg_temp.expect('stock after sale', 'system', 'FoodThaiThai', 'A=14 B=14', format('A=%s B=%s', v_qa, v_qb));

  -- cancel_order as the owner, for real (not rolled back), then twice more.
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', c_owner::text, true);
  perform public.cancel_order(v_sorder, 'parity stock');
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select stock_quantity into v_qa from public.menu_items where id = v_a;
  select stock_quantity into v_qb from public.menu_items where id = v_b;
  perform pg_temp.expect('stock after cancel_order', 'owner', 'FoodThaiThai', 'A=20 B=20', format('A=%s B=%s', v_qa, v_qb));

  perform pg_temp.expect('second cancel_order', 'owner', 'FoodThaiThai', 'ERR cannot_cancel_status:cancelled',
    pg_temp.try_as(c_owner, array[format('select public.cancel_order(%L)::text', v_sorder)]));
  update public.orders set status = 'cancelled' where id = v_sorder;   -- same status: no transition
  select stock_quantity into v_qa from public.menu_items where id = v_a;
  select stock_quantity into v_qb from public.menu_items where id = v_b;
  perform pg_temp.expect('stock after repeated cancel', 'system', 'FoodThaiThai', 'A=20 B=20', format('A=%s B=%s', v_qa, v_qb));

  update public.orders set status = 'pending' where id = v_sorder;     -- un-cancel takes it again
  select stock_quantity into v_qa from public.menu_items where id = v_a;
  select stock_quantity into v_qb from public.menu_items where id = v_b;
  perform pg_temp.expect('stock after un-cancel', 'system', 'FoodThaiThai', 'A=14 B=14', format('A=%s B=%s', v_qa, v_qb));

  -- decide_payment_proof's reject is a cancel too.
  insert into public.payments (order_id, branch_id, amount, method, status)
  values (v_sorder, c_ftt, 10, 'transfer', 'pending') returning id into v_pay;
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', c_owner::text, true);
  perform public.decide_payment_proof(v_pay, false, 'parity reject');
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select stock_quantity into v_qa from public.menu_items where id = v_a;
  select stock_quantity into v_qb from public.menu_items where id = v_b;
  perform pg_temp.expect('stock after slip rejected', 'owner', 'FoodThaiThai', 'A=20 B=20', format('A=%s B=%s', v_qa, v_qb));
  select confirmed_by::text into v_res from public.payments where id = v_pay;
  perform pg_temp.expect('decide_payment_proof confirmed_by', 'owner', 'FoodThaiThai', v_owner_row::text, coalesce(v_res, 'null'));

  update public.orders set status = 'refunded' where id = v_sorder;    -- cancelled -> refunded: no move
  select stock_quantity into v_qa from public.menu_items where id = v_a;
  select stock_quantity into v_qb from public.menu_items where id = v_b;
  perform pg_temp.expect('stock after cancelled -> refunded', 'system', 'FoodThaiThai', 'A=20 B=20', format('A=%s B=%s', v_qa, v_qb));

  -- A combo line sold before combos took stock (2026-09-18 05:45:50 UTC) took none, so it gives
  -- none back. Each line records what it took (order_items.stock_taken, 20260918170000_stock_integrity);
  -- such a line has no record (NULL), so the test clears the record today's decrement wrote and
  -- resets the shelf to what the old decrement would have left (dish line only).
  insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
  values ('T-PARITY-LEGACY', c_ftt, 'pickup', 'pending', 10, 10, '[]') returning id into v_lorder;
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal)
  values (v_lorder, v_a, 'Parity dish A', 5, 1, 5);
  insert into public.order_items (order_id, menu_item_id, combo_id, item_name, unit_price, quantity, subtotal, combo_contents, created_at)
  values (v_lorder, null, v_combo, 'Parity combo', 12, 1, 12, null, timestamptz '2026-09-01 12:00+00');
  update public.order_items set stock_taken = null where order_id = v_lorder and menu_item_id is null;
  update public.menu_items set stock_quantity = 10 where id in (v_a, v_b);
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', c_owner::text, true);
  perform public.cancel_order(v_lorder, 'parity legacy combo');
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select stock_quantity into v_qa from public.menu_items where id = v_a;
  select stock_quantity into v_qb from public.menu_items where id = v_b;
  perform pg_temp.expect('stock after cancel, legacy combo line', 'owner', 'FoodThaiThai', 'A=11 B=10', format('A=%s B=%s', v_qa, v_qb));
  update public.orders set status = 'pending' where id = v_lorder;     -- un-cancel: the dish only
  select stock_quantity into v_qa from public.menu_items where id = v_a;
  select stock_quantity into v_qb from public.menu_items where id = v_b;
  perform pg_temp.expect('stock after un-cancel, legacy combo line', 'system', 'FoodThaiThai', 'A=10 B=10', format('A=%s B=%s', v_qa, v_qb));

  -- A full refund before the kitchen started is a cancellation with money back; after, the food
  -- is made and the stock stays gone.
  update public.menu_items set stock_quantity = 20 where id in (v_a, v_b);
  insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
  values ('T-PARITY-REFUND-EARLY', c_ftt, 'pickup', 'confirmed', 10, 10, '[]') returning id into v_rorder;
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal)
  values (v_rorder, v_a, 'Parity dish A', 5, 5, 25);
  insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
  values ('T-PARITY-REFUND-LATE', c_ftt, 'pickup', 'preparing', 10, 10, '[]') returning id into v_rlate;
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, subtotal)
  values (v_rlate, v_b, 'Parity dish B', 5, 3, 15);
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', c_owner::text, true);
  perform public.refund_order(v_rorder, 10, 'parity refund early');
  perform public.refund_order(v_rlate, 10, 'parity refund late');
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select stock_quantity into v_qa from public.menu_items where id = v_a;
  select stock_quantity into v_qb from public.menu_items where id = v_b;
  perform pg_temp.expect('stock after full refunds (confirmed A x5, preparing B x3)', 'owner', 'FoodThaiThai',
    'A=20 B=17', format('A=%s B=%s', v_qa, v_qb));
  update public.orders set status = 'cancelled' where id = v_rorder;   -- refunded -> cancelled: no move
  select stock_quantity into v_qa from public.menu_items where id = v_a;
  perform pg_temp.expect('stock after refunded -> cancelled', 'system', 'FoodThaiThai', 'A=20', format('A=%s', v_qa));
end
$test$;

select seq, verdict, check_name, who, branch, expected, actual from t_out
union all
select 999999, (select case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAILURES' end from t_out),
       format('%s checks, %s failed', count(*), count(*) filter (where verdict = 'FAIL')), null, null, null, null
  from t_out
order by 1;

rollback;
