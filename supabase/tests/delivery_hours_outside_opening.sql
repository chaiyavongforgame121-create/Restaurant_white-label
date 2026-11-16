begin;

-- Delivery hours outside opening hours (20261116100000_delivery_hours_outside_opening, the owner's
-- report of 2026-11-16). A rolled-back script, not a migration. Pins, at a shop open 09:00-17:30
-- every day that delivers and takes bookings 08:00-09:00 and 18:00-19:00 (America/Chicago):
-- is_branch_open_for judging a delivery by the delivery windows alone while "Limit delivery to set
-- hours" is on (08:30 and 18:30 open, 12:00 and 19:30 closed), by opening hours while it is off, and
-- pickup, dine-in and QR orders by opening hours either way; an overnight delivery window; a
-- closure, a pause and a hidden branch closing delivery, an unknown branch false; the owner's switch
-- in the admin (patch_branch_settings) turning one rule into the other; storefront_status's new
-- delivery_open_now (a boolean, beside every old key, false for an unknown branch) open from the
-- delivery windows while the shop is shut, closed by a pause or a closure; and the BEFORE INSERT
-- gates on orders: a diner's delivery booked for 08:30 inserted with delivery hours and booking
-- windows on, refused branch_closed_at_scheduled_time with delivery hours off, a 12:00 delivery
-- refused by the delivery-hours gate (it fires first), a pickup at 08:30 refused, the booking
-- windows still applying to diners and not to the till. Section 0 checks what the migration left
-- behind: the new function and its grants (is_branch_open's), tg_enforce_scheduled_time and
-- storefront_status changed only as described, and five functions as they were live.
--
-- Run it on a LOCAL stack where you can (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/delivery_hours_outside_opening.sql
-- Before the migration is applied, run the migration and this file in one transaction instead: a
-- "begin;" of your own, then the migration without its own "begin;" and "commit;", then this file
-- without its own "begin;". Section 0's "as live" checks compare with definitions read live on
-- 2026-11-16 (pg_get_functiondef), so they hold on the real schema.
--
-- Everything happens inside one transaction that ends in ROLLBACK, on a restaurant this script
-- creates for itself (section 0 only reads). now() is the transaction's start for the whole script.
-- The times under test are tomorrow's, in the branch's zone, so they never depend on the hour the
-- script runs; the "right now" checks of section 5 first move the hours so the answer is known.
--   pg_temp.try_as(role, uid, sqls[])  as `anon` (uid null), `authenticated` or `service_role`, in a
--                                      subtransaction that is always rolled back; reports
--                                      'ok <last value>' or 'ERR <sqlstate> <message>'.
--   pg_temp.try_sql(sqls[])            the same as the script itself with no JWT (a migration, the
--                                      SQL editor): only triggers and constraints apply. Every check
--                                      that writes runs here, so nothing leaks into the next one.
--   pg_temp.call_as(uid, sql)          with uid's JWT claims (the role stays the script's), KEPT when
--                                      it succeeds. Reports the same way; the claims are cleared
--                                      afterwards either way.
--   pg_temp.act_as(uid)                sets only the JWT claims, so auth.uid() is that person while
--                                      the statements that follow keep their effect. act_as(null)
--                                      clears them.
--
-- People (auth.users rows made here):
--   owner    restaurants.owner_user_id of the test restaurant (branch.settings everywhere)
--
-- Restaurant zz-dho-<s>, on its trial (every branch delivers), two branches in America/Chicago with
-- the same week: opening hours 09:00-17:30, delivery windows and booking windows 08:00-09:00 and
-- 18:00-19:00, every day; booking windows switched on at both.
--   on    delivery_hours_enabled true   ("Limit delivery to set hours" ticked)
--   off   delivery_hours_enabled false
--
-- Each section after the fixtures runs in its own block: one that breaks reports a FAIL row and
-- the others still run. Nothing a section writes is kept. The result is one row per check with
-- PASS/FAIL, then a summary row.

create temp table t_out (
  seq serial,
  check_name text,
  expected text,
  actual text,
  verdict text
) on commit drop;

-- Run statements as p_role (p_uid's JWT when given) and report 'ok <last value>' or
-- 'ERR <sqlstate> <message>'. Always rolled back.
create or replace function pg_temp.try_as(p_role text, p_uid uuid, p_sqls text[])
returns text
language plpgsql
as $$
declare
  s text;
  v_last text;
  v_msg text;
  v_det text;
  v_state text;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', p_role,
                        'app_metadata', json_build_object('is_platform_admin', false))::text, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    perform set_config('role', p_role, true);
    foreach s in array p_sqls loop
      execute s into v_last;
    end loop;
    raise exception using message = 'TRY_AS_OK', detail = coalesce(v_last, '');
  exception when others then
    get stacked diagnostics v_msg = message_text, v_det = pg_exception_detail, v_state = returned_sqlstate;
    if v_msg = 'TRY_AS_OK' then
      return 'ok' || case when coalesce(v_det, '') <> '' then ' ' || v_det else '' end;
    end if;
    return 'ERR ' || v_state || ' ' || v_msg;
  end;
end $$;

-- Run statements as the script's own database role with no JWT claims. Reports like try_as.
-- Always rolled back.
create or replace function pg_temp.try_sql(p_sqls text[])
returns text
language plpgsql
as $$
declare
  s text;
  v_last text;
  v_msg text;
  v_det text;
  v_state text;
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    foreach s in array p_sqls loop
      execute s into v_last;
    end loop;
    raise exception using message = 'TRY_AS_OK', detail = coalesce(v_last, '');
  exception when others then
    get stacked diagnostics v_msg = message_text, v_det = pg_exception_detail, v_state = returned_sqlstate;
    if v_msg = 'TRY_AS_OK' then
      return 'ok' || case when coalesce(v_det, '') <> '' then ' ' || v_det else '' end;
    end if;
    return 'ERR ' || v_state || ' ' || v_msg;
  end;
end $$;

-- Run one statement with p_uid's JWT claims (the database role stays the script's) and KEEP what
-- it did when it succeeds. 'ok <value>' or 'ERR <sqlstate> <message>' (then nothing it did is
-- kept). The claims are cleared afterwards.
create or replace function pg_temp.call_as(p_uid uuid, p_sql text)
returns text
language plpgsql
as $$
declare
  v_last text;
  v_msg text;
  v_state text;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated',
                        'app_metadata', json_build_object('is_platform_admin', false))::text, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    execute p_sql into v_last;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return 'ok' || case when coalesce(v_last, '') <> '' then ' ' || v_last else '' end;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return 'ERR ' || v_state || ' ' || v_msg;
  end;
