-- One plan, every feature included (20261024100000_single_plan, docs/PACKAGING-2026-10-24.md).
-- A rolled-back script, not a migration. Pins: the catalog (§4.1), the prices a request is quoted
-- ($199 + $89 x extra branches once, $49 x branches a month), delivery included at every branch
-- with the merchant's free switch (§3), public.set_branch_delivery's permissions, billing never
-- touching branch_addons, the dropped card-rail delivery guards, and only a platform admin writing
-- restaurants.feature_overrides (§2). Section 0 checks what the migration's data step left behind.
--
-- Run it on a LOCAL stack, never on live (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/single_plan.sql
-- Before the migration is applied, run the migration and this file in one transaction instead
-- (drop this file's own "begin;" and put the migration's body after a "begin;" of your own).
--
-- Everything happens inside one transaction that ends in ROLLBACK, on restaurants this script
-- creates for itself (section 0 only reads). Two ways of acting as someone:
--   pg_temp.try_as(uid, sqls[, admin])  as the `authenticated` role (or anon when uid is null), in
--                                       a subtransaction that is always rolled back -- for
--                                       permission checks.
--   pg_temp.act_as(uid[, admin])        sets only the JWT claims, so auth.uid() is that person
--                                       while the statements that follow keep their effect.
--                                       act_as(null) is the service role again (no JWT).
--
-- People (auth.users rows made here):
--   owner         restaurants.owner_user_id of both test restaurants
--   stranger      nobody's staff
--   admin         app_metadata.is_platform_admin
--   cashier       staff of restaurant A at branch a1 (no branch.settings)
--   branch_admin  staff role 'admin' of restaurant A at branch a1 only (branch.settings there)
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
  values (v, 'single-plan-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', p_admin), '{}'::jsonb, now(), now());
  return v;
end $$;

-- One catalog row as the checks below spell it: name kind once monthly seats per-unit features active.
create or replace function pg_temp.product(p_code text)
returns text
language sql
as $$
  select bp.name || ' ' || bp.kind || ' ' || bp.one_time_price::int || ' ' || bp.monthly_price::int || ' '
         || bp.included_seats || ' ' || bp.seats_per_unit || ' ' || bp.features::text || ' ' || bp.is_active
    from public.billing_products bp where bp.code = p_code;
$$;

do $test$
declare
  v_owner        uuid := pg_temp.new_user('owner');
  v_stranger     uuid := pg_temp.new_user('stranger');
  v_admin        uuid := pg_temp.new_user('admin', true);
  v_cashier      uuid := pg_temp.new_user('cashier');
  v_branch_admin uuid := pg_temp.new_user('branch-admin');
  v_sfx          text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_code         text := 'ZZSP10' || upper(left(v_sfx, 6));
  v_ra uuid; v_a1 uuid; v_a2 uuid; v_a3 uuid;
  v_rb uuid; v_b1 uuid; v_b2 uuid; v_b3 uuid;
  v_q1 uuid; v_q2 uuid;
  v_sub_b uuid;
  v_version bigint;
  v_on boolean;
  r jsonb;
