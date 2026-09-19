-- Isolation leftovers (20260918200000_isolation_leftovers). A rolled-back script, not a migration.
--
-- Run from the repo root:
--   SUPABASE_TELEMETRY_DISABLED=1 npx --yes supabase db query --linked \
--     --project-ref ayyfczidnzxetndiijmv -f supabase/tests/isolation_leftovers.sql
--
-- Everything happens inside one transaction that ends in ROLLBACK. Calls made on someone's behalf
-- through pg_temp.try_as also run in their own subtransaction, which is always rolled back.
--
-- People (never owner@test.com: it is a platform admin, so every check passes for it):
--   customer  customer@test.com  a diner with a customers row at Hamburger only
--   bobby     Bobby              a diner with rows at Hamburger and Food Thai Thai
--   driver    driver@test.com    a rider
--   cashier   cashier@test.com   cashier row at Hamburger
--   owner     chaiyavongboy1     owner row at Hamburger
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

-- Act as p_uid for plain statements that follow (not rolled back until the end of the script).
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
  c_ham    constant uuid := '44444444-4444-4444-4444-444444444444';
  c_ftt    constant uuid := 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';
  c_cust   constant uuid := 'a1111111-1111-1111-1111-111111111111';
  c_bobby  constant uuid := '1e74fba1-cebf-46b1-a963-fb4915bd899d';
  c_driver constant uuid := 'a4444444-4444-4444-4444-444444444444';
  c_cash   constant uuid := 'a2222222-2222-2222-2222-222222222222';
  c_owner  constant uuid := '9467cf42-0a03-4abe-86d5-a2610ee15d0a';
  v_cust_row uuid;
  v_bobby_ftt uuid;
  v_bobby_ham uuid;
  v_driver_row uuid;
  v_cash_row uuid;
  v_owner_row uuid;
  v_ep constant text := 'https://push.example.test/isolation-leftovers-1';
  v_sub1 uuid;
  v_sub2 uuid;
  v_row record;
  v_n int;
  v_cart_other uuid;
  v_cart_ftt uuid;
  v_cart_ham uuid;
  v_cart_synth uuid;
  v_cart_guest uuid;
  v_cart_recent uuid;
  v_swept int;