end $$;

-- Who auth.uid() is for the statements that follow (null: nobody, no JWT). The database role
-- stays the script's.
create or replace function pg_temp.act_as(p_uid uuid)
returns void
language plpgsql
as $$
begin
  if p_uid is null then
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated',
                        'app_metadata', json_build_object('is_platform_admin', false))::text, true);
    perform set_config('request.jwt.claim.sub', p_uid::text, true);
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

create or replace function pg_temp.new_user(p_label text)
returns uuid
language plpgsql
as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v, 'delivery-hours-outside-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', false), '{}'::jsonb, now(), now());
  return v;
end $$;

-- A function body with carriage returns and comments dropped and every run of white space made one
-- space: two bodies equal under it differ in layout, line endings or comments only (live's
-- storefront_status was saved with CRLF line endings).
create or replace function pg_temp.norm(p_src text)
returns text
language sql
immutable
as $$
  select btrim(regexp_replace(
           regexp_replace(replace(p_src, chr(13), ''), '--[^' || chr(10) || ']*', '', 'g'),
           '[[:space:]]+', ' ', 'g'));
$$;

-- Who may EXECUTE a function: PUBLIC (an explicit ACL entry), then the three API roles.
create or replace function pg_temp.grants(p_fn regprocedure)
returns text
language sql
stable
as $$
  select 'PUBLIC=' || (exists (select 1 from pg_proc p
                                cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                where p.oid = p_fn and a.grantee = 0 and a.privilege_type = 'EXECUTE'))::text
      || ' anon=' || has_function_privilege('anon', p_fn::oid, 'execute')::text
      || ' authenticated=' || has_function_privilege('authenticated', p_fn::oid, 'execute')::text
      || ' service_role=' || has_function_privilege('service_role', p_fn::oid, 'execute')::text;
$$;

-- "<owner> <security definer> <volatility> <settings> <returns>" of a function.
create or replace function pg_temp.shape(p_fn regprocedure)
returns text
language sql
stable
as $$
  select pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' ' || p.provolatile::text || ' '
         || coalesce(array_to_string(p.proconfig, ','), '-') || ' ' || format_type(p.prorettype, null)
    from pg_proc p
   where p.oid = p_fn;
$$;

do $test$
declare
  v_owner uuid := pg_temp.new_user('owner');
  v_sfx   text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_r uuid; v_on uuid; v_off uuid;
  -- Tomorrow in the branch's zone, and today's weekday there.
  v_day   date := (now() at time zone 'America/Chicago')::date + 1;
  v_dow   int  := extract(dow from (now() at time zone 'America/Chicago'))::int;
  t_0830  timestamptz := (v_day + time '08:30') at time zone 'America/Chicago';
  t_1200  timestamptz := (v_day + time '12:00') at time zone 'America/Chicago';
  t_1830  timestamptz := (v_day + time '18:30') at time zone 'America/Chicago';
  t_1930  timestamptz := (v_day + time '19:30') at time zone 'America/Chicago';
  t_2300  timestamptz := (v_day + time '23:00') at time zone 'America/Chicago';
  t_0100n timestamptz := (v_day + 1 + time '01:00') at time zone 'America/Chicago';
  t_0230n timestamptz := (v_day + 1 + time '02:30') at time zone 'America/Chicago';
  v_times timestamptz[];
  s_on jsonb; s_off jsonb; s_x jsonb;
  v_want text;
  v_have text;
  -- is_branch_open_for (or is_branch_open, is_delivery_available) at each time, in order.
  c_open  constant text := 'select string_agg(coalesce(public.is_branch_open_for(%L::uuid, %L, u.t)::text, ''<null>''), '','' order by u.i) from unnest(%L::timestamptz[]) with ordinality as u(t, i)';
  c_old   constant text := 'select string_agg(coalesce(public.is_branch_open(%L::uuid, u.t)::text, ''<null>''), '','' order by u.i) from unnest(%L::timestamptz[]) with ordinality as u(t, i)';
  c_avail constant text := 'select string_agg(coalesce(public.is_delivery_available(%L::uuid, u.t)::text, ''<null>''), '','' order by u.i) from unnest(%L::timestamptz[]) with ordinality as u(t, i)';
  -- An order as the BEFORE INSERT triggers see it: number, branch, channel, source, booked time.
  c_order constant text := 'insert into public.orders (order_number, branch_id, channel, source, status, subtotal, total, status_history, scheduled_for) values (%L, %L::uuid, %L::public.order_channel, %L, ''pending'', 10, 10, ''[]''::jsonb, %L::timestamptz) returning ''inserted''::text';
  c_set     constant text := 'update public.branches set settings = coalesce(settings, ''{}''::jsonb) || %L::jsonb where id = %L::uuid returning id';
  c_closure constant text := 'insert into public.branch_closures (branch_id, starts_at, ends_at, reason) values (%L::uuid, %L::timestamptz, %L::timestamptz, ''ZZ test closure'') returning id';
  -- Delivery windows replaced by one covering the whole of every day (a window closing at or
  -- before it opens crosses midnight, and 00:00-00:00 is the whole day).
  c_no_delivery_hours constant text := 'delete from public.branch_delivery_hours where branch_id = %L::uuid returning id';
  c_all_day_delivery  constant text := 'insert into public.branch_delivery_hours (branch_id, day_of_week, opens_at, closes_at) select %L::uuid, d, time ''00:00'', time ''00:00'' from generate_series(0, 6) d returning id';
  c_no_opening_hours  constant text := 'delete from public.branch_hours where branch_id = %L::uuid returning id';
  -- delivery_open_now | is_branch_open now | the old delivery key, of one branch.
  c_now constant text := 'select concat_ws(''|'', public.storefront_status(%L::uuid) ->> ''delivery_open_now'', public.is_branch_open(%L::uuid)::text, public.storefront_status(%L::uuid) ->> ''delivery'')';
  c_closed_at constant text := 'ERR P0001 branch_closed_at_scheduled_time';
  c_keys constant text := 'card_payment,card_ready,delivery,delivery_available,delivery_entitled,delivery_hours_on,delivery_mode,delivery_open_now,delivery_windows,entitled,opening_hours,schedule_max_days,schedule_min_lead_min,schedule_slot_minutes,scheduling_enabled,timezone';
  -- The live bodies (pg_get_functiondef, 2026-11-16) of the two functions the migration re-creates.
  c_live_trigger constant text := $live$