begin
  -- 0. What the migration left behind (§4.2, §6) ---------------------------------------------------
  perform pg_temp.expect('data: no subscription line sells delivery', '0',
    (select count(*)::text from public.subscription_items where product_code = 'delivery'));
  perform pg_temp.expect('data: every paying restaurant''s base and extra_branch lines are at the catalog price', '0',
    (select count(*)::text
       from public.subscription_items si
       join public.subscriptions s on s.id = si.subscription_id
       join public.billing_products pp on pp.code = s.plan_code
       join public.billing_products bp on bp.code = si.product_code
      where si.product_code in ('base', 'extra_branch')
        and coalesce(pp.trial_days, 0) = 0
        and si.unit_price <> bp.monthly_price));
  perform pg_temp.expect('data: every paying subscription''s unit_price is the plan''s', '0',
    (select count(*)::text
       from public.subscriptions s join public.billing_products pp on pp.code = s.plan_code
      where coalesce(pp.trial_days, 0) = 0 and s.unit_price <> pp.monthly_price));
  perform pg_temp.expect('data: no branch_addons row switches delivery ON (only the merchant''s off switch is left)', '0',
    (select count(*)::text from public.branch_addons where active));
  perform pg_temp.expect('data: no override switches a withdrawn feature on or repeats a plan feature', '0',
    (select count(*)::text
       from public.restaurants r,
            jsonb_each(case when jsonb_typeof(r.feature_overrides) = 'object' then r.feature_overrides else '{}'::jsonb end) e
      where e.value = to_jsonb(true)
        and e.key in ('ai_suite', 'ai_voice', 'digital_signage', 'ai_menu_import', 'card_payment', 'delivery')));
  perform pg_temp.expect('data: no restaurant is granted a withdrawn feature or carries an add-on', '0',
    (select count(*)::text from public.billing_entitlements be
      where be.addons <> '{}'::text[]
         or be.features ?| array['ai_suite', 'ai_voice', 'digital_signage', 'ai_menu_import']));
  perform pg_temp.expect('data: no pending request asks for delivery', '0',
    (select count(*)::text from public.billing_requests
      where status = 'pending' and (addons <> '{}'::text[] or delivery_branch_ids <> '{}'::uuid[])));

  -- 1. The catalog (§4.1) -------------------------------------------------------------------------
  perform pg_temp.expect('catalog: base', 'FavorNoms Plan plan 199 49 1 0 {"delivery": true, "card_payment": true} true',
    pg_temp.product('base'));
  perform pg_temp.expect('catalog: extra_branch', 'Additional branch addon 89 49 0 1 {} true',
    pg_temp.product('extra_branch'));
  perform pg_temp.expect('catalog: trial, still 14 days', 'Free trial plan 0 0 1 0 {"delivery": true, "card_payment": true} true 14',
    pg_temp.product('trial') || ' ' || (select trial_days from public.billing_products where code = 'trial'));
  perform pg_temp.expect('catalog: delivery is kept, withdrawn', 'Delivery (withdrawn) addon 0 0 0 0 {} false',
    pg_temp.product('delivery'));
  perform pg_temp.expect('catalog: ai_suite is kept, withdrawn, granting nothing', 'AI Suite (withdrawn) false {}',
    (select name || ' ' || is_active || ' ' || features::text from public.billing_products where code = 'ai_suite'));
  perform pg_temp.expect('catalog: "per branch" holds -- base and extra_branch cost the same a month', 'true',
    ((select monthly_price from public.billing_products where code = 'base')
       = (select monthly_price from public.billing_products where code = 'extra_branch'))::text);
  perform pg_temp.expect('catalog: no product grants a withdrawn feature (§2)', '0',
    (select count(*)::text from public.billing_products
      where features ?| array['ai_suite', 'ai_voice', 'digital_signage', 'ai_menu_import']));

  -- Fixture: restaurant A on its trial with two branches; restaurant B paying for three by hand.
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-sp-a-' || v_sfx, 'ZZ Single Plan A') returning id into v_ra;
  perform private.billing_apply_selection(v_ra, 'trial', '{}'::uuid[], 2, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'one', 'A One') returning id into v_a1;
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'two', 'A Two') returning id into v_a2;
  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status)
  values (v_cashier, v_ra, v_a1, 'cashier', 'active'), (v_branch_admin, v_ra, v_a1, 'admin', 'active');

  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-sp-b-' || v_sfx, 'ZZ Single Plan B') returning id into v_rb;
  perform pg_temp.act_as(v_admin, true);
  -- The delivery ids a caller still sends are ignored.
  perform public.billing_set_package(v_rb, 'base', 3, array[gen_random_uuid()], 'active', null);
  perform pg_temp.act_as(null);
  insert into public.branches (restaurant_id, slug, name) values (v_rb, 'one', 'B One') returning id into v_b1;
  insert into public.branches (restaurant_id, slug, name) values (v_rb, 'two', 'B Two') returning id into v_b2;
  insert into public.branches (restaurant_id, slug, name) values (v_rb, 'three', 'B Three') returning id into v_b3;
  select id into v_sub_b from public.subscriptions where restaurant_id = v_rb;

  insert into public.billing_discount_codes (code, kind, value, per_restaurant_limit)
  values (v_code, 'percent', 10, 5);

  -- 2. Delivery is in the plan at every branch (§2, §3) ---------------------------------------------
  perform pg_temp.expect('trial: $0, two seats, the plan''s features, no add-on', 'trial 0.00 2 {"delivery": true, "card_payment": true} {}',
    (select plan_code || ' ' || monthly_total || ' ' || branch_seats || ' ' || features::text || ' ' || addons::text
       from public.billing_entitlements where restaurant_id = v_ra));
  perform pg_temp.expect('trial: every branch delivers, with no branch_addons row', 'true true 0',
    private.branch_has_feature(v_a1, 'delivery')::text || ' ' || private.branch_has_feature(v_a2, 'delivery')::text || ' '
      || (select count(*) from public.branch_addons where branch_id in (v_a1, v_a2)));
  perform pg_temp.expect('paying by hand: 3 x $49, the plan''s features, no add-on', 'base 147.00 3 {"delivery": true, "card_payment": true} {}',
    (select plan_code || ' ' || monthly_total || ' ' || branch_seats || ' ' || features::text || ' ' || addons::text
       from public.billing_entitlements where restaurant_id = v_rb));
  perform pg_temp.expect('paying by hand: the lines are the plan and two seats at the catalog price', 'base:1:49,extra_branch:2:49',
    (select string_agg(product_code || ':' || quantity || ':' || unit_price::int, ',' order by product_code)
       from public.subscription_items where subscription_id = v_sub_b));
  perform pg_temp.expect('paying by hand: every branch delivers, none was sold delivery', 'true true true 0',
    private.branch_has_feature(v_b1, 'delivery')::text || ' ' || private.branch_has_feature(v_b2, 'delivery')::text || ' '
      || private.branch_has_feature(v_b3, 'delivery')::text || ' '
      || (select count(*) from public.branch_addons where branch_id in (v_b1, v_b2, v_b3)));
  perform pg_temp.expect('entitlements: delivery_branch_ids lists the branches that deliver now, and so does the old key', '3 true',
    jsonb_array_length(private.entitlements_json(v_rb) -> 'delivery_branch_ids')::text || ' '
      || ((private.entitlements_json(v_rb) -> 'delivery_branch_ids') = (private.entitlements_json(v_rb) -> 'delivery_unlocked_branch_ids'))::text);
  perform pg_temp.expect('storefront: delivery entitled, card payment on', 'true true',
    (public.storefront_status(v_b2) ->> 'delivery_entitled') || ' ' || (public.storefront_status(v_b2) ->> 'card_payment'));
  perform pg_temp.expect('paid state: nothing is unlocked per branch any more', '[]',
    (private.billing_paid_state(v_rb) -> 'delivery_unlocked_branch_ids')::text);

  -- 3. What a purchase costs (§1) ---------------------------------------------------------------------
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_ra, 'base', 2, array[v_a1], null, null);
  perform pg_temp.act_as(null);
  v_q1 := (r ->> 'id')::uuid;
  perform pg_temp.expect('request: two branches are $199 + $89 once and $98 a month; the delivery ids sent are ignored',
    'true 288 98 {} {}',
    (r ->> 'ok') || ' ' || (r ->> 'one_time_total')::numeric::int || ' ' || (r ->> 'monthly_total')::numeric::int || ' '
      || (select addons::text || ' ' || delivery_branch_ids::text from public.billing_requests where id = v_q1));
  perform pg_temp.expect('request: its one-time charges are the base and one seat, no delivery charge', 'base:199,extra_branch:89',
    (select string_agg(code || ':' || amount::int, ',' order by code) from public.billing_charges where request_id = v_q1));
  -- An old request that still names delivering branches is priced without delivery all the same.
  update public.billing_requests set delivery_branch_ids = array[v_a1, v_a2], addons = array['delivery'] where id = v_q1;
  perform pg_temp.act_as(v_owner);
  r := public.billing_checkout_context(v_q1);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('checkout context: the plan and one seat at $49, no delivery line', 'base:1:4900,extra_branch:1:4900',
    (select string_agg((e ->> 'code') || ':' || (e ->> 'quantity') || ':' || (e ->> 'unit_amount_cents'), ',' order by ord)
       from jsonb_array_elements(r -> 'monthly_lines') with ordinality as t(e, ord)));
  perform pg_temp.act_as(v_owner);
  r := public.validate_billing_discount(v_ra, v_code, 'base', 3, array[v_a1, v_a2]);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('discount: three branches are $377 once, 10% off', 'true 377 37.70 339.30',
    (r ->> 'valid') || ' ' || (r ->> 'one_time_total')::numeric::int || ' '
      || round((r ->> 'amount_off')::numeric, 2) || ' ' || round((r ->> 'net_total')::numeric, 2));

  perform pg_temp.act_as(v_admin, true);
  r := public.decide_billing_request(v_q1, true, 'bank transfer');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('approved: base, two seats, $98 a month, both branches deliver, no row written', 'base 98.00 2 true true 0',
    (select plan_code || ' ' || monthly_total || ' ' || branch_seats from public.billing_entitlements where restaurant_id = v_ra) || ' '
      || private.branch_has_feature(v_a1, 'delivery')::text || ' ' || private.branch_has_feature(v_a2, 'delivery')::text || ' '
      || (select count(*) from public.branch_addons where branch_id in (v_a1, v_a2)));
  perform pg_temp.expect('approved: the base and the seat are paid', 'true 2 []',
    (private.billing_paid_state(v_ra) ->> 'base_paid') || ' ' || (private.billing_paid_state(v_ra) ->> 'seats_paid') || ' '
      || (private.billing_paid_state(v_ra) -> 'delivery_unlocked_branch_ids')::text);
  perform pg_temp.act_as(v_owner);
  r := public.request_package_change(v_ra, 'base', 3, '{}'::uuid[], null, null);
  perform pg_temp.act_as(null);
  v_q2 := (r ->> 'id')::uuid;
  perform pg_temp.expect('a third branch later: $89 once, $147 a month', '89 147 extra_branch:89',
    (r ->> 'one_time_total')::numeric::int || ' ' || (r ->> 'monthly_total')::numeric::int || ' '
      || (select string_agg(code || ':' || amount::int, ',') from public.billing_charges where request_id = v_q2));
  perform pg_temp.act_as(v_admin, true);
  perform public.decide_billing_request(v_q2, false, 'test');
  perform pg_temp.act_as(null);

  -- 4. A stray delivery line is neither billed nor granted, and the next package change deletes it.
  insert into public.subscription_items (subscription_id, product_code, quantity, unit_price)
  values (v_sub_b, 'delivery', 2, 30);
  perform pg_temp.expect('stray delivery line: not billed, no add-on listed', '147.00 {}',
    (select monthly_total || ' ' || addons::text from public.billing_entitlements where restaurant_id = v_rb));
  perform pg_temp.act_as(v_admin, true);
  perform public.billing_set_package(v_rb, 'base', 3, '{}'::uuid[], 'active', null);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('stray delivery line: removed by the next package change', '0',
    (select count(*)::text from public.subscription_items where subscription_id = v_sub_b and product_code = 'delivery'));

  -- 5. The merchant's switch (§3) --------------------------------------------------------------------
  select version into v_version from public.storefront_versions where branch_id = v_a2;
  perform pg_temp.act_as(v_owner);
  perform pg_temp.expect('switch off: answers false', 'false', public.set_branch_delivery(v_a2, false)::text);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('switch off: one row with active = false, the branch no longer delivers', 'false false false',
    (select active::text from public.branch_addons where branch_id = v_a2 and code = 'delivery') || ' '
      || private.branch_feature_granted(v_a2, 'delivery')::text || ' ' || private.branch_has_feature(v_a2, 'delivery')::text);
  perform pg_temp.expect('switch off: the storefront stops offering delivery there, not at the other branch', 'false false true',
    (public.storefront_status(v_a2) ->> 'delivery_entitled') || ' ' || (public.storefront_status(v_a2) ->> 'delivery') || ' '
      || (public.storefront_status(v_a1) ->> 'delivery_entitled'));
  perform pg_temp.expect('switch off: the storefront version is bumped, so an open storefront refreshes', 'true',
    ((select version from public.storefront_versions where branch_id = v_a2) = coalesce(v_version, 0) + 1)::text);
  perform pg_temp.expect('switch off: entitlements list only the other branch; the branch payload says no, the restaurant''s still yes',
    'true false true',
    ((private.entitlements_json(v_ra) -> 'delivery_branch_ids') = jsonb_build_array(v_a1))::text || ' '
      || (private.entitlements_json(v_ra, v_a2) #>> '{features,delivery}') || ' '
      || (private.entitlements_json(v_ra) #>> '{features,delivery}'));
  perform pg_temp.act_as(v_owner);
  r := public.get_billing_overview(v_ra);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('overview: each branch says whether it delivers now; delivery_unlocked is always true',
    'A One:true:true,A Two:false:true',
    (select string_agg((e ->> 'name') || ':' || (e ->> 'delivery_active') || ':' || (e ->> 'delivery_unlocked'), ',' order by e ->> 'name')
       from jsonb_array_elements(r -> 'branches') e));
  -- Each write below is its own statement: a check that read the table in the same statement as
  -- the call would see the snapshot taken before the call wrote.
  select version into v_version from public.storefront_versions where branch_id = v_a2;
  perform pg_temp.act_as(v_owner);
  v_on := public.set_branch_delivery(v_a2, false);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('switch off twice: still false, nothing written, no bump', 'false 1 true',
    v_on::text || ' ' || (select count(*) from public.branch_addons where branch_id = v_a2) || ' '
      || ((select version from public.storefront_versions where branch_id = v_a2) = v_version)::text);

  -- No billing writer touches the switch, whatever delivery ids it is sent.
  perform pg_temp.act_as(v_admin, true);
  perform public.billing_set_package(v_ra, 'base', 3, array[v_a1, v_a2], 'active', null);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('a package change neither switches delivery on nor off', 'false true',
    private.branch_feature_granted(v_a2, 'delivery')::text || ' ' || private.branch_feature_granted(v_a1, 'delivery')::text);

  perform pg_temp.act_as(v_owner);
  v_on := public.set_branch_delivery(v_a2, true);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('switch on: answers true, the row is gone, the branch delivers', 'true 0 true',
    v_on::text || ' ' || (select count(*) from public.branch_addons where branch_id = v_a2) || ' '
      || private.branch_has_feature(v_a2, 'delivery')::text);
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'three', 'A Three') returning id into v_a3;
  perform pg_temp.expect('a branch opened since delivers with no row of its own', 'true 0',
    private.branch_has_feature(v_a3, 'delivery')::text || ' ' || (select count(*) from public.branch_addons where branch_id = v_a3));

  -- A platform admin's delivery:false switches it off everywhere; the branch switch cannot undo it.
  perform pg_temp.act_as(v_admin, true);
  perform public.platform_set_feature_override(v_ra, 'delivery', 'off');
  perform pg_temp.act_as(null);
  perform pg_temp.expect('override delivery off: no branch delivers, whatever the switch says', 'false false []',
    private.branch_feature_granted(v_a1, 'delivery')::text || ' ' || private.branch_feature_granted(v_a3, 'delivery')::text || ' '
      || (private.entitlements_json(v_ra) -> 'delivery_branch_ids')::text);
  perform pg_temp.act_as(v_admin, true);
  perform public.platform_set_feature_override(v_ra, 'delivery', 'plan');
  perform pg_temp.act_as(null);

  -- 6. Who may switch it -----------------------------------------------------------------------------
  perform pg_temp.expect('switch: the owner', 'ok false',
    pg_temp.try_as(v_owner, array[format('select public.set_branch_delivery(%L, false)::text', v_a1)]));
  perform pg_temp.expect('switch: a branch admin at their branch (branch.settings)', 'ok false',
    pg_temp.try_as(v_branch_admin, array[format('select public.set_branch_delivery(%L, false)::text', v_a1)]));
  perform pg_temp.expect('switch: a branch admin at another branch is refused', 'ERR forbidden',
    pg_temp.try_as(v_branch_admin, array[format('select public.set_branch_delivery(%L, false)::text', v_a2)]));
  perform pg_temp.expect('switch: a cashier is refused', 'ERR forbidden',
    pg_temp.try_as(v_cashier, array[format('select public.set_branch_delivery(%L, false)::text', v_a1)]));
  perform pg_temp.expect('switch: a stranger is refused', 'ERR forbidden',
    pg_temp.try_as(v_stranger, array[format('select public.set_branch_delivery(%L, false)::text', v_a1)]));
  perform pg_temp.expect('switch: a platform admin', 'ok false',
    pg_temp.try_as(v_admin, array[format('select public.set_branch_delivery(%L, false)::text', v_b1)], true));
  perform pg_temp.expect('switch: anon cannot call it at all', 'ERR permission denied for function set_branch_delivery',
    pg_temp.try_as(null, array[format('select public.set_branch_delivery(%L, false)::text', v_a1)]));
  perform pg_temp.expect('switch: an unknown branch is named', 'ERR branch_not_found',
    pg_temp.try_as(v_admin, array['select public.set_branch_delivery(gen_random_uuid(), false)::text'], true));
  perform pg_temp.expect('switch: on/off must be given', 'ERR invalid_argument',
    pg_temp.try_as(v_owner, array[format('select public.set_branch_delivery(%L, null)::text', v_a1)]));
  perform pg_temp.expect('switch: nobody writes branch_addons directly', 'ERR permission denied for table branch_addons',
    pg_temp.try_as(v_owner, array[format(
      'insert into public.branch_addons (branch_id, code, active) values (%L, ''delivery'', false) returning 1', v_a1)]));
  perform pg_temp.act_as(v_owner);
  perform public.set_branch_delivery(v_a1, false);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('switch: staff of the branch read it, a stranger does not', 'ok 1|ok 0',
    pg_temp.try_as(v_cashier, array[format('select count(*)::text from public.branch_addons where branch_id = %L', v_a1)])
      || '|' || pg_temp.try_as(v_stranger, array[format('select count(*)::text from public.branch_addons where branch_id = %L', v_a1)]));
  perform pg_temp.act_as(v_owner);
  perform public.set_branch_delivery(v_a1, true);
  perform pg_temp.act_as(null);
  perform pg_temp.expect('switch: executable by authenticated only; SECURITY DEFINER, search_path pinned',
    'true false false true search_path=public, pg_temp',
    has_function_privilege('authenticated', 'public.set_branch_delivery(uuid,boolean)', 'execute')::text || ' '
      || has_function_privilege('anon', 'public.set_branch_delivery(uuid,boolean)', 'execute')::text || ' '
      || has_function_privilege('service_role', 'public.set_branch_delivery(uuid,boolean)', 'execute')::text || ' '
      || (select prosecdef::text || ' ' || array_to_string(proconfig, ',') from pg_proc
           where oid = 'public.set_branch_delivery(uuid,boolean)'::regprocedure));

  -- 7. The card-rail delivery guards are gone (§4.2) ----------------------------------------------
  perform pg_temp.expect('guards: the triggers and their functions are dropped, and the unlock helpers', '0 <null> <null> <null> <null>',
    (select count(*) from pg_trigger
      where tgname in ('branches_block_stripe_delivery_loss', 'branches_block_stripe_delivery_loss_delete',
                       'branches_stripe_delivery_off_on_hide'))::text || ' '
      || coalesce(to_regprocedure('private.guard_branch_stripe_delivery()')::text, '<null>') || ' '
      || coalesce(to_regprocedure('private.tg_branches_stripe_delivery_off()')::text, '<null>') || ' '
      || coalesce(to_regprocedure('private.branch_delivery_unlocked(uuid)')::text, '<null>') || ' '
      || coalesce(to_regprocedure('private.delivery_unlocked_branch_ids(uuid)')::text, '<null>'));
  update public.subscriptions set stripe_subscription_id = 'sub_TESTSP' || v_sfx where restaurant_id = v_rb;
  perform pg_temp.expect('guards: the owner hides a branch of a card restaurant, and delivery is not touched', 'true ok 0',
    private.billing_is_stripe_managed(v_rb)::text || ' '
      || pg_temp.try_as(v_owner, array[format('update public.branches set is_active = false where id = %L returning 1', v_b3),
           format('select count(*)::text from public.branch_addons where branch_id = %L', v_b3)]));
  perform pg_temp.expect('guards: and deletes one', 'ok 0',
    pg_temp.try_service(array[format('delete from public.branches where id = %L returning 1', v_b3),
      format('select count(*)::text from public.branches where id = %L', v_b3)]));
  update public.subscriptions set stripe_subscription_id = null where restaurant_id = v_rb;

  -- 8. restaurants.feature_overrides is the platform's (§2) ---------------------------------------
  perform pg_temp.expect('overrides: the owner cannot write them', 'ERR restaurant_privileged_column_denied',
    pg_temp.try_as(v_owner, array[format(
      'update public.restaurants set feature_overrides = ''{"ai_suite": true}''::jsonb where id = %L returning 1', v_ra)]));
  perform pg_temp.expect('overrides: the owner still renames the restaurant', 'ok 1',
    pg_temp.try_as(v_owner, array[format('update public.restaurants set name = ''ZZ Renamed'' where id = %L returning 1', v_ra)]));
  perform pg_temp.expect('overrides: a platform admin writes them, directly or through the console''s RPC', 'ok 1|ok true',
    pg_temp.try_as(v_admin, array[format(
      'update public.restaurants set feature_overrides = ''{"ai_voice": false}''::jsonb where id = %L returning 1', v_ra)], true)
      || '|' || pg_temp.try_as(v_admin, array[format(
      'select public.platform_set_feature_override(%L, ''digital_signage'', ''off'') ->> ''ok''', v_ra)], true));
  perform pg_temp.expect('overrides: the service role is not policed', 'ok 1',
    pg_temp.try_service(array[format(
      'update public.restaurants set feature_overrides = ''{}''::jsonb where id = %L returning 1', v_ra)]));
  perform pg_temp.expect('overrides: nor can a restaurant be born with them (insert)', 'ERR restaurant_privileged_column_denied',
    pg_temp.try_as(v_owner, array[format(
      'insert into public.restaurants (owner_user_id, slug, name, feature_overrides) values (%L, %L, ''ZZ Born'', ''{"ai_suite": true}''::jsonb) returning 1',
      v_owner, 'zz-sp-ins-' || v_sfx)]));
  perform pg_temp.expect('overrides: nor with raw loyalty settings', 'ERR restaurant_privileged_column_denied',
    pg_temp.try_as(v_owner, array[format(
      'insert into public.restaurants (owner_user_id, slug, name, loyalty_settings) values (%L, %L, ''ZZ Born'', ''{"enabled": true}''::jsonb) returning 1',
      v_owner, 'zz-sp-ins-' || v_sfx)]));
  perform pg_temp.expect('overrides: a plain insert still works', 'ok 1',
    pg_temp.try_as(v_owner, array[format(
      'insert into public.restaurants (owner_user_id, slug, name) values (%L, %L, ''ZZ Born'') returning 1',
      v_owner, 'zz-sp-ins-' || v_sfx)]));
  -- try_as rolls back after each call, so the insert and the trial go in one call.
  perform pg_temp.expect('trial: an owner of another restaurant gets no second free trial', 'ERR trial_already_used',
    pg_temp.try_as(v_owner, array[
      format('insert into public.restaurants (owner_user_id, slug, name) values (%L, %L, ''ZZ Born'') returning 1',
             v_owner, 'zz-sp-ins-' || v_sfx),
      format('select public.billing_start_trial((select id from public.restaurants where slug = %L))::text',
             'zz-sp-ins-' || v_sfx)]));
  perform pg_temp.expect('trial: a platform admin may still start one', 'ok trialing',
    pg_temp.try_as(v_admin, array[
      format('insert into public.restaurants (owner_user_id, slug, name) values (%L, %L, ''ZZ Born'') returning 1',
             v_owner, 'zz-sp-ins-' || v_sfx),
      format('select public.billing_start_trial((select id from public.restaurants where slug = %L)) ->> ''status''',
             'zz-sp-ins-' || v_sfx)], true));

  -- 9. Delivery needs the restaurant paid up -------------------------------------------------------
  update public.subscriptions set status = 'expired' where restaurant_id = v_ra;
  perform pg_temp.expect('lapsed: no branch delivers now, though the plan still grants delivery', 'false [] true',
    private.branch_feature_granted(v_a1, 'delivery')::text || ' '
      || (private.entitlements_json(v_ra) -> 'delivery_branch_ids')::text || ' '
      || (private.entitlements_json(v_ra) #>> '{features,delivery}'));
  perform pg_temp.act_as(v_owner);
  perform pg_temp.expect('lapsed: the switch is free and still works', 'false',
    public.set_branch_delivery(v_a1, false)::text);
  perform pg_temp.act_as(null);
end
$test$;

select seq, verdict, check_name, expected, actual from t_out
union all
select 999999, (select case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAILURES' end from t_out),
       format('%s checks, %s failed', count(*), count(*) filter (where verdict = 'FAIL')), null, null
  from t_out
order by 1;

rollback;
