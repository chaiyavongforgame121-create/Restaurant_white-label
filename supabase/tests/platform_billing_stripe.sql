-- Platform billing through Stripe (20260926100000_platform_billing_stripe and its review fixes
-- 20260927100000_platform_billing_stripe_fixes and 20260927200000_platform_billing_stripe_fixes_2,
-- docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §8, §9, §10).
-- A rolled-back script, not a migration. Checks whose rule the fixes changed say so (§9.x, §10.x).
--
-- Run from the repo root once the migration is applied:
--   SUPABASE_TELEMETRY_DISABLED=1 npx --yes supabase db query --linked \
--     --project-ref ayyfczidnzxetndiijmv -f supabase/tests/platform_billing_stripe.sql
-- Before it is applied, run the migration and this file in one transaction instead (drop this
-- file's own "begin;" and put the migration after a "begin;" of your own).
--
-- Everything happens inside one transaction that ends in ROLLBACK, on a restaurant this script
-- creates for itself: no existing row is used as a fixture. Two ways of acting as someone:
--   pg_temp.try_as(uid, sqls[, admin])  as the `authenticated` role, in a subtransaction that is
--                                       always rolled back -- for permission checks.
--   pg_temp.act_as(uid[, admin])        sets only the JWT claims, so auth.uid() is that person
--                                       while the statements that follow keep their effect --
--                                       for the merchant and the operator doing things the next
--                                       check builds on. act_as(null) is the service role again
--                                       (no JWT), which is who the edge functions and the webhook
--                                       are.
--
-- People (auth.users rows made here):
--   owner     restaurants.owner_user_id of both test restaurants    billing.manage
--   stranger  nobody's staff                                        nothing
--   admin     app_metadata.is_platform_admin                         the platform console
--   cashier   staff of the fourth restaurant (section 17)            no billing.manage
--
-- Stripe ids are made up (cus_TEST..., sub_TEST..., in_TEST...). No Stripe call is made.
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
create or replace function pg_temp.try_as(p_uid uuid, p_sqls text[], p_admin boolean default false)
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
        json_build_object('sub', p_uid, 'role', 'authenticated',
                          'app_metadata', json_build_object('is_platform_admin', p_admin))::text, true);
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

-- Run statements as the service role (no JWT) and report 'ok <last value>' or 'ERR <message>'.
-- Always rolled back.
create or replace function pg_temp.try_service(p_sqls text[])
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

-- Who auth.uid() is for the statements that follow (null: the service role, no JWT).
create or replace function pg_temp.act_as(p_uid uuid, p_admin boolean default false)
returns void
language plpgsql
as $$
begin
  if p_uid is null then
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated',
                        'app_metadata', json_build_object('is_platform_admin', p_admin))::text, true);
    perform set_config('request.jwt.claim.sub', p_uid::text, true);
    perform set_config('request.jwt.claim.role', '', true);
  end if;
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

create or replace function pg_temp.new_user(p_label text, p_admin boolean default false)
returns uuid
language plpgsql
as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v, 'billing-test-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', p_admin), '{}'::jsonb, now(), now());
  return v;
end $$;

-- A Stripe invoice as the webhook passes it on: amounts in cents, times in unix seconds.
create or replace function pg_temp.invoice(p_id text, p_sub text, p_reason text, p_status text,
                                           p_cents integer, p_attempts integer, p_period_end timestamptz)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'id', p_id, 'subscription', p_sub, 'customer', 'cus_TESTPBS1', 'billing_reason', p_reason,
    'status', p_status, 'amount_due', p_cents,
    'amount_paid', case when p_status = 'paid' then p_cents else 0 end, 'currency', 'usd',
    'period_start', extract(epoch from p_period_end - interval '1 month')::bigint,
    'period_end', extract(epoch from p_period_end)::bigint,
    'hosted_invoice_url', 'https://invoice.stripe.com/i/' || p_id,
    'status_transitions', jsonb_build_object('paid_at',
      case when p_status = 'paid' then extract(epoch from now())::bigint end),
    'attempt_count', p_attempts);
$$;

do $test$
declare
  v_owner    uuid := pg_temp.new_user('owner');
  v_stranger uuid := pg_temp.new_user('stranger');
  v_admin    uuid := pg_temp.new_user('admin', true);
  v_sfx      text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_rid      uuid;
  v_rid2     uuid;
  v_b1       uuid;
  v_b2       uuid;
  v_c1       uuid;
  v_code1    text := 'ZZPBS10' || upper(left(v_sfx, 6));
  v_code2    text := 'ZZPBS20' || upper(left(v_sfx, 6));
  v_trial_end timestamptz;
  v_x        timestamptz;   -- paid-through after the first purchase
  v_start    timestamptz;
  v_grace    timestamptz;
  v_q1 uuid; v_q2 uuid; v_q3 uuid; v_q4 uuid; v_q5 uuid; v_qr2 uuid;
  v_q6 uuid; v_q7 uuid; v_q8 uuid; v_q9 uuid; v_q10 uuid;
  v_rid3     uuid;
  v_d1       uuid;
  v_d2       uuid;
  v_d3       uuid;
  v_t        timestamptz := now();
  v_evt      text := 'evt_TESTPBS_' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_bool     boolean;
  v_claim    text;
  v_count    integer;
  r          jsonb;
  v_items    jsonb;
  -- Section 17 (§10): a fourth restaurant on the card rail.
  v_cashier  uuid := pg_temp.new_user('cashier');
  v_rid4     uuid;
  v_e1       uuid;
  v_e2       uuid;
  v_e3       uuid;
  v_x4       timestamptz;
  v_evt2     text := 'evt_TESTPBS_' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_q11 uuid; v_q12 uuid; v_q13 uuid; v_q14 uuid; v_q15 uuid; v_q16 uuid; v_q17 uuid;