begin
  if new.scheduled_for is null then return new; end if;

  if not public.is_branch_open(new.branch_id, new.scheduled_for) then
    raise exception 'branch_closed_at_scheduled_time' using errcode = 'P0001';
  end if;

  -- Staff surfaces are exempt from the bookable-window rule ONLY. It is a self-service
  -- policy for diners; a manager taking a phone booking at the till IS the override. They
  -- are not exempt from opening hours above, which place-order already enforces for them.
  -- place-order applies the same exemption; if the two diverge, a counter booking passes
  -- there and dies here as an unexplained failure.
  if coalesce(new.source, 'web') in ('counter', 'pos') then return new; end if;

  if not public.is_schedule_window_open(new.branch_id, new.scheduled_for) then
    raise exception 'outside_scheduling_window' using errcode = 'P0001';
  end if;

  return new;
end $live$;
  c_live_status constant text := $live$
  select coalesce((
    select jsonb_build_object(
      'entitled',           coalesce(b.entitled_through is not null and b.entitled_through > now(), false),
      'delivery',           coalesce(private.branch_has_feature(b.id, 'delivery')
                                     and public.is_delivery_available(b.id), false),
      'delivery_entitled',  coalesce(private.branch_has_feature(b.id, 'delivery'), false),
      'delivery_available', public.is_delivery_available(b.id),
      'delivery_hours_on',  coalesce((b.settings->>'delivery_hours_enabled')::boolean, false),
      'delivery_mode',      coalesce(b.settings->>'delivery_mode', 'platform'),
      'delivery_windows',   coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'day_of_week', h.day_of_week,
                                       'opens_at', to_char(h.opens_at,'HH24:MI'),
                                       'closes_at', to_char(h.closes_at,'HH24:MI'))
                                     order by h.day_of_week, h.opens_at)
                              from public.branch_delivery_hours h where h.branch_id = b.id
                            ), '[]'::jsonb),
      -- Sold with the base, so it stays restaurant-wide.
      'card_payment',       coalesce(b.entitled_through > now() and (be.features -> 'card_payment') = to_jsonb(true), false),
      -- The branch's own Stripe account can take charges. The checkout offers card only when
      -- card_payment AND card_ready are both true; the account id itself is never exposed.
      'card_ready',         private.branch_card_ready(b.id),

      'timezone',           coalesce(b.timezone, 'America/New_York'),
      -- Empty array means "no hours configured", which is_branch_open() treats as
      -- always-open. The client must read it the same way, so the distinction between
      -- "no hours" and "closed all week" is preserved rather than flattened to [].
      'opening_hours',      coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'day_of_week', h.day_of_week,
                                       'opens_at', to_char(h.opens_at,'HH24:MI'),
                                       'closes_at', to_char(h.closes_at,'HH24:MI'))
                                     order by h.day_of_week, h.opens_at)
                              from public.branch_hours h where h.branch_id = b.id
                            ), '[]'::jsonb),
      'scheduling_enabled', coalesce((b.settings->>'scheduling_enabled')::boolean, true),
      'schedule_min_lead_min', greatest(0, coalesce((b.settings->>'schedule_min_lead_min')::int, 15)),
      'schedule_max_days',     greatest(0, coalesce((b.settings->>'schedule_max_days')::int, 14)),
      'schedule_slot_minutes', greatest(5, coalesce((b.settings->>'schedule_slot_minutes')::int, 15))
    )
    from public.branches b
    left join public.billing_entitlements be on be.restaurant_id = b.restaurant_id
    where b.id = p_branch_id
  ), jsonb_build_object('entitled', false, 'delivery', false, 'delivery_entitled', false,
                        'delivery_available', false, 'delivery_hours_on', false,
                        'delivery_mode', 'platform', 'delivery_windows', '[]'::jsonb,
                        'card_payment', false, 'card_ready', false,
                        'timezone', 'America/New_York', 'opening_hours', '[]'::jsonb,
                        'scheduling_enabled', false,
                        'schedule_min_lead_min', 15, 'schedule_max_days', 14,
                        'schedule_slot_minutes', 15));
