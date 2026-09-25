-- Stripe Connect card payments (20260925100000_stripe_connect_payments). A rolled-back script, not a
-- migration.
--
-- Run from the repo root once the migration is applied:
--   SUPABASE_TELEMETRY_DISABLED=1 npx --yes supabase db query --linked \
--     --project-ref ayyfczidnzxetndiijmv -f supabase/tests/stripe_connect_payments.sql
-- Before it is applied, run the migration and this file in one transaction instead (drop this
-- file's own "begin;" and put the migration after a "begin;" of your own).
--
-- Everything happens inside one transaction that ends in ROLLBACK. Calls made on someone's behalf
-- through pg_temp.try_as run in their own subtransaction, which is always rolled back. Statements
-- run directly here are the service role's (no JWT), which is who the edge functions are.
--
-- People, found by role at Coastal Grill / Hamburger (no platform admin: every check passes for one):
--   owner     restaurants.owner_user_id     billing.manage + branch.settings
--   admin     an active admin row           branch.settings, no billing.manage
--   cashier   an active cashier row         neither
--
-- Account ids are made up (acct_TEST...). No Stripe call is made.
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

-- A storefront order with an online card payment, as place-order writes it.
create or replace function pg_temp.card_order(p_number text, p_total numeric, p_age interval, p_account text)
returns uuid
language plpgsql
as $$
declare v_order uuid;
begin
  insert into public.orders (order_number, branch_id, channel, status, status_history, subtotal, discount_amount,
    tax_amount, delivery_fee, service_fee, tip_amount, total, promo_discount, source, held, awaiting_payment, created_at)
  values (p_number, '44444444-4444-4444-4444-444444444444', 'pickup', 'pending', '[]'::jsonb, p_total, 0, 0, 0, 0, 0,
          p_total, 0, 'web', false, true, now() - p_age)
  returning id into v_order;
  insert into public.payments (order_id, branch_id, amount, method, status, gateway, gateway_metadata)
  values (v_order, '44444444-4444-4444-4444-444444444444', p_total, 'card', 'pending', 'stripe',
          jsonb_build_object('pending', true, 'stripe_account', p_account));
  return v_order;
end $$;

do $test$
declare
  c_branch constant uuid := '44444444-4444-4444-4444-444444444444';
  c_thai constant uuid := 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';
  v_owner uuid;
  v_admin uuid;
  v_cashier uuid;
  v_order uuid;
  v_pay uuid;
  v_old uuid;
  v_fresh uuid;
  v_counter uuid;
  v_proc uuid;
  v_stuck uuid;
  v_stale uuid;
  v_other_owner uuid;
  v_other_branch uuid;
  v_err text;
  r jsonb;
begin
  select r.owner_user_id into v_owner from public.restaurants r where r.id = '33333333-3333-3333-3333-333333333333';
  select sm.user_id into v_admin from public.staff_members sm join auth.users u on u.id = sm.user_id
   where sm.branch_id = c_branch and sm.role = 'admin' and sm.status = 'active'
     and not coalesce((u.raw_app_meta_data ->> 'is_platform_admin')::boolean, false) limit 1;
  select sm.user_id into v_cashier from public.staff_members sm join auth.users u on u.id = sm.user_id
   where sm.branch_id = c_branch and sm.role = 'cashier' and sm.status = 'active'
     and not coalesce((u.raw_app_meta_data ->> 'is_platform_admin')::boolean, false) limit 1;

  -- 0. place-order's old "stripe" label on card sets that never touched Stripe is gone ---------
  perform pg_temp.expect('no stripe label without a charge from before Connect', '0',
    (select count(*)::text from public.payments
      where gateway = 'stripe' and gateway_charge_id is null and created_at < timestamptz '2026-09-25 00:00:00+00'));

  -- 1. storefront_status keeps its keys and gains card_ready ---------------------------------
  perform pg_temp.expect('storefront_status: 15 keys with card_ready', 'card_payment,card_ready,delivery,delivery_available,delivery_entitled,delivery_hours_on,delivery_mode,delivery_windows,entitled,opening_hours,schedule_max_days,schedule_min_lead_min,schedule_slot_minutes,scheduling_enabled,timezone',
    (select string_agg(k, ',' order by k) from jsonb_object_keys(public.storefront_status(c_branch)) k));
  perform pg_temp.expect('card_ready false without an account', 'false', (public.storefront_status(c_branch) ->> 'card_ready'));
  perform pg_temp.expect('card_ready false for an unknown branch', 'false',
    (public.storefront_status('00000000-0000-0000-0000-000000000000') ->> 'card_ready'));

  delete from public.branch_payment_accounts where branch_id = c_branch;
  insert into public.branch_payment_accounts (branch_id, stripe_account_id, charges_enabled, payouts_enabled, details_submitted)
  values (c_branch, 'acct_TESTHAMBURGER', true, true, true);
  perform pg_temp.expect('card_ready true once charges are enabled', 'true', (public.storefront_status(c_branch) ->> 'card_ready'));
  perform pg_temp.expect('card_ready stays per branch', 'false', (public.storefront_status(c_thai) ->> 'card_ready'));
  perform pg_temp.expect('anon reads storefront_status', 'ok 15',
    pg_temp.try_as(null, array[format('select count(*)::text from jsonb_object_keys(public.storefront_status(%L))', c_branch)]));

  -- 2. who reads and writes branch_payment_accounts ------------------------------------------
  perform pg_temp.expect('owner reads the account', 'ok 1',
    pg_temp.try_as(v_owner, array[format('select count(*)::text from public.branch_payment_accounts where branch_id = %L', c_branch)]));
  perform pg_temp.expect('admin (branch.settings) reads the account', 'ok 1',
    pg_temp.try_as(v_admin, array[format('select count(*)::text from public.branch_payment_accounts where branch_id = %L', c_branch)]));
  perform pg_temp.expect('cashier reads nothing', 'ok 0',
    pg_temp.try_as(v_cashier, array[format('select count(*)::text from public.branch_payment_accounts where branch_id = %L', c_branch)]));
  perform pg_temp.expect('anon cannot read accounts', 'ERR permission denied%',
    pg_temp.try_as(null, array['select count(*)::text from public.branch_payment_accounts']));
  perform pg_temp.expect('owner cannot point the branch at another account', 'ERR permission denied%',
    pg_temp.try_as(v_owner, array[format(
      'update public.branch_payment_accounts set stripe_account_id = %L where branch_id = %L returning 1', 'acct_TESTEVIL', c_branch)]));
  perform pg_temp.expect('owner cannot insert an account', 'ERR permission denied%',
    pg_temp.try_as(v_owner, array[format(
      'insert into public.branch_payment_accounts (branch_id, stripe_account_id) values (%L, %L) returning 1', c_thai, 'acct_TESTEVIL')]));
  perform pg_temp.expect('signed-in users cannot apply a PaymentIntent', 'ERR permission denied for function%',
    pg_temp.try_as(v_owner, array[
      'select public.stripe_connect_apply_payment_intent(''acct_TESTHAMBURGER'', ''{"id":"pi_x","status":"succeeded"}''::jsonb)::text']));

  -- 3. an online card order waits, and nobody signed in can pretend it was paid --------------
  v_order := pg_temp.card_order('TEST-SC-1', 10, interval '0', 'acct_TESTHAMBURGER');
  select id into v_pay from public.payments where order_id = v_order;
  perform pg_temp.expect('card order awaits payment', 'true', (select awaiting_payment::text from public.orders where id = v_order));
  perform pg_temp.expect('owner cannot mark the Stripe payment paid', 'ERR stripe_payment_server_only',
    pg_temp.try_as(v_owner, array[format('update public.payments set status = ''completed'' where id = %L returning 1', v_pay)]));
  perform pg_temp.expect('decide_payment_proof cannot settle it', 'ERR stripe_payment_server_only',
    pg_temp.try_as(v_owner, array[format('select public.decide_payment_proof(%L, true, null)::text', v_pay)]));
  perform pg_temp.expect('staff cannot insert a Stripe payment', 'ERR stripe_payment_server_only',
    pg_temp.try_as(v_owner, array[format(
      'insert into public.payments (order_id, branch_id, amount, method, status, gateway) values (%L, %L, 10, ''card'', ''completed'', ''stripe'') returning 1',
      v_order, c_branch)]));
  perform pg_temp.expect('the unpaid order cannot be moved on', 'ERR card_payment_not_completed',
    pg_temp.try_as(v_owner, array[format('update public.orders set status = ''confirmed'' where id = %L returning 1', v_order)]));

  -- 4. PaymentIntent events --------------------------------------------------------------------
  r := public.stripe_connect_apply_payment_intent('acct_TESTOTHER', jsonb_build_object(
    'id', 'pi_TESTSC1', 'status', 'succeeded', 'amount_received', 1000, 'currency', 'usd',
    'metadata', jsonb_build_object('payment_id', v_pay)));
  perform pg_temp.expect('another account cannot pay it', 'account_mismatch', r ->> 'error');
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC1', 'status', 'processing', 'currency', 'usd', 'metadata', jsonb_build_object('payment_id', v_pay)));
  perform pg_temp.expect('processing changes nothing', 'pending false', (r ->> 'status') || ' ' || (r ->> 'changed'));
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC1', 'status', 'succeeded', 'amount_received', 1000, 'currency', 'usd', 'latest_charge', 'ch_TESTSC1'));
  perform pg_temp.expect('success completes the payment', 'completed true', (r ->> 'status') || ' ' || (r ->> 'changed'));
  perform pg_temp.expect('success confirms the order and releases it', 'confirmed false',
    (select status || ' ' || awaiting_payment from public.orders where id = v_order));
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC1', 'status', 'succeeded', 'amount_received', 1000, 'currency', 'usd'));
  perform pg_temp.expect('a repeated success changes nothing', 'false', r ->> 'changed');
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC1', 'status', 'requires_payment_method', 'currency', 'usd',
    'last_payment_error', jsonb_build_object('message', 'Your card was declined.')));
  perform pg_temp.expect('a late failure never undoes a payment', 'completed', r ->> 'status');
  perform pg_temp.expect('the kitchen can move a paid order on', 'ok 1',
    pg_temp.try_as(v_owner, array[format('update public.orders set status = ''preparing'' where id = %L returning 1', v_order)]));

  -- 5. refunds ---------------------------------------------------------------------------------
  r := public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTSC1', 'amount', 300, 'status', 'succeeded', 'payment_intent', 'pi_TESTSC1'), v_owner, 'Cold fries');
  perform pg_temp.expect('a partial refund keeps the payment completed', 'completed 3.00', (r ->> 'payment_status') || ' ' || (r ->> 'amount_refunded'));
  r := public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTSC1', 'amount', 300, 'status', 'pending', 'payment_intent', 'pi_TESTSC1'));
  perform pg_temp.expect('a late pending event does not reopen a refund', 'succeeded', r ->> 'refund_status');
  perform pg_temp.expect('the first writer keeps who and why', 'Cold fries true',
    (select reason || ' ' || (created_by = v_owner) from public.payment_refunds where stripe_refund_id = 're_TESTSC1'));
  r := public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTSC2', 'amount', 700, 'status', 'succeeded', 'charge', 'ch_TESTSC1'));
  perform pg_temp.expect('refunded in full -> refunded', 'refunded', r ->> 'payment_status');
  r := public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTSC2', 'amount', 700, 'status', 'failed', 'charge', 'ch_TESTSC1'));
  perform pg_temp.expect('a refund failing after success -> completed again', 'completed', r ->> 'payment_status');
  r := public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTSC3', 'amount', 500, 'status', 'succeeded', 'charge', 'ch_TESTNOTOURS'));
  perform pg_temp.expect('a refund of a charge the platform never made is ignored', 'payment_not_found', r ->> 'error');
  r := public.stripe_connect_record_refund('acct_TESTOTHER', jsonb_build_object(
    'id', 're_TESTSC4', 'amount', 100, 'status', 'succeeded', 'payment_intent', 'pi_TESTSC1'));
  perform pg_temp.expect('another account cannot record a refund on it', 'account_mismatch', r ->> 'error');
  perform pg_temp.expect('the owner (payments.view) reads the refunds', 'ok 2',
    pg_temp.try_as(v_owner, array[format('select count(*)::text from public.payment_refunds where payment_id = %L', v_pay)]));
  perform pg_temp.expect('the owner cannot write a refund row', 'ERR permission denied%',
    pg_temp.try_as(v_owner, array[format(
      'insert into public.payment_refunds (payment_id, order_id, branch_id, amount, status) values (%L, %L, %L, 1, ''succeeded'') returning 1',
      v_pay, v_order, c_branch)]));

  -- 6. disputes --------------------------------------------------------------------------------
  r := public.stripe_connect_record_dispute('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'dp_TESTSC1', 'amount', 1000, 'reason', 'fraudulent', 'status', 'needs_response', 'charge', 'ch_TESTSC1'),
    'charge.dispute.created');
  perform pg_temp.expect('a dispute is found by its charge and recorded', 'true', r ->> 'ok');
  perform pg_temp.expect('the dispute sits on the payment', 'dp_TESTSC1 fraudulent needs_response',
    (select (gateway_metadata ->> 'dispute_id') || ' ' || (gateway_metadata ->> 'dispute_reason') || ' ' || (gateway_metadata ->> 'dispute_status')
       from public.payments where id = v_pay));
  perform pg_temp.expect('and on the order history', '1',
    (select count(*)::text from public.audit_logs where entity_id = v_pay and action = 'payment_dispute_opened'));

  -- 7. the 30-minute expiry and a payment that arrives after it -------------------------------
  v_old := pg_temp.card_order('TEST-SC-2', 12.5, interval '40 minutes', 'acct_TESTHAMBURGER');
  update public.payments set gateway_charge_id = 'pi_TESTSC2' where order_id = v_old;
  v_fresh := pg_temp.card_order('TEST-SC-3', 8, interval '5 minutes', 'acct_TESTHAMBURGER');
  perform private.expire_unpaid_card_orders();
  perform pg_temp.expect('an unpaid card order is cancelled after 30 minutes', 'cancelled false voided',
    (select o.status || ' ' || o.awaiting_payment || ' ' || p.status from public.orders o join public.payments p on p.order_id = o.id where o.id = v_old));
  perform pg_temp.expect('a younger one is left alone', 'pending true',
    (select status || ' ' || awaiting_payment from public.orders where id = v_fresh));
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC2', 'status', 'succeeded', 'amount_received', 1250, 'currency', 'usd'));
  perform pg_temp.expect('money after the order closed must go back', 'refund_required order_closed 1250',
    (r ->> 'action') || ' ' || (r ->> 'reason') || ' ' || (r ->> 'refund_amount_cents'));
  perform pg_temp.expect('the closed order stays closed', 'cancelled false',
    (select status || ' ' || awaiting_payment from public.orders where id = v_old));
  perform public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTSC5', 'amount', 1250, 'status', 'succeeded', 'payment_intent', 'pi_TESTSC2'));
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC2', 'status', 'succeeded', 'amount_received', 1250, 'currency', 'usd'));
  perform pg_temp.expect('once refunded, a repeat asks for nothing more', '<null> refunded', coalesce(r ->> 'action', '<null>') || ' ' || (r ->> 'status'));

  -- 7b. a payment Stripe is still settling waits an hour at most ---------------------------------
  -- Processing 40 minutes after the order: the card may still clear, so the order keeps waiting.
  v_proc := pg_temp.card_order('TEST-SC-5', 10, interval '40 minutes', 'acct_TESTHAMBURGER');
  perform public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC5', 'status', 'processing', 'amount', 1000, 'amount_received', 0, 'currency', 'usd',
    'metadata', jsonb_build_object('payment_id', (select id from public.payments where order_id = v_proc))));
  -- Processing four days after the order (a bank debit): no longer a reason to wait.
  v_stuck := pg_temp.card_order('TEST-SC-6', 10, interval '4 days', 'acct_TESTHAMBURGER');
  perform public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC6', 'status', 'processing', 'amount', 1000, 'amount_received', 0, 'currency', 'usd',
    'metadata', jsonb_build_object('payment_id', (select id from public.payments where order_id = v_stuck))));
  -- Declined 45 minutes in, then the older processing snapshot of the same attempt delivered late.
  v_stale := pg_temp.card_order('TEST-SC-7', 10, interval '45 minutes', 'acct_TESTHAMBURGER');
  perform public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC7', 'status', 'requires_payment_method', 'amount', 1000, 'amount_received', 0, 'currency', 'usd',
    'last_payment_error', jsonb_build_object('code', 'card_declined', 'message', 'Your card was declined.'),
    'metadata', jsonb_build_object('payment_id', (select id from public.payments where order_id = v_stale))));
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC7', 'status', 'processing', 'amount', 1000, 'amount_received', 0, 'currency', 'usd',
    'metadata', jsonb_build_object('payment_id', (select id from public.payments where order_id = v_stale))));
  perform pg_temp.expect('a late processing snapshot does not reopen a declined payment', 'failed requires_payment_method',
    (select status || ' ' || (gateway_metadata ->> 'stripe_status') from public.payments where order_id = v_stale));
  perform private.expire_unpaid_card_orders();
  perform pg_temp.expect('a processing payment keeps its order waiting within the hour', 'pending true pending',
    (select o.status || ' ' || o.awaiting_payment || ' ' || p.status from public.orders o join public.payments p on p.order_id = o.id where o.id = v_proc));
  perform pg_temp.expect('a payment processing for days no longer holds its order', 'cancelled false voided',
    (select o.status || ' ' || o.awaiting_payment || ' ' || p.status from public.orders o join public.payments p on p.order_id = o.id where o.id = v_stuck));
  perform pg_temp.expect('the expiry records the real age', '5760',
    (select metadata ->> 'after_minutes' from public.audit_logs where entity_id = v_stuck and action = 'order_card_payment_expired'));
  perform pg_temp.expect('a declined payment is not held open by a stale processing event', 'cancelled false voided',
    (select o.status || ' ' || o.awaiting_payment || ' ' || p.status from public.orders o join public.payments p on p.order_id = o.id where o.id = v_stale));
  -- The debit clears days later: the money goes back, and the order never reaches the kitchen.
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC6', 'status', 'succeeded', 'amount', 1000, 'amount_received', 1000, 'currency', 'usd',
    'metadata', jsonb_build_object('payment_id', (select id from public.payments where order_id = v_stuck))));
  perform pg_temp.expect('a debit clearing days later is refunded, not cooked', 'refund_required order_closed cancelled',
    (r ->> 'action') || ' ' || (r ->> 'reason') || ' ' || (select status::text from public.orders where id = v_stuck));

  -- 8. the wrong amount is not accepted as payment ----------------------------------------------
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTSC3', 'status', 'succeeded', 'amount_received', 100, 'currency', 'usd',
    'metadata', jsonb_build_object('payment_id', (select id from public.payments where order_id = v_fresh))));
  perform pg_temp.expect('a short payment is refunded, not accepted', 'refund_required amount_mismatch pending',
    (r ->> 'action') || ' ' || (r ->> 'reason') || ' ' || (r ->> 'status'));
  perform pg_temp.expect('and the order keeps waiting', 'pending true',
    (select status || ' ' || awaiting_payment from public.orders where id = v_fresh));

  -- 9. a counter card sale is still the till's to settle ----------------------------------------
  insert into public.orders (order_number, branch_id, channel, status, status_history, subtotal, discount_amount,
    tax_amount, delivery_fee, service_fee, tip_amount, total, promo_discount, source, held, awaiting_payment)
  values ('TEST-SC-4', c_branch, 'pickup', 'pending', '[]'::jsonb, 5, 0, 0, 0, 0, 0, 5, 0, 'counter', false, false)
  returning id into v_counter;
  insert into public.payments (order_id, branch_id, amount, method, status, gateway)
  values (v_counter, c_branch, 5, 'card', 'pending', 'stripe');
  perform pg_temp.expect('the till records a counter card sale', 'ok%',
    pg_temp.try_as(v_owner, array[format('select public.record_counter_payment(%L, 5)::text', v_counter)]));

  -- 10. a payment belongs to its order's branch --------------------------------------------------
  -- payments_staff_write checked payments.decide at the new row's branch only, so another
  -- restaurant's owner could hang a transfer row on this order and freeze its card payment.
  select r2.owner_user_id, b.id into v_other_owner, v_other_branch
    from public.restaurants r2
    join public.branches b on b.restaurant_id = r2.id
    join auth.users u on u.id = r2.owner_user_id
   where r2.id <> '33333333-3333-3333-3333-333333333333'
     and not coalesce((u.raw_app_meta_data ->> 'is_platform_admin')::boolean, false)
     and not exists (select 1 from public.staff_members sm
                      where sm.user_id = r2.owner_user_id
                        and sm.restaurant_id = '33333333-3333-3333-3333-333333333333')
   order by r2.created_at
   limit 1;
  perform pg_temp.expect('fixture: another restaurant''s owner who is nobody here', 'true', (v_other_owner is not null)::text);
  perform pg_temp.expect('who holds payments.decide at their own branch', 'ok true',
    pg_temp.try_as(v_other_owner, array[format(
      'select private.staff_has_capability(%L, ''payments.decide'')::text', v_other_branch)]));

  v_order := pg_temp.card_order('TEST-MS-1', 10, interval '0', 'acct_TESTHAMBURGER');
  select id into v_pay from public.payments where order_id = v_order;
  perform pg_temp.expect('another restaurant cannot hang a payment on this order', 'ERR payment_branch_mismatch',
    pg_temp.try_as(v_other_owner, array[format(
      'insert into public.payments (order_id, branch_id, amount, method, status) values (%L, %L, 1, ''transfer'', ''pending'') returning 1',
      v_order, v_other_branch)]));
  perform pg_temp.expect('the owner cannot file one under their other branch', 'ERR payment_branch_mismatch',
    pg_temp.try_as(v_owner, array[format(
      'insert into public.payments (order_id, branch_id, amount, method, status) values (%L, %L, 1, ''transfer'', ''pending'') returning 1',
      v_order, c_thai)]));
  perform pg_temp.expect('nor move one to their other branch afterwards', 'ERR payment_branch_mismatch',
    pg_temp.try_as(v_owner, array[
      format('insert into public.payments (order_id, branch_id, amount, method, status) values (%L, %L, 1, ''transfer'', ''pending'') returning 1',
             v_order, c_branch),
      format('update public.payments set branch_id = %L where order_id = %L and method = ''transfer'' returning 1',
             c_thai, v_order)]));
  begin
    insert into public.payments (order_id, branch_id, amount, method, status)
    values (v_order, v_other_branch, 1, 'transfer', 'pending');
    v_err := 'ok';
  exception when others then
    v_err := 'ERR ' || sqlerrm;
  end;
  perform pg_temp.expect('the service role is held to it too', 'ERR payment_branch_mismatch', v_err);

  -- A transfer row of the order's own branch is still allowed, and if the order's rules then refuse
  -- the confirm, the diner's card money is recorded anyway instead of rolling back with it.
  insert into public.payments (order_id, branch_id, amount, method, status)
  values (v_order, c_branch, 10, 'transfer', 'pending');
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTMS1', 'status', 'succeeded', 'amount_received', 1000, 'currency', 'usd',
    'metadata', jsonb_build_object('payment_id', v_pay)));
  perform pg_temp.expect('a card success is kept when the order refuses its confirm',
    'true completed pending transfer_payment_not_approved',
    (r ->> 'ok') || ' ' || (r ->> 'status') || ' ' || (r ->> 'order_status') || ' ' || coalesce(r ->> 'order_confirm_error', '<null>'));
  perform pg_temp.expect('the payment is completed on the books', 'completed pending',
    (select p.status || ' ' || o.status from public.payments p join public.orders o on o.id = p.order_id where p.id = v_pay));
  -- The order page's re-check applies the same success again while the diner waits.
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTMS1', 'status', 'succeeded', 'amount_received', 1000, 'currency', 'usd'));
  perform pg_temp.expect('a repeat still answers why', 'completed pending transfer_payment_not_approved',
    (r ->> 'status') || ' ' || (r ->> 'order_status') || ' ' || coalesce(r ->> 'order_confirm_error', '<null>'));
  perform pg_temp.expect('and the order history says why it is still pending, once', '1',
    (select count(*)::text from public.audit_logs where entity_id = v_order and action = 'card_payment_order_not_confirmed'));
  delete from public.payments where order_id = v_order and method = 'transfer';
  r := public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTMS1', 'status', 'succeeded', 'amount_received', 1000, 'currency', 'usd'));
  perform pg_temp.expect('the same success applied again confirms it once nothing is in the way', 'confirmed <null>',
    (r ->> 'order_status') || ' ' || coalesce(r ->> 'order_confirm_error', '<null>'));

  -- 11. a refund only moves forward ---------------------------------------------------------------
  -- Stripe delivers events in any order; a succeeded refund can fail later, and failed and
  -- canceled are final.
  v_order := pg_temp.card_order('TEST-MS-2', 10, interval '0', 'acct_TESTHAMBURGER');
  select id into v_pay from public.payments where order_id = v_order;
  perform public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTMS2', 'status', 'succeeded', 'amount_received', 1000, 'currency', 'usd',
    'metadata', jsonb_build_object('payment_id', v_pay)));
  perform public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTMS2', 'amount', 1000, 'status', 'succeeded', 'payment_intent', 'pi_TESTMS2'));
  perform public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTMS2', 'amount', 1000, 'status', 'failed', 'payment_intent', 'pi_TESTMS2'));
  r := public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTMS2', 'amount', 1000, 'status', 'succeeded', 'payment_intent', 'pi_TESTMS2'));
  perform pg_temp.expect('a late succeeded snapshot does not cover a refund that failed since', 'failed completed 0',
    (r ->> 'refund_status') || ' ' || (r ->> 'payment_status') || ' ' || (r ->> 'amount_refunded'));
  r := public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTMS2', 'amount', 1000, 'status', 'pending', 'payment_intent', 'pi_TESTMS2'));
  perform pg_temp.expect('nor does a late pending one', 'failed', r ->> 'refund_status');
  perform public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTMS2B', 'amount', 400, 'status', 'canceled', 'payment_intent', 'pi_TESTMS2'));
  r := public.stripe_connect_record_refund('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 're_TESTMS2B', 'amount', 400, 'status', 'succeeded', 'payment_intent', 'pi_TESTMS2'));
  perform pg_temp.expect('a canceled refund stays canceled', 'canceled completed', (r ->> 'refund_status') || ' ' || (r ->> 'payment_status'));

  -- 12. charge.refunded's fallback applies a charge the webhook has just re-read ------------------
  -- Only a fresh Charge reaches it now, so it takes the charge's amount as it is, down as well as up.
  v_order := pg_temp.card_order('TEST-MS-3', 10, interval '0', 'acct_TESTHAMBURGER');
  select id into v_pay from public.payments where order_id = v_order;
  perform public.stripe_connect_apply_payment_intent('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'pi_TESTMS3', 'status', 'succeeded', 'amount_received', 1000, 'currency', 'usd',
    'latest_charge', 'ch_TESTMS3', 'metadata', jsonb_build_object('payment_id', v_pay)));
  r := public.stripe_connect_apply_charge_refunded('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'ch_TESTMS3', 'payment_intent', 'pi_TESTMS3', 'refunded', true, 'amount_refunded', 1000));
  perform pg_temp.expect('a charge refunded in full marks the payment refunded', 'refunded 10.00',
    (select status || ' ' || (gateway_metadata ->> 'amount_refunded') from public.payments where id = v_pay));
  r := public.stripe_connect_apply_charge_refunded('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'ch_TESTMS3', 'payment_intent', 'pi_TESTMS3', 'refunded', false, 'amount_refunded', 0));
  perform pg_temp.expect('the same charge read after its refund failed takes it back', 'completed 0.00',
    (select status || ' ' || (gateway_metadata ->> 'amount_refunded') from public.payments where id = v_pay));
  r := public.stripe_connect_apply_charge_refunded('acct_TESTHAMBURGER', jsonb_build_object(
    'id', 'ch_TESTMS3', 'payment_intent', 'pi_TESTMS3'));
  perform pg_temp.expect('a charge that does not say leaves the payment as it is', 'completed 0.00',
    (select status || ' ' || (gateway_metadata ->> 'amount_refunded') from public.payments where id = v_pay));

  -- 13. housekeeping -----------------------------------------------------------------------------
  perform pg_temp.expect('the expiry runs every minute', '* * * * *',
    (select schedule from cron.job where jobname = 'expire-unpaid-card-orders'));
end
$test$;

select seq, verdict, check_name, expected, actual from t_out
union all
select 999999, (select case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAILURES' end from t_out),
       format('%s checks, %s failed', count(*), count(*) filter (where verdict = 'FAIL')), null, null
  from t_out
order by 1;

rollback;