begin
  select id into v_cust_row   from public.customers where user_id = c_cust  and branch_id = c_ham order by created_at limit 1;
  select id into v_bobby_ftt  from public.customers where user_id = c_bobby and branch_id = c_ftt order by created_at limit 1;
  select id into v_bobby_ham  from public.customers where user_id = c_bobby and branch_id = c_ham order by created_at limit 1;
  select id into v_driver_row from public.drivers where user_id = c_driver limit 1;
  select id into v_cash_row   from public.staff_members where user_id = c_cash  and status = 'active' order by created_at limit 1;
  select id into v_owner_row  from public.staff_members where user_id = c_owner and status = 'active' order by created_at limit 1;

  -- 1. edit_pending_order is gone (no caller; every call failed on order_items.name).
  perform pg_temp.expect('edit_pending_order dropped', 'true',
    (not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'edit_pending_order'))::text);

  -- 2. private.customer_id_for_user is gone; the set-returning helpers still work.
  perform pg_temp.expect('private.customer_id_for_user dropped', 'true',
    (to_regprocedure('private.customer_id_for_user()') is null)::text);
  perform pg_temp.expect('order_ids_for_customer sees Bobby''s orders at both branches', 'ok true',
    pg_temp.try_as(c_bobby, array[
      'select ((select count(*) from private.order_ids_for_customer())
               = (select count(*) from public.orders o join public.customers c on c.id = o.customer_id
                   where c.user_id = ''1e74fba1-cebf-46b1-a963-fb4915bd899d''))::text']));

  -- 3. register_push_subscription: only the caller's own recipient.
  perform pg_temp.expect('fixtures present', 'true',
    (v_cust_row is not null and v_bobby_ftt is not null and v_driver_row is not null
     and v_cash_row is not null and v_owner_row is not null)::text);
  perform pg_temp.expect('anon may not register push', 'false',
    has_function_privilege('anon', 'public.register_push_subscription(text,uuid,text,text,text,text)', 'execute')::text);
  perform pg_temp.expect('register push: no session', 'ERR auth_required',
    pg_temp.try_as(null, array[format(
      'select public.register_push_subscription(''customer'', %L, %L, ''k'', ''a'')::text', v_cust_row, v_ep)]));
  perform pg_temp.expect('register push: bad recipient type', 'ERR invalid_recipient_type',
    pg_temp.try_as(c_cust, array[format(
      'select public.register_push_subscription(''walkin'', %L, %L, ''k'', ''a'')::text', v_cust_row, v_ep)]));
  perform pg_temp.expect('register push: diner, own row, then reads it', 'ok 1',
    pg_temp.try_as(c_cust, array[
      format('select public.register_push_subscription(''customer'', %L, %L, ''k'', ''a'')::text', v_cust_row, v_ep),
      format('select count(*)::text from public.push_subscriptions where endpoint = %L', v_ep)]));
  perform pg_temp.expect('register push: diner names another diner''s row', 'ERR not_your_recipient',
    pg_temp.try_as(c_cust, array[format(
      'select public.register_push_subscription(''customer'', %L, %L, ''k'', ''a'')::text', v_bobby_ftt, v_ep)]));
  perform pg_temp.expect('register push: diner names a rider', 'ERR not_your_recipient',
    pg_temp.try_as(c_cust, array[format(
      'select public.register_push_subscription(''driver'', %L, %L, ''k'', ''a'')::text', v_driver_row, v_ep)]));
  perform pg_temp.expect('register push: diner names a staff row', 'ERR not_your_recipient',
    pg_temp.try_as(c_cust, array[format(
      'select public.register_push_subscription(''staff'', %L, %L, ''k'', ''a'')::text', v_cash_row, v_ep)]));
  perform pg_temp.expect('register push: diner row passed as a driver id', 'ERR not_your_recipient',
    pg_temp.try_as(c_cust, array[format(
      'select public.register_push_subscription(''driver'', %L, %L, ''k'', ''a'')::text', v_cust_row, v_ep)]));
  perform pg_temp.expect('register push: rider, own profile', 'ok%',
    pg_temp.try_as(c_driver, array[format(
      'select public.register_push_subscription(''driver'', %L, %L, ''k'', ''a'')::text', v_driver_row, v_ep)]));
  perform pg_temp.expect('register push: cashier, own staff row', 'ok%',
    pg_temp.try_as(c_cash, array[format(
      'select public.register_push_subscription(''staff'', %L, %L, ''k'', ''a'')::text', v_cash_row, v_ep)]));
  perform pg_temp.expect('register push: cashier names the owner''s staff row', 'ERR not_your_recipient',
    pg_temp.try_as(c_cash, array[format(
      'select public.register_push_subscription(''staff'', %L, %L, ''k'', ''a'')::text', v_owner_row, v_ep)]));
  update public.staff_members set status = 'suspended' where id = v_cash_row;
  perform pg_temp.expect('register push: suspended staff row', 'ERR not_your_recipient',
    pg_temp.try_as(c_cash, array[format(
      'select public.register_push_subscription(''staff'', %L, %L, ''k'', ''a'')::text', v_cash_row, v_ep)]));
  update public.staff_members set status = 'active' where id = v_cash_row;
  perform pg_temp.expect('direct insert into push_subscriptions is refused', 'ERR new row violates row-level security policy%',
    pg_temp.try_as(c_cust, array[format(
      'insert into public.push_subscriptions (user_id, recipient_type, recipient_id, endpoint, p256dh, auth)
       values (%L, ''driver'', %L, %L, ''k'', ''a'') returning id::text', c_cust, v_driver_row, v_ep)]));

  -- One endpoint is one browser: the next login to register it takes it over, recipient included.
  perform pg_temp.act_as(c_cust);
  v_sub1 := public.register_push_subscription('customer', v_cust_row, v_ep, 'k1', 'a1', 'test');
  perform pg_temp.act_as(c_driver);
  v_sub2 := public.register_push_subscription('driver', v_driver_row, v_ep, 'k2', 'a2', 'test');
  perform pg_temp.act_as(null);
  select count(*) into v_n from public.push_subscriptions where endpoint = v_ep;
  select user_id, recipient_type, recipient_id, p256dh into v_row from public.push_subscriptions where endpoint = v_ep;
  perform pg_temp.expect('endpoint re-registered by another login moves to it',
    format('1 row, same id, %s driver %s k2', c_driver, v_driver_row),
    format('%s row, %s id, %s %s %s %s', v_n, case when v_sub1 = v_sub2 then 'same' else 'new' end,
           v_row.user_id, v_row.recipient_type, v_row.recipient_id, v_row.p256dh));
  -- The previous owner no longer sees it; the new one does.
  perform pg_temp.expect('previous login no longer reads the endpoint', 'ok 0',
    pg_temp.try_as(c_cust, array[format('select count(*)::text from public.push_subscriptions where endpoint = %L', v_ep)]));
  perform pg_temp.expect('new login reads the endpoint', 'ok 1',
    pg_temp.try_as(c_driver, array[format('select count(*)::text from public.push_subscriptions where endpoint = %L', v_ep)]));

  -- 4. sweep_abandoned_carts: the diner's row at the CART's branch, and the cart's own address.
  -- customer@test has a row at Hamburger only, with an email: a Food Thai Thai cart must not be
  -- addressed to it.
  perform pg_temp.expect('customer@test has no Food Thai Thai row', '0',
    (select count(*)::text from public.customers where user_id = c_cust and branch_id = c_ftt));
  update public.customers set email = 'leftovers-ham@example.com' where id = v_cust_row;
  -- Bobby's Food Thai Thai row has no email of its own: the cart's address is what is sent to.
  update public.customers set email = null where id = v_bobby_ftt;

  insert into public.abandoned_carts (user_id, customer_email, branch_id, cart, subtotal, created_at)
  values (c_cust, 'leftovers-other@example.com', c_ftt, '[]'::jsonb, 11, now() - interval '2 hours')
  returning id into v_cart_other;
  insert into public.abandoned_carts (user_id, customer_email, branch_id, cart, subtotal, created_at)
  values (c_bobby, '  Leftovers-FTT@Example.com ', c_ftt, '[]'::jsonb, 12.5, now() - interval '2 hours')
  returning id into v_cart_ftt;
  if v_bobby_ham is not null then
    insert into public.abandoned_carts (user_id, customer_email, branch_id, cart, subtotal, created_at)
    values (c_bobby, 'leftovers-ham-cart@example.com', c_ham, '[]'::jsonb, 13, now() - interval '2 hours')
    returning id into v_cart_ham;
  end if;
  insert into public.abandoned_carts (user_id, customer_email, branch_id, cart, subtotal, created_at)
  values (c_bobby, 'x1@customer.favornoms.local', c_ftt, '[]'::jsonb, 14, now() - interval '2 hours')
  returning id into v_cart_synth;
  insert into public.abandoned_carts (customer_email, branch_id, cart, subtotal, created_at)
  values ('leftovers-guest@example.com', c_ftt, '[]'::jsonb, 15, now() - interval '2 hours')
  returning id into v_cart_guest;
  insert into public.abandoned_carts (user_id, customer_email, branch_id, cart, subtotal, created_at)
  values (c_bobby, 'leftovers-recent@example.com', c_ftt, '[]'::jsonb, 16, now() - interval '10 minutes')
  returning id into v_cart_recent;

  v_swept := public.sweep_abandoned_carts();
  perform pg_temp.expect('sweep count', case when v_bobby_ham is null then '1' else '2' end, v_swept::text);

  select o.branch_id, o.recipient_type, o.recipient_id, o.channel, o.variables->>'email' as email,
         (select notified_at is not null from public.abandoned_carts where id = v_cart_ftt) as notified
    into v_row
    from public.notifications_outbox o
   where o.template = 'abandoned_cart' and o.variables->>'cart_id' = v_cart_ftt::text;
  perform pg_temp.expect('FTT cart goes to the diner''s FTT row with the cart''s address',
    format('%s email customer %s Leftovers-FTT@Example.com true', c_ftt, v_bobby_ftt),
    format('%s %s %s %s %s %s', v_row.branch_id, v_row.channel, v_row.recipient_type, v_row.recipient_id,
           v_row.email, v_row.notified::text));
  if v_cart_ham is not null then
    select o.branch_id, o.recipient_id into v_row
      from public.notifications_outbox o
     where o.template = 'abandoned_cart' and o.variables->>'cart_id' = v_cart_ham::text;
    perform pg_temp.expect('Hamburger cart goes to the diner''s Hamburger row',
      format('%s %s', c_ham, v_bobby_ham), format('%s %s', v_row.branch_id, v_row.recipient_id));
  end if;
  perform pg_temp.expect('cart at a branch where the diner has no row is left alone', 'not notified, 0 rows',
    (select case when a.notified_at is null then 'not notified' else 'notified' end
       || ', ' || (select count(*) from public.notifications_outbox where variables->>'cart_id' = v_cart_other::text) || ' rows'
       from public.abandoned_carts a where a.id = v_cart_other));
  perform pg_temp.expect('synthetic address, guest and recent carts are left alone', '0 notified, 0 rows',
    (select count(*) filter (where notified_at is not null) || ' notified, '
       || (select count(*) from public.notifications_outbox
            where variables->>'cart_id' in (v_cart_synth::text, v_cart_guest::text, v_cart_recent::text)) || ' rows'
       from public.abandoned_carts where id in (v_cart_synth, v_cart_guest, v_cart_recent)));
  perform pg_temp.expect('a second sweep sends nothing again', '0', public.sweep_abandoned_carts()::text);
  perform pg_temp.expect('authenticated may not run the sweep', 'false',
    has_function_privilege('authenticated', 'public.sweep_abandoned_carts()', 'execute')::text);
end
$test$;

-- Sections 5-8 (added 2026-09-19).
--   kitchen  kitchen@test.com  kitchen row at Hamburger
--   bb       bb@bb.com         admin row at Hamburger only
do $test2$
declare
  c_rest    constant uuid := '33333333-3333-3333-3333-333333333333';
  c_ham     constant uuid := '44444444-4444-4444-4444-444444444444';
  c_ftt     constant uuid := 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';
  c_cust    constant uuid := 'a1111111-1111-1111-1111-111111111111';
  c_bobby   constant uuid := '1e74fba1-cebf-46b1-a963-fb4915bd899d';
  c_driver  constant uuid := 'a4444444-4444-4444-4444-444444444444';
  c_cash    constant uuid := 'a2222222-2222-2222-2222-222222222222';
  c_kitchen constant uuid := 'a3333333-3333-3333-3333-333333333333';
  c_owner   constant uuid := '9467cf42-0a03-4abe-86d5-a2610ee15d0a';
  c_bb      constant uuid := '147d5c02-04e7-44af-8595-337605d785e6';
  v_cancelled uuid;
  v_refunded uuid;
  v_ready uuid;
  v_open uuid;
  v_deliv_order uuid;
  v_ftt_order uuid;
  v_bobby_order uuid;
  v_line uuid;
  v_driver_row uuid;
  v_cash_row uuid;
  v_invite uuid;
  v_item uuid;
  v_path text;
begin
  select id into v_cancelled from public.orders
   where branch_id = c_ham and status = 'cancelled' and total > 0 order by created_at desc limit 1;
  select id into v_refunded from public.orders
   where branch_id = c_ham and status = 'refunded' order by created_at desc limit 1;
  select o.id into v_ready from public.orders o
   where o.branch_id = c_ham and o.status = 'ready'
     and not exists (select 1 from public.payments p where p.order_id = o.id and p.method = 'transfer')
   order by o.created_at desc limit 1;
  select o.id into v_open from public.orders o
   where o.branch_id = c_ham and o.status in ('pending', 'confirmed', 'preparing')
   order by o.created_at desc limit 1;
  select o.id into v_deliv_order from public.orders o join public.deliveries d on d.order_id = o.id
   where o.branch_id = c_ham and o.status in ('confirmed', 'preparing', 'ready')
     and d.status in ('pending', 'dispatching')
     and not exists (select 1 from public.payments p where p.order_id = o.id and p.method = 'transfer')
   order by o.created_at desc limit 1;
  select id into v_ftt_order from public.orders where branch_id = c_ftt order by created_at desc limit 1;
  select o.id into v_bobby_order from public.orders o join public.customers c on c.id = o.customer_id
   where c.user_id = c_bobby and exists (select 1 from public.order_items oi where oi.order_id = o.id)
   order by o.created_at desc limit 1;
  select oi.id into v_line from public.order_items oi join public.orders o on o.id = oi.order_id
   where o.branch_id = c_ham and o.status in ('pending', 'confirmed', 'preparing', 'ready')
   order by o.created_at desc limit 1;
  select id into v_driver_row from public.drivers where user_id = c_driver limit 1;
  select id into v_cash_row from public.staff_members
   where user_id = c_cash and restaurant_id = c_rest and branch_id = c_ham;

  perform pg_temp.expect('5-8 fixtures present', 'true',
    (v_cancelled is not null and v_refunded is not null and v_ready is not null and v_open is not null
     and v_deliv_order is not null and v_ftt_order is not null and v_bobby_order is not null
     and v_line is not null and v_driver_row is not null and v_cash_row is not null)::text);

  -- 5. Cancelled and refunded orders stay closed.
  perform pg_temp.expect('kitchen cannot reopen a cancelled order', 'ERR order_status_final:cancelled',
    pg_temp.try_as(c_kitchen, array[format(
      'update public.orders set status = ''preparing'' where id = %L returning status::text', v_cancelled)]));
  perform pg_temp.expect('owner cannot complete a cancelled order', 'ERR order_status_final:cancelled',
    pg_temp.try_as(c_owner, array[format(
      'update public.orders set status = ''completed'' where id = %L returning status::text', v_cancelled)]));
  perform pg_temp.expect('owner cannot move a refunded order', 'ERR order_status_final:refunded',
    pg_temp.try_as(c_owner, array[format(
      'update public.orders set status = ''completed'' where id = %L returning status::text', v_refunded)]));
  perform pg_temp.expect('refunded cannot become cancelled', 'ERR order_status_final:refunded',
    pg_temp.try_as(c_owner, array[format(
      'update public.orders set status = ''cancelled'' where id = %L returning status::text', v_refunded)]));
  perform pg_temp.expect('a signed-in platform admin is held too', 'ERR order_status_final:cancelled',
    pg_temp.try_as('a0000000-0000-0000-0000-000000000001', array[format(
      'update public.orders set status = ''preparing'' where id = %L returning status::text', v_cancelled)]));
  -- No JWT (service role, cron, SQL console) is trusted, as guard_staff_role_escalation trusts it.
  perform pg_temp.expect('no session may still correct a status', 'ok cancelled',
    pg_temp.try_as(null, array[format(
      'update public.orders set status = ''cancelled'' where id = %L returning status::text', v_refunded)]));
  -- Staff write no other column since section 9, so "not a change" is the same status written again.
  perform pg_temp.expect('writing a cancelled order''s own status again is not a change', 'ok cancelled',
    pg_temp.try_as(c_owner, array[format(
      'update public.orders set status = status where id = %L returning status::text', v_cancelled)]));
  perform pg_temp.expect('refund_order on a cancelled order marks it refunded', 'ok refunded',
    pg_temp.try_as(c_owner, array[
      format('select public.refund_order(id, total, ''leftovers test'')::text from public.orders where id = %L', v_cancelled),
      format('select status::text from public.orders where id = %L', v_cancelled)]));
  perform pg_temp.expect('kitchen bump and undo still work', 'ok ready',
    pg_temp.try_as(c_kitchen, array[
      format('update public.orders set status = ''completed'' where id = %L and status = ''ready'' returning status::text', v_ready),
      format('update public.orders set status = ''ready'' where id = %L and status = ''completed'' returning status::text', v_ready)]));
  perform pg_temp.expect('cancel_order still cancels, and the cancel is final', 'ERR order_status_final:cancelled',
    pg_temp.try_as(c_owner, array[
      format('select public.cancel_order(%L, ''leftovers test'')::text', v_open),
      format('update public.orders set status = ''confirmed'' where id = %L returning status::text', v_open)]));
  perform pg_temp.expect('delivery delivered after its order was cancelled leaves the order cancelled', 'ok cancelled delivered',
    pg_temp.try_as(null, array[
      format('update public.deliveries set status = ''picked_up'', driver_id = %L where order_id = %L returning status::text', v_driver_row, v_deliv_order),
      format('update public.orders set status = ''cancelled'' where id = %L returning status::text', v_deliv_order),
      format('update public.deliveries set status = ''delivered'' where order_id = %L returning status::text', v_deliv_order),
      format('select o.status::text || '' '' || d.status::text from public.orders o join public.deliveries d on d.order_id = o.id where o.id = %L', v_deliv_order)]));
  perform pg_temp.expect('delivery delivered still completes a live order', 'ok completed',
    pg_temp.try_as(null, array[
      format('update public.deliveries set status = ''picked_up'', driver_id = %L where order_id = %L returning status::text', v_driver_row, v_deliv_order),
      format('update public.deliveries set status = ''delivered'' where order_id = %L returning status::text', v_deliv_order),
      format('select status::text from public.orders where id = %L', v_deliv_order)]));
  perform pg_temp.expect('advance_self_delivery skips a closed order', 'true',
    (pg_get_functiondef('public.advance_self_delivery(uuid,text)'::regprocedure)
       like '%where id = v_order and status not in (''cancelled'', ''refunded'')%')::text);

  -- 6. order_items: staff read only.
  perform pg_temp.expect('kitchen cannot reprice a line', 'ERR permission denied for table order_items',
    pg_temp.try_as(c_kitchen, array[format(
      'update public.order_items set unit_price = 0 where id = %L returning id::text', v_line)]));
  perform pg_temp.expect('owner cannot delete a line', 'ERR permission denied for table order_items',
    pg_temp.try_as(c_owner, array[format(
      'delete from public.order_items where id = %L returning id::text', v_line)]));
  perform pg_temp.expect('owner cannot insert a line', 'ERR permission denied for table order_items',
    pg_temp.try_as(c_owner, array[format(
      'insert into public.order_items (order_id, item_name, quantity, unit_price, subtotal)
       values (%L, ''x'', 1, 0, 0) returning id::text', v_open)]));
  perform pg_temp.expect('kitchen reads its branch''s lines', 'ok true',
    pg_temp.try_as(c_kitchen, array[format(
      'select (count(*) > 0)::text from public.order_items where id = %L', v_line)]));
  perform pg_temp.expect('kitchen reads no Food Thai Thai lines', 'ok 0',
    pg_temp.try_as(c_kitchen, array[format(
      'select count(*)::text from public.order_items where order_id = %L', v_ftt_order)]));
  perform pg_temp.expect('kitchen still ticks a line off', 'ok ready',
    pg_temp.try_as(c_kitchen, array[format(
      'select public.set_order_item_prep_status(%L, ''ready'')', v_line)]));
  perform pg_temp.expect('a diner still reads their own order''s lines', 'ok true',
    pg_temp.try_as(c_bobby, array[format(
      'select (count(*) > 0)::text from public.order_items where order_id = %L', v_bobby_order)]));
  perform pg_temp.expect('order_items policies', 'order_items_customer_own SELECT, order_items_staff_read SELECT',
    (select string_agg(policyname || ' ' || cmd, ', ' order by policyname) from pg_policies
      where schemaname = 'public' and tablename = 'order_items'));

  -- 7. Branding bucket: a branch's folder needs a capability at that branch.
  perform pg_temp.expect('Hamburger admin cannot upload into Food Thai Thai''s folder', 'ERR new row violates row-level security policy%',
    pg_temp.try_as(c_bb, array[format(
      'insert into storage.objects (bucket_id, name) values (''branding'', %L) returning name',
      c_rest || '/' || c_ftt || '/leftovers-test.png')]));
  perform pg_temp.expect('... nor under an upper-case spelling of it', 'ERR new row violates row-level security policy%',
    pg_temp.try_as(c_bb, array[format(
      'insert into storage.objects (bucket_id, name) values (''branding'', %L) returning name',
      c_rest || '/' || upper(c_ftt::text) || '/leftovers-test.png')]));
  perform pg_temp.expect('Hamburger admin uploads into Hamburger''s folder', 'ok%',
    pg_temp.try_as(c_bb, array[format(
      'insert into storage.objects (bucket_id, name) values (''branding'', %L) returning name',
      c_rest || '/' || c_ham || '/leftovers-test.png')]));
  perform pg_temp.expect('Hamburger admin still uploads a flat restaurant file (today''s paths)', 'ok%',
    pg_temp.try_as(c_bb, array[format(
      'insert into storage.objects (bucket_id, name) values (''branding'', %L) returning name',
      c_rest || '/payment-qr-leftovers-test.png')]));
  perform pg_temp.expect('owner uploads into Food Thai Thai''s folder', 'ok%',
    pg_temp.try_as(c_owner, array[format(
      'insert into storage.objects (bucket_id, name) values (''branding'', %L) returning name',
      c_rest || '/' || c_ftt || '/leftovers-test.png')]));
  perform pg_temp.expect('owner uploads a flat restaurant file', 'ok%',
    pg_temp.try_as(c_owner, array[format(
      'insert into storage.objects (bucket_id, name) values (''branding'', %L) returning name',
      c_rest || '/logo-leftovers-test.png')]));
  perform pg_temp.expect('cashier still cannot upload branding', 'ERR new row violates row-level security policy%',
    pg_temp.try_as(c_cash, array[format(
      'insert into storage.objects (bucket_id, name) values (''branding'', %L) returning name',
      c_rest || '/logo-leftovers-test.png')]));
  perform pg_temp.expect('kitchen cannot upload into its own branch folder', 'ERR new row violates row-level security policy%',
    pg_temp.try_as(c_kitchen, array[format(
      'insert into storage.objects (bucket_id, name) values (''branding'', %L) returning name',
      c_rest || '/' || c_ham || '/leftovers-test.png')]));
  v_path := c_rest || '/' || c_ftt || '/leftovers-update-test.png';
  insert into storage.objects (bucket_id, name) values ('branding', v_path);
  perform pg_temp.expect('owner replaces a file in Food Thai Thai''s folder', 'ok 1',
    pg_temp.try_as(c_owner, array[format(
      'with u as (update storage.objects set metadata = ''{"t":1}'' where bucket_id = ''branding'' and name = %L returning 1)
       select count(*)::text from u', v_path)]));
  perform pg_temp.expect('Hamburger admin cannot replace it', 'ok 0',
    pg_temp.try_as(c_bb, array[format(
      'with u as (update storage.objects set metadata = ''{"t":1}'' where bucket_id = ''branding'' and name = %L returning 1)
       select count(*)::text from u', v_path)]));
  perform pg_temp.expect('delete rule: Hamburger admin / owner on Food Thai Thai''s folder', 'ok false / ok true',
    pg_temp.try_as(c_bb, array[format(
      'select (private.administers_restaurant_folder(%1$L) and private.branding_branch_folder_ok(%1$L))::text', v_path)])
    || ' / ' ||
    pg_temp.try_as(c_owner, array[format(
      'select (private.administers_restaurant_folder(%1$L) and private.branding_branch_folder_ok(%1$L))::text', v_path)]));
  perform pg_temp.expect('anon may not run the folder helper', 'false',
    coalesce(has_function_privilege('anon', to_regprocedure('private.branding_branch_folder_ok(text)'), 'execute'), true)::text);

  -- 8. Re-invited after being removed: the removed row comes back.
  perform pg_temp.act_as(null);
  update public.staff_members set status = 'removed' where id = v_cash_row;
  insert into public.staff_members (restaurant_id, branch_id, invited_email, role, status, permissions)
  values (c_rest, c_ham, 'cashier@test.com', 'manager', 'pending', array['x.test']::text[])
  returning id into v_invite;
  perform pg_temp.expect('removed cashier accepts a new invitation: old row comes back', 'ok ' || v_cash_row || ' true manager',
    pg_temp.try_as(c_cash, array[format(
      'select (r->>''staff_id'') || '' '' || (r->>''revived'') || '' '' || (r->>''role'') from public.accept_staff_invite(%L) r', v_invite)]));
  perform pg_temp.expect('... active, with the invitation''s role and permissions', 'ok active manager {x.test} true',
    pg_temp.try_as(c_cash, array[
      format('select public.accept_staff_invite(%L)::text', v_invite),
      format('select s.status::text || '' '' || s.role::text || '' '' || s.permissions::text || '' '' || (s.accepted_at is not null)::text
                from public.staff_members s where s.id = %L', v_cash_row)]));
  perform pg_temp.expect('... and the spent invitation is gone', 'ok 0',
    pg_temp.try_as(c_cash, array[
      format('select public.accept_staff_invite(%L)::text', v_invite),
      format('select count(*)::text from public.staff_members where id = %L', v_invite)]));
  perform pg_temp.expect('another account cannot accept it', 'ERR invite_email_mismatch',
    pg_temp.try_as(c_kitchen, array[format('select public.accept_staff_invite(%L)::text', v_invite)]));
  perform pg_temp.expect('removed row cannot be revived without the invitation''s role', 'ERR staff_self_role_change_forbidden',
    pg_temp.try_as(null, array[
      format('select set_config(''request.jwt.claims'', %L, true)', json_build_object('sub', c_cash, 'role', 'authenticated')::text),
      format('select set_config(''request.jwt.claim.sub'', %L, true)', c_cash),
      format('update public.staff_members set status = ''active'', role = ''admin'', invited_email = ''cashier@test.com''
               where id = %L returning id::text', v_cash_row)]));
  update public.staff_members set status = 'suspended' where id = v_cash_row;
  perform pg_temp.expect('suspended row is still refused', 'ERR already_staff_here',
    pg_temp.try_as(c_cash, array[format('select public.accept_staff_invite(%L)::text', v_invite)]));
  update public.staff_members set status = 'active' where id = v_cash_row;
  perform pg_temp.expect('active row is still refused', 'ERR already_staff_here',
    pg_temp.try_as(c_cash, array[format('select public.accept_staff_invite(%L)::text', v_invite)]));
  delete from public.staff_members where id = v_invite;
  insert into public.staff_members (restaurant_id, branch_id, invited_email, role, status)
  values (c_rest, c_ftt, 'customer@test.com', 'cashier', 'pending')
  returning id into v_invite;
  perform pg_temp.expect('a first invitation is still claimed as before', 'ok ' || v_invite || ' false active',
    pg_temp.try_as(c_cust, array[
      format('select public.accept_staff_invite(%L)::text', v_invite),
      format('select s.id || '' '' || coalesce(s.accepted_at is null, false)::text || '' '' || s.status::text
                from public.staff_members s where s.id = %L and s.user_id = %L', v_invite, c_cust)]));

  -- Already true before this migration; kept as regressions.
  select id into v_item from public.menu_items where branch_id = c_ham and is_active order by created_at limit 1;
  update public.menu_items set track_stock = true, stock_quantity = 7 where id = v_item;
  perform pg_temp.expect('duplicate_menu_item: the copy starts untracked', 'ok false <null>',
    pg_temp.try_as(c_owner, array[
      format('select set_config(''leftovers.dup'', public.duplicate_menu_item(%L)::text, true)', v_item),
      'select mi.track_stock::text || '' '' || coalesce(mi.stock_quantity::text, ''<null>'')
         from public.menu_items mi where mi.id = current_setting(''leftovers.dup'')::uuid']));
  perform pg_temp.expect('v_low_stock_items: a diner sees nothing', 'ok 0',
    pg_temp.try_as(c_cust, array['select count(*)::text from public.v_low_stock_items']));
  perform pg_temp.expect('v_low_stock_items: kitchen sees only its branch', 'ok 0',
    pg_temp.try_as(c_kitchen, array[format(
      'select count(*)::text from public.v_low_stock_items where branch_id <> %L', c_ham)]));
end
$test2$;

-- Sections 9-10 (added 2026-09-19, second delta).
do $test3$
declare
  c_ham     constant uuid := '44444444-4444-4444-4444-444444444444';
  c_ftt     constant uuid := 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';
  c_bobby   constant uuid := '1e74fba1-cebf-46b1-a963-fb4915bd899d';
  c_cash    constant uuid := 'a2222222-2222-2222-2222-222222222222';
  c_kitchen constant uuid := 'a3333333-3333-3333-3333-333333333333';
  c_owner   constant uuid := '9467cf42-0a03-4abe-86d5-a2610ee15d0a';
  v_pending uuid;
  v_ready uuid;
  v_ftt_order uuid;
  v_bobby_order uuid;
  v_bobby_ham uuid;
  v_item uuid;
  v_counter uuid;
  v_web uuid;
begin
  perform pg_temp.act_as(null);
  insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
  values ('T-LEFTOVERS-P1', c_ham, 'pickup', 'pending', 10, 10, '[]')
  returning id into v_pending;
  insert into public.orders (order_number, branch_id, channel, status, subtotal, total, status_history)
  values ('T-LEFTOVERS-R1', c_ham, 'pickup', 'ready', 10, 10,
          jsonb_build_array(jsonb_build_object('status', 'ready', 'at', now())))
  returning id into v_ready;
  select id into v_ftt_order from public.orders where branch_id = c_ftt order by created_at desc limit 1;
  select o.id into v_bobby_order from public.orders o join public.customers c on c.id = o.customer_id
   where c.user_id = c_bobby order by o.created_at desc limit 1;
  select id into v_bobby_ham from public.customers where user_id = c_bobby and branch_id = c_ham
   order by created_at limit 1;
  select id into v_item from public.menu_items where branch_id = c_ham and is_active order by created_at limit 1;

  perform pg_temp.expect('9-10 fixtures present', 'true',
    (v_pending is not null and v_ready is not null and v_ftt_order is not null
     and v_bobby_order is not null and v_bobby_ham is not null and v_item is not null)::text);

  -- 9. orders: staff read, and change the status only. The reviewer's C1-C4 first.
  perform pg_temp.expect('C1 kitchen cannot rewrite an order''s money columns', 'ERR permission denied for table orders',
    pg_temp.try_as(c_kitchen, array[format(
      'update public.orders set total = 0, subtotal = 0 where id = %L returning total::text', v_ready)]));
  perform pg_temp.expect('C2 kitchen cannot inflate a subtotal', 'ERR permission denied for table orders',
    pg_temp.try_as(c_kitchen, array[format(
      'update public.orders set subtotal = 50000 where id = %L returning subtotal::text', v_ready)]));
  perform pg_temp.expect('C3 kitchen cannot make up an order for a diner', 'ERR permission denied for table orders',
    pg_temp.try_as(c_kitchen, array[format(
      'insert into public.orders (order_number, branch_id, channel, customer_id, subtotal, total, status)
       values (''T-LEFTOVERS-FAKE'', %L, ''pickup'', %L, 777, 777, ''pending'') returning id::text', c_ham, v_bobby_ham)]));
  perform pg_temp.expect('C4 kitchen cannot delete an order', 'ERR permission denied for table orders',
    pg_temp.try_as(c_kitchen, array[format(
      'delete from public.orders where id = %L returning id::text', v_pending)]));
  perform pg_temp.expect('the owner cannot delete an order either', 'ERR permission denied for table orders',
    pg_temp.try_as(c_owner, array[format(
      'delete from public.orders where id = %L returning id::text', v_pending)]));
  perform pg_temp.expect('the owner cannot rewrite a total either', 'ERR permission denied for table orders',
    pg_temp.try_as(c_owner, array[format(
      'update public.orders set total = 1 where id = %L returning total::text', v_ready)]));
  perform pg_temp.expect('a cashier cannot zero a live order''s total', 'ERR permission denied for table orders',
    pg_temp.try_as(c_cash, array[format(
      'update public.orders set discount_amount = 10, total = 0 where id = %L returning total::text', v_ready)]));
  perform pg_temp.expect('privileges: anon none, authenticated update(status) only',
    'anon i/u/d f f f; auth i/d f f; auth update status t, discount f, total f, subtotal f, tip f, customer_id f, branch f',
    format('anon i/u/d %s %s %s; auth i/d %s %s; auth update status %s, discount %s, total %s, subtotal %s, tip %s, customer_id %s, branch %s',
      has_table_privilege('anon', 'public.orders', 'insert'),
      has_any_column_privilege('anon', 'public.orders', 'update'),
      has_table_privilege('anon', 'public.orders', 'delete'),
      has_table_privilege('authenticated', 'public.orders', 'insert'),
      has_table_privilege('authenticated', 'public.orders', 'delete'),
      has_column_privilege('authenticated', 'public.orders', 'status', 'update'),
      has_column_privilege('authenticated', 'public.orders', 'discount_amount', 'update'),
      has_column_privilege('authenticated', 'public.orders', 'total', 'update'),
      has_column_privilege('authenticated', 'public.orders', 'subtotal', 'update'),
      has_column_privilege('authenticated', 'public.orders', 'tip_amount', 'update'),
      has_column_privilege('authenticated', 'public.orders', 'customer_id', 'update'),
      has_column_privilege('authenticated', 'public.orders', 'branch_id', 'update')));
  -- The till discounts through place-order (discount_percent) since 20260919100000; a direct write
  -- of the amounts is refused even on the sale the cashier has just rung up.
  perform pg_temp.act_as(null);
  insert into public.orders (order_number, branch_id, channel, source, status, subtotal, total, status_history)
  values ('T-LEFTOVERS-C1', c_ham, 'pickup', 'counter', 'pending', 10, 10.70, '[]')
  returning id into v_counter;
  insert into public.payments (order_id, branch_id, amount, method, status)
  values (v_counter, c_ham, 10.70, 'cash', 'pending');
  perform pg_temp.expect('a cashier cannot discount a fresh counter sale directly', 'ERR permission denied for table orders',
    pg_temp.try_as(c_cash, array[format(
      'update public.orders set discount_amount = 2, total = 8.70 where id = %L returning total::text', v_counter)]));
  perform pg_temp.expect('record_counter_payment settles the amount place-order priced', 'ok confirmed 10.70 completed 10.70',
    pg_temp.try_as(c_cash, array[
      format('select public.record_counter_payment(%L)::text', v_counter),
      format('select o.status::text || '' '' || o.total::text || '' '' || p.status::text || '' '' || p.amount::text
                from public.orders o join public.payments p on p.order_id = o.id where o.id = %L', v_counter)]));
  perform pg_temp.expect('definer functions and the service role still write amounts', 'ok 9.99',
    pg_temp.try_as(null, array[format(
      'update public.orders set total = 9.99 where id = %L returning total::text', v_ready)]));
  -- What the apps write (counter-view confirm, kitchen-view advance and Undo), as they write it.
  perform pg_temp.expect('counter confirms a pending order and reads the id back', 'ok ' || v_pending,
    pg_temp.try_as(c_cash, array[format(
      'update public.orders set status = ''confirmed'' where id = %L and status = ''pending'' returning id::text', v_pending)]));
  perform pg_temp.expect('kitchen advances and undoes, guarded on the status it showed', 'ok ' || v_ready,
    pg_temp.try_as(c_kitchen, array[
      format('update public.orders set status = ''completed'' where id = %L and branch_id = %L and status = ''ready'' returning id::text', v_ready, c_ham),
      format('update public.orders set status = ''ready'' where id = %L and branch_id = %L and status = ''completed'' returning id::text', v_ready, c_ham)]));
  perform pg_temp.expect('completing still stamps completed_at (a BEFORE trigger, no column grant needed)', 'ok true',
    pg_temp.try_as(c_kitchen, array[
      format('update public.orders set status = ''completed'' where id = %L returning id::text', v_ready),
      format('select (completed_at is not null)::text from public.orders where id = %L', v_ready)]));
  perform pg_temp.expect('kitchen reads its branch''s order', 'ok 1',
    pg_temp.try_as(c_kitchen, array[format('select count(*)::text from public.orders where id = %L', v_ready)]));
  perform pg_temp.expect('kitchen neither reads nor moves a Food Thai Thai order', 'ok 0 0',
    pg_temp.try_as(c_kitchen, array[format(
      'with u as (update public.orders set status = status where id = %1$L returning 1)
       select (select count(*) from u)::text || '' '' || (select count(*) from public.orders where id = %1$L)::text', v_ftt_order)]));
  perform pg_temp.expect('a diner still reads their own order', 'ok 1',
    pg_temp.try_as(c_bobby, array[format('select count(*)::text from public.orders where id = %L', v_bobby_order)]));
  perform pg_temp.expect('a diner cannot change their order''s status', 'ok 0',
    pg_temp.try_as(c_bobby, array[format(
      'with u as (update public.orders set status = ''completed'' where id = %L returning 1) select count(*)::text from u', v_bobby_order)]));
  perform pg_temp.expect('orders policies', 'orders_customer_own SELECT, orders_staff_read SELECT, orders_staff_update UPDATE',
    (select string_agg(policyname || ' ' || cmd, ', ' order by policyname) from pg_policies
      where schemaname = 'public' and tablename = 'orders'));

  -- 10. menu_items.out_of_stock: the storefront's "sold out", without the count.
  update public.menu_items set track_stock = true, stock_quantity = 0 where id = v_item;
  perform pg_temp.expect('out_of_stock: tracked at 0', 'true',
    (select out_of_stock::text from public.menu_items where id = v_item));
  update public.menu_items set stock_quantity = 3 where id = v_item;
  perform pg_temp.expect('out_of_stock: tracked at 3', 'false',
    (select out_of_stock::text from public.menu_items where id = v_item));
  update public.menu_items set track_stock = false, stock_quantity = null where id = v_item;
  perform pg_temp.expect('out_of_stock: untracked', 'false',
    (select out_of_stock::text from public.menu_items where id = v_item));
  perform pg_temp.expect('anon reads out_of_stock', 'ok false',
    pg_temp.try_as(null, array[
      'select set_config(''role'', ''anon'', true)',
      format('select out_of_stock::text from public.menu_items where id = %L', v_item)]));
  perform pg_temp.expect('out_of_stock cannot be written', 'ERR column "out_of_stock" can only be updated to DEFAULT',
    pg_temp.try_as(null, array[format(
      'update public.menu_items set out_of_stock = true where id = %L returning id::text', v_item)]));
end
$test3$;

select seq, verdict, check_name, expected, actual from t_out
union all
select 999999, (select case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAILURES' end from t_out),
       format('%s checks, %s failed', count(*), count(*) filter (where verdict = 'FAIL')), null, null
  from t_out
order by 1;

rollback;