$live$;
begin
  v_times := array[t_0830, t_1200, t_1830, t_1930];

  -- 0. What the migration left behind ----------------------------------------------------------
  begin
    perform pg_temp.expect('is_branch_open_for: postgres, SECURITY DEFINER, STABLE, search_path pinned, returns boolean; it has a comment',
      'is_branch_open_for(uuid,text,timestamp with time zone) postgres true s search_path=public, pg_temp boolean true',
      (select p.oid::regprocedure::text || ' ' || pg_temp.shape(p.oid::regprocedure) || ' '
              || (obj_description(p.oid, 'pg_proc') is not null)::text
         from pg_proc p
        where p.oid = to_regprocedure('public.is_branch_open_for(uuid,text,timestamptz)')));
    perform pg_temp.expect('is_branch_open_for: one signature, (p_branch_id uuid, p_channel text, p_at timestamptz default now())',
      'p_branch_id uuid, p_channel text, p_at timestamp with time zone DEFAULT now()',
      (select string_agg(pg_get_function_arguments(p.oid), '|')
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname = 'is_branch_open_for'));
    perform pg_temp.expect('is_branch_open_for: exactly is_branch_open''s grants (PUBLIC, anon, authenticated, service_role)',
      coalesce(pg_temp.grants(to_regprocedure('public.is_branch_open(uuid,timestamptz)')), '<is_branch_open missing>'),
      pg_temp.grants(to_regprocedure('public.is_branch_open_for(uuid,text,timestamptz)')));
    perform pg_temp.expect('is_branch_open_for: the diner (anon), the admin (authenticated) and place-order (service_role) may call it; an unknown branch is false',
      'ok false|ok false|ok false',
      pg_temp.try_as('anon', null, array[format('select public.is_branch_open_for(%L::uuid, ''delivery'')::text', gen_random_uuid())]) || '|'
        || pg_temp.try_as('authenticated', null, array[format('select public.is_branch_open_for(%L::uuid, ''delivery'')::text', gen_random_uuid())]) || '|'
        || pg_temp.try_as('service_role', null, array[format('select public.is_branch_open_for(%L::uuid, ''pickup'')::text', gen_random_uuid())]));
    perform pg_temp.expect('is_branch_open_for: delivery with delivery_hours_enabled read as is_delivery_available reads it, then active, not paused (is_branch_open''s expression), no closure at p_at, inside a delivery window; else is_branch_open',
      'true',
      (select (p.prosrc like '%if p_channel = ''delivery'' then%'
                             || 'select coalesce((b.settings->>''delivery_hours_enabled'')::boolean, false)%into v_delivery_hours%'
                             || 'if v_delivery_hours then%b.is_active%'
                             || 'not coalesce((b.settings->>''orders_paused'')::boolean, false)%'
                             || 'from public.branch_closures%p_at between starts_at and ends_at%'
                             || 'public.is_delivery_available(p_branch_id, p_at)%'
                             || 'return public.is_branch_open(p_branch_id, p_at);%')::text
         from pg_proc p
        where p.oid = to_regprocedure('public.is_branch_open_for(uuid,text,timestamptz)')));

    v_want := pg_temp.norm(replace(c_live_trigger, 'public.is_branch_open(new.branch_id, new.scheduled_for)',
                                   'public.is_branch_open_for(new.branch_id, new.channel::text, new.scheduled_for)'));
    v_have := pg_temp.norm((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.tg_enforce_scheduled_time()')));
    perform pg_temp.expect('tg_enforce_scheduled_time: the live body with one change, is_branch_open(branch, scheduled_for) -> is_branch_open_for(branch, channel, scheduled_for) (layout and comments aside)',
      'same', case when v_have = v_want then 'same' else coalesce(v_have, '<missing>') end);
    perform pg_temp.expect('tg_enforce_scheduled_time: still postgres, SECURITY DEFINER, search_path pinned, a trigger; PUBLIC, anon and authenticated may not call it',
      'postgres true v search_path=public, pg_temp trigger|PUBLIC=false anon=false authenticated=false service_role=%',
      pg_temp.shape(to_regprocedure('public.tg_enforce_scheduled_time()')) || '|'
        || pg_temp.grants(to_regprocedure('public.tg_enforce_scheduled_time()')));

    v_want := replace(replace(pg_temp.norm(c_live_status),
      '''delivery_hours_on'', coalesce((b.settings->>''delivery_hours_enabled'')::boolean, false),',
      '''delivery_hours_on'', coalesce((b.settings->>''delivery_hours_enabled'')::boolean, false), '
      || '''delivery_open_now'', coalesce(private.branch_has_feature(b.id, ''delivery'') and public.is_branch_open_for(b.id, ''delivery'', now()), false),'),
      '''delivery_hours_on'', false,', '''delivery_hours_on'', false, ''delivery_open_now'', false,');
    v_have := pg_temp.norm((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.storefront_status(uuid)')));
    perform pg_temp.expect('storefront_status: the live body with delivery_open_now added after delivery_hours_on, in the answer and the fallback, and nothing else (layout and comments aside)',
      'same', case when v_have = v_want then 'same' else coalesce(v_have, '<missing>') end);
    perform pg_temp.expect('storefront_status: still postgres, SECURITY DEFINER, STABLE, search_path pinned, jsonb; anon, authenticated and service_role may call it, PUBLIC may not; one signature',
      'postgres true s search_path=public, pg_temp jsonb|PUBLIC=false anon=true authenticated=true service_role=true|p_branch_id uuid',
      pg_temp.shape(to_regprocedure('public.storefront_status(uuid)')) || '|'
        || pg_temp.grants(to_regprocedure('public.storefront_status(uuid)')) || '|'
        || (select string_agg(pg_get_function_arguments(p.oid), '|')
              from pg_proc p
             where p.pronamespace = 'public'::regnamespace and p.proname = 'storefront_status'));

    perform pg_temp.expect('left as they were live (md5 of the body read on 2026-11-16): is_branch_open, is_delivery_available, is_schedule_window_open, tg_enforce_delivery_hours, release_scheduled_orders',
      'is_branch_open 47b37b1a4563c639e061b0de6e1d4876|is_delivery_available aef6c18f6197170c766bc3f43ef1593d|'
      || 'is_schedule_window_open 1f2013e2be8e11bb5094cb7619323ee4|tg_enforce_delivery_hours d2add7226c1d5d4a0d948e34517c78d9|'
      || 'release_scheduled_orders d549ed5cb35ba595b975852c3cf3c369',
      'is_branch_open ' || coalesce((select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.is_branch_open(uuid,timestamptz)')), '<missing>')
      || '|is_delivery_available ' || coalesce((select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.is_delivery_available(uuid,timestamptz)')), '<missing>')
      || '|is_schedule_window_open ' || coalesce((select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.is_schedule_window_open(uuid,timestamptz)')), '<missing>')
      || '|tg_enforce_delivery_hours ' || coalesce((select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.tg_enforce_delivery_hours()')), '<missing>')
      || '|release_scheduled_orders ' || coalesce((select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('private.release_scheduled_orders()')), '<missing>'));

    perform pg_temp.expect('orders: the BEFORE INSERT row triggers in firing (name) order, so the delivery-hours gate runs before the scheduled-time gate, each on its function',
      'orders_billing_gate,orders_customer_same_branch,orders_enforce_delivery_hours,orders_enforce_scheduled_time,orders_table_and_session'
      || '|orders_enforce_delivery_hours>tg_enforce_delivery_hours,orders_enforce_scheduled_time>tg_enforce_scheduled_time',
      (select string_agg(t.tgname::text, ',' order by t.tgname::text collate "C")
         from pg_trigger t
        where t.tgrelid = 'public.orders'::regclass and not t.tgisinternal
          and (t.tgtype & 7) = 7 and t.tgenabled <> 'D')
      || '|' || (select string_agg(t.tgname::text || '>' || t.tgfoid::regproc::text, ',' order by t.tgname::text collate "C")
                   from pg_trigger t
                  where t.tgrelid = 'public.orders'::regclass
                    and t.tgname in ('orders_enforce_delivery_hours', 'orders_enforce_scheduled_time')));
  exception when others then
    perform pg_temp.expect('section 0 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- Fixture: the restaurant on its trial and the two branches, written as the script's role with no
  -- JWT, so only triggers and constraints apply. Any rows a branch was born with are replaced.
  begin
    perform pg_temp.act_as(null);
    insert into public.restaurants (owner_user_id, slug, name)
    values (v_owner, 'zz-dho-' || v_sfx, 'ZZ Delivery Hours Outside Opening') returning id into v_r;
    perform private.billing_apply_selection(v_r, 'trial', '{}'::uuid[], 4, 'trialing', null, null, null);
    insert into public.branches (restaurant_id, slug, name, timezone)
    values (v_r, 'on', 'ZZ Delivery Hours On', 'America/Chicago') returning id into v_on;
    insert into public.branches (restaurant_id, slug, name, timezone)
    values (v_r, 'off', 'ZZ Delivery Hours Off', 'America/Chicago') returning id into v_off;
    update public.branches
       set settings = coalesce(settings, '{}'::jsonb)
                      || jsonb_build_object('delivery_hours_enabled', id = v_on, 'schedule_hours_enabled', true,
                                            'orders_paused', false)
     where id in (v_on, v_off);

    delete from public.branch_hours where branch_id in (v_on, v_off);
    delete from public.branch_delivery_hours where branch_id in (v_on, v_off);
    delete from public.branch_schedule_hours where branch_id in (v_on, v_off);
    insert into public.branch_hours (branch_id, day_of_week, opens_at, closes_at)
    select b.id, d, time '09:00', time '17:30'
      from unnest(array[v_on, v_off]) as b(id), generate_series(0, 6) as d;
    insert into public.branch_delivery_hours (branch_id, day_of_week, opens_at, closes_at)
    select b.id, d, w.o, w.c
      from unnest(array[v_on, v_off]) as b(id), generate_series(0, 6) as d,
           (values (time '08:00', time '09:00'), (time '18:00', time '19:00')) as w(o, c);
    insert into public.branch_schedule_hours (branch_id, day_of_week, opens_at, closes_at)
    select b.id, d, w.o, w.c
      from unnest(array[v_on, v_off]) as b(id), generate_series(0, 6) as d,
           (values (time '08:00', time '09:00'), (time '18:00', time '19:00')) as w(o, c);
  exception when others then
    perform pg_temp.act_as(null);
    perform pg_temp.expect('fixture ran', 'ok', 'ERR ' || sqlerrm);
    return;
  end;

  perform pg_temp.expect('fixture: both branches in America/Chicago, active, entitled to delivery; delivery hours on at on, off at off; booking windows on at both; not paused',
    'America/Chicago true true true true false|America/Chicago true true false true false',
    (select string_agg(b.timezone || ' ' || b.is_active::text || ' ' || private.branch_has_feature(b.id, 'delivery')::text || ' '
                       || coalesce(b.settings ->> 'delivery_hours_enabled', '-') || ' '
                       || coalesce(b.settings ->> 'schedule_hours_enabled', '-') || ' '
                       || coalesce(b.settings ->> 'orders_paused', '-'), '|' order by b.slug = 'off')
       from public.branches b where b.id in (v_on, v_off)));
  perform pg_temp.expect('fixture: 7 opening-hour rows, 14 delivery windows and 14 booking windows at each branch, and no closure',
    '7 14 14 0|7 14 14 0',
    (select string_agg((select count(*) from public.branch_hours h where h.branch_id = b.id)::text || ' '
                       || (select count(*) from public.branch_delivery_hours h where h.branch_id = b.id)::text || ' '
                       || (select count(*) from public.branch_schedule_hours h where h.branch_id = b.id)::text || ' '
                       || (select count(*) from public.branch_closures c where c.branch_id = b.id)::text,
                       '|' order by b.slug = 'off')
       from public.branches b where b.id in (v_on, v_off)));
  perform pg_temp.expect('fixture: the times under test are tomorrow 08:30, 12:00, 18:30 and 19:30 in Chicago',
    '08:30 12:00 18:30 19:30|true',
    (select string_agg(to_char(u.t at time zone 'America/Chicago', 'HH24:MI'), ' ' order by u.i)
       from unnest(v_times) with ordinality as u(t, i))
    || '|' || (select bool_and((u.t at time zone 'America/Chicago')::date = v_day) from unnest(v_times) as u(t))::text);

  -- 1. is_branch_open_for by channel and time. Starts: the fixture. ------------------------------
  begin
    perform pg_temp.expect('delivery, delivery hours on: 08:30 open, 12:00 closed, 18:30 open, 19:30 closed (the delivery windows, before opening and after closing)',
      'ok true,false,true,false', pg_temp.try_sql(array[format(c_open, v_on, 'delivery', v_times)]));
    perform pg_temp.expect('delivery, delivery hours off: opening hours decide, 08:30 closed, 12:00 open, 18:30 closed, 19:30 closed',
      'ok false,true,false,false', pg_temp.try_sql(array[format(c_open, v_off, 'delivery', v_times)]));
    perform pg_temp.expect('pickup, dine-in and QR follow opening hours with delivery hours on (on) and off (off)',
      'ok false,true,false,false|ok false,true,false,false|ok false,true,false,false|ok false,true,false,false|ok false,true,false,false|ok false,true,false,false',
      pg_temp.try_sql(array[format(c_open, v_on, 'pickup', v_times)]) || '|'
        || pg_temp.try_sql(array[format(c_open, v_on, 'dine_in', v_times)]) || '|'
        || pg_temp.try_sql(array[format(c_open, v_on, 'qr_ordering', v_times)]) || '|'
        || pg_temp.try_sql(array[format(c_open, v_off, 'pickup', v_times)]) || '|'
        || pg_temp.try_sql(array[format(c_open, v_off, 'dine_in', v_times)]) || '|'
        || pg_temp.try_sql(array[format(c_open, v_off, 'qr_ordering', v_times)]));
    perform pg_temp.expect('unchanged beside it: is_branch_open (opening hours) at both, is_delivery_available (the windows at on, always while off)',
      'ok false,true,false,false|ok false,true,false,false|ok true,false,true,false|ok true,true,true,true',
      pg_temp.try_sql(array[format(c_old, v_on, v_times)]) || '|'
        || pg_temp.try_sql(array[format(c_old, v_off, v_times)]) || '|'
        || pg_temp.try_sql(array[format(c_avail, v_on, v_times)]) || '|'
        || pg_temp.try_sql(array[format(c_avail, v_off, v_times)]));
    perform pg_temp.expect('delivery hours on, an overnight window 22:00-02:00 added (rolled back): 23:00 and 01:00 open, 02:30 closed, the shop shut throughout',
      'ok true,true,false|false,false,false',
      pg_temp.try_sql(array[
        format('insert into public.branch_delivery_hours (branch_id, day_of_week, opens_at, closes_at) select %L::uuid, d, time ''22:00'', time ''02:00'' from generate_series(0, 6) d returning id', v_on),
        format(c_open, v_on, 'delivery', array[t_2300, t_0100n, t_0230n])])
      || '|' || (select string_agg(public.is_branch_open(v_on, u.t)::text, ',' order by u.i)
                   from unnest(array[t_2300, t_0100n, t_0230n]) with ordinality as u(t, i)));
  exception when others then
    perform pg_temp.expect('section 1 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 2. What still closes delivery, each rolled back. Starts: the fixture. ------------------------
  begin
    perform pg_temp.expect('a closure 08:00-09:00 tomorrow closes delivery at 08:30 and not at 18:30',
      'ok false,true',
      pg_temp.try_sql(array[
        format(c_closure, v_on, t_0830 - interval '30 minutes', t_0830 + interval '30 minutes'),
        format(c_open, v_on, 'delivery', array[t_0830, t_1830])]));
    perform pg_temp.expect('paused (orders_paused) closes delivery at every time',
      'ok false,false,false,false',
      pg_temp.try_sql(array[format(c_set, '{"orders_paused": true}', v_on), format(c_open, v_on, 'delivery', v_times)]));
    perform pg_temp.expect('a hidden branch (is_active false) takes no delivery',
      'ok false,false,false,false',
      pg_temp.try_sql(array[format('update public.branches set is_active = false where id = %L::uuid returning id', v_on),
                            format(c_open, v_on, 'delivery', v_times)]));
    perform pg_temp.expect('delivery hours on with no delivery window left: no delivery, though the shop is open at 12:00',
      'ok false,false,false,false',
      pg_temp.try_sql(array[format(c_no_delivery_hours, v_on), format(c_open, v_on, 'delivery', v_times)]));
    perform pg_temp.expect('an unknown branch is false for delivery and for pickup',
      'ok false,false,false,false|ok false,false,false,false',
      pg_temp.try_sql(array[format(c_open, gen_random_uuid(), 'delivery', v_times)]) || '|'
        || pg_temp.try_sql(array[format(c_open, gen_random_uuid(), 'pickup', v_times)]));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 3. The owner's switch, as the admin's delivery-hours card saves it (patch_branch_settings),
  --    rolled back. Starts: the fixture. -----------------------------------------------------------
  begin
    perform pg_temp.expect('owner ticks "Limit delivery to set hours" at off: delivery follows its windows (08:30 and 18:30)',
      'ok true,false,true,false',
      pg_temp.try_as('authenticated', v_owner, array[
        format('select public.patch_branch_settings(%L::uuid, ''{"delivery_hours_enabled": true}''::jsonb) ->> ''delivery_hours_enabled''', v_off),
        format(c_open, v_off, 'delivery', v_times)]));
    perform pg_temp.expect('owner unticks it at on: delivery follows opening hours again (12:00 only)',
      'ok false,true,false,false',
      pg_temp.try_as('authenticated', v_owner, array[
        format('select public.patch_branch_settings(%L::uuid, ''{"delivery_hours_enabled": false}''::jsonb) ->> ''delivery_hours_enabled''', v_on),
        format(c_open, v_on, 'delivery', v_times)]));
  exception when others then
    perform pg_temp.expect('section 3 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 4. storefront_status's keys. Starts: the fixture. ---------------------------------------------
  begin
    s_on := public.storefront_status(v_on);
    s_off := public.storefront_status(v_off);
    s_x := public.storefront_status(gen_random_uuid());
    perform pg_temp.expect('storefront_status: 16 keys, every old one and delivery_open_now (on, off, an unknown branch''s fallback)',
      c_keys || '|' || c_keys || '|' || c_keys,
      (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(s_on) k) || '|'
        || (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(s_off) k) || '|'
        || (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(s_x) k));
    perform pg_temp.expect('storefront_status: delivery_open_now is a boolean at both branches; false for an unknown branch',
      'boolean|boolean|boolean false',
      jsonb_typeof(s_on -> 'delivery_open_now') || '|' || jsonb_typeof(s_off -> 'delivery_open_now') || '|'
        || jsonb_typeof(s_x -> 'delivery_open_now') || ' ' || (s_x ->> 'delivery_open_now'));
    perform pg_temp.expect('storefront_status: delivery_open_now is entitled and is_branch_open_for(branch, delivery, now) (on, off)',
      'true|true',
      ((s_on ->> 'delivery_open_now') = (private.branch_has_feature(v_on, 'delivery')
                                          and public.is_branch_open_for(v_on, 'delivery', now()))::text)::text || '|'
        || ((s_off ->> 'delivery_open_now') = (private.branch_has_feature(v_off, 'delivery')
                                                and public.is_branch_open_for(v_off, 'delivery', now()))::text)::text);
    perform pg_temp.expect('storefront_status: the old keys answer as before (delivery_hours_on on|off, 14 windows, 7 opening rows, the zone, entitled, delivery at off, delivery at on = is_delivery_available now)',
      'true|false|14|7|America/Chicago|true|true|true',
      (s_on ->> 'delivery_hours_on') || '|' || (s_off ->> 'delivery_hours_on') || '|'
        || jsonb_array_length(s_on -> 'delivery_windows')::text || '|' || jsonb_array_length(s_on -> 'opening_hours')::text || '|'
        || (s_on ->> 'timezone') || '|' || (s_on ->> 'delivery_entitled') || '|' || (s_off ->> 'delivery') || '|'
        || ((s_on ->> 'delivery') = public.is_delivery_available(v_on)::text)::text);
  exception when others then
    perform pg_temp.expect('section 4 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 5. delivery_open_now right now, with the hours moved so the answer is known, each rolled back.
  --    Starts: the fixture. --------------------------------------------------------------------------
  begin
    perform pg_temp.expect('on, shop shut now (its only opening window on another weekday), delivering all day: delivery_open_now true | is_branch_open false | delivery true',
      'ok true|false|true',
      pg_temp.try_sql(array[
        format(c_no_opening_hours, v_on),
        format('insert into public.branch_hours (branch_id, day_of_week, opens_at, closes_at) values (%L::uuid, %s, time ''09:00'', time ''17:30'') returning id', v_on, (v_dow + 3) % 7),
        format(c_no_delivery_hours, v_on),
        format(c_all_day_delivery, v_on),
        format(c_now, v_on, v_on, v_on)]));
    perform pg_temp.expect('on, delivering all day but paused: delivery_open_now false, while the old delivery key still says true',
      'ok false|true',
      pg_temp.try_sql(array[
        format(c_no_delivery_hours, v_on),
        format(c_all_day_delivery, v_on),
        format(c_set, '{"orders_paused": true}', v_on),
        format('select concat_ws(''|'', public.storefront_status(%L::uuid) ->> ''delivery_open_now'', public.storefront_status(%L::uuid) ->> ''delivery'')', v_on, v_on)]));
    perform pg_temp.expect('off, no opening hours (always open): delivery_open_now true | is_branch_open true | delivery true',
      'ok true|true|true',
      pg_temp.try_sql(array[format(c_no_opening_hours, v_off), format(c_now, v_off, v_off, v_off)]));
    perform pg_temp.expect('off, no opening hours and a closure covering now: delivery_open_now false | is_branch_open false | delivery true (the old key ignores closures, as before)',
      'ok false|false|true',
      pg_temp.try_sql(array[
        format(c_no_opening_hours, v_off),
        format(c_closure, v_off, now() - interval '1 hour', now() + interval '1 hour'),
        format(c_now, v_off, v_off, v_off)]));
  exception when others then
    perform pg_temp.expect('section 5 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 6. Orders through the BEFORE INSERT gates, each rolled back. Starts: the fixture. -------------
  begin
    perform pg_temp.expect('a diner''s delivery booked for 08:30, delivery hours and booking windows on: both gates pass and it is inserted',
      'ok inserted',
      pg_temp.try_sql(array[format(c_order, 'T-DHO-A-' || v_sfx, v_on, 'delivery', 'web', t_0830)]));
    perform pg_temp.expect('the same at 18:30 is inserted too',
      'ok inserted',
      pg_temp.try_sql(array[format(c_order, 'T-DHO-B-' || v_sfx, v_on, 'delivery', 'web', t_1830)]));
    perform pg_temp.expect('the same delivery for 08:30 with delivery hours off is refused: branch_closed_at_scheduled_time',
      c_closed_at,
      pg_temp.try_sql(array[format(c_order, 'T-DHO-C-' || v_sfx, v_off, 'delivery', 'web', t_0830)]));
    perform pg_temp.expect('a delivery for 12:00 with delivery hours on is refused by the delivery-hours gate, which fires first',
      'ERR P0001 delivery_not_available_at_that_time',
      pg_temp.try_sql(array[format(c_order, 'T-DHO-D-' || v_sfx, v_on, 'delivery', 'web', t_1200)]));
    perform pg_temp.expect('a pickup booked for 08:30 is refused (opening hours decide pickup); one for 12:00, with booking windows off, is inserted',
      c_closed_at || '|ok inserted',
      pg_temp.try_sql(array[format(c_order, 'T-DHO-E-' || v_sfx, v_on, 'pickup', 'web', t_0830)]) || '|'
        || pg_temp.try_sql(array[format(c_set, '{"schedule_hours_enabled": false}', v_on),
                                 format(c_order, 'T-DHO-F-' || v_sfx, v_on, 'pickup', 'web', t_1200)]));
    perform pg_temp.expect('a counter delivery booked for 08:30 with booking windows off is inserted',
      'ok inserted',
      pg_temp.try_sql(array[format(c_set, '{"schedule_hours_enabled": false}', v_on),
                            format(c_order, 'T-DHO-G-' || v_sfx, v_on, 'delivery', 'counter', t_0830)]));
    perform pg_temp.expect('booking windows narrowed to 08:00-09:00: a diner''s delivery for 18:30 is outside_scheduling_window, the till''s is inserted',
      'ERR P0001 outside_scheduling_window|ok inserted',
      pg_temp.try_sql(array[format('delete from public.branch_schedule_hours where branch_id = %L::uuid and opens_at = time ''18:00'' returning id', v_on),
                            format(c_order, 'T-DHO-H-' || v_sfx, v_on, 'delivery', 'web', t_1830)]) || '|'
        || pg_temp.try_sql(array[format('delete from public.branch_schedule_hours where branch_id = %L::uuid and opens_at = time ''18:00'' returning id', v_on),
                                 format(c_order, 'T-DHO-I-' || v_sfx, v_on, 'delivery', 'counter', t_1830)]));
    perform pg_temp.expect('delivery hours off: a diner''s delivery for 12:00 is open but outside the booking windows; with them off it is inserted',
      'ERR P0001 outside_scheduling_window|ok inserted',
      pg_temp.try_sql(array[format(c_order, 'T-DHO-J-' || v_sfx, v_off, 'delivery', 'web', t_1200)]) || '|'
        || pg_temp.try_sql(array[format(c_set, '{"schedule_hours_enabled": false}', v_off),
                                 format(c_order, 'T-DHO-K-' || v_sfx, v_off, 'delivery', 'web', t_1200)]));
    perform pg_temp.expect('a delivery for 08:30 at a closure, or while paused, is refused: branch_closed_at_scheduled_time',
      c_closed_at || '|' || c_closed_at,
      pg_temp.try_sql(array[format(c_closure, v_on, t_0830 - interval '30 minutes', t_0830 + interval '30 minutes'),
                            format(c_order, 'T-DHO-L-' || v_sfx, v_on, 'delivery', 'web', t_0830)]) || '|'
        || pg_temp.try_sql(array[format(c_set, '{"orders_paused": true}', v_on),
                                 format(c_order, 'T-DHO-M-' || v_sfx, v_on, 'delivery', 'web', t_0830)]));
    perform pg_temp.expect('(nothing of that was kept: no test order at either branch)',
      '0', (select count(*)::text from public.orders where branch_id in (v_on, v_off)));
  exception when others then
    perform pg_temp.expect('section 6 ran', 'ok', 'ERR ' || sqlerrm);
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