begin
  -- 0. Fixture: a restaurant on its 14-day trial with two branches, and a second one ---------------
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-pbs-' || v_sfx, 'ZZ Platform Billing Test')
  returning id into v_rid;
  perform private.billing_apply_selection(v_rid, 'trial', '{}'::uuid[], 2, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_rid, 'one', 'Branch One') returning id into v_b1;
  insert into public.branches (restaurant_id, slug, name) values (v_rid, 'two', 'Branch Two') returning id into v_b2;
  select trial_ends_at into v_trial_end from public.subscriptions where restaurant_id = v_rid;

  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-pbs2-' || v_sfx, 'ZZ Platform Billing Test Two')
  returning id into v_rid2;
  perform private.billing_apply_selection(v_rid2, 'trial', '{}'::uuid[], 3, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_rid2, 'one', 'Second One') returning id into v_c1;
  insert into public.branches (restaurant_id, slug, name) values (v_rid2, 'two', 'Second Two');

  insert into public.billing_discount_codes (code, kind, value, per_restaurant_limit)
  values (v_code1, 'percent', 10, 1), (v_code2, 'percent', 20, 5);

  perform pg_temp.expect('fixture: a trial restaurant with two branches', 'trialing 2 2',
    (select s.status || ' ' || be.branch_seats || ' ' || (select count(*) from public.branches where restaurant_id = v_rid)
       from public.subscriptions s join public.billing_entitlements be on be.restaurant_id = s.restaurant_id
      where s.restaurant_id = v_rid));

  -- 1. The switch and the new shapes, before anything is paid by card ------------------------------
  perform pg_temp.expect('new columns: billing_requests.rail defaults to manual', '''manual''::text',
    (select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'billing_requests' and column_name = 'rail'));
  perform pg_temp.expect('billing_invoices has RLS and no policy', 'true 0',
    (select c.relrowsecurity || ' ' || (select count(*) from pg_policies where tablename = 'billing_invoices')
       from pg_class c where c.oid = 'public.billing_invoices'::regclass));

  update public.platform_settings set billing = '{}'::jsonb where id = 1;
  perform pg_temp.expect('card billing is off by default', 'false', public.billing_stripe_enabled()::text);
  update public.platform_settings set billing = jsonb_build_object('stripe_enabled', 'yes') where id = 1;
  perform pg_temp.expect('a switch that is not a boolean true reads as off', 'false', public.billing_stripe_enabled()::text);
  update public.platform_settings set billing = jsonb_build_object('stripe_enabled', true) where id = 1;
  perform pg_temp.expect('switched on', 'true', public.billing_stripe_enabled()::text);
  perform pg_temp.expect('grace days default to 7', '7', private.billing_grace_days()::text);
  perform pg_temp.expect('the owner reads the switch', 'ok true',
    pg_temp.try_as(v_owner, array['select public.billing_stripe_enabled()::text']));
  perform pg_temp.expect('the settings row is still one row the console can read', 'true',
    (select (to_jsonb(ps) ? 'billing')::text from public.platform_settings ps where id = 1));

  perform pg_temp.act_as(v_owner);
  r := public.get_billing_overview(v_rid);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('overview: the billing object has exactly the parsed keys',
    'cancel_at,cancel_at_period_end,card,grace_until,last_invoice,next_charge_amount,next_charge_at,pending_invoice_url,pending_request_rail,rail,status,stripe_customer,stripe_enabled',
    (select string_agg(k, ',' order by k) from jsonb_object_keys(r -> 'billing') k));
  perform pg_temp.expect('overview: the old keys are all still there', 'billing,branches,charges,entitlements,paid,pending_request',
    (select string_agg(k, ',' order by k) from jsonb_object_keys(r) k));
  perform pg_temp.expect('overview on a trial: manual, trialing, enabled, no card, no invoice, no request',
    'manual trialing true false <null> <null> <null> <null>',
    (r #>> '{billing,rail}') || ' ' || (r #>> '{billing,status}') || ' ' || (r #>> '{billing,stripe_enabled}') || ' '
      || (r #>> '{billing,stripe_customer}') || ' ' || coalesce(r #>> '{billing,card}', '<null>') || ' '
      || coalesce(r #>> '{billing,last_invoice}', '<null>') || ' ' || coalesce(r #>> '{billing,pending_request_rail}', '<null>')
      || ' ' || coalesce(r #>> '{billing,next_charge_at}', '<null>'));

  -- 2. The merchant files a request; the edge function reads what to charge -------------------------
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid, 'base', 2, array[v_b1], v_code1, null);
  perform pg_temp.act_as(null);
  v_q1 := (r ->> 'id')::uuid;
  perform pg_temp.expect('the request is filed on the manual rail first', 'true pending manual',
    (r ->> 'ok') || ' ' || (r ->> 'status') || ' ' || (r ->> 'rail'));
  perform pg_temp.expect('its code is reserved', 'reserved',
    (select string_agg(status, ',') from public.billing_discount_redemptions where request_id = v_q1));

  perform pg_temp.act_as(v_owner);
  r := public.billing_checkout_context(v_q1);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('context: keys', 'charges,monthly_lines,ok,request,restaurant,stripe_managed,subscription',
    (select string_agg(k, ',' order by k) from jsonb_object_keys(r) k));
  perform pg_temp.expect('context: monthly lines in cents', 'base:1:2900,extra_branch:1:2900,delivery:1:3000',
    (select string_agg((e ->> 'code') || ':' || (e ->> 'quantity') || ':' || (e ->> 'unit_amount_cents'), ',' order by ord)
       from jsonb_array_elements(r -> 'monthly_lines') with ordinality as t(e, ord)));
  perform pg_temp.expect('context: the one-time charges add up to the request, net of the code, $0 lines left out',
    'true 2',
    ((select sum((e ->> 'net_amount')::numeric) from jsonb_array_elements(r -> 'charges') e)
       = (r #>> '{request,one_time_total}')::numeric)::text || ' ' || jsonb_array_length(r -> 'charges'));
  perform pg_temp.expect('context: the restaurant, its owner and the trial',
    'false trialing trial <null> true',
    (r ->> 'stripe_managed') || ' ' || (r #>> '{subscription,status}') || ' ' || (r #>> '{subscription,plan_code}') || ' '
      || coalesce(r #>> '{restaurant,stripe_customer_id}', '<null>') || ' '
      || ((r #>> '{restaurant,owner_email}') like 'billing-test-owner-%')::text);
  perform pg_temp.expect('context: a stranger is refused', 'ok {"ok": false, "error": "forbidden"}',
    pg_temp.try_as(v_stranger, array[format('select public.billing_checkout_context(%L)::text', v_q1)]));
  perform pg_temp.expect('context: an unknown request answers the same', '{"ok": false, "error": "forbidden"}',
    (select public.billing_checkout_context(gen_random_uuid())::text));
  perform pg_temp.expect('context: anon cannot call it at all', 'ERR permission denied for function%',
    pg_temp.try_as(null, array[format('select public.billing_checkout_context(%L)::text', v_q1)]));

  perform pg_temp.act_as(v_owner);
  r := public.billing_branch_context(v_b1);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('branch context: the owner may manage it', 'true true false',
    (r ->> 'ok') || ' ' || (r ->> 'can_manage') || ' ' || (r ->> 'stripe_managed'));
  perform pg_temp.expect('branch context: its restaurant', v_rid::text, r ->> 'restaurant_id');
  perform pg_temp.expect('branch context: a stranger may not, and learns no Stripe id', 'ok false false true',
    pg_temp.try_as(v_stranger, array[format(
      'select (r->>''can_manage'') || '' '' || (r->>''stripe_managed'') || '' '' || (r->''stripe_customer_id'' = ''null''::jsonb)::text from (select public.billing_branch_context(%L) r) x', v_b1)]));
  perform pg_temp.expect('branch context: an unknown branch', 'branch_not_found',
    public.billing_branch_context(gen_random_uuid()) ->> 'error');

  -- 3. The service role writes; nobody signed in can ------------------------------------------------
  perform pg_temp.expect('the owner cannot settle a request', 'ERR permission denied for function%',
    pg_temp.try_as(v_owner, array[format(
      'select public.billing_settle_stripe_request(%L, ''cus_X'', ''sub_X'', null, now(), ''[]'', null)::text', v_q1)]));
  perform pg_temp.expect('the owner cannot sync a status', 'ERR permission denied for function%',
    pg_temp.try_as(v_owner, array['select public.billing_sync_stripe_status(''sub_X'', ''active'', false, null, null, null)::text']));
  perform pg_temp.expect('the owner cannot record an invoice', 'ERR permission denied for function%',
    pg_temp.try_as(v_owner, array['select public.billing_record_stripe_invoice(''{}''::jsonb, now())::text']));
  perform pg_temp.expect('the owner cannot mark a request as paid by card', 'ERR permission denied for function%',
    pg_temp.try_as(v_owner, array[format('select public.billing_mark_request_stripe(%L, ''cs_X'', null)::text', v_q1)]));
  perform pg_temp.expect('the owner cannot read the invoice table', 'ERR permission denied%',
    pg_temp.try_as(v_owner, array['select count(*)::text from public.billing_invoices']));
  perform pg_temp.expect('a platform admin cannot store a Stripe customer', 'ERR permission denied for function%',
    pg_temp.try_as(v_admin, array['select public.billing_set_stripe_customer(gen_random_uuid(), ''cus_X'')::text'], true));

  perform public.billing_set_stripe_customer(v_rid, 'cus_TESTPBS1');
  perform pg_temp.expect('the customer is stored in billing_stripe_customers and on its trial row, never on the restaurant (§9.7)',
    'cus_TESTPBS1 cus_TESTPBS1 <null>',
    (select c.stripe_customer_id || ' ' || s.stripe_customer_id || ' ' || coalesce(r2.stripe_customer_id, '<null>')
       from public.restaurants r2 join public.subscriptions s on s.restaurant_id = r2.id
       join public.billing_stripe_customers c on c.restaurant_id = r2.id where r2.id = v_rid));
  perform pg_temp.expect('a malformed customer id is refused', 'ERR invalid_customer_id',
    pg_temp.try_service(array[format('select public.billing_set_stripe_customer(%L, ''acct_1'')::text', v_rid)]));
  perform pg_temp.expect('the owner cannot point the restaurant at another Stripe customer', 'ERR restaurant_privileged_column_denied',
    pg_temp.try_as(v_owner, array[format(
      'update public.restaurants set stripe_customer_id = ''cus_SOMEONEELSE'' where id = %L returning 1', v_rid)]));
  perform pg_temp.expect('nor can a platform admin', 'ERR restaurant_privileged_column_denied',
    pg_temp.try_as(v_admin, array[format(
      'update public.restaurants set stripe_customer_id = ''cus_SOMEONEELSE'' where id = %L returning 1', v_rid)], true));
  perform pg_temp.expect('the owner still renames their restaurant', 'ok 1',
    pg_temp.try_as(v_owner, array[format(
      'update public.restaurants set name = ''ZZ Renamed'' where id = %L returning 1', v_rid)]));

  perform public.billing_mark_request_stripe(v_q1, 'cs_test_PBS1', null);
  perform pg_temp.expect('the request is now being paid by card', 'stripe cs_test_PBS1 pending',
    (select rail || ' ' || stripe_checkout_session_id || ' ' || status from public.billing_requests where id = v_q1));
  perform pg_temp.act_as(v_owner);
  perform pg_temp.expect('overview: the pending request waits for the card', 'stripe',
    public.get_billing_overview(v_rid) #>> '{billing,pending_request_rail}');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('an operator cannot approve a request awaiting card payment', 'ERR stripe_managed',
    pg_temp.try_as(v_admin, array[format('select public.decide_billing_request(%L, true, null)::text', v_q1)], true));
  perform pg_temp.expect('but can reject it', 'ok%',
    pg_temp.try_as(v_admin, array[format('select public.decide_billing_request(%L, false, ''abandoned'')::text', v_q1)], true));

  -- 4. A first purchase settles: trial -> active, paid through the anchor ---------------------------
  v_items := jsonb_build_array(
    jsonb_build_object('product_code', 'base', 'stripe_subscription_item_id', 'si_TESTBASE'),
    jsonb_build_object('product_code', 'extra_branch', 'stripe_subscription_item_id', 'si_TESTSEAT'),
    jsonb_build_object('product_code', 'delivery', 'stripe_subscription_item_id', 'si_TESTDEL'));
  r := public.billing_settle_stripe_request(v_q1, 'cus_TESTPBS1', 'sub_TESTPBS1', 'in_TESTFIRST', v_trial_end, v_items,
         jsonb_build_object('brand', 'visa', 'last4', '4242', 'exp_month', 12, 'exp_year', 2030));
  v_x := v_trial_end;
  perform pg_temp.expect('settle: a first purchase', 'true false first_purchase',
    (r ->> 'ok') || ' ' || (r ->> 'duplicate') || ' ' || (r ->> 'kind'));
  perform pg_temp.expect('settle: active on the base, the trial over, paid through the first charge date',
    'active base <null> true true',
    (select s.status || ' ' || s.plan_code || ' ' || coalesce(s.trial_ends_at::text, '<null>') || ' '
            || (s.current_period_end = v_x) || ' ' || (s.next_billing_at = v_x)
       from public.subscriptions s where s.restaurant_id = v_rid));
  perform pg_temp.expect('settle: Stripe ids, card (in billing_stripe_customers, §9.7), no grace, not cancelling',
    'cus_TESTPBS1 sub_TESTPBS1 visa 4242 12/2030 <null> false',
    (select s.stripe_customer_id || ' ' || s.stripe_subscription_id || ' ' || c.card_brand || ' ' || c.card_last4 || ' '
            || c.card_exp_month || '/' || c.card_exp_year || ' ' || coalesce(s.grace_until::text, '<null>') || ' ' || s.cancel_at_period_end
       from public.subscriptions s join public.billing_stripe_customers c on c.restaurant_id = s.restaurant_id
      where s.restaurant_id = v_rid));
  perform pg_temp.expect('settle: entitled through the anchor plus the renewal slack (§9.1), at $29 + $29 + $30', 'active true 88.00 2',
    (select be.status || ' ' || (be.entitled_through = v_x + interval '7 days') || ' ' || be.monthly_total || ' ' || be.branch_seats
       from public.billing_entitlements be where be.restaurant_id = v_rid));
  perform pg_temp.expect('settle: every charge of the request paid by that invoice', 'paid:in_TESTFIRST:3',
    (select string_agg(distinct status || ':' || coalesce(stripe_invoice_id, '-'), ',') || ':' || count(*)
       from public.billing_charges where request_id = v_q1));
  perform pg_temp.expect('settle: the code is redeemed', 'redeemed',
    (select string_agg(status, ',') from public.billing_discount_redemptions where request_id = v_q1));
  perform pg_temp.expect('settle: the request is approved, paid by card', 'approved stripe Paid by card (Stripe) true in_TESTFIRST',
    (select status || ' ' || rail || ' ' || decision_note || ' ' || (paid_at is not null) || ' ' || stripe_invoice_id
       from public.billing_requests where id = v_q1));
  perform pg_temp.expect('settle: Stripe''s item ids are on the lines', 'base:si_TESTBASE,delivery:si_TESTDEL,extra_branch:si_TESTSEAT',
    (select string_agg(si.product_code || ':' || si.stripe_subscription_item_id, ',' order by si.product_code)
       from public.subscription_items si join public.subscriptions s on s.id = si.subscription_id
      where s.restaurant_id = v_rid));
  perform pg_temp.expect('settle: the chosen branch delivers, the other does not', 'true false',
    private.branch_feature_granted(v_b1, 'delivery')::text || ' ' || private.branch_feature_granted(v_b2, 'delivery')::text);
  perform pg_temp.expect('settle: logged', '1',
    (select count(*)::text from public.billing_events where restaurant_id = v_rid and type = 'stripe.request_settled'));
  perform pg_temp.expect('now on the Stripe rail', 'true', private.billing_is_stripe_managed(v_rid)::text);

  perform pg_temp.act_as(v_owner);
  r := public.get_billing_overview(v_rid);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('overview on the Stripe rail: rail, status, customer, next charge, amount, card',
    'stripe active true true 88.00 visa 4242 12 2030 <null>',
    (r #>> '{billing,rail}') || ' ' || (r #>> '{billing,status}') || ' ' || (r #>> '{billing,stripe_customer}') || ' '
      || ((r #>> '{billing,next_charge_at}')::timestamptz = v_x)::text || ' ' || (r #>> '{billing,next_charge_amount}') || ' '
      || (r #>> '{billing,card,brand}') || ' ' || (r #>> '{billing,card,last4}') || ' ' || (r #>> '{billing,card,exp_month}') || ' '
      || (r #>> '{billing,card,exp_year}') || ' ' || coalesce(r #>> '{billing,pending_request_rail}', '<null>'));
  perform pg_temp.expect('overview: the paid ledger now holds the base and the seat', 'true 2',
    (r #>> '{paid,base_paid}') || ' ' || (r #>> '{paid,seats_paid}'));

  perform pg_temp.act_as(v_owner);
  r := public.billing_branch_context(v_b2);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('branch context once paying: the ids and the rail', 'cus_TESTPBS1 sub_TESTPBS1 true',
    (r ->> 'stripe_customer_id') || ' ' || (r ->> 'stripe_subscription_id') || ' ' || (r ->> 'stripe_managed'));
  perform pg_temp.expect('context of a settled request: not pending any more', 'ok false request_not_pending approved',
    pg_temp.try_as(v_owner, array[format(
      'select (r->>''ok'') || '' '' || (r->>''error'') || '' '' || (r->>''status'') from (select public.billing_checkout_context(%L) r) x', v_q1)]))
    ;

  -- 5. The same payment told twice -------------------------------------------------------------------
  r := public.billing_settle_stripe_request(v_q1, 'cus_TESTPBS1', 'sub_TESTPBS1', 'in_TESTFIRST', v_trial_end, v_items, null);
  perform pg_temp.expect('duplicate settle: answered as a duplicate', 'true true', (r ->> 'ok') || ' ' || (r ->> 'duplicate'));
  perform pg_temp.expect('duplicate settle: nothing moved', '1 true',
    (select count(*)::text from public.billing_events where restaurant_id = v_rid and type = 'stripe.request_settled')
      || ' ' || (select (current_period_end = v_x)::text from public.subscriptions where restaurant_id = v_rid));

  -- 6. A stale checkout: the merchant replaced the request, then the old tab was paid --------------
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid, 'base', 2, array[v_b1, v_b2], null, null);
  v_q2 := (r ->> 'id')::uuid;
  r := public.request_package_change(v_rid, 'base', 2, array[v_b1, v_b2], null, null);
  v_q3 := (r ->> 'id')::uuid;
  perform pg_temp.act_as(null);
  perform pg_temp.expect('the first of the two was superseded', 'cancelled', (select status from public.billing_requests where id = v_q2));
  r := public.billing_settle_stripe_request(v_q2, 'cus_TESTPBS1', 'sub_TESTPBS1', 'in_TESTSTALE', v_x, '[]'::jsonb, null);
  perform pg_temp.expect('stale settle: refused so the caller refunds it', 'false request_not_pending cancelled',
    (r ->> 'ok') || ' ' || (r ->> 'reason') || ' ' || (r ->> 'status'));
  perform pg_temp.expect('stale settle: the superseded request stays cancelled, its charges void', 'cancelled void',
    (select br.status || ' ' || coalesce((select string_agg(distinct c.status, ',') from public.billing_charges c where c.request_id = br.id), 'void')
       from public.billing_requests br where br.id = v_q2));
  r := public.billing_settle_stripe_request(v_q1, 'cus_TESTPBS1', 'sub_TESTPBS1', 'in_TESTSECOND', v_trial_end, v_items, null);
  perform pg_temp.expect('a second, different payment for a settled request is refused too', 'false request_not_pending approved',
    (r ->> 'ok') || ' ' || (r ->> 'reason') || ' ' || (r ->> 'status'));

  -- 7. A change on the existing subscription keeps the period -------------------------------------------
  select current_period_start into v_start from public.subscriptions where restaurant_id = v_rid;
  perform pg_temp.act_as(v_owner);
  r := public.billing_checkout_context(v_q3);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('change context: Stripe-managed, the subscription and its items', 'true sub_TESTPBS1 3 base:1:2900,extra_branch:1:2900,delivery:2:3000',
    (r ->> 'stripe_managed') || ' ' || (r #>> '{subscription,stripe_subscription_id}') || ' '
      || jsonb_array_length(r #> '{subscription,items}') || ' '
      || (select string_agg((e ->> 'code') || ':' || (e ->> 'quantity') || ':' || (e ->> 'unit_amount_cents'), ',' order by ord)
            from jsonb_array_elements(r -> 'monthly_lines') with ordinality as t(e, ord)));
  perform public.billing_mark_request_stripe(v_q3, null, 'in_TESTCHG');
  perform pg_temp.expect('the change waits on its invoice', 'true', (public.billing_request_for_invoice('in_TESTCHG') = v_q3)::text);
  perform pg_temp.expect('an unknown invoice matches no request', '<null>',
    coalesce(public.billing_request_for_invoice('in_TESTNOTHING')::text, '<null>'));
  r := public.billing_settle_stripe_request(v_q3, 'cus_TESTPBS1', 'sub_TESTPBS1', 'in_TESTCHG', v_x + interval '1 month',
         jsonb_build_array(jsonb_build_object('product_code', 'delivery', 'stripe_subscription_item_id', 'si_TESTDEL2')), null);
  perform pg_temp.expect('change settle: a change', 'true change', (r ->> 'ok') || ' ' || (r ->> 'kind'));
  perform pg_temp.expect('change settle: the period is kept', 'true true active',
    (select (current_period_end = v_x)::text || ' ' || (current_period_start = v_start)::text || ' ' || status
       from public.subscriptions where restaurant_id = v_rid));
  perform pg_temp.expect('change settle: both branches deliver, $29 x 2 + $30 x 2', 'true true 118.00',
    private.branch_feature_granted(v_b1, 'delivery')::text || ' ' || private.branch_feature_granted(v_b2, 'delivery')::text
      || ' ' || (select monthly_total::text from public.billing_entitlements where restaurant_id = v_rid));
  perform pg_temp.expect('change settle: the delivery line has its new item id, the card is unchanged', 'si_TESTDEL2 4242',
    (select si.stripe_subscription_item_id || ' ' || c.card_last4 from public.subscription_items si
       join public.subscriptions s on s.id = si.subscription_id
       join public.billing_stripe_customers c on c.restaurant_id = s.restaurant_id
      where s.restaurant_id = v_rid and si.product_code = 'delivery'));
  perform pg_temp.expect('change settle: approved, and still found from its invoice whatever its status (§9.3)', 'approved true',
    (select status from public.billing_requests where id = v_q3) || ' '
      || (public.billing_request_for_invoice('in_TESTCHG') = v_q3)::text);
  r := public.billing_settle_stripe_request(v_q3, 'cus_TESTPBS1', 'sub_TESTPBS1', 'in_TESTCHG', v_x, '[]'::jsonb, null);
  perform pg_temp.expect('change settle told twice: a duplicate', 'true true', (r ->> 'ok') || ' ' || (r ->> 'duplicate'));

  -- 8. A change that will never be paid is cancelled --------------------------------------------------
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid, 'base', 3, array[v_b1, v_b2], v_code2, null);
  perform pg_temp.act_as(null);
  v_q4 := (r ->> 'id')::uuid;
  perform public.billing_mark_request_stripe(v_q4, null, 'in_TESTEXPIRED', 'https://invoice.stripe.com/i/in_TESTEXPIRED');
  perform pg_temp.expect('fixture: the third seat is on order, with a code', 'pending reserved 1',
    (select string_agg(distinct c.status, ',') from public.billing_charges c where c.request_id = v_q4) || ' '
      || (select string_agg(status, ',') from public.billing_discount_redemptions where request_id = v_q4) || ' '
      || (select redemption_count from public.billing_discount_codes where code = v_code2));

  -- §9.3: while the change waits on its invoice it can be neither replaced nor rejected.
  perform pg_temp.act_as(v_owner);
  r := public.get_billing_overview(v_rid);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('overview: the change waits on Stripe''s invoice page',
    'stripe https://invoice.stripe.com/i/in_TESTEXPIRED https://invoice.stripe.com/i/in_TESTEXPIRED',
    (r #>> '{billing,pending_request_rail}') || ' ' || (r #>> '{billing,pending_invoice_url}') || ' '
      || (r #>> '{pending_request,stripe_invoice_url}'));
  perform pg_temp.expect('payment in progress: the merchant cannot replace the change (money-sql-1)', 'ERR payment_in_progress',
    pg_temp.try_as(v_owner, array[format(
      'select public.request_package_change(%L, ''base'', 2, ''{}''::uuid[], null, null)::text', v_rid)]));
  perform pg_temp.expect('payment in progress: nor can an operator reject it', 'ERR payment_in_progress',
    pg_temp.try_as(v_admin, array[format('select public.decide_billing_request(%L, false, ''no'')::text', v_q4)], true));
  perform pg_temp.expect('payment in progress: the change is untouched', 'pending pending reserved',
    (select status from public.billing_requests where id = v_q4) || ' '
      || (select string_agg(distinct c.status, ',') from public.billing_charges c where c.request_id = v_q4) || ' '
      || (select string_agg(status, ',') from public.billing_discount_redemptions where request_id = v_q4));
  perform pg_temp.expect('an invoice page that is not https is refused', 'ERR invalid_invoice_url',
    pg_temp.try_service(array[format(
      'select public.billing_mark_request_stripe(%L, null, ''in_TESTEXPIRED'', ''http://invoice.example/x'')::text', v_q4)]));
  perform pg_temp.expect('a checkout keeps no invoice page', 'ok <null>',
    pg_temp.try_service(array[format(
      'select public.billing_mark_request_stripe(%L, ''cs_test_PBS4'', null, ''https://invoice.stripe.com/i/x'')::text', v_q4),
      format('select coalesce(stripe_invoice_url, ''<null>'') from public.billing_requests where id = %L', v_q4)]));
  perform public.billing_cancel_stripe_request(v_q4, 'pending_update_expired');
  perform pg_temp.expect('cancel: the request is cancelled, its charges void, its code given back', 'cancelled pending_update_expired void 0 0',
    (select status || ' ' || decision_note from public.billing_requests where id = v_q4) || ' '
      || (select string_agg(distinct c.status, ',') from public.billing_charges c where c.request_id = v_q4) || ' '
      || (select count(*) from public.billing_discount_redemptions where request_id = v_q4) || ' '
      || (select redemption_count from public.billing_discount_codes where code = v_code2));
  perform pg_temp.expect('a cancelled change is still found from its invoice, so a late payment is refunded (§9.3)', 'true',
    (public.billing_request_for_invoice('in_TESTEXPIRED') = v_q4)::text);
  perform pg_temp.expect('once it is cancelled the merchant may file again', 'ok true',
    pg_temp.try_as(v_owner, array[format(
      'select public.request_package_change(%L, ''base'', 2, ''{}''::uuid[], null, null) ->> ''ok''', v_rid)]));
  perform public.billing_cancel_stripe_request(v_q4, 'again');
  perform pg_temp.expect('cancel: a second cancel is a no-op', 'cancelled pending_update_expired',
    (select status || ' ' || decision_note from public.billing_requests where id = v_q4));
  perform public.billing_cancel_stripe_request(v_q1, 'too late');
  perform pg_temp.expect('cancel: a settled request is left alone', 'approved paid',
    (select status from public.billing_requests where id = v_q1) || ' '
      || (select string_agg(distinct status, ',') from public.billing_charges where request_id = v_q1));
  perform pg_temp.expect('cancel: a stale mark is refused', 'ERR request_not_pending',
    pg_temp.try_service(array[format('select public.billing_mark_request_stripe(%L, ''cs_test_LATE'', null)::text', v_q4)]));

  -- 9. Guards: manual controls refuse a Stripe restaurant ---------------------------------------------
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid, 'base', 2, array[v_b1], null, null);
  perform pg_temp.act_as(null);
  v_q5 := (r ->> 'id')::uuid;
  perform pg_temp.expect('guard: approving a manual request of a Stripe restaurant', 'ERR stripe_managed',
    pg_temp.try_as(v_admin, array[format('select public.decide_billing_request(%L, true, null)::text', v_q5)], true));
  perform pg_temp.expect('guard: rejecting it still works', 'ok true false',
    pg_temp.try_as(v_admin, array[format(
      'select (x->>''ok'') || '' '' || (x->>''approved'') from (select public.decide_billing_request(%L, false, ''no'') x) y', v_q5)], true));
  perform pg_temp.expect('guard: billing_set_package on a Stripe restaurant', 'ERR stripe_managed',
    pg_temp.try_as(v_admin, array[format(
      'select public.billing_set_package(%L, ''base'', 2, ''{}''::uuid[], ''active'', null)::text', v_rid)], true));
  perform pg_temp.expect('guard: feature switches still work', 'ok true',
    pg_temp.try_as(v_admin, array[format(
      'select (public.platform_set_feature_override(%L, ''digital_signage'', ''off'') ->> ''ok'')', v_rid)], true));
  perform pg_temp.act_as(v_owner);
  perform pg_temp.expect('overview: a manual request of a Stripe restaurant', 'manual',
    public.get_billing_overview(v_rid) #>> '{billing,pending_request_rail}');
  perform pg_temp.act_as(null);

  -- 10. Platform payloads -------------------------------------------------------------------------------
  perform pg_temp.expect('list_restaurant_subscriptions: keys of a row',
    'ok billing,created_at,entitlements,feature_overrides,open_invoice,restaurant_id,restaurant_name,restaurant_slug,stripe_customer_id,stripe_subscription_id',
    pg_temp.try_as(v_admin, array[format(
      'select string_agg(k, '','' order by k) from jsonb_array_elements(public.list_restaurant_subscriptions()) e, jsonb_object_keys(e) k where e->>''restaurant_id'' = %L', v_rid)], true));
  perform pg_temp.expect('list_restaurant_subscriptions: the rail, the ids, no open invoice while active',
    'ok stripe cus_TESTPBS1 sub_TESTPBS1 null 13',
    pg_temp.try_as(v_admin, array[format(
      'select (e#>>''{billing,rail}'') || '' '' || (e->>''stripe_customer_id'') || '' '' || (e->>''stripe_subscription_id'') || '' '' || (e->''open_invoice'')::text || '' '' || (select count(*) from jsonb_object_keys(e->''billing'')) from jsonb_array_elements(public.list_restaurant_subscriptions()) e where e->>''restaurant_id'' = %L', v_rid)], true));
  perform pg_temp.expect('list_restaurant_subscriptions: a merchant is refused', 'ERR forbidden',
    pg_temp.try_as(v_owner, array['select public.list_restaurant_subscriptions()::text']));
  perform pg_temp.expect('list_billing_requests: rows carry the rail, the session and paid_at', 'ok stripe cs_test_PBS1 true',
    pg_temp.try_as(v_admin, array[format(
      'select (e->>''rail'') || '' '' || (e->>''stripe_checkout_session_id'') || '' '' || (e->>''paid_at'' is not null)::text from jsonb_array_elements(public.list_billing_requests(null)) e where e->>''id'' = %L', v_q1)], true));
  perform pg_temp.expect('list_billing_requests: a manual request says manual', 'ok manual',
    pg_temp.try_as(v_admin, array[format(
      'select e->>''rail'' from jsonb_array_elements(public.list_billing_requests(null)) e where e->>''id'' = %L', v_q5)], true));

  insert into public.billing_events (type, level, note, restaurant_id)
  values ('account.updated', 'info', 'connect', v_rid), ('payment_intent.succeeded', 'info', 'connect', v_rid),
         ('stripe_connect.dispute_created', 'warn', 'connect', v_rid);
  perform pg_temp.expect('platform_billing_events: the settlements, no Connect event', 'ok 2 0',
    pg_temp.try_as(v_admin, array[format(
      'select count(*) filter (where e->>''type'' = ''stripe.request_settled'') || '' '' || count(*) filter (where e->>''note'' = ''connect'') from unnest(public.platform_billing_events(%L, 100)) e', v_rid)], true));
  perform pg_temp.expect('platform_billing_events: newest first, limited', 'ok 1',
    pg_temp.try_as(v_admin, array[format(
      'select cardinality(public.platform_billing_events(%L, 1))::text', v_rid)], true));
  perform pg_temp.expect('platform_billing_events: a merchant is refused', 'ERR forbidden',
    pg_temp.try_as(v_owner, array[format('select cardinality(public.platform_billing_events(%L, 10))::text', v_rid)]));

  -- 11. Status sync: every mapping, the grace in and out, and the date never moves -----------------
  r := public.billing_sync_stripe_status('sub_TESTNOBODY', 'active', false, null, null, null);
  perform pg_temp.expect('sync: a subscription nobody has', 'false unknown_subscription', (r ->> 'ok') || ' ' || (r ->> 'reason'));

  v_grace := v_x + interval '7 days';
  r := public.billing_sync_stripe_status('sub_TESTPBS1', 'past_due', false, null, v_x + interval '1 year', null);
  perform pg_temp.expect('sync past_due: past_due, grace = paid-through + 7 days, date kept', 'past_due true true',
    (select status || ' ' || (grace_until = v_grace) || ' ' || (current_period_end = v_x) from public.subscriptions where restaurant_id = v_rid));
  perform pg_temp.expect('sync past_due: entitled until the grace, the branches too', 'true true',
    (select (entitled_through = v_grace)::text from public.billing_entitlements where restaurant_id = v_rid) || ' '
      || (select bool_and(entitled_through = v_grace)::text from public.branches where restaurant_id = v_rid));
  perform pg_temp.expect('sync past_due: still on the Stripe rail', 'true', private.billing_is_stripe_managed(v_rid)::text);
  perform public.billing_sync_stripe_status('sub_TESTPBS1', 'unpaid', false, null, null, null);
  perform pg_temp.expect('sync unpaid: past_due, the grace is not extended', 'past_due true',
    (select status || ' ' || (grace_until = v_grace) from public.subscriptions where restaurant_id = v_rid));
  perform public.billing_sync_stripe_status('sub_TESTPBS1', 'incomplete', false, null, null, null);
  perform public.billing_sync_stripe_status('sub_TESTPBS1', 'incomplete_expired', false, null, null, null);
  perform pg_temp.expect('sync incomplete / incomplete_expired: unchanged', 'past_due true',
    (select status || ' ' || (grace_until = v_grace) from public.subscriptions where restaurant_id = v_rid));
  r := public.billing_sync_stripe_status('sub_TESTPBS1', 'canceled', false, null, null, null);
  perform pg_temp.expect('sync canceled during the grace: cancelled, the grace kept (D9)', 'cancelled true true',
    (select status || ' ' || (grace_until = v_grace) || ' ' || (cancelled_at is not null) from public.subscriptions where restaurant_id = v_rid));
  perform pg_temp.expect('sync canceled: entitled until the grace, off the Stripe rail', 'true false',
    (select (entitled_through = v_grace)::text from public.billing_entitlements where restaurant_id = v_rid) || ' '
      || private.billing_is_stripe_managed(v_rid)::text);
  perform public.billing_sync_stripe_status('sub_TESTPBS1', 'active', false, null, v_x, null);
  perform pg_temp.expect('sync active: active, the grace gone, entitled through the date plus the renewal slack (§9.1)', 'active <null> <null> true',
    (select status || ' ' || coalesce(grace_until::text, '<null>') || ' ' || coalesce(cancelled_at::text, '<null>')
            || ' ' || (select (entitled_through = v_x + interval '7 days')::text from public.billing_entitlements where restaurant_id = v_rid)
       from public.subscriptions where restaurant_id = v_rid));
  perform public.billing_sync_stripe_status('sub_TESTPBS1', 'trialing', false, null, v_x, null);
  perform pg_temp.expect('sync trialing: active in our records', 'active', (select status::text from public.subscriptions where restaurant_id = v_rid));
  perform public.billing_sync_stripe_status('sub_TESTPBS1', 'active', true, v_x, null,
    jsonb_build_object('brand', 'mastercard', 'last4', '5555', 'exp_month', 3, 'exp_year', 2029));
  perform pg_temp.expect('sync cancel_at_period_end: flagged, card updated, still Stripe-managed', 'active true true mastercard 5555 3/2029 true',
    (select s.status || ' ' || s.cancel_at_period_end || ' ' || (s.cancel_at = v_x) || ' ' || c.card_brand || ' ' || c.card_last4 || ' '
            || c.card_exp_month || '/' || c.card_exp_year || ' ' || private.billing_is_stripe_managed(v_rid)
       from public.subscriptions s join public.billing_stripe_customers c on c.restaurant_id = s.restaurant_id
      where s.restaurant_id = v_rid));
  perform pg_temp.act_as(v_owner);
  r := public.get_billing_overview(v_rid);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('overview while cancelling: no next charge, the flag and the date', '<null> true true',
    coalesce(r #>> '{billing,next_charge_at}', '<null>') || ' ' || (r #>> '{billing,cancel_at_period_end}') || ' '
      || ((r #>> '{billing,cancel_at}')::timestamptz = v_x)::text);
  perform public.billing_sync_stripe_status('sub_TESTPBS1', null, null, null, null,
    jsonb_build_object('brand', 'visa', 'last4', '4242', 'exp_month', 1, 'exp_year', 2031));
  perform pg_temp.expect('sync with only a card: the card, nothing else', 'active true visa 4242 1/2031',
    (select s.status || ' ' || s.cancel_at_period_end || ' ' || c.card_brand || ' ' || c.card_last4 || ' ' || c.card_exp_month || '/' || c.card_exp_year
       from public.subscriptions s join public.billing_stripe_customers c on c.restaurant_id = s.restaurant_id
      where s.restaurant_id = v_rid));
  perform public.billing_sync_stripe_status('sub_TESTPBS1', 'active', false, null, v_x, jsonb_build_object('brand', 'visa'));
  perform pg_temp.expect('sync un-cancel: flag and date cleared, a malformed card ignored', 'false <null> 4242',
    (select s.cancel_at_period_end || ' ' || coalesce(s.cancel_at::text, '<null>') || ' ' || c.card_last4
       from public.subscriptions s join public.billing_stripe_customers c on c.restaurant_id = s.restaurant_id
      where s.restaurant_id = v_rid));
  perform public.billing_sync_stripe_status('sub_TESTPBS1', 'paused', false, null, null, null);
  perform pg_temp.expect('sync paused: expired, nothing entitled', 'expired <null>',
    (select s.status || ' ' || coalesce(be.entitled_through::text, '<null>')
       from public.subscriptions s join public.billing_entitlements be on be.restaurant_id = s.restaurant_id where s.restaurant_id = v_rid));
  perform public.billing_sync_stripe_status('sub_TESTPBS1', 'past_due', false, null, null, null);
  perform public.billing_sync_stripe_status('sub_TESTPBS1', 'canceled', false, null, null, null);
  perform pg_temp.expect('sync on an expired row: past_due and canceled do not relabel it', 'expired <null>',
    (select status || ' ' || coalesce(grace_until::text, '<null>') from public.subscriptions where restaurant_id = v_rid));
  perform public.billing_sync_stripe_status('sub_TESTPBS1', 'active', false, null, v_x, null);
  perform pg_temp.expect('sync active again: active', 'active', (select status::text from public.subscriptions where restaurant_id = v_rid));
  perform pg_temp.expect('sync never moved the paid-through date', 'true',
    (select (current_period_end = v_x)::text from public.subscriptions where restaurant_id = v_rid));
  perform pg_temp.expect('sync logged each status change, and only those', '5',
    (select count(*)::text from public.billing_events where restaurant_id = v_rid and type = 'stripe.status_changed'));

  -- 12. A paid invoice moves the date forward, only forward ------------------------------------------
  r := public.billing_record_stripe_invoice(
         pg_temp.invoice('in_TESTRENEW1', 'sub_TESTPBS1', 'subscription_cycle', 'paid', 11800, 1, v_x + interval '1 month'),
         v_x + interval '1 month');
  perform pg_temp.expect('invoice paid: applied', 'true true', (r ->> 'ok') || ' ' || (r ->> 'applied'));
  perform pg_temp.expect('invoice paid: paid through the new period, next charge then', 'true true active',
    (select (current_period_end = v_x + interval '1 month') || ' ' || (next_billing_at = v_x + interval '1 month') || ' ' || status
       from public.subscriptions where restaurant_id = v_rid));
  perform pg_temp.expect('invoice paid: recorded in dollars with its period and link', 'paid 118.00 118.00 subscription_cycle true true 1',
    (select status || ' ' || amount_due || ' ' || amount_paid || ' ' || billing_reason || ' '
            || (abs(extract(epoch from period_end - (v_x + interval '1 month'))) < 1) || ' ' || (paid_at is not null) || ' ' || attempt_count
       from public.billing_invoices where stripe_invoice_id = 'in_TESTRENEW1'));
  r := public.billing_record_stripe_invoice(
         pg_temp.invoice('in_TESTRENEW1', 'sub_TESTPBS1', 'subscription_cycle', 'paid', 11800, 1, v_x), v_x);
  perform pg_temp.expect('invoice paid with an older date: the date stays', 'true',
    (select (current_period_end = v_x + interval '1 month')::text from public.subscriptions where restaurant_id = v_rid));
  r := public.billing_record_stripe_invoice(
         pg_temp.invoice('in_TESTOLDSUB', 'sub_TESTOLD', 'subscription_cycle', 'paid', 2900, 1, v_x + interval '6 months'),
         v_x + interval '6 months');
  perform pg_temp.expect('invoice of a subscription the restaurant left: recorded by the customer, not applied', 'true false true',
    (r ->> 'ok') || ' ' || (r ->> 'applied') || ' '
      || (select (current_period_end = v_x + interval '1 month')::text from public.subscriptions where restaurant_id = v_rid));
  r := public.billing_record_stripe_invoice(
         pg_temp.invoice('in_TESTNOBODY', 'sub_TESTNOBODY', 'subscription_cycle', 'paid', 2900, 1, v_x) || '{"customer": "cus_TESTNOBODY"}'::jsonb,
         v_x);
  perform pg_temp.expect('invoice of nobody we know', 'false unknown_customer', (r ->> 'ok') || ' ' || (r ->> 'reason'));

  -- 13. A failed renewal starts the grace, once ----------------------------------------------------------
  v_x := v_x + interval '1 month';
  v_grace := v_x + interval '7 days';
  r := public.billing_record_stripe_invoice_failed(
         (pg_temp.invoice('in_TESTFAIL1', null, 'subscription_cycle', 'open', 11800, 1, v_x + interval '1 month') - 'subscription')
         || jsonb_build_object('parent', jsonb_build_object('subscription_details', jsonb_build_object('subscription', 'sub_TESTPBS1'))));
  perform pg_temp.expect('invoice failed (basil shape): past_due with the grace', 'true true past_due true',
    (r ->> 'ok') || ' ' || (r ->> 'past_due') || ' '
      || (select status || ' ' || (grace_until = v_grace) from public.subscriptions where restaurant_id = v_rid));
  r := public.billing_record_stripe_invoice_failed(
         pg_temp.invoice('in_TESTFAIL1', 'sub_TESTPBS1', 'subscription_cycle', 'open', 11800, 2, v_x + interval '1 month'));
  perform pg_temp.expect('invoice failed again: the grace is not extended, the attempts counted', 'past_due true open 2 true',
    (select s.status || ' ' || (s.grace_until = v_grace) from public.subscriptions s where s.restaurant_id = v_rid) || ' '
      || (select bi.status || ' ' || bi.attempt_count || ' ' || (s.current_period_end = v_x)
            from public.billing_invoices bi, public.subscriptions s
           where bi.stripe_invoice_id = 'in_TESTFAIL1' and s.restaurant_id = v_rid));
  perform pg_temp.expect('the platform sees what Stripe is still trying to collect', 'ok 118.00 2 open subscription_cycle true',
    pg_temp.try_as(v_admin, array[format(
      'select (e#>>''{open_invoice,amount_due}'') || '' '' || (e#>>''{open_invoice,attempt_count}'') || '' '' || (e#>>''{open_invoice,status}'') || '' '' || (e#>>''{open_invoice,billing_reason}'') || '' '' || (e#>>''{open_invoice,hosted_invoice_url}'' like ''https://invoice.stripe.com/%%'')::text from jsonb_array_elements(public.list_restaurant_subscriptions()) e where e->>''restaurant_id'' = %L', v_rid)], true));
  -- Every invoice here was written at the same now(); the older ones are made older, as they are.
  update public.billing_invoices set created_at = created_at - interval '1 hour'
   where restaurant_id = v_rid and stripe_invoice_id <> 'in_TESTFAIL1';
  perform pg_temp.act_as(v_owner);
  r := public.get_billing_overview(v_rid);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('overview while past due: the rail, the status, the grace, the last PAID invoice of this subscription (§9.8)',
    'stripe past_due true paid 1',
    (r #>> '{billing,rail}') || ' ' || (r #>> '{billing,status}') || ' '
      || ((r #>> '{billing,grace_until}')::timestamptz = v_grace)::text || ' '
      || (r #>> '{billing,last_invoice,status}') || ' ' || (r #>> '{billing,last_invoice,attempt_count}'));
  perform pg_temp.expect('overview: the last invoice has every parsed key', 'amount_due,amount_paid,attempt_count,billing_reason,hosted_invoice_url,paid_at,status',
    (select string_agg(k, ',' order by k) from jsonb_object_keys(r #> '{billing,last_invoice}') k));

  r := public.billing_record_stripe_invoice(
         pg_temp.invoice('in_TESTFAIL1', 'sub_TESTPBS1', 'subscription_cycle', 'paid', 11800, 3, v_x + interval '1 month'),
         v_x + interval '1 month');
  perform pg_temp.expect('a retry succeeds: active, the grace over, paid through the next month', 'active <null> true paid',
    (select status || ' ' || coalesce(grace_until::text, '<null>') || ' ' || (current_period_end = v_x + interval '1 month')
       from public.subscriptions where restaurant_id = v_rid) || ' '
      || (select status from public.billing_invoices where stripe_invoice_id = 'in_TESTFAIL1'));
  r := public.billing_record_stripe_invoice_failed(
         pg_temp.invoice('in_TESTFAIL1', 'sub_TESTPBS1', 'subscription_cycle', 'open', 11800, 3, v_x + interval '1 month'));
  perform pg_temp.expect('a late failure event after the payment changes nothing', 'false paid active',
    (r ->> 'past_due') || ' ' || (select status from public.billing_invoices where stripe_invoice_id = 'in_TESTFAIL1') || ' '
      || (select status::text from public.subscriptions where restaurant_id = v_rid));
  r := public.billing_record_stripe_invoice_failed(
         pg_temp.invoice('in_TESTUPDFAIL', 'sub_TESTPBS1', 'subscription_update', 'open', 7000, 1, v_x + interval '1 month'));
  perform pg_temp.expect('a failed CHANGE does not make the restaurant past due', 'false active',
    (r ->> 'past_due') || ' ' || (select status::text from public.subscriptions where restaurant_id = v_rid));
  perform pg_temp.expect('no open invoice shown once it is paid up', 'ok null',
    pg_temp.try_as(v_admin, array[format(
      'select (e->''open_invoice'')::text from jsonb_array_elements(public.list_restaurant_subscriptions()) e where e->>''restaurant_id'' = %L', v_rid)], true));

  -- 14. The expiry tick honours the grace -----------------------------------------------------------------
  update public.subscriptions
     set status = 'past_due', current_period_end = now() - interval '1 day', grace_until = now() + interval '6 days'
   where restaurant_id = v_rid;
  perform private.billing_expire_tick();
  perform pg_temp.expect('tick: past its paid-through date but within the grace, it keeps working', 'past_due true true',
    (select s.status || ' ' || (be.entitled_through = now() + interval '6 days') || ' ' || private.restaurant_entitled(v_rid)
       from public.subscriptions s join public.billing_entitlements be on be.restaurant_id = s.restaurant_id where s.restaurant_id = v_rid));
  update public.subscriptions set status = 'cancelled' where restaurant_id = v_rid;
  perform private.billing_expire_tick();
  perform pg_temp.expect('tick: cancelled during the grace, it keeps working until the grace', 'cancelled true',
    (select status || ' ' || private.restaurant_entitled(v_rid) from public.subscriptions where restaurant_id = v_rid));
  -- On the Stripe rail the deadline is at least the period end plus the grace days (§9.1), so the
  -- grace that ends here is the one that follows a period end 8 days ago.
  update public.subscriptions
     set status = 'past_due', current_period_end = now() - interval '8 days', grace_until = now() - interval '1 day'
   where restaurant_id = v_rid;
  perform private.billing_expire_tick();
  perform pg_temp.expect('tick: the grace is over, it goes dark', 'expired <null> false',
    (select s.status || ' ' || coalesce(be.entitled_through::text, '<null>') || ' ' || private.restaurant_entitled(v_rid)
       from public.subscriptions s join public.billing_entitlements be on be.restaurant_id = s.restaurant_id where s.restaurant_id = v_rid));
  update public.subscriptions
     set status = 'active', current_period_end = now() - interval '1 hour', grace_until = null
   where restaurant_id = v_rid;
  perform private.billing_expire_tick();
  perform pg_temp.expect('tick: a card restaurant an hour past its period end keeps working -- Stripe charges the renewal after it (money-sql-5)',
    'active true true',
    (select s.status || ' ' || (be.entitled_through = s.current_period_end + interval '7 days') || ' ' || private.restaurant_entitled(v_rid)
       from public.subscriptions s join public.billing_entitlements be on be.restaurant_id = s.restaurant_id where s.restaurant_id = v_rid));
  update public.subscriptions set current_period_end = now() - interval '8 days' where restaurant_id = v_rid;
  perform private.billing_expire_tick();
  perform pg_temp.expect('tick: a card restaurant past its period end plus the grace days goes dark', 'expired',
    (select status::text from public.subscriptions where restaurant_id = v_rid));
  -- A manual row (no Stripe subscription) ignores a grace that is not its own.
  update public.subscriptions
     set status = 'active', stripe_subscription_id = null,
         current_period_end = now() - interval '1 minute', grace_until = now() + interval '6 days'
   where restaurant_id = v_rid;
  perform private.billing_expire_tick();
  perform pg_temp.expect('tick: a MANUAL active row ignores a stale grace', 'expired',
    (select status::text from public.subscriptions where restaurant_id = v_rid));
  -- Put the ended subscription back: section 16 starts from a row that still carries it.
  update public.subscriptions set stripe_subscription_id = 'sub_TESTPBS1', grace_until = null where restaurant_id = v_rid;
  perform pg_temp.expect('the cron job is declared once, every 10 minutes', '1 */10 * * * * select private.billing_expire_tick()',
    (select count(*) || ' ' || min(schedule) || ' ' || min(command) from cron.job where jobname = 'billing-expire-tick'));

  -- 15. A settle the package no longer fits is logged, not retried; approvals and grants elsewhere --
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid2, 'base', 2, '{}'::uuid[], null, null);
  perform pg_temp.act_as(null);
  v_qr2 := (r ->> 'id')::uuid;
  perform public.billing_mark_request_stripe(v_qr2, 'cs_test_PBS2', null);
  perform pg_temp.expect('guard: approving a request awaiting card payment of a manual restaurant', 'ERR stripe_managed',
    pg_temp.try_as(v_admin, array[format('select public.decide_billing_request(%L, true, null)::text', v_qr2)], true));
  insert into public.branches (restaurant_id, slug, name) values (v_rid2, 'three', 'Second Three');
  r := public.billing_settle_stripe_request(v_qr2, 'cus_TESTPBS2', 'sub_TESTPBS2', 'in_TESTPBS2', now() + interval '1 month',
         '[]'::jsonb, null);
  perform pg_temp.expect('settle that no longer fits: answered, not raised', 'false settle_failed plan_limit_exceeded:branches:3/2',
    (r ->> 'ok') || ' ' || (r ->> 'reason') || ' ' || (r ->> 'detail'));
  perform pg_temp.expect('settle that no longer fits: nothing applied, the request still pending', 'trialing <null> pending pending',
    (select s.status || ' ' || coalesce(s.stripe_subscription_id, '<null>') from public.subscriptions s where s.restaurant_id = v_rid2) || ' '
      || (select status from public.billing_requests where id = v_qr2) || ' '
      || (select string_agg(distinct status, ',') from public.billing_charges where request_id = v_qr2));
  perform pg_temp.expect('settle that no longer fits: logged as an error', '1',
    (select count(*)::text from public.billing_events where restaurant_id = v_rid2 and type = 'stripe.settle_failed' and level = 'error'));
  perform pg_temp.expect('billing_set_package still works on a manual restaurant', 'ok active',
    pg_temp.try_as(v_admin, array[format(
      'select public.billing_set_package(%L, ''base'', 3, ''{}''::uuid[], ''active'', null) ->> ''status''', v_rid2)], true));
  -- The branch that did not fit is hidden; the same payment told again now settles. Without a
  -- paid-through date (or with one already past) the first purchase is paid for one month.
  update public.branches set is_active = false where restaurant_id = v_rid2 and slug = 'three';
  r := public.billing_settle_stripe_request(v_qr2, 'cus_TESTPBS2', 'sub_TESTPBS2', 'in_TESTPBS2', now() - interval '1 day',
         '[]'::jsonb, null);
  perform pg_temp.expect('a first purchase with no usable paid-through date: one month from now', 'true first_purchase active true',
    (r ->> 'ok') || ' ' || (r ->> 'kind') || ' '
      || (select status || ' ' || (current_period_end = now() + interval '1 month') || '' from public.subscriptions where restaurant_id = v_rid2));

  -- A second Checkout completes for a restaurant that sub_TESTPBS2 already bills.
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid2, 'base', 2, array[v_c1], null, null);
  perform pg_temp.act_as(null);
  v_qr2 := (r ->> 'id')::uuid;
  r := public.billing_settle_stripe_request(v_qr2, 'cus_TESTPBS2', 'sub_TESTPBS2B', 'in_TESTPBS2B', now() + interval '1 month',
         '[]'::jsonb, null);
  perform pg_temp.expect('a Checkout for a restaurant another subscription already bills is refused for a refund',
    'false request_not_pending another_subscription pending sub_TESTPBS2',
    (r ->> 'ok') || ' ' || (r ->> 'reason') || ' ' || (r ->> 'detail') || ' '
      || (select status from public.billing_requests where id = v_qr2) || ' '
      || (select stripe_subscription_id from public.subscriptions where restaurant_id = v_rid2));

  -- 16. The review fixes (20260927100000, §9) ---------------------------------------------------------
  -- v_rid starts here expired, still carrying the Stripe subscription that ended (sub_TESTPBS1).

  -- 16a. Stripe ids and the card are private (§9.7; SEC-SQL-1, SEC-SQL-2, SEC-EDGE-1).
  perform pg_temp.expect('fixes: billing_stripe_customers has RLS and no policy', 'true 0',
    (select c.relrowsecurity || ' ' || (select count(*) from pg_policies where tablename = 'billing_stripe_customers')
       from pg_class c where c.oid = 'public.billing_stripe_customers'::regclass));
  perform pg_temp.expect('fixes: the owner cannot read billing_stripe_customers', 'ERR permission denied%',
    pg_temp.try_as(v_owner, array['select count(*)::text from public.billing_stripe_customers']));
  perform pg_temp.expect('fixes: no restaurant carries a Stripe customer any more', '0',
    (select count(*)::text from public.restaurants where stripe_customer_id is not null));
  perform pg_temp.expect('fixes: nobody signed in can create a restaurant carrying a Stripe customer (SEC-SQL-1)',
    'ERR new row for relation "restaurants" violates check constraint "restaurants_stripe_customer_id_retired"%',
    pg_temp.try_as(v_stranger, array[format(
      'insert into public.restaurants (owner_user_id, slug, name, stripe_customer_id) values (%L, %L, ''ZZ Forger'', ''cus_TESTPBS1'') returning 1',
      v_stranger, 'zz-pbs-forger-' || v_sfx)]));
  perform pg_temp.expect('fixes: not even the service role can', 'ERR new row for relation "restaurants" violates check constraint%',
    pg_temp.try_service(array[format(
      'insert into public.restaurants (owner_user_id, slug, name, stripe_customer_id) values (%L, %L, ''ZZ Forger'', ''cus_TESTPBS9'') returning 1',
      v_owner, 'zz-pbs-forger2-' || v_sfx)]));
  perform pg_temp.expect('fixes: a member reads the plan off subscriptions, not its Stripe ids or card (SEC-SQL-2)',
    'ok expired|ERR permission denied for table subscriptions|ERR permission denied for table subscriptions',
    pg_temp.try_as(v_owner, array[format('select status::text from public.subscriptions where restaurant_id = %L', v_rid)]) || '|'
      || pg_temp.try_as(v_owner, array[format('select stripe_subscription_id from public.subscriptions where restaurant_id = %L', v_rid)]) || '|'
      || pg_temp.try_as(v_owner, array[format('select card_last4 from public.subscriptions where restaurant_id = %L', v_rid)]));
  perform pg_temp.expect('fixes: the card is never written to subscriptions', '0',
    (select count(*)::text from public.subscriptions
      where card_last4 is not null or card_brand is not null or card_exp_month is not null or card_exp_year is not null));
  perform pg_temp.expect('fixes: the dormant stripe_sync_subscription can be run by nobody', 'false false false',
    has_function_privilege('service_role', 'public.stripe_sync_subscription(uuid,text,text,text,jsonb,timestamptz,timestamptz,timestamptz,boolean)', 'execute')::text
      || ' ' || has_function_privilege('authenticated', 'public.stripe_sync_subscription(uuid,text,text,text,jsonb,timestamptz,timestamptz,timestamptz,boolean)', 'execute')::text
      || ' ' || has_function_privilege('anon', 'public.stripe_sync_subscription(uuid,text,text,text,jsonb,timestamptz,timestamptz,timestamptz,boolean)', 'execute')::text);
  perform pg_temp.expect('fixes: every edge/webhook writer is the service role''s alone', '9 of 9',
    (select count(*) filter (where has_function_privilege('service_role', f, 'execute')
                               and not has_function_privilege('authenticated', f, 'execute')
                               and not has_function_privilege('anon', f, 'execute')) || ' of ' || count(*)
       from unnest(array[
         'public.stripe_event_claim(text,text,integer)', 'public.stripe_event_done(text)',
         'public.billing_mark_invoice_refunded(text)', 'public.billing_settings_merge(jsonb,uuid)',
         'public.billing_mark_request_stripe(uuid,text,text,text)',
         'public.billing_settle_stripe_request(uuid,text,text,text,timestamptz,jsonb,jsonb,numeric)',
         'public.billing_sync_stripe_status(text,text,boolean,timestamptz,timestamptz,jsonb,numeric)',
         'public.billing_request_for_invoice(text)', 'public.billing_set_stripe_customer(uuid,text)']) f));
  perform pg_temp.expect('fixes: the old signatures are gone', '<null> <null> <null>',
    coalesce(to_regprocedure('public.billing_mark_request_stripe(uuid,text,text)')::text, '<null>') || ' '
      || coalesce(to_regprocedure('public.billing_settle_stripe_request(uuid,text,text,text,timestamptz,jsonb,jsonb)')::text, '<null>') || ' '
      || coalesce(to_regprocedure('public.billing_sync_stripe_status(text,text,boolean,timestamptz,timestamptz,jsonb)')::text, '<null>'));

  -- 16b. One deadline (§9.1; money-sql-5, money-sql-7).
  perform pg_temp.expect('deadline: a card restaurant runs to its period end plus the grace days', 'true',
    (private.billing_deadline('active', 'sub_X', v_t, null, null) = v_t + interval '7 days')::text);
  perform pg_temp.expect('deadline: past due on the card rail, the later of that and its grace', 'true true',
    (private.billing_deadline('past_due', 'sub_X', v_t, null, v_t + interval '9 days') = v_t + interval '9 days')::text || ' '
      || (private.billing_deadline('past_due', 'sub_X', v_t, null, v_t + interval '2 days') = v_t + interval '7 days')::text);
  perform pg_temp.expect('deadline: a cancelled card subscription keeps what it paid for and its grace, no slack', 'true true',
    (private.billing_deadline('cancelled', 'sub_X', v_t, null, null) = v_t)::text || ' '
      || (private.billing_deadline('cancelled', 'sub_X', v_t, null, v_t + interval '3 days') = v_t + interval '3 days')::text);
  perform pg_temp.expect('deadline: a manual row ends as before (period end, trial, grace only while past due)', 'true true true',
    (private.billing_deadline('active', null, v_t, null, v_t + interval '5 days') = v_t)::text || ' '
      || (private.billing_deadline('trialing', null, v_t, v_t + interval '2 days', null) = v_t + interval '2 days')::text || ' '
      || (private.billing_deadline('past_due', null, v_t, null, v_t + interval '5 days') = v_t + interval '5 days')::text);
  perform pg_temp.expect('deadline: expired and unknown have none', '<null> <null>',
    coalesce(private.billing_deadline('expired', 'sub_X', v_t, null, null)::text, '<null>') || ' '
      || coalesce(private.billing_deadline(null, null, v_t, null, null)::text, '<null>'));
  update public.platform_settings set billing = billing || '{"grace_days": 3}'::jsonb where id = 1;
  perform pg_temp.expect('deadline: the grace days are the platform''s setting', 'true',
    (private.billing_deadline('active', 'sub_X', v_t, null, null) = v_t + interval '3 days')::text);
  update public.platform_settings set billing = billing - 'grace_days' where id = 1;

  -- 16c. Every member learns the rail from the entitlements (UIM-6).
  perform pg_temp.expect('entitlements: billing_rail is manual once the card subscription has ended', 'manual',
    private.entitlements_json(v_rid) ->> 'billing_rail');
  perform pg_temp.expect('entitlements: only billing_rail and billing_ends_at were added (§9.9, §10.8)',
    'addons,billing_ends_at,billing_rail,branch_id,branch_seats,branches_used,delivery_branch_ids,delivery_unlocked_branch_ids,entitled,entitled_through,features,monthly_total,plan_code,restaurant_id,status,trial_ends_at',
    (select string_agg(k, ',' order by k) from jsonb_object_keys(private.entitlements_json(v_rid, v_b1)) k));

  -- 16d. A first purchase over a row that still carries another subscription names it (money-sql-2).
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid, 'base', 2, array[v_b1], null, null);
  perform pg_temp.act_as(null);
  v_q6 := (r ->> 'id')::uuid;
  perform public.billing_mark_request_stripe(v_q6, 'cs_test_PBS6', null);
  r := public.billing_settle_stripe_request(v_q6, 'cus_TESTPBS1', 'sub_TESTPBS3', 'in_TESTPBS3', now() + interval '1 month',
         jsonb_build_array(
           jsonb_build_object('product_code', 'base', 'stripe_subscription_item_id', 'si_TESTB3'),
           jsonb_build_object('product_code', 'extra_branch', 'stripe_subscription_item_id', 'si_TESTS3'),
           jsonb_build_object('product_code', 'delivery', 'stripe_subscription_item_id', 'si_TESTD3')),
         jsonb_build_object('brand', 'mastercard', 'last4', '5555', 'exp_month', 4, 'exp_year', 2032), 87.00);
  perform pg_temp.expect('replacing: the settle names the subscription it replaced, for the caller to cancel', 'true first_purchase sub_TESTPBS1 stripe',
    (r ->> 'ok') || ' ' || (r ->> 'kind') || ' ' || coalesce(r ->> 'replaced_subscription_id', '<null>') || ' '
      || (r #>> '{entitlements,billing_rail}'));
  perform pg_temp.expect('replacing: the new subscription, Stripe''s monthly total, the card beside it', 'sub_TESTPBS3 87.00 mastercard 5555 4/2032 <null>',
    (select s.stripe_subscription_id || ' ' || s.stripe_monthly_amount || ' ' || c.card_brand || ' ' || c.card_last4 || ' '
            || c.card_exp_month || '/' || c.card_exp_year || ' ' || coalesce(s.card_last4, '<null>')
       from public.subscriptions s join public.billing_stripe_customers c on c.restaurant_id = s.restaurant_id
      where s.restaurant_id = v_rid));
  perform pg_temp.expect('replacing: the settle''s entitlements already carry the renewal slack', 'true',
    ((r #>> '{entitlements,entitled_through}')::timestamptz
       = (select current_period_end + interval '7 days' from public.subscriptions where restaurant_id = v_rid))::text);
  perform pg_temp.expect('replacing: logged', '1',
    (select count(*)::text from public.billing_events where restaurant_id = v_rid and type = 'stripe.subscription_replaced'));
  select current_period_end into v_x from public.subscriptions where restaurant_id = v_rid;

  -- 16e. What the Stripe rail shows (§9.6, §9.8; ui-platform-4, WH-6, money-sql-8).
  perform pg_temp.act_as(v_owner);
  r := public.get_billing_overview(v_rid);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('rail: Stripe''s total is the next charge (ours says 88), the new card, no invoice of the old subscription',
    'stripe 87.00 88.00 mastercard true <null>',
    (r #>> '{billing,rail}') || ' ' || (r #>> '{billing,next_charge_amount}') || ' ' || (r #>> '{entitlements,monthly_total}') || ' '
      || (r #>> '{billing,card,brand}') || ' ' || (r #>> '{billing,stripe_customer}') || ' '
      || coalesce(r #>> '{billing,last_invoice}', '<null>'));

  r := public.billing_record_stripe_invoice(
         pg_temp.invoice('in_TESTPBS3', 'sub_TESTPBS3', 'subscription_create', 'paid', 8700, 1, v_x), v_x);
  update public.billing_invoices set created_at = created_at - interval '30 minutes' where stripe_invoice_id = 'in_TESTPBS3';
  -- A stale Checkout's invoice, found by the customer, then refunded (WH-6).
  r := public.billing_record_stripe_invoice(
         pg_temp.invoice('in_TESTSTALE9', 'sub_TESTSTALE9', 'subscription_create', 'paid', 8700, 1, v_x + interval '1 month'),
         v_x + interval '1 month');
  perform pg_temp.expect('a stale checkout''s invoice is recorded, not applied, and is not the last invoice', 'true false https://invoice.stripe.com/i/in_TESTPBS3',
    (r ->> 'ok') || ' ' || (r ->> 'applied') || ' ' || (private.billing_rail_json(v_rid) #>> '{last_invoice,hosted_invoice_url}'));
  r := public.billing_mark_invoice_refunded('in_TESTSTALE9');
  perform pg_temp.expect('refunded: the stale invoice is marked refunded', 'true true refunded',
    (r ->> 'ok') || ' ' || (r ->> 'changed') || ' ' || (select status from public.billing_invoices where stripe_invoice_id = 'in_TESTSTALE9'));
  r := public.billing_mark_invoice_refunded('in_TESTSTALE9');
  perform pg_temp.expect('refunded: marking it twice changes nothing', 'true false', (r ->> 'ok') || ' ' || (r ->> 'changed'));
  perform pg_temp.expect('refunded: an unknown or malformed invoice', 'unknown_invoice invalid_invoice',
    (public.billing_mark_invoice_refunded('in_TESTNOSUCH') ->> 'reason') || ' ' || (public.billing_mark_invoice_refunded('cs_1') ->> 'reason'));
  perform public.billing_record_stripe_invoice(
    pg_temp.invoice('in_TESTSTALE9', 'sub_TESTSTALE9', 'subscription_create', 'paid', 8700, 1, v_x + interval '1 month'),
    v_x + interval '1 month');
  perform pg_temp.expect('refunded: a late invoice.paid does not make it paid again', 'refunded',
    (select status from public.billing_invoices where stripe_invoice_id = 'in_TESTSTALE9'));
  -- A change invoice of the CURRENT subscription, then refunded: the last invoice is the paid one before it.
  perform public.billing_record_stripe_invoice(
    pg_temp.invoice('in_TESTPBS3B', 'sub_TESTPBS3', 'subscription_update', 'paid', 4100, 1, v_x), v_x);
  perform pg_temp.expect('last invoice: the newest paid invoice of the current subscription', 'https://invoice.stripe.com/i/in_TESTPBS3B',
    private.billing_rail_json(v_rid) #>> '{last_invoice,hosted_invoice_url}');
  perform public.billing_mark_invoice_refunded('in_TESTPBS3B');
  perform pg_temp.expect('last invoice: a refunded one is not it', 'https://invoice.stripe.com/i/in_TESTPBS3',
    private.billing_rail_json(v_rid) #>> '{last_invoice,hosted_invoice_url}');
  r := public.billing_record_stripe_invoice(
         pg_temp.invoice('in_TESTPBS3B', 'sub_TESTPBS3', 'subscription_update', 'paid', 4100, 1, v_x + interval '2 months'),
         v_x + interval '2 months');
  perform pg_temp.expect('refunded: a redelivered refunded invoice moves no date', 'false true',
    (r ->> 'applied') || ' ' || (select (current_period_end = v_x)::text from public.subscriptions where restaurant_id = v_rid));
  r := public.billing_record_stripe_invoice(
         pg_temp.invoice('in_TESTWEIRD', 'sub_TESTPBS3', 'subscription_cycle', 'mystery', 4100, 1, v_x + interval '2 months'),
         v_x + interval '2 months');
  perform pg_temp.expect('an invoice status Stripe does not have is stored as open and applies nothing', 'open false true',
    (select status from public.billing_invoices where stripe_invoice_id = 'in_TESTWEIRD') || ' ' || (r ->> 'applied') || ' '
      || (select (current_period_end = v_x)::text from public.subscriptions where restaurant_id = v_rid));
  perform pg_temp.expect('billing_invoices refuses a status it does not know', 'ERR new row for relation "billing_invoices" violates check constraint%',
    pg_temp.try_service(array[format(
      'insert into public.billing_invoices (restaurant_id, stripe_invoice_id, status) values (%L, ''in_TESTBOGUS'', ''bogus'') returning 1', v_rid)]));

  -- 16f. Status sync stores Stripe's total, the card beside the customer; cancel_at alone ends the charges.
  perform public.billing_sync_stripe_status('sub_TESTPBS3', 'active', false, null, v_x, null, 97.00);
  perform pg_temp.expect('sync: Stripe''s recurring total is stored (ui-platform-4)', '97.00',
    (select stripe_monthly_amount::text from public.subscriptions where restaurant_id = v_rid));
  perform public.billing_sync_stripe_status('sub_TESTPBS3', 'active', false, null, v_x,
    jsonb_build_object('brand', 'amex', 'last4', '0005', 'exp_month', 7, 'exp_year', 2031));
  perform pg_temp.expect('sync without a total keeps it; the card goes to billing_stripe_customers only', '97.00 amex 0005 7/2031 <null>',
    (select s.stripe_monthly_amount || ' ' || c.card_brand || ' ' || c.card_last4 || ' ' || c.card_exp_month || '/' || c.card_exp_year
            || ' ' || coalesce(s.card_last4, '<null>')
       from public.subscriptions s join public.billing_stripe_customers c on c.restaurant_id = s.restaurant_id
      where s.restaurant_id = v_rid));
  perform public.billing_sync_stripe_status('sub_TESTPBS3', 'active', false, v_x, v_x, null);
  perform pg_temp.act_as(v_owner);
  r := public.get_billing_overview(v_rid);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('cancel_at without cancel_at_period_end: no next charge, the date it ends (UIM-4, ui-platform-2)', '<null> false true stripe',
    coalesce(r #>> '{billing,next_charge_at}', '<null>') || ' ' || (r #>> '{billing,cancel_at_period_end}') || ' '
      || ((r #>> '{billing,cancel_at}')::timestamptz = v_x)::text || ' ' || (r #>> '{billing,rail}'));
  perform public.billing_sync_stripe_status('sub_TESTPBS3', 'active', false, null, v_x, null);

  -- 16g. A change settles with Stripe's new total (§9.6).
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid, 'base', 2, array[v_b1, v_b2], null, null);
  perform pg_temp.act_as(null);
  v_q7 := (r ->> 'id')::uuid;
  perform public.billing_mark_request_stripe(v_q7, null, 'in_TESTCHG7', 'https://invoice.stripe.com/i/in_TESTCHG7');
  r := public.billing_settle_stripe_request(v_q7, 'cus_TESTPBS1', 'sub_TESTPBS3', 'in_TESTCHG7', v_x,
         jsonb_build_array(jsonb_build_object('product_code', 'delivery', 'stripe_subscription_item_id', 'si_TESTD3')), null, 117.00);
  perform pg_temp.expect('change settle: Stripe''s new total, both branches deliver, nothing replaced', 'true change <null> 117.00 true true',
    (r ->> 'ok') || ' ' || (r ->> 'kind') || ' ' || coalesce(r ->> 'replaced_subscription_id', '<null>') || ' '
      || (select stripe_monthly_amount::text from public.subscriptions where restaurant_id = v_rid) || ' '
      || private.branch_feature_granted(v_b1, 'delivery')::text || ' ' || private.branch_feature_granted(v_b2, 'delivery')::text);
  perform pg_temp.expect('rail after the change: Stripe''s total, no invoice page once paid', '117.00 <null> <null>',
    (private.billing_rail_json(v_rid) ->> 'next_charge_amount') || ' '
      || coalesce(private.billing_rail_json(v_rid) ->> 'pending_invoice_url', '<null>') || ' '
      || coalesce(private.billing_rail_json(v_rid) ->> 'pending_request_rail', '<null>'));

  -- 16h. A delivering branch of a card restaurant stays until its delivery is off (§9.6, money-sql-6).
  perform pg_temp.expect('branch guard: the owner cannot hide a delivering branch of a card restaurant', 'ERR stripe_delivery_active',
    pg_temp.try_as(v_owner, array[format('update public.branches set is_active = false where id = %L returning 1', v_b2)]));
  perform pg_temp.expect('branch guard: nor can it be deleted', 'ERR stripe_delivery_active',
    pg_temp.try_service(array[format('delete from public.branches where id = %L returning 1', v_b2)]));
  perform pg_temp.expect('branch guard: nor moved to another restaurant', 'ERR stripe_delivery_active',
    pg_temp.try_service(array[format('update public.branches set restaurant_id = %L where id = %L returning 1', v_rid2, v_b2)]));
  perform pg_temp.expect('branch guard: the branch''s other settings still change', 'ok 1',
    pg_temp.try_as(v_owner, array[format('update public.branches set name = ''ZZ Two Renamed'' where id = %L returning 1', v_b2)]));
  perform pg_temp.expect('branch guard: a card restaurant''s branch without delivery can still be hidden', 'ok 1',
    pg_temp.try_as(v_owner, array[format(
      'update public.branches set is_active = false where restaurant_id = %L and slug = ''two'' returning 1', v_rid2)]));
  perform pg_temp.expect('branch guard: the platform can still suspend a card restaurant (D11)', 'ok 2',
    pg_temp.try_as(v_admin, array[format('select public.set_restaurant_suspended(%L, true)::text', v_rid),
      format('select count(*)::text from public.branches where restaurant_id = %L and not is_active', v_rid)], true));
  perform pg_temp.expect('branch guard: deleting the whole restaurant still cascades', 'ok 0',
    pg_temp.try_service(array[format('delete from public.restaurants where id = %L returning 1', v_rid),
      format('select count(*)::text from public.branches where restaurant_id = %L', v_rid)]));

  -- 16i. The manual rail detaches a card subscription that has ended (§9.2, money-sql-3).
  perform public.billing_sync_stripe_status('sub_TESTPBS3', 'paused', false, null, null, null);
  perform pg_temp.expect('fixture: the card subscription has ended, the row still carries it', 'expired sub_TESTPBS3 false manual',
    (select status || ' ' || stripe_subscription_id from public.subscriptions where restaurant_id = v_rid) || ' '
      || private.billing_is_stripe_managed(v_rid)::text || ' ' || (private.billing_rail_json(v_rid) ->> 'rail'));
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid, 'base', 2, array[v_b1], null, null);
  perform pg_temp.act_as(null);
  v_q8 := (r ->> 'id')::uuid;
  perform pg_temp.act_as(v_admin, true);
  r := public.decide_billing_request(v_q8, true, 'bank transfer');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('manual approval over an ended card subscription: its Stripe ids go, the customer and card stay',
    'active <null> <null> false <null> <null> <null> <null> cus_TESTPBS1 amex',
    (select s.status || ' ' || coalesce(s.stripe_subscription_id, '<null>') || ' '
            || coalesce((select string_agg(si.stripe_subscription_item_id, ',') from public.subscription_items si where si.subscription_id = s.id), '<null>') || ' '
            || s.cancel_at_period_end || ' ' || coalesce(s.cancel_at::text, '<null>') || ' ' || coalesce(s.grace_until::text, '<null>') || ' '
            || coalesce(s.next_billing_at::text, '<null>') || ' ' || coalesce(s.stripe_monthly_amount::text, '<null>') || ' '
            || s.stripe_customer_id || ' ' || c.card_brand
       from public.subscriptions s join public.billing_stripe_customers c on c.restaurant_id = s.restaurant_id
      where s.restaurant_id = v_rid));
  perform pg_temp.expect('manual approval: the manual rail, not Stripe-managed, approved, logged', 'manual false approved 1 manual',
    (private.billing_rail_json(v_rid) ->> 'rail') || ' ' || private.billing_is_stripe_managed(v_rid)::text || ' '
      || (select status from public.billing_requests where id = v_q8) || ' '
      || (select count(*) from public.billing_events where restaurant_id = v_rid and type = 'stripe.subscription_detached') || ' '
      || (private.entitlements_json(v_rid) ->> 'billing_rail'));
  r := public.billing_record_stripe_invoice(
         pg_temp.invoice('in_TESTLATE3', 'sub_TESTPBS3', 'subscription_cycle', 'paid', 9700, 1, now() + interval '3 months'),
         now() + interval '3 months');
  perform pg_temp.expect('an invoice of the detached subscription is recorded but moves nothing', 'true false true',
    (r ->> 'ok') || ' ' || (r ->> 'applied') || ' '
      || (select (current_period_end < now() + interval '2 months')::text from public.subscriptions where restaurant_id = v_rid));

  -- 16j. Nothing is charged for a request that can no longer settle; one customer per restaurant.
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-pbs3-' || v_sfx, 'ZZ Platform Billing Test Three')
  returning id into v_rid3;
  perform private.billing_apply_selection(v_rid3, 'trial', '{}'::uuid[], 3, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_rid3, 'one', 'Third One') returning id into v_d1;
  insert into public.branches (restaurant_id, slug, name) values (v_rid3, 'two', 'Third Two') returning id into v_d2;
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid3, 'base', 2, array[v_d1], null, null);
  perform pg_temp.act_as(null);
  v_q9 := (r ->> 'id')::uuid;
  -- A third branch opens after the request was filed (the trial has a spare seat).
  insert into public.branches (restaurant_id, slug, name) values (v_rid3, 'three', 'Third Three') returning id into v_d3;
  perform pg_temp.act_as(v_owner);
  r := public.billing_checkout_context(v_q9);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('checkout context: seats short of the active branches are refused before any charge (money-sql-4)',
    'false plan_limit_exceeded plan_limit_exceeded:branches:3/2 3 2',
    (r ->> 'ok') || ' ' || (r ->> 'error') || ' ' || (r ->> 'detail') || ' ' || (r ->> 'branches_used') || ' ' || (r ->> 'branch_seats'));

  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid3, 'base', 3, '{}'::uuid[], null, null);
  perform pg_temp.act_as(null);
  v_q10 := (r ->> 'id')::uuid;
  perform public.billing_mark_request_stripe(v_q10, 'cs_test_PBS10', null);
  r := public.billing_settle_stripe_request(v_q10, 'cus_TESTPBS1', 'sub_TESTPBS10', 'in_TESTPBS10', now() + interval '1 month',
         '[]'::jsonb, null, 87.00);
  perform pg_temp.expect('settle through another restaurant''s customer: refused before anything is applied',
    'false settle_failed first_purchase customer_of_another_restaurant trialing <null> pending',
    (r ->> 'ok') || ' ' || (r ->> 'reason') || ' ' || (r ->> 'kind') || ' ' || (r ->> 'detail') || ' '
      || (select s.status || ' ' || coalesce(s.stripe_subscription_id, '<null>') from public.subscriptions s where s.restaurant_id = v_rid3) || ' '
      || (select status from public.billing_requests where id = v_q10));
  perform pg_temp.expect('storing another restaurant''s customer is refused', 'ERR customer_of_another_restaurant',
    pg_temp.try_service(array[format('select public.billing_set_stripe_customer(%L, ''cus_TESTPBS1'')::text', v_rid3)]));

  -- billing_set_package detaches an ended subscription too, and a manual restaurant hides branches as before.
  update public.subscriptions
     set stripe_subscription_id = 'sub_TESTDEAD3', status = 'expired', grace_until = now() + interval '1 day',
         next_billing_at = now(), cancel_at_period_end = true, stripe_monthly_amount = 10
   where restaurant_id = v_rid3;
  perform pg_temp.act_as(v_admin, true);
  r := public.billing_set_package(v_rid3, 'base', 3, array[v_d1], 'active', null);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('billing_set_package over an ended card subscription detaches it (money-sql-3)', 'active <null> <null> <null> false <null> manual',
    (select s.status || ' ' || coalesce(s.stripe_subscription_id, '<null>') || ' ' || coalesce(s.grace_until::text, '<null>') || ' '
            || coalesce(s.next_billing_at::text, '<null>') || ' ' || s.cancel_at_period_end || ' '
            || coalesce(s.stripe_monthly_amount::text, '<null>')
       from public.subscriptions s where s.restaurant_id = v_rid3) || ' ' || (private.billing_rail_json(v_rid3) ->> 'rail'));
  perform pg_temp.expect('branch guard: a manual restaurant hides a delivering branch as before', 'true ok 1',
    private.branch_feature_granted(v_d1, 'delivery')::text || ' '
      || pg_temp.try_as(v_owner, array[format('update public.branches set is_active = false where id = %L returning 1', v_d1)]));
  perform pg_temp.expect('hiding a delivering branch of a manual restaurant keeps its add-on (§10.3 is the card rail''s)', 'ok true',
    pg_temp.try_as(v_owner, array[format('update public.branches set is_active = false where id = %L returning 1', v_d1),
      format('select active::text from public.branch_addons where branch_id = %L and code = ''delivery''', v_d1)]));

  -- 16k. Webhook events are claimed with a lease (WH-5); the claim says claimed / in_flight /
  -- handled (§10.7, SEC-R2-2), so a delivery that meets a live lease is retried, not dropped.
  perform pg_temp.expect('claim: a new event is claimed', 'claimed', public.stripe_event_claim(v_evt, 'invoice.paid', 300));
  perform pg_temp.expect('claim: a second delivery while it is being handled is in flight (SEC-R2-2)', 'in_flight',
    public.stripe_event_claim(v_evt, 'invoice.paid', 300));
  update public.billing_events set created_at = now() - interval '10 minutes' where stripe_event_id = v_evt;
  v_claim := public.stripe_event_claim(v_evt, 'invoice.paid', 300);
  perform pg_temp.expect('claim: an abandoned claim is taken over once the lease has run out', 'claimed 2 received',
    v_claim || ' ' || (select (payload ->> 'claims') || ' ' || note from public.billing_events where stripe_event_id = v_evt));
  perform pg_temp.expect('claim: and only once; the next delivery is in flight', 'in_flight',
    public.stripe_event_claim(v_evt, 'invoice.paid', 300));
  perform public.stripe_event_done(v_evt);
  perform pg_temp.expect('claim: once handled, a redelivery is answered handled', 'handled',
    public.stripe_event_claim(v_evt, 'invoice.paid', 300));
  update public.billing_events set created_at = now() - interval '10 minutes' where stripe_event_id = v_evt;
  v_claim := public.stripe_event_claim(v_evt, 'invoice.paid', 300);
  perform pg_temp.expect('claim: a handled event is never claimed again', 'handled handled',
    (select note from public.billing_events where stripe_event_id = v_evt) || ' ' || v_claim);
  perform pg_temp.expect('claim: no id, no claim', 'handled', public.stripe_event_claim('', 'invoice.paid', 300));
  v_claim := public.stripe_event_claim(v_evt2, 'invoice.paid', 300);
  v_bool := public.stripe_event_forget(v_evt2);
  perform pg_temp.expect('claim: a claim a failed worker released is claimed afresh', 'claimed true claimed',
    v_claim || ' ' || v_bool::text || ' ' || public.stripe_event_claim(v_evt2, 'invoice.paid', 300));
  perform pg_temp.expect('claim: it answers text now', 'text',
    (select format_type(prorettype, null) from pg_proc where oid = 'public.stripe_event_claim(text,text,integer)'::regprocedure));
  perform pg_temp.expect('claim: the Connect webhook''s stripe_event_seen / forget are unchanged', 'true false true true',
    public.stripe_event_seen(v_evt || '_c', 'account.updated')::text || ' '
      || public.stripe_event_seen(v_evt || '_c', 'account.updated')::text || ' '
      || public.stripe_event_forget(v_evt || '_c')::text || ' '
      || public.stripe_event_seen(v_evt || '_c', 'account.updated')::text);
  perform pg_temp.expect('claim: the owner cannot claim an event', 'ERR permission denied for function%',
    pg_temp.try_as(v_owner, array['select public.stripe_event_claim(''evt_x'', ''x'', 300)::text']));

  -- 16l. platform_settings.billing is patched atomically (SEC-EDGE-2).
  update public.platform_settings set billing = '{"stripe_enabled": true, "portal_configuration_id": "bpc_OLD"}'::jsonb where id = 1;
  r := public.billing_settings_merge('{"portal_configuration_id": "bpc_NEW"}'::jsonb, null);
  perform pg_temp.expect('settings merge: only the keys given change', 'true bpc_NEW',
    (r ->> 'stripe_enabled') || ' ' || (r ->> 'portal_configuration_id'));
  r := public.billing_settings_merge('{"stripe_enabled": false, "portal_configuration_id": null}'::jsonb, v_admin);
  perform pg_temp.expect('settings merge: a key patched to null is removed, the switch goes off, the admin is recorded',
    '{"stripe_enabled": false} false true',
    r::text || ' ' || public.billing_stripe_enabled()::text || ' '
      || (select (updated_by = v_admin)::text from public.platform_settings where id = 1));
  perform pg_temp.expect('settings merge: a switch that is not a boolean is refused', 'ERR invalid_billing_setting:stripe_enabled',
    pg_temp.try_service(array['select public.billing_settings_merge(''{"stripe_enabled": "yes"}''::jsonb)::text']));
  perform pg_temp.expect('settings merge: a patch that is not an object is refused', 'ERR invalid_billing_settings',
    pg_temp.try_service(array['select public.billing_settings_merge(''[1]''::jsonb)::text']));
  perform pg_temp.expect('settings merge: the owner cannot call it', 'ERR permission denied for function%',
    pg_temp.try_as(v_owner, array['select public.billing_settings_merge(''{"stripe_enabled": true}''::jsonb)::text']));
  -- 17. The second review fixes (20260927200000, §10) --------------------------------------------------
  -- A fourth restaurant goes on the card rail with three branches, the first one delivering.
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-pbs4-' || v_sfx, 'ZZ Platform Billing Test Four')
  returning id into v_rid4;
  perform private.billing_apply_selection(v_rid4, 'trial', '{}'::uuid[], 3, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_rid4, 'one', 'Fourth One') returning id into v_e1;
  insert into public.branches (restaurant_id, slug, name) values (v_rid4, 'two', 'Fourth Two') returning id into v_e2;
  insert into public.branches (restaurant_id, slug, name) values (v_rid4, 'three', 'Fourth Three') returning id into v_e3;
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid4, 'base', 3, array[v_e1], null, null);
  perform pg_temp.act_as(null);
  v_q11 := (r ->> 'id')::uuid;
  perform public.billing_mark_request_stripe(v_q11, 'cs_test_PBS11', null);
  perform pg_temp.expect('§10 fixture: a checkout marks no invoice time', '<null> <null>',
    (select coalesce(stripe_invoice_marked_at::text, '<null>') || ' ' || coalesce(stripe_change_started_at::text, '<null>')
       from public.billing_requests where id = v_q11));
  r := public.billing_settle_stripe_request(v_q11, 'cus_TESTPBS4', 'sub_TESTPBS4', 'in_TESTPBS4', now() + interval '1 month',
         '[]'::jsonb, null, 117.00);
  select current_period_end into v_x4 from public.subscriptions where restaurant_id = v_rid4;
  perform pg_temp.expect('§10 fixture: a card restaurant with three branches, the first delivering', 'true first_purchase true true false false',
    (r ->> 'ok') || ' ' || (r ->> 'kind') || ' ' || private.billing_is_stripe_managed(v_rid4)::text || ' '
      || private.branch_feature_granted(v_e1, 'delivery')::text || ' ' || private.branch_feature_granted(v_e2, 'delivery')::text || ' '
      || private.branch_feature_granted(v_e3, 'delivery')::text);

  -- 17a. Delivery follows active branches (§10.3, money-rr-3).
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid4, 'base', 3, array[v_e1, v_e2, v_e3], null, null);
  perform pg_temp.act_as(null);
  v_q12 := (r ->> 'id')::uuid;
  -- The third branch is hidden before the change is paid; it does not deliver yet, so the guard lets it go.
  update public.branches set is_active = false where id = v_e3;
  perform public.billing_mark_request_stripe(v_q12, null, 'in_TESTCHG12', 'https://invoice.stripe.com/i/in_TESTCHG12');
  r := public.billing_settle_stripe_request(v_q12, 'cus_TESTPBS4', 'sub_TESTPBS4', 'in_TESTCHG12', null, '[]'::jsonb, null, 147.00);
  perform pg_temp.expect('delivery: a branch hidden before the change settled is not switched on (money-rr-3)', 'true change true true false 3',
    (r ->> 'ok') || ' ' || (r ->> 'kind') || ' '
      || coalesce((select active::text from public.branch_addons where branch_id = v_e1 and code = 'delivery'), 'false') || ' '
      || coalesce((select active::text from public.branch_addons where branch_id = v_e2 and code = 'delivery'), 'false') || ' '
      || coalesce((select active::text from public.branch_addons where branch_id = v_e3 and code = 'delivery'), 'false') || ' '
      || (select cardinality(delivery_branch_ids)::text from public.billing_requests where id = v_q12));
  update public.branches set is_active = true where id = v_e3;
  perform pg_temp.expect('delivery: shown again, it does not deliver', 'false 2',
    private.branch_feature_granted(v_e3, 'delivery')::text || ' '
      || jsonb_array_length(private.entitlements_json(v_rid4) -> 'delivery_branch_ids')::text);

  -- A platform admin hides a delivering branch (the guard lets the platform through).
  perform pg_temp.act_as(v_admin, true);
  update public.branches set is_active = false where id = v_e2;
  perform pg_temp.act_as(null);
  perform pg_temp.expect('hide: a delivering branch of a card restaurant hidden by the platform loses its add-on, keeps its unlock (money-rr-3)',
    'false true 1 1',
    (select active::text || ' ' || (unlocked_at is not null)::text from public.branch_addons where branch_id = v_e2 and code = 'delivery') || ' '
      || (select count(*)::text from public.billing_events where restaurant_id = v_rid4 and type = 'stripe.delivery_branch_hidden') || ' '
      || (select si.quantity::text from public.subscription_items si join public.subscriptions s on s.id = si.subscription_id
           where s.restaurant_id = v_rid4 and si.product_code = 'delivery'));
  update public.branches set is_active = true where id = v_e2;
  perform pg_temp.expect('hide: shown again, it does not deliver and is not billed', 'false 1 1',
    private.branch_feature_granted(v_e2, 'delivery')::text || ' '
      || jsonb_array_length(private.entitlements_json(v_rid4) -> 'delivery_branch_ids')::text || ' '
      || (select si.quantity::text from public.subscription_items si join public.subscriptions s on s.id = si.subscription_id
           where s.restaurant_id = v_rid4 and si.product_code = 'delivery'));

  -- A suspension is not a hide: Stripe goes on billing, and Restore shows the same branches.
  perform pg_temp.act_as(v_admin, true);
  perform public.set_restaurant_suspended(v_rid4, true);
  perform pg_temp.expect('suspend: a suspended card restaurant keeps its delivery add-on', '0 true',
    (select count(*)::text from public.branches where restaurant_id = v_rid4 and is_active) || ' '
      || (select active::text from public.branch_addons where branch_id = v_e1 and code = 'delivery'));
  perform public.set_restaurant_suspended(v_rid4, false);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('restore: the delivering branch delivers again', '3 true',
    (select count(*)::text from public.branches where restaurant_id = v_rid4 and is_active) || ' '
      || private.branch_feature_granted(v_e1, 'delivery')::text);

  -- 17b. A card change lock always ends (§10.1; money-rr-1, money-rr-4).
  perform pg_temp.expect('new columns: when a request was tied to its invoice, and when its change was sent', '2',
    (select count(*)::text from information_schema.columns
      where table_schema = 'public' and table_name = 'billing_requests'
        and column_name in ('stripe_invoice_marked_at', 'stripe_change_started_at')));
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid4, 'base', 4, array[v_e1, v_e3], v_code2, null);
  perform pg_temp.act_as(null);
  v_q13 := (r ->> 'id')::uuid;
  perform pg_temp.expect('fixture: a fourth seat is on order, with a code', 'pending reserved',
    (select string_agg(distinct c.status, ',') from public.billing_charges c where c.request_id = v_q13) || ' '
      || (select string_agg(status, ',') from public.billing_discount_redemptions where request_id = v_q13));
  perform public.billing_mark_change_started(v_q13);
  perform pg_temp.expect('in flight: the update is marked as sent, on the card rail, with no invoice yet', 'stripe true <null> active',
    (select br.rail || ' ' || (br.stripe_change_started_at = now())::text || ' ' || coalesce(br.stripe_invoice_id, '<null>') || ' '
            || private.billing_card_lock(br)
       from public.billing_requests br where br.id = v_q13));
  perform pg_temp.expect('in flight: the merchant cannot replace it, invoice or not (money-rr-4)', 'ERR payment_in_progress',
    pg_temp.try_as(v_owner, array[format(
      'select public.request_package_change(%L, ''base'', 3, ''{}''::uuid[], null, null)::text', v_rid4)]));
  perform pg_temp.expect('in flight: nor can an operator reject it', 'ERR payment_in_progress',
    pg_temp.try_as(v_admin, array[format('select public.decide_billing_request(%L, false, ''no'')::text', v_q13)], true));
  perform pg_temp.expect('in flight: nor approve it', 'ERR stripe_managed',
    pg_temp.try_as(v_admin, array[format('select public.decide_billing_request(%L, true, null)::text', v_q13)], true));
  perform pg_temp.expect('the owner cannot mark a change as sent', 'ERR permission denied for function%',
    pg_temp.try_as(v_owner, array[format('select public.billing_mark_change_started(%L)::text', v_q13)]));
  perform pg_temp.expect('marking an unknown request as sent', 'ERR request_not_found',
    pg_temp.try_service(array['select public.billing_mark_change_started(gen_random_uuid())::text']));

  -- 23 hours later nothing came of it: the next request releases the lock.
  update public.billing_requests set stripe_change_started_at = now() - interval '23 hours 1 minute' where id = v_q13;
  perform pg_temp.expect('in flight 23 hours ago: the lock has run out', 'expired',
    (select private.billing_card_lock(br) from public.billing_requests br where br.id = v_q13));
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid4, 'base', 3, array[v_e1, v_e3], null, null);
  perform pg_temp.act_as(null);
  v_q14 := (r ->> 'id')::uuid;
  perform pg_temp.expect('expired lock: the new request is filed', 'true pending',
    (r ->> 'ok') || ' ' || (select status from public.billing_requests where id = v_q14));
  perform pg_temp.expect('expired lock: the old request is cancelled, its charges void, its code given back (money-rr-1)',
    'cancelled card payment window expired void 0 1',
    (select status || ' ' || decision_note from public.billing_requests where id = v_q13) || ' '
      || (select string_agg(distinct c.status, ',') from public.billing_charges c where c.request_id = v_q13) || ' '
      || (select count(*) from public.billing_discount_redemptions where request_id = v_q13) || ' '
      || (select count(*) from public.billing_events where restaurant_id = v_rid4 and type = 'stripe.card_lock_expired'));
  perform pg_temp.expect('marking a cancelled request as sent is refused, so a superseded change is never sent', 'ERR request_not_pending',
    pg_temp.try_service(array[format('select public.billing_mark_change_started(%L)::text', v_q13)]));

  -- The invoice lock counts from when the request was first tied to that invoice.
  perform public.billing_mark_request_stripe(v_q14, null, 'in_TESTLOCK14', 'https://invoice.stripe.com/i/in_TESTLOCK14');
  perform pg_temp.expect('invoice lock: the time it was tied to its invoice is kept', 'true <null> active',
    (select (br.stripe_invoice_marked_at = now())::text || ' ' || coalesce(br.stripe_change_started_at::text, '<null>') || ' '
            || private.billing_card_lock(br)
       from public.billing_requests br where br.id = v_q14));
  update public.billing_requests set stripe_invoice_marked_at = now() - interval '5 hours' where id = v_q14;
  perform public.billing_mark_request_stripe(v_q14, null, 'in_TESTLOCK14', 'https://invoice.stripe.com/i/in_TESTLOCK14');
  perform pg_temp.expect('invoice lock: marking the same invoice again does not restart the window', 'true',
    (select (stripe_invoice_marked_at = now() - interval '5 hours')::text from public.billing_requests where id = v_q14));
  perform public.billing_mark_request_stripe(v_q14, null, 'in_TESTLOCK14B', 'https://invoice.stripe.com/i/in_TESTLOCK14B');
  perform pg_temp.expect('invoice lock: a different invoice starts a new window', 'true',
    (select (stripe_invoice_marked_at = now())::text from public.billing_requests where id = v_q14));
  update public.billing_requests set stripe_invoice_marked_at = now() - interval '22 hours 59 minutes' where id = v_q14;
  perform pg_temp.expect('invoice lock: 22 h 59 min on, an operator still cannot reject it', 'ERR payment_in_progress',
    pg_temp.try_as(v_admin, array[format('select public.decide_billing_request(%L, false, null)::text', v_q14)], true));
  perform pg_temp.expect('invoice lock: nor can the merchant replace it', 'ERR payment_in_progress',
    pg_temp.try_as(v_owner, array[format(
      'select public.request_package_change(%L, ''base'', 3, ''{}''::uuid[], null, null)::text', v_rid4)]));
  update public.billing_requests set stripe_invoice_marked_at = now() - interval '23 hours 1 minute' where id = v_q14;
  perform pg_temp.act_as(v_admin, true);
  perform pg_temp.expect('invoice lock: past 23 hours an operator''s own note is kept', 'ok rejected merchant gave up',
    pg_temp.try_service(array[format('select public.decide_billing_request(%L, false, ''merchant gave up'')::text', v_q14),
      format('select status || '' '' || decision_note from public.billing_requests where id = %L', v_q14)]));
  r := public.decide_billing_request(v_q14, false, null);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('invoice lock: past 23 hours an operator can reject it; with no note the reason is recorded (money-rr-1)',
    'true false rejected card payment window expired none',
    (r ->> 'ok') || ' ' || (r ->> 'approved') || ' '
      || (select status || ' ' || decision_note from public.billing_requests where id = v_q14) || ' '
      || coalesce((select string_agg(distinct c.status, ',') from public.billing_charges c
                    where c.request_id = v_q14 and c.status <> 'void'), 'none'));
  perform pg_temp.expect('invoice lock: the rejected change is still found from its invoice, so a late payment is refunded', 'true',
    (public.billing_request_for_invoice('in_TESTLOCK14B') = v_q14)::text);

  -- A lock tied to an invoice with no time (an older writer) counts from the request's last update.
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid4, 'base', 3, array[v_e1, v_e3], null, null);
  perform pg_temp.act_as(null);
  v_q15 := (r ->> 'id')::uuid;
  perform public.billing_mark_request_stripe(v_q15, null, 'in_TESTLOCK15', null);
  update public.billing_requests set stripe_invoice_marked_at = null where id = v_q15;
  perform pg_temp.expect('invoice lock with no time: live, from the last update', 'active',
    (select private.billing_card_lock(br) from public.billing_requests br where br.id = v_q15));
  perform public.billing_cancel_stripe_request(v_q15, 'test');
  perform pg_temp.expect('no lock once the request is not pending', '<null>',
    (select coalesce(private.billing_card_lock(br), '<null>') from public.billing_requests br where br.id = v_q15));

  -- 17c. A change is never settled as a first purchase (§10.5, money-rr-7).
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid4, 'base', 4, array[v_e1, v_e3], null, null);
  perform pg_temp.act_as(null);
  v_q16 := (r ->> 'id')::uuid;
  perform public.billing_mark_request_stripe(v_q16, null, 'in_TESTCHG16', 'https://invoice.stripe.com/i/in_TESTCHG16');
  -- The row expires while the change waits on 3-D Secure.
  perform public.billing_sync_stripe_status('sub_TESTPBS4', 'paused', false, null, null, null);
  r := public.billing_settle_stripe_request(v_q16, 'cus_TESTPBS4', 'sub_TESTPBS4', 'in_TESTCHG16', now() + interval '1 month',
         '[]'::jsonb, null, 176.00);
  perform pg_temp.expect('expired row: a change of its own subscription is refused, not settled as a first purchase (money-rr-7)',
    'false not_managed change expired',
    (r ->> 'ok') || ' ' || (r ->> 'reason') || ' ' || (r ->> 'kind') || ' ' || (r ->> 'subscription_status'));
  perform pg_temp.expect('expired row: nothing is written', 'expired true 147.00 pending pending false 1',
    (select s.status || ' ' || (s.current_period_end = v_x4)::text || ' ' || s.stripe_monthly_amount
       from public.subscriptions s where s.restaurant_id = v_rid4) || ' '
      || (select status from public.billing_requests where id = v_q16) || ' '
      || (select string_agg(distinct c.status, ',') from public.billing_charges c where c.request_id = v_q16) || ' '
      || coalesce((select active::text from public.branch_addons where branch_id = v_e3 and code = 'delivery'), 'false') || ' '
      || (select count(*) from public.billing_events where restaurant_id = v_rid4 and type = 'stripe.settle_refused'
            and note = 'not_managed:expired'));
  -- Stripe says it is active again: the same payment is a change.
  perform public.billing_sync_stripe_status('sub_TESTPBS4', 'active', false, null, v_x4, null);
  r := public.billing_settle_stripe_request(v_q16, 'cus_TESTPBS4', 'sub_TESTPBS4', 'in_TESTCHG16', now() + interval '1 month',
         '[]'::jsonb, null, 176.00);
  perform pg_temp.expect('managed again: the same payment settles as a change, the period kept', 'true change true true 4 paid',
    (r ->> 'ok') || ' ' || (r ->> 'kind') || ' '
      || (select (current_period_end = v_x4)::text from public.subscriptions where restaurant_id = v_rid4) || ' '
      || private.branch_feature_granted(v_e3, 'delivery')::text || ' '
      || (select branch_seats::text from public.billing_entitlements where restaurant_id = v_rid4) || ' '
      || (select string_agg(distinct c.status, ',') from public.billing_charges c where c.request_id = v_q16));

  -- 17d. cancel_at counts as cancelling only on or before the next renewal (§10.8; ui-rr-2, ui-rr-3).
  perform pg_temp.expect('renewing: a next charge, no end date', 'true <null>',
    ((private.billing_rail_json(v_rid4) ->> 'next_charge_at')::timestamptz = v_x4)::text || ' '
      || coalesce(private.entitlements_json(v_rid4) ->> 'billing_ends_at', '<null>'));
  perform public.billing_sync_stripe_status('sub_TESTPBS4', 'active', false, v_x4 + interval '2 months', v_x4, null);
  perform pg_temp.expect('cancel_at after the next renewal: that renewal is still charged, no end date yet (ui-rr-2)', 'true <null>',
    ((private.billing_rail_json(v_rid4) ->> 'next_charge_at')::timestamptz = v_x4)::text || ' '
      || coalesce(private.entitlements_json(v_rid4) ->> 'billing_ends_at', '<null>'));
  perform public.billing_sync_stripe_status('sub_TESTPBS4', 'active', false, v_x4, v_x4, null);
  perform pg_temp.expect('cancel_at on the next renewal: no next charge, every member sees the end date (ui-rr-3)', '<null> true',
    coalesce(private.billing_rail_json(v_rid4) ->> 'next_charge_at', '<null>') || ' '
      || ((private.entitlements_json(v_rid4) ->> 'billing_ends_at')::timestamptz = v_x4)::text);
  perform public.billing_sync_stripe_status('sub_TESTPBS4', 'active', true, null, null, null);
  perform pg_temp.expect('cancel_at_period_end: no next charge, ends at the period end', '<null> true',
    coalesce(private.billing_rail_json(v_rid4) ->> 'next_charge_at', '<null>') || ' '
      || ((private.entitlements_json(v_rid4) ->> 'billing_ends_at')::timestamptz = v_x4)::text);
  perform pg_temp.expect('a manager reads the end date from the entitlements', 'true',
    ((private.entitlements_json(v_rid4, v_e1) ->> 'billing_ends_at')::timestamptz = v_x4)::text);
  perform pg_temp.expect('billing_ends_at is only for the card rail', '<null>',
    coalesce(private.entitlements_json(v_rid3) ->> 'billing_ends_at', '<null>'));
  perform public.billing_sync_stripe_status('sub_TESTPBS4', 'active', false, null, v_x4, null);
  perform pg_temp.expect('un-cancelled: the next charge is back, no end date', 'true <null>',
    ((private.billing_rail_json(v_rid4) ->> 'next_charge_at')::timestamptz = v_x4)::text || ' '
      || coalesce(private.entitlements_json(v_rid4) ->> 'billing_ends_at', '<null>'));

  -- 17e. The pending request hides Stripe ids and the invoice page from staff (SEC-R2-1).
  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status)
  values (v_cashier, v_rid4, v_e1, 'cashier', 'active');
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_rid4, 'base', 3, array[v_e1, v_e3], null, null);
  perform pg_temp.act_as(null);
  v_q17 := (r ->> 'id')::uuid;
  perform public.billing_mark_request_stripe(v_q17, null, 'in_TESTSEC17', 'https://invoice.stripe.com/i/in_TESTSEC17');
  perform pg_temp.expect('pending request: the owner reads its invoice page and ids', 'ok https://invoice.stripe.com/i/in_TESTSEC17 in_TESTSEC17',
    pg_temp.try_as(v_owner, array[format(
      'select (r->>''stripe_invoice_url'') || '' '' || (r->>''stripe_invoice_id'') from (select public.get_pending_billing_request(%L) r) x', v_rid4)]));
  perform pg_temp.expect('pending request: a cashier reads the request but no Stripe id or invoice page (SEC-R2-1)',
    'ok ' || v_q17 || ' pending stripe false false false true',
    pg_temp.try_as(v_cashier, array[format(
      'select (r->>''id'') || '' '' || (r->>''status'') || '' '' || (r->>''rail'') || '' '' || (r ? ''stripe_invoice_url'')::text || '' '' || (r ? ''stripe_invoice_id'')::text || '' '' || (r ? ''stripe_checkout_session_id'')::text || '' '' || (r ? ''stripe_invoice_marked_at'')::text from (select public.get_pending_billing_request(%L) r) x', v_rid4)]));
  perform pg_temp.expect('pending request: a stranger is refused', 'ERR forbidden',
    pg_temp.try_as(v_stranger, array[format('select public.get_pending_billing_request(%L)::text', v_rid4)]));
  perform pg_temp.expect('pending request: the platform reads it whole', 'ok in_TESTSEC17',
    pg_temp.try_as(v_admin, array[format('select public.get_pending_billing_request(%L) ->> ''stripe_invoice_id''', v_rid4)], true));
  perform public.billing_cancel_stripe_request(v_q17, 'test');

  -- 17f. Whether a subscription is anyone's (§10.2, money-rr-2).
  perform pg_temp.expect('is current: held by a row (any status) or not', 'true true false false false false',
    public.billing_subscription_is_current('sub_TESTPBS4')::text || ' '
      || public.billing_subscription_is_current('sub_TESTPBS2')::text || ' '
      || public.billing_subscription_is_current('sub_TESTPBS3')::text || ' '
      || public.billing_subscription_is_current('sub_TESTNOBODY')::text || ' '
      || public.billing_subscription_is_current('')::text || ' '
      || public.billing_subscription_is_current(null)::text);
  perform pg_temp.expect('the new edge/webhook functions are the service role''s alone', '2 of 2',
    (select count(*) filter (where has_function_privilege('service_role', f, 'execute')
                               and not has_function_privilege('authenticated', f, 'execute')
                               and not has_function_privilege('anon', f, 'execute')) || ' of ' || count(*)
       from unnest(array['public.billing_mark_change_started(uuid)', 'public.billing_subscription_is_current(text)']) f));
  perform pg_temp.expect('the lock helpers and the trigger are nobody''s to call', 'false false false',
    has_function_privilege('authenticated', 'private.billing_card_lock(public.billing_requests)', 'execute')::text || ' '
      || has_function_privilege('authenticated', 'private.billing_release_expired_card_locks(uuid)', 'execute')::text || ' '
      || has_function_privilege('authenticated', 'private.tg_branches_stripe_delivery_off()', 'execute')::text);

end
$test$;

select seq, verdict, check_name, expected, actual from t_out
union all
select 999999, (select case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAILURES' end from t_out),
       format('%s checks, %s failed', count(*), count(*) filter (where verdict = 'FAIL')), null, null
  from t_out
order by 1;

rollback;
