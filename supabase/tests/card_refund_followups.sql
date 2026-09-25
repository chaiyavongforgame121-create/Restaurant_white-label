-- Card refund follow-ups (20260925120000_card_refund_followups). A rolled-back script, not a
-- migration.
--
-- Run from the repo root once the migrations are applied:
--   SUPABASE_TELEMETRY_DISABLED=1 npx --yes supabase db query --linked \
--     --project-ref ayyfczidnzxetndiijmv -f supabase/tests/card_refund_followups.sql
-- Before they are applied, put 20260925100000, 20260925110000 and 20260925120000 after a "begin;"
-- of your own and this file (without its own "begin;") after them, in one transaction.
--
-- Everything ends in ROLLBACK. Calls made on someone's behalf through pg_temp.try_as run in their
-- own subtransaction, which is always rolled back, so each check starts from the state the direct
-- statements (the service role's, no JWT) left. No Stripe call is made; account ids are made up.
--
-- People at Coastal Grill / Hamburger:
--   owner    restaurants.owner_user_id   orders.cancel, orders.refund
--   kitchen  an active kitchen row       kitchen.access (the kitchen's Reject), no orders.refund
--   diner    a customers row at the branch whose user is nobody's staff
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
    else
      perform set_config('role', 'anon', true);
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

-- A storefront card order for p_customer. Paid when p_intent is given: the PaymentIntent is
-- applied as the Connect webhook applies it, which completes the payment and confirms the order.
create or replace function pg_temp.web_card_order(p_number text, p_total numeric, p_customer uuid, p_intent text)
returns uuid
language plpgsql
as $$
declare
  v_order uuid;
  v_pay uuid;
begin
  insert into public.orders (order_number, branch_id, customer_id, channel, status, status_history, subtotal,
    discount_amount, tax_amount, delivery_fee, service_fee, tip_amount, total, promo_discount, source, held,
    awaiting_payment)
  values (p_number, '44444444-4444-4444-4444-444444444444', p_customer, 'pickup', 'pending', '[]'::jsonb, p_total,
          0, 0, 0, 0, 0, p_total, 0, 'web', false, true)
  returning id into v_order;
  insert into public.payments (order_id, branch_id, amount, method, status, gateway, gateway_metadata)
  values (v_order, '44444444-4444-4444-4444-444444444444', p_total, 'card', 'pending', 'stripe',
          jsonb_build_object('pending', true, 'stripe_account', 'acct_TESTREFUND'))
  returning id into v_pay;
  if p_intent is not null then
    perform public.stripe_connect_apply_payment_intent('acct_TESTREFUND', jsonb_build_object(
      'id', p_intent, 'status', 'succeeded', 'amount_received', round(p_total * 100), 'currency', 'usd',
      'latest_charge', 'ch_' || substr(p_intent, 4), 'metadata', jsonb_build_object('payment_id', v_pay)));
  end if;
  return v_order;
end $$;

-- Make the statements that follow in this transaction run as p_uid (auth.uid()), or as the
-- service role again with null. Unlike try_as, what they do is kept for the next checks.
create or replace function pg_temp.act_as(p_uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
end $$;

-- A Stripe refund of p_cents on p_intent, recorded as the Connect webhook or stripe-refund would.
create or replace function pg_temp.stripe_refund(p_refund text, p_intent text, p_cents int, p_status text)
returns jsonb
language sql
as $$
  select public.stripe_connect_record_refund('acct_TESTREFUND', jsonb_build_object(
    'id', p_refund, 'amount', p_cents, 'status', p_status, 'payment_intent', p_intent));
$$;

do $test$
declare
  c_branch constant uuid := '44444444-4444-4444-4444-444444444444';
  v_owner uuid;
  v_kitchen uuid;
  v_diner uuid;
  v_customer uuid;
  v_order uuid;
  v_cash uuid;
  v_counter uuid;
  v_pay uuid;
begin
  select r.owner_user_id into v_owner from public.restaurants r where r.id = '33333333-3333-3333-3333-333333333333';
  select sm.user_id into v_kitchen from public.staff_members sm join auth.users u on u.id = sm.user_id
   where sm.branch_id = c_branch and sm.role = 'kitchen' and sm.status = 'active'
     and not coalesce((u.raw_app_meta_data ->> 'is_platform_admin')::boolean, false) limit 1;
  select c.id, c.user_id into v_customer, v_diner
    from public.customers c join auth.users u on u.id = c.user_id
   where c.branch_id = c_branch
     and not exists (select 1 from public.staff_members sm where sm.user_id = c.user_id)
     and not exists (select 1 from public.restaurants r where r.owner_user_id = c.user_id)
     and not coalesce((u.raw_app_meta_data ->> 'is_platform_admin')::boolean, false)
   limit 1;

  perform pg_temp.expect('fixtures: owner, kitchen and diner found', 'true true true',
    (v_owner is not null)::text || ' ' || (v_kitchen is not null)::text || ' ' || (v_diner is not null)::text);

  delete from public.branch_payment_accounts where branch_id = c_branch;
  insert into public.branch_payment_accounts (branch_id, stripe_account_id, charges_enabled, payouts_enabled, details_submitted)
  values (c_branch, 'acct_TESTREFUND', true, true, true);

  -- 1. a diner and their card payment ----------------------------------------------------------
  v_order := pg_temp.web_card_order('TEST-RF-1', 10, v_customer, null);
  perform pg_temp.expect('a diner may still cancel an order they have not paid', 'ok%',
    pg_temp.try_as(v_diner, array[format('select public.cancel_order(%L, ''changed my mind'')::text', v_order)]));

  v_order := pg_temp.web_card_order('TEST-RF-2', 10, v_customer, 'pi_TESTRF2');
  perform pg_temp.expect('the paid order is confirmed', 'confirmed completed',
    (select o.status || ' ' || p.status from public.orders o join public.payments p on p.order_id = o.id where o.id = v_order));
  perform pg_temp.expect('the diner cannot cancel once the card went through', 'ERR card_paid_ask_restaurant',
    pg_temp.try_as(v_diner, array[format('select public.cancel_order(%L, ''changed my mind'')::text', v_order)]));

  -- 2. staff cannot close a paid order without its refund -------------------------------------
  perform pg_temp.expect('the owner cannot cancel it without a refund', 'ERR card_refund_required',
    pg_temp.try_as(v_owner, array[format('select public.cancel_order(%L, ''Admin canceled'')::text', v_order)]));
  perform pg_temp.expect('nor can the kitchen''s Reject', 'ERR card_refund_required',
    pg_temp.try_as(v_kitchen, array[format('select public.cancel_order(%L, ''Rejected by kitchen'')::text', v_order)]));
  perform pg_temp.expect('nor a direct status write', 'ERR card_refund_required',
    pg_temp.try_as(v_owner, array[format('update public.orders set status = ''cancelled'' where id = %L returning 1', v_order)]));
  perform pg_temp.expect('nor refund_order with no Stripe refund behind it', 'ERR card_refund_required',
    pg_temp.try_as(v_owner, array[format('select public.refund_order(%L, 10, null)::text', v_order)]));
  perform pg_temp.expect('nor a partial refund_order with none behind it', 'ERR card_refund_required',
    pg_temp.try_as(v_owner, array[format('select public.refund_order(%L, 2, null)::text', v_order)]));
  perform pg_temp.expect('moving it on is still allowed', 'ok 1',
    pg_temp.try_as(v_owner, array[format('update public.orders set status = ''preparing'' where id = %L returning 1', v_order)]));

  perform pg_temp.stripe_refund('re_TESTRF2A', 'pi_TESTRF2', 300, 'succeeded');
  perform pg_temp.expect('3.00 back of 10.00 leaves 7.00 owed', '7.00',
    (select private.order_card_refund_due(v_order)::text));
  perform pg_temp.expect('a partial refund is not enough to cancel', 'ERR card_refund_required',
    pg_temp.try_as(v_owner, array[format('select public.cancel_order(%L, ''Admin canceled'')::text', v_order)]));

  perform pg_temp.stripe_refund('re_TESTRF2B', 'pi_TESTRF2', 700, 'pending');
  perform pg_temp.expect('a pending refund of the rest counts as sent', '0.00',
    (select private.order_card_refund_due(v_order)::text));
  perform pg_temp.expect('then the kitchen can reject it', 'ok%',
    pg_temp.try_as(v_kitchen, array[format('select public.cancel_order(%L, ''Rejected by kitchen'')::text', v_order)]));
  perform pg_temp.expect('and the owner can cancel it', 'ok%',
    pg_temp.try_as(v_owner, array[format('select public.cancel_order(%L, ''Admin canceled'')::text', v_order)]));

  -- 3. refund_order adds up: an online card order --------------------------------------------
  -- The back office's order of events, kept for real (not in try_as): Stripe refunds 5.00, the
  -- order records it; later Stripe refunds the other 15.00 and the order records that.
  perform pg_temp.expect('the kitchen cannot record refunds', 'ERR not_authorized',
    pg_temp.try_as(v_kitchen, array[format('select public.refund_order(%L, 1, null)::text', v_order)]));
  v_order := pg_temp.web_card_order('TEST-RF-3', 20, v_customer, 'pi_TESTRF3');
  perform pg_temp.stripe_refund('re_TESTRF3A', 'pi_TESTRF3', 500, 'succeeded');
  perform pg_temp.act_as(v_owner);
  perform public.refund_order(v_order, 5, 'Cold fries');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('a card refund Stripe made is recorded, the order stays open', 'confirmed',
    (select status::text from public.orders where id = v_order));
  perform pg_temp.expect('recording more than Stripe refunded is refused', 'ERR card_refund_required',
    pg_temp.try_as(v_owner, array[format('select public.refund_order(%L, 6, null)::text', v_order)]));
  perform pg_temp.stripe_refund('re_TESTRF3B', 'pi_TESTRF3', 1500, 'succeeded');
  perform pg_temp.act_as(v_owner);
  perform public.refund_order(v_order, 15, null);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('partial refunds that cover the card close the order like one full refund', 'refunded 2',
    (select o.status || ' ' || (select count(*) from public.audit_logs a
                                   where a.entity_type = 'order' and a.entity_id = o.id and a.action = 'refund')
       from public.orders o where o.id = v_order));

  -- A refund made straight in the Stripe Dashboard counts: the back office records only the rest.
  v_order := pg_temp.web_card_order('TEST-RF-4', 12, v_customer, 'pi_TESTRF4');
  perform pg_temp.stripe_refund('re_TESTRF4A', 'pi_TESTRF4', 1200, 'succeeded');
  perform pg_temp.expect('a Dashboard refund in full lets a small record close the order', 'ok refunded',
    pg_temp.try_as(v_owner, array[
      format('select public.refund_order(%L, 1, null)', v_order),
      format('select status::text from public.orders where id = %L', v_order)]));

  -- 4. refund_order adds up: everything else ---------------------------------------------------
  insert into public.orders (order_number, branch_id, channel, status, status_history, subtotal, discount_amount,
    tax_amount, delivery_fee, service_fee, tip_amount, total, promo_discount, source, held, awaiting_payment)
  values ('TEST-RF-5', c_branch, 'pickup', 'completed', '[]'::jsonb, 10, 0, 0, 0, 0, 0, 10, 0, 'counter', false, false)
  returning id into v_cash;
  perform pg_temp.expect('one full refund closes a cash order, as before', 'ok refunded',
    pg_temp.try_as(v_owner, array[
      format('select public.refund_order(%L, 10, null)', v_cash),
      format('select status::text from public.orders where id = %L', v_cash)]));
  perform pg_temp.expect('two partial refunds adding up to the total close it the same way', 'ok refunded',
    pg_temp.try_as(v_owner, array[
      format('select public.refund_order(%L, 4, null)', v_cash),
      format('select public.refund_order(%L, 6, null)', v_cash),
      format('select status::text from public.orders where id = %L', v_cash)]));
  perform pg_temp.expect('one partial refund leaves it open', 'ok completed',
    pg_temp.try_as(v_owner, array[
      format('select public.refund_order(%L, 4, null)', v_cash),
      format('select status::text from public.orders where id = %L', v_cash)]));
  perform pg_temp.expect('refunds cannot add up to more than the total', 'ERR refund_exceeds_remaining:4.00',
    pg_temp.try_as(v_owner, array[
      format('select public.refund_order(%L, 6, null)', v_cash),
      format('select public.refund_order(%L, 6, null)', v_cash)]));
  perform pg_temp.expect('nothing is left after a full refund', 'ERR refund_exceeds_remaining:0.00',
    pg_temp.try_as(v_owner, array[
      format('select public.refund_order(%L, 10, null)', v_cash),
      format('select public.refund_order(%L, 1, null)', v_cash)]));
  perform pg_temp.expect('a single amount over the total is still invalid', 'ERR invalid_refund_amount',
    pg_temp.try_as(v_owner, array[format('select public.refund_order(%L, 11, null)', v_cash)]));

  -- 5. what is not held ------------------------------------------------------------------------
  -- A card sale swiped on the restaurant's own terminal (counter, no gateway) is not a Stripe
  -- payment: cancelling it is the till's business, as before.
  insert into public.orders (order_number, branch_id, channel, status, status_history, subtotal, discount_amount,
    tax_amount, delivery_fee, service_fee, tip_amount, total, promo_discount, source, held, awaiting_payment)
  values ('TEST-RF-6', c_branch, 'pickup', 'confirmed', '[]'::jsonb, 8, 0, 0, 0, 0, 0, 8, 0, 'counter', false, false)
  returning id into v_counter;
  insert into public.payments (order_id, branch_id, amount, method, status, gateway)
  values (v_counter, c_branch, 8, 'card', 'completed', null);
  perform pg_temp.expect('a counter card sale cancels without Stripe', 'ok%',
    pg_temp.try_as(v_owner, array[format('select public.cancel_order(%L, ''Admin canceled'')::text', v_counter)]));

  v_order := pg_temp.web_card_order('TEST-RF-7', 9, v_customer, null);
  perform pg_temp.expect('staff can cancel an unpaid card order', 'ok%',
    pg_temp.try_as(v_owner, array[format('select public.cancel_order(%L, ''Admin canceled'')::text', v_order)]));

  v_order := pg_temp.web_card_order('TEST-RF-8', 15, v_customer, 'pi_TESTRF8');
  perform public.stripe_connect_record_dispute('acct_TESTREFUND', jsonb_build_object(
    'id', 'dp_TESTRF8', 'amount', 1500, 'reason', 'fraudulent', 'status', 'warning_needs_response',
    'payment_intent', 'pi_TESTRF8'), 'charge.dispute.created');
  perform pg_temp.expect('an inquiry leaves the money with the restaurant: still held', 'ERR card_refund_required',
    pg_temp.try_as(v_owner, array[format('select public.cancel_order(%L, ''Admin canceled'')::text', v_order)]));
  perform public.stripe_connect_record_dispute('acct_TESTREFUND', jsonb_build_object(
    'id', 'dp_TESTRF8', 'amount', 1500, 'reason', 'fraudulent', 'status', 'needs_response',
    'payment_intent', 'pi_TESTRF8'), 'charge.dispute.updated');
  perform pg_temp.expect('a formal dispute has taken the money: the order can be cancelled', 'ok%',
    pg_temp.try_as(v_owner, array[format('select public.cancel_order(%L, ''Admin canceled'')::text', v_order)]));

  -- The service role (the expiry, place-order's clean-up) is not held; a signed-in refund after
  -- such a cancel still is.
  v_order := pg_temp.web_card_order('TEST-RF-9', 11, v_customer, 'pi_TESTRF9');
  update public.orders set status = 'cancelled' where id = v_order;
  perform pg_temp.expect('the service role can close it', 'cancelled',
    (select status::text from public.orders where id = v_order));
  perform pg_temp.expect('but marking it refunded needs the refund', 'ERR card_refund_required',
    pg_temp.try_as(v_owner, array[format('update public.orders set status = ''refunded'' where id = %L returning 1', v_order)]));

  -- 6. money never counts as returned when it was not ------------------------------------------
  -- A refund that succeeded and then failed, its old 'succeeded' snapshot delivered after the
  -- failure (Stripe does not deliver events in order; a retry can come hours late).
  v_order := pg_temp.web_card_order('TEST-RF-10', 10, v_customer, 'pi_TESTRF10');
  perform pg_temp.stripe_refund('re_TESTRF10', 'pi_TESTRF10', 1000, 'succeeded');
  perform pg_temp.stripe_refund('re_TESTRF10', 'pi_TESTRF10', 1000, 'failed');
  perform pg_temp.stripe_refund('re_TESTRF10', 'pi_TESTRF10', 1000, 'succeeded');
  perform pg_temp.expect('a late succeeded snapshot leaves the refund failed and 10.00 owed', 'failed completed 10.00',
    (select r.status || ' ' || p.status || ' ' || private.order_card_refund_due(v_order)
       from public.payment_refunds r join public.payments p on p.id = r.payment_id
      where r.stripe_refund_id = 're_TESTRF10'));
  perform pg_temp.expect('so the kitchen still cannot Reject it with nothing sent back', 'ERR card_refund_required',
    pg_temp.try_as(v_kitchen, array[format('select public.cancel_order(%L, ''Rejected by kitchen'')::text', v_order)]));

  -- The charge read while its refund was on the way said refunded in full; the refund then failed.
  v_order := pg_temp.web_card_order('TEST-RF-11', 10, v_customer, 'pi_TESTRF11');
  perform pg_temp.stripe_refund('re_TESTRF11', 'pi_TESTRF11', 1000, 'pending');
  perform public.stripe_connect_apply_charge_refunded('acct_TESTREFUND', jsonb_build_object(
    'id', 'ch_TESTRF11', 'payment_intent', 'pi_TESTRF11', 'refunded', true, 'amount_refunded', 1000));
  perform pg_temp.expect('while it is on its way nothing is owed', 'refunded 0',
    (select p.status || ' ' || private.order_card_refund_due(v_order) from public.payments p where p.order_id = v_order));
  perform pg_temp.stripe_refund('re_TESTRF11', 'pi_TESTRF11', 1000, 'failed');
  perform pg_temp.expect('once it failed the payment is paid again and 10.00 is owed', 'completed 10.00',
    (select p.status || ' ' || private.order_card_refund_due(v_order) from public.payments p where p.order_id = v_order));
  perform pg_temp.expect('and the owner cannot mark the order refunded on it', 'ERR card_refund_required',
    pg_temp.try_as(v_owner, array[format('select public.refund_order(%L, 10, null)::text', v_order)]));
  -- The same charge re-read after the failure (the webhook's fallback) keeps it that way.
  perform public.stripe_connect_apply_charge_refunded('acct_TESTREFUND', jsonb_build_object(
    'id', 'ch_TESTRF11', 'payment_intent', 'pi_TESTRF11', 'refunded', false, 'amount_refunded', 0));
  perform pg_temp.expect('a fresh charge read after the failure changes nothing', 'completed 10.00',
    (select p.status || ' ' || private.order_card_refund_due(v_order) from public.payments p where p.order_id = v_order));

  -- A transfer row of the order's own branch holds the confirm when the card goes through: the
  -- money is still recorded, and closing the order still needs its refund.
  v_order := pg_temp.web_card_order('TEST-RF-12', 10, v_customer, null);
  select id into v_pay from public.payments where order_id = v_order;
  insert into public.payments (order_id, branch_id, amount, method, status)
  values (v_order, c_branch, 10, 'transfer', 'pending');
  perform public.stripe_connect_apply_payment_intent('acct_TESTREFUND', jsonb_build_object(
    'id', 'pi_TESTRF12', 'status', 'succeeded', 'amount_received', 1000, 'currency', 'usd',
    'metadata', jsonb_build_object('payment_id', v_pay)));
  perform pg_temp.expect('the card money is recorded though the order stays pending', 'completed pending 10.00',
    (select p.status || ' ' || o.status || ' ' || private.order_card_refund_due(v_order)
       from public.payments p join public.orders o on o.id = p.order_id where p.id = v_pay));
  perform pg_temp.expect('and the kitchen cannot Reject it without the refund', 'ERR card_refund_required',
    pg_temp.try_as(v_kitchen, array[format('select public.cancel_order(%L, ''Rejected by kitchen'')::text', v_order)]));

  -- A dispute the restaurant won keeps the money with it; a late 'needs_response' snapshot of the
  -- same dispute must not make the order cancellable without a refund.
  v_order := pg_temp.web_card_order('TEST-RF-13', 10, v_customer, 'pi_TESTRF13');
  perform public.stripe_connect_record_dispute('acct_TESTREFUND', jsonb_build_object(
    'id', 'dp_TESTRF13', 'amount', 1000, 'reason', 'fraudulent', 'status', 'won',
    'payment_intent', 'pi_TESTRF13'), 'charge.dispute.closed');
  perform public.stripe_connect_record_dispute('acct_TESTREFUND', jsonb_build_object(
    'id', 'dp_TESTRF13', 'amount', 1000, 'reason', 'fraudulent', 'status', 'needs_response',
    'payment_intent', 'pi_TESTRF13'), 'charge.dispute.updated');
  perform pg_temp.expect('a won dispute stays won when an older snapshot arrives', 'won 10.00',
    (select (p.gateway_metadata ->> 'dispute_status') || ' ' || private.order_card_refund_due(v_order)
       from public.payments p where p.order_id = v_order));
  perform pg_temp.expect('so cancelling it still needs its refund', 'ERR card_refund_required',
    pg_temp.try_as(v_owner, array[format('select public.cancel_order(%L, ''Admin canceled'')::text', v_order)]));
end
$test$;

select seq, verdict, check_name, expected, actual from t_out
union all
select 999999, (select case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAILURES' end from t_out),
       format('%s checks, %s failed', count(*), count(*) filter (where verdict = 'FAIL')), null, null
  from t_out
order by 1;

rollback;
