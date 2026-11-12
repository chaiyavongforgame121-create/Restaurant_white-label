begin;

-- Deleting a removed team member (20261112100000_delete_removed_staff_member, the owner's report of
-- 2026-11-12). A rolled-back script, not a migration. Pins: delete_removed_staff_member deleting a
-- removed row nobody's work points at, writing one audit row (staff_member_deleted, the actor,
-- role, address and account) and answering {deleted: true}; a second call being staff_not_found;
-- pending, active and suspended rows refused with staff_not_removed and kept; a removed row an
-- order, a payment, a shift or a table sitting (opened or closed) points at refused with
-- staff_has_history and kept, with the order, payment, shift and sittings untouched, and deleted
-- once nothing points at it; who may, as cancel_staff_invite decides it (the owner, staff.manage
-- at the row's branch, restaurant-wide authority for a row with no branch, the owner alone for an
-- admin row; not the cashier, a stranger, a token without a user, the service role or anon); and
-- inviting the person again after a delete (a new pending row for the same address and branch,
-- which they can accept); cancel_staff_invite putting an invitation revived from a removed member
-- with history back to removed ({cancelled, kept}, audited) instead of deleting it, a second Cancel
-- on it being invite_already_cancelled, and deleting one with no history as before;
-- accept_staff_invite treating such a kept row as gone (invite_not_found), and, when the account
-- already has a removed row at that branch, reviving that row and keeping a spent invitation that
-- history points at (as removed) while still deleting one without. Section 0 checks what the
-- migration left behind.
--
-- Run it on a LOCAL stack, never on live (rolled-back suites still bloat live indexes and WAL):
--   supabase db reset   (or apply the migrations), then
--   psql "$LOCAL_DB_URL" -f supabase/tests/delete_removed_staff_member.sql
-- Before the migration is applied, run the migration and this file in one transaction instead: a
-- "begin;" of your own, then the migration without its own "begin;" and "commit;", then this file
-- without its own "begin;".
--
-- Everything happens inside one transaction that ends in ROLLBACK, on a restaurant this script
-- creates for itself (section 0 only reads).
--   pg_temp.try_as(role, uid, sqls[])  as `anon` (uid null), `authenticated` or `service_role`, in a
--                                      subtransaction that is always rolled back; reports
--                                      'ok <last value>' or 'ERR <sqlstate> <message>'.
--   pg_temp.try_sql(sqls[])            the same as the script itself with no JWT (a migration, the
--                                      SQL editor): only triggers and constraints apply. A statement
--                                      may set request.jwt.claim.sub to call an RPC as someone.
--   pg_temp.call_as(uid, sql)          with uid's JWT claims (the role stays the script's), KEPT when
--                                      it succeeds. Reports the same way; the claims are cleared
--                                      afterwards either way.
--   pg_temp.act_as(uid)                sets only the JWT claims, so auth.uid() is that person while
--                                      the statements that follow keep their effect. act_as(null)
--                                      clears them.
--
-- People (auth.users rows made here):
--   owner               restaurants.owner_user_id of A (every branch, admin rows included)
--   branch admin        admin at A's branch one only (staff.manage there, not at two)
--   every-branch admin  admin row of A with no branch (staff.manage everywhere, not over admins)
--   cashier             cashier at branch one (no staff.manage)
--   stranger            no membership anywhere
-- Every row under test but the pending one has an account of its own, as a removed row always has
-- (only an active or suspended member can be removed); gone's address is confirmed, so it can accept
-- again.
--
-- Restaurant A (zz-drs-a-<s>), branches one and two. Rows under test, all at branch one unless
-- said: gone (removed cashier), b1 (removed kitchen), b2 (removed cashier at two), wide (removed
-- cashier with no branch), admin (removed admin), pending (an open invitation), active (cashier),
-- suspended (kitchen), and five removed rows with history: order (an order's staff_id), payment
-- (a payment's confirmed_by), shift (a closed shift), opened and closed (a closed sitting each,
-- opened_by_staff and closed_by_staff). The history was written while they were active, then they
-- were removed.
--
-- Each section after the fixtures runs in its own block: one that breaks reports a FAIL row and
-- the others still run. Later sections build on earlier ones; the state each one starts from is
-- written above it. The result is one row per check with PASS/FAIL, then a summary row.

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

-- An account; p_confirmed marks its address confirmed, as accept_staff_invite requires.
create or replace function pg_temp.new_user(p_label text, p_confirmed boolean default false)
returns uuid
language plpgsql
as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          email_confirmed_at)
  values (v, 'delete-removed-staff-' || p_label || '-' || left(v::text, 8) || '@favornoms.test', 'authenticated',
          'authenticated', jsonb_build_object('is_platform_admin', false), '{}'::jsonb, now(), now(),
          case when p_confirmed then now() end);
  return v;
end $$;

-- A staff row for p_user's account, carrying its address as every row with an account does.
create or replace function pg_temp.staff_row(p_user uuid, p_restaurant uuid, p_branch uuid, p_role text, p_status text)
returns uuid
language plpgsql
as $$
declare v uuid;
begin
  insert into public.staff_members (user_id, restaurant_id, branch_id, role, status, invited_email, accepted_at)
  values (p_user, p_restaurant, p_branch, p_role::public.staff_role, p_status::public.staff_status,
          (select lower(u.email) from auth.users u where u.id = p_user), now())
  returning id into v;
  return v;
end $$;

-- Each row's status in order, or 'gone'.
create or replace function pg_temp.state(p_ids uuid[])
returns text
language sql
as $$
  select string_agg(coalesce(sm.status::text, 'gone'), ',' order by u.i)
    from unnest(p_ids) with ordinality as u(id, i)
    left join public.staff_members sm on sm.id = u.id;
$$;

-- How many deletions are audited at p_restaurant.
create or replace function pg_temp.deletions(p_restaurant uuid)
returns integer
language sql
as $$
  select count(*)::integer
    from public.audit_logs a
   where a.restaurant_id::text = p_restaurant::text and a.action = 'staff_member_deleted';
$$;

-- The report of a call that deleted p_id.
create or replace function pg_temp.deleted_answer(p_id uuid)
returns text
language sql
as $$
  select 'ok ' || jsonb_build_object('staff_id', p_id, 'deleted', true)::text;
$$;

do $test$
declare
  v_owner    uuid := pg_temp.new_user('owner');
  v_badmin   uuid := pg_temp.new_user('branch-admin');
  v_wadmin   uuid := pg_temp.new_user('every-branch-admin');
  v_cashier  uuid := pg_temp.new_user('cashier');
  v_stranger uuid := pg_temp.new_user('stranger');
  u_gone     uuid := pg_temp.new_user('gone', true);
  u_b1       uuid := pg_temp.new_user('b1');
  u_b2       uuid := pg_temp.new_user('b2');
  u_wide     uuid := pg_temp.new_user('wide');
  u_admin    uuid := pg_temp.new_user('admin');
  u_active   uuid := pg_temp.new_user('active');
  u_susp     uuid := pg_temp.new_user('suspended');
  u_order    uuid := pg_temp.new_user('order');
  u_pay      uuid := pg_temp.new_user('payment');
  u_shift    uuid := pg_temp.new_user('shift');
  u_open     uuid := pg_temp.new_user('opened');
  u_close    uuid := pg_temp.new_user('closed');
  v_sfx text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_ra uuid; v_a1 uuid; v_a2 uuid;
  r_gone uuid; r_b1 uuid; r_b2 uuid; r_wide uuid; r_admin uuid;
  r_pending uuid; r_active uuid; r_susp uuid;
  r_order uuid; r_pay uuid; r_shift uuid; r_open uuid; r_close uuid;
  v_order uuid; v_pay_order uuid; v_payment uuid; v_shift uuid; v_table uuid; v_sess_open uuid; v_sess_close uuid;
  v_gone_email text;
  v_new uuid;
  v_x uuid;
  v_inv uuid;
  v_n int;
  v_audit int;
  v_answer text;
  c_del         constant text := 'select public.delete_removed_staff_member(%L)::text';
  c_cancel      constant text := 'select public.cancel_staff_invite(%L)::text';
  c_accept      constant text := 'select public.accept_staff_invite(%L)::text';
  c_sub         constant text := 'select set_config(''request.jwt.claim.sub'', %L, true)';
  c_cap         constant text := 'select private.staff_has_capability(%L, ''staff.manage'')::text || ''|'' || private.staff_has_capability(%L, ''staff.manage'')::text';
  c_no_auth     constant text := 'ERR 42501 not_authorized';
  c_not_removed constant text := 'ERR P0001 staff_not_removed';
  c_history     constant text := 'ERR P0001 staff_has_history';
  -- cancel_staff_invite's authority checks as live (20260918190000 §7), in order, cut at every
  -- place a line could break.
  c_rule constant text :=
    '%v_owns := private.user_owns_restaurant(v_row.restaurant_id);'
    || '%if v_row.role = ''owner'' or v_row.branch_id is null then'
    || '%v_allowed := v_owns or exists ('
    || '%rc.role = sm.role::text%rc.capability = ''staff.manage'''
    || '%sm.restaurant_id = v_row.restaurant_id%sm.user_id = v_uid%sm.status = ''active''%sm.branch_id is null'
    || '%v_allowed := private.staff_has_capability(v_row.branch_id, ''staff.manage'');'
    || '%if not v_allowed then%raise exception ''not_authorized'' using errcode = ''42501'';'
    || '%if v_row.role in (''owner'', ''admin'') and not v_owns then%raise exception ''not_authorized'' using errcode = ''42501'';%';
begin
  -- 0. What the migration left behind ----------------------------------------------------------
  begin
    perform pg_temp.expect('delete_removed_staff_member: postgres, SECURITY DEFINER, search_path pinned, returns jsonb; authenticated and service_role may call it, anon and PUBLIC may not; it has a comment',
      'delete_removed_staff_member(uuid) postgres true search_path=public, pg_temp jsonb true true false false true',
      (select p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' '
              || array_to_string(p.proconfig, ',') || ' ' || format_type(p.prorettype, null) || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || (exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                           where a.grantee = 0 and a.privilege_type = 'EXECUTE'))::text || ' '
              || (obj_description(p.oid, 'pg_proc') is not null)::text
         from pg_proc p
        where p.oid = to_regprocedure('public.delete_removed_staff_member(uuid)')));
    perform pg_temp.expect('delete_removed_staff_member: one signature, (p_staff_id uuid)', 'p_staff_id uuid',
      (select string_agg(pg_get_function_arguments(p.oid), '|')
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname = 'delete_removed_staff_member'));
    perform pg_temp.expect('delete_removed_staff_member: cancel_staff_invite''s authority checks, word for word (both pass the same pattern)',
      'true|true',
      (select (p.prosrc like c_rule)::text from pg_proc p
        where p.oid = to_regprocedure('public.delete_removed_staff_member(uuid)'))
      || '|' || (select (p.prosrc like c_rule)::text from pg_proc p
                  where p.oid = to_regprocedure('public.cancel_staff_invite(uuid)')));
    perform pg_temp.expect('delete_removed_staff_member: locks the row first, then who, then removed, then the five history checks, then the delete and its audit row',
      'true',
      (select (p.prosrc like '%from public.staff_members%for update;%staff_not_found%v_owns := %not_authorized%'
                             || 'if v_row.status <> ''removed'' then%staff_not_removed%'
                             || 'public.orders o where o.staff_id = v_row.id%public.payments p where p.confirmed_by = v_row.id%'
                             || 'public.staff_shifts s where s.staff_member_id = v_row.id%'
                             || 'ts.opened_by_staff = v_row.id or ts.closed_by_staff = v_row.id%staff_has_history%'
                             || 'delete from public.staff_members where id = v_row.id;%'
                             || 'insert into public.audit_logs%''staff''%''staff_member_deleted''%''staff_member''%')::text
         from pg_proc p
        where p.oid = to_regprocedure('public.delete_removed_staff_member(uuid)')));
    perform pg_temp.expect('the history checks cover every foreign key into staff_members, and none restricts a delete (SET NULL n, CASCADE c)',
      'public.orders.staff_id:n,public.payments.confirmed_by:n,public.staff_shifts.staff_member_id:c,'
      || 'public.table_sessions.closed_by_staff:n,public.table_sessions.opened_by_staff:n',
      (select string_agg(n.nspname || '.' || c.relname || '.' || a.attname || ':' || k.confdeltype::text, ','
                         order by n.nspname, c.relname, a.attname)
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
        where k.contype = 'f' and k.confrelid = 'public.staff_members'::regclass));
    perform pg_temp.expect('cancel_staff_invite: still postgres, SECURITY DEFINER, search_path pinned, jsonb; authenticated and service_role may call it, anon and PUBLIC may not; one signature',
      'cancel_staff_invite(uuid) postgres true search_path=public, pg_temp jsonb true true false false|p_staff_id uuid',
      (select p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' '
              || array_to_string(p.proconfig, ',') || ' ' || format_type(p.prorettype, null) || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || (exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                           where a.grantee = 0 and a.privilege_type = 'EXECUTE'))::text
         from pg_proc p
        where p.oid = to_regprocedure('public.cancel_staff_invite(uuid)'))
      || '|' || (select string_agg(pg_get_function_arguments(p.oid), '|')
                   from pg_proc p
                  where p.pronamespace = 'public'::regnamespace and p.proname = 'cancel_staff_invite'));
    perform pg_temp.expect('cancel_staff_invite: pending and unclaimed only, then the five history checks put the row back to removed, and only then the delete',
      'true',
      (select (p.prosrc like '%for update;%invite_not_found%not_authorized%'
                             || 'v_row.status = ''removed'' and v_row.user_id is null%invite_already_cancelled%'
                             || 'v_row.status <> ''pending'' or v_row.user_id is not null%invite_not_pending%'
                             || 'public.orders o where o.staff_id = v_row.id%public.payments p where p.confirmed_by = v_row.id%'
                             || 'public.staff_shifts s where s.staff_member_id = v_row.id%'
                             || 'ts.opened_by_staff = v_row.id or ts.closed_by_staff = v_row.id%'
                             || 'set status = ''removed''%''kept'', true%'
                             || 'delete from public.staff_members where id = p_staff_id;%')::text
         from pg_proc p
        where p.oid = to_regprocedure('public.cancel_staff_invite(uuid)')));
    perform pg_temp.expect('accept_staff_invite: still postgres, SECURITY DEFINER, search_path pinned, jsonb; authenticated and service_role may call it, anon and PUBLIC may not; one signature',
      'accept_staff_invite(uuid) postgres true search_path=public, pg_temp jsonb true true false false|p_staff_id uuid',
      (select p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner)::text || ' ' || p.prosecdef::text || ' '
              || array_to_string(p.proconfig, ',') || ' ' || format_type(p.prorettype, null) || ' '
              || has_function_privilege('authenticated', p.oid, 'execute')::text || ' '
              || has_function_privilege('service_role', p.oid, 'execute')::text || ' '
              || has_function_privilege('anon', p.oid, 'execute')::text || ' '
              || (exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                           where a.grantee = 0 and a.privilege_type = 'EXECUTE'))::text
         from pg_proc p
        where p.oid = to_regprocedure('public.accept_staff_invite(uuid)'))
      || '|' || (select string_agg(pg_get_function_arguments(p.oid), '|')
                   from pg_proc p
                  where p.pronamespace = 'public'::regnamespace and p.proname = 'accept_staff_invite'));
    perform pg_temp.expect('accept_staff_invite: a kept row is invite_not_found; on a clash the removed row comes back, then the spent invitation is kept as removed if history points at it, else deleted',
      'true',
      (select (p.prosrc like '%for update;%invite_not_found%'
                             || 'v_row.status = ''removed'' and v_row.user_id is null then raise exception ''invite_not_found''%'
                             || 'invite_not_pending%invite_email_mismatch%email_not_confirmed%'
                             || 'exception when unique_violation then%already_staff_here%'
                             || 'where id = v_old.id;%'
                             || 'public.orders o where o.staff_id = v_row.id%public.payments p where p.confirmed_by = v_row.id%'
                             || 'public.staff_shifts s where s.staff_member_id = v_row.id%'
                             || 'ts.opened_by_staff = v_row.id or ts.closed_by_staff = v_row.id%'
                             || 'set status = ''removed'' where id = v_row.id;%else%'
                             || 'delete from public.staff_members where id = v_row.id;%''revived'', true%')::text
         from pg_proc p
        where p.oid = to_regprocedure('public.accept_staff_invite(uuid)')));
  exception when others then
    perform pg_temp.expect('section 0 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- Fixture: restaurant A on its trial with two branches. Written as the script's role with no JWT,
  -- so only triggers and constraints apply.
  perform pg_temp.act_as(null);
  insert into public.restaurants (owner_user_id, slug, name)
  values (v_owner, 'zz-drs-a-' || v_sfx, 'ZZ Delete Removed Staff A') returning id into v_ra;
  perform private.billing_apply_selection(v_ra, 'trial', '{}'::uuid[], 4, 'trialing', null, null, null);
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'one', 'A One') returning id into v_a1;
  insert into public.branches (restaurant_id, slug, name) values (v_ra, 'two', 'A Two') returning id into v_a2;
  perform pg_temp.staff_row(v_badmin, v_ra, v_a1, 'admin', 'active');
  perform pg_temp.staff_row(v_wadmin, v_ra, null, 'admin', 'active');
  perform pg_temp.staff_row(v_cashier, v_ra, v_a1, 'cashier', 'active');

  r_gone   := pg_temp.staff_row(u_gone, v_ra, v_a1, 'cashier', 'removed');
  r_b1     := pg_temp.staff_row(u_b1, v_ra, v_a1, 'kitchen', 'removed');
  r_b2     := pg_temp.staff_row(u_b2, v_ra, v_a2, 'cashier', 'removed');
  r_wide   := pg_temp.staff_row(u_wide, v_ra, null, 'cashier', 'removed');
  r_admin  := pg_temp.staff_row(u_admin, v_ra, v_a1, 'admin', 'removed');
  r_active := pg_temp.staff_row(u_active, v_ra, v_a1, 'cashier', 'active');
  r_susp   := pg_temp.staff_row(u_susp, v_ra, v_a1, 'kitchen', 'suspended');
  insert into public.staff_members (restaurant_id, branch_id, invited_email, role, status)
  values (v_ra, v_a1, 'delete-removed-staff-pending-' || v_sfx || '@favornoms.test', 'cashier', 'pending')
  returning id into r_pending;
  select invited_email into v_gone_email from public.staff_members where id = r_gone;

  -- The five with history, active while they worked.
  r_order := pg_temp.staff_row(u_order, v_ra, v_a1, 'cashier', 'active');
  r_pay   := pg_temp.staff_row(u_pay, v_ra, v_a1, 'cashier', 'active');
  r_shift := pg_temp.staff_row(u_shift, v_ra, v_a1, 'kitchen', 'active');
  r_open  := pg_temp.staff_row(u_open, v_ra, v_a1, 'server', 'active');
  r_close := pg_temp.staff_row(u_close, v_ra, v_a1, 'server', 'active');
  insert into public.orders (order_number, branch_id, channel, source, status, subtotal, total, status_history, staff_id)
  values ('T-DRS-O-' || v_sfx, v_a1, 'pickup', 'counter', 'completed', 10, 10, '[]', r_order) returning id into v_order;
  insert into public.orders (order_number, branch_id, channel, source, status, subtotal, total, status_history)
  values ('T-DRS-P-' || v_sfx, v_a1, 'pickup', 'counter', 'pending', 10, 10, '[]') returning id into v_pay_order;
  insert into public.payments (order_id, branch_id, amount, method, status, confirmed_by, confirmed_at, paid_at)
  values (v_pay_order, v_a1, 10, 'cash', 'completed', r_pay, now(), now()) returning id into v_payment;
  insert into public.staff_shifts (staff_member_id, branch_id, shift_role, clocked_in_at, clocked_out_at)
  values (r_shift, v_a1, 'general', now() - interval '5 hours', now() - interval '1 hour') returning id into v_shift;
  insert into public.tables (branch_id, table_number) values (v_a1, 'DRS-1') returning id into v_table;
  insert into public.table_sessions (branch_id, table_id, status, opened_via, opened_by_staff, opened_at, closed_at, closed_reason)
  values (v_a1, v_table, 'closed', 'staff', r_open, now() - interval '3 hours', now() - interval '2 hours', 'paid')
  returning id into v_sess_open;
  insert into public.table_sessions (branch_id, table_id, status, opened_via, closed_by_staff, opened_at, closed_at, closed_reason)
  values (v_a1, v_table, 'closed', 'scan', r_close, now() - interval '2 hours', now() - interval '1 hour', 'staff_closed')
  returning id into v_sess_close;
  update public.staff_members set status = 'removed' where id in (r_order, r_pay, r_shift, r_open, r_close);

  perform pg_temp.expect('fixture: the branch admin holds staff.manage at branch one only, the every-branch admin at both, the cashier at neither (one | two)',
    'ok true|false ; ok true|true ; ok false|false',
    pg_temp.try_sql(array[format(c_sub, v_badmin), format(c_cap, v_a1, v_a2)]) || ' ; '
      || pg_temp.try_sql(array[format(c_sub, v_wadmin), format(c_cap, v_a1, v_a2)]) || ' ; '
      || pg_temp.try_sql(array[format(c_sub, v_cashier), format(c_cap, v_a1, v_a2)]));
  perform pg_temp.expect('fixture: the rows under test as written (gone, b1, b2, wide, admin, pending, active, suspended, order, payment, shift, opened, closed)',
    'removed,removed,removed,removed,removed,pending,active,suspended,removed,removed,removed,removed,removed',
    pg_temp.state(array[r_gone, r_b1, r_b2, r_wide, r_admin, r_pending, r_active, r_susp,
                        r_order, r_pay, r_shift, r_open, r_close]));
  perform pg_temp.expect('fixture: one order, payment, shift, opened sitting and closed sitting point at the five with history, and nothing at the others',
    '1|1|1|1|1|0',
    (select count(*)::text from public.orders where staff_id = r_order) || '|'
      || (select count(*)::text from public.payments where confirmed_by = r_pay) || '|'
      || (select count(*)::text from public.staff_shifts where staff_member_id = r_shift) || '|'
      || (select count(*)::text from public.table_sessions where opened_by_staff = r_open) || '|'
      || (select count(*)::text from public.table_sessions where closed_by_staff = r_close) || '|'
      || ((select count(*) from public.orders where staff_id in (r_gone, r_b1, r_b2, r_wide, r_admin))
          + (select count(*) from public.payments where confirmed_by in (r_gone, r_b1, r_b2, r_wide, r_admin))
          + (select count(*) from public.staff_shifts where staff_member_id in (r_gone, r_b1, r_b2, r_wide, r_admin))
          + (select count(*) from public.table_sessions
              where opened_by_staff in (r_gone, r_b1, r_b2, r_wide, r_admin)
                 or closed_by_staff in (r_gone, r_b1, r_b2, r_wide, r_admin)))::text);

  -- 1. The owner deletes gone. Starts: the fixture. ---------------------------------------------
  begin
    perform pg_temp.expect('before: the removed row still holds its account''s place at branch one, so a second row for that account there is refused (rolled back)',
      'ERR 23505 %',
      pg_temp.try_sql(array[format(
        'insert into public.staff_members (user_id, restaurant_id, branch_id, role, status) values (%L, %L, %L, ''cashier'', ''active'') returning id',
        u_gone, v_ra, v_a1)]));
    select count(*) into v_n from public.staff_members where restaurant_id = v_ra;
    v_audit := pg_temp.deletions(v_ra);
    v_answer := pg_temp.call_as(v_owner, format(c_del, r_gone));
    perform pg_temp.expect('owner: a removed row with no history is deleted, and the answer says so',
      pg_temp.deleted_answer(r_gone), v_answer);
    perform pg_temp.expect('owner: the row is gone, and only that row',
      'gone|' || (v_n - 1),
      pg_temp.state(array[r_gone]) || '|' || (select count(*) from public.staff_members where restaurant_id = v_ra));
    perform pg_temp.expect('owner: one audit row, staff_member_deleted by the owner as staff, for the row''s restaurant and branch, with its role, address and account; one more deletion audited here',
      '1|staff|true|staff_member|true|true|cashier|true|true|invited_email,role,user_id|' || (v_audit + 1),
      (select count(*)::text from public.audit_logs a
        where a.entity_id::text = r_gone::text and a.action = 'staff_member_deleted')
      || '|' || coalesce(
        (select a.actor_type || '|' || (a.actor_id::text = v_owner::text)::text || '|' || a.entity_type || '|'
                || (a.restaurant_id::text = v_ra::text)::text || '|' || (a.branch_id::text = v_a1::text)::text || '|'
                || (a.metadata ->> 'role') || '|' || (a.metadata ->> 'invited_email' = v_gone_email)::text || '|'
                || (a.metadata ->> 'user_id' = u_gone::text)::text || '|'
                || (select string_agg(k.akey, ',' order by k.akey) from jsonb_object_keys(a.metadata) as k(akey))
           from public.audit_logs a
          where a.entity_id::text = r_gone::text and a.action = 'staff_member_deleted'
          order by a.created_at desc
          limit 1), '-')
      || '|' || pg_temp.deletions(v_ra));
    perform pg_temp.expect('owner: deleting it again is staff_not_found (another tab, another admin)', 'ERR P0002 staff_not_found',
      pg_temp.call_as(v_owner, format(c_del, r_gone)));
  exception when others then
    perform pg_temp.act_as(null);
    perform pg_temp.expect('section 1 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 2. Not removed. Starts: pending, active and suspended as the fixture wrote them. -------------
  begin
    v_audit := pg_temp.deletions(v_ra);
    perform pg_temp.expect('not removed: a pending invitation, an active and a suspended member are refused with staff_not_removed, the owner too',
      c_not_removed || '|' || c_not_removed || '|' || c_not_removed,
      pg_temp.call_as(v_owner, format(c_del, r_pending)) || '|'
        || pg_temp.call_as(v_owner, format(c_del, r_active)) || '|'
        || pg_temp.call_as(v_owner, format(c_del, r_susp)));
    perform pg_temp.expect('not removed: all three stay as they were, and no deletion is audited',
      'pending,active,suspended|' || v_audit,
      pg_temp.state(array[r_pending, r_active, r_susp]) || '|' || pg_temp.deletions(v_ra));
  exception when others then
    perform pg_temp.expect('section 2 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 3. History. Starts: the five removed rows with history, as the fixture wrote them. -----------
  begin
    v_audit := pg_temp.deletions(v_ra);
    perform pg_temp.expect('history: a removed row an order, a payment, a shift, an opened or a closed sitting points at is refused with staff_has_history',
      c_history || '|' || c_history || '|' || c_history || '|' || c_history || '|' || c_history,
      pg_temp.call_as(v_owner, format(c_del, r_order)) || '|'
        || pg_temp.call_as(v_owner, format(c_del, r_pay)) || '|'
        || pg_temp.call_as(v_owner, format(c_del, r_shift)) || '|'
        || pg_temp.call_as(v_owner, format(c_del, r_open)) || '|'
        || pg_temp.call_as(v_owner, format(c_del, r_close)));
    perform pg_temp.expect('history: the five stay removed, and no deletion is audited',
      'removed,removed,removed,removed,removed|' || v_audit,
      pg_temp.state(array[r_order, r_pay, r_shift, r_open, r_close]) || '|' || pg_temp.deletions(v_ra));
    perform pg_temp.expect('history: the order, the payment, the shift and both sittings still name them',
      'true|true|true|true|true',
      (select (o.staff_id = r_order)::text from public.orders o where o.id = v_order) || '|'
        || (select (p.confirmed_by = r_pay)::text from public.payments p where p.id = v_payment) || '|'
        || (select (s.staff_member_id = r_shift)::text from public.staff_shifts s where s.id = v_shift) || '|'
        || (select (ts.opened_by_staff = r_open)::text from public.table_sessions ts where ts.id = v_sess_open) || '|'
        || (select (ts.closed_by_staff = r_close)::text from public.table_sessions ts where ts.id = v_sess_close));
    perform pg_temp.expect('history: once nothing points at them (rolled back), each of the five is deleted',
      'ok 0',
      pg_temp.try_sql(array[
        format('update public.orders set staff_id = null where id = %L returning id', v_order),
        format('update public.payments set confirmed_by = null where id = %L returning id', v_payment),
        format('delete from public.staff_shifts where id = %L returning id', v_shift),
        format('update public.table_sessions set opened_by_staff = null where id = %L returning id', v_sess_open),
        format('update public.table_sessions set closed_by_staff = null where id = %L returning id', v_sess_close),
        format(c_sub, v_owner),
        format(c_del, r_order), format(c_del, r_pay), format(c_del, r_shift), format(c_del, r_open), format(c_del, r_close),
        format('select count(*)::text from public.staff_members where id in (%L, %L, %L, %L, %L)',
               r_order, r_pay, r_shift, r_open, r_close)]));
    perform pg_temp.expect('history: (nothing of that was kept: the five and their history as they were)',
      'removed,removed,removed,removed,removed|1|1|1|1|1',
      pg_temp.state(array[r_order, r_pay, r_shift, r_open, r_close]) || '|'
        || (select count(*)::text from public.orders where staff_id = r_order) || '|'
        || (select count(*)::text from public.payments where confirmed_by = r_pay) || '|'
        || (select count(*)::text from public.staff_shifts where staff_member_id = r_shift) || '|'
        || (select count(*)::text from public.table_sessions where opened_by_staff = r_open) || '|'
        || (select count(*)::text from public.table_sessions where closed_by_staff = r_close));
  exception when others then
    perform pg_temp.expect('section 3 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 4. Who may not, each rolled back. Starts: b1 removed at branch one. -------------------------
  begin
    perform pg_temp.expect('who: anon may not call it; a token without a user, or the service role, must sign in',
      'ERR 42501 permission denied for function delete_removed_staff_member|ERR 42501 sign_in_required|ERR 42501 sign_in_required',
      pg_temp.try_as('anon', null, array[format(c_del, r_b1)]) || '|'
        || pg_temp.try_as('authenticated', null, array[format(c_del, r_b1)]) || '|'
        || pg_temp.try_as('service_role', null, array[format(c_del, r_b1)]));
    perform pg_temp.expect('who: the cashier of that branch and a stranger may not', c_no_auth || '|' || c_no_auth,
      pg_temp.try_as('authenticated', v_cashier, array[format(c_del, r_b1)]) || '|'
        || pg_temp.try_as('authenticated', v_stranger, array[format(c_del, r_b1)]));
    perform pg_temp.expect('who: an unknown id is staff_not_found', 'ERR P0002 staff_not_found',
      pg_temp.try_as('authenticated', v_owner, array[format(c_del, gen_random_uuid())]));
    perform pg_temp.expect('who: b1 is still there, removed', 'removed', pg_temp.state(array[r_b1]));
  exception when others then
    perform pg_temp.expect('section 4 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 5. Branch and every-branch admins, then the owner. Starts: b1 and admin removed at branch one,
  --    b2 removed at two, wide removed with no branch. ---------------------------------------------
  begin
    v_audit := pg_temp.deletions(v_ra);
    perform pg_temp.expect('branch admin: refused on the removed row with no branch, the one at branch two, and a removed admin of their own branch',
      c_no_auth || '|' || c_no_auth || '|' || c_no_auth,
      pg_temp.call_as(v_badmin, format(c_del, r_wide)) || '|'
        || pg_temp.call_as(v_badmin, format(c_del, r_b2)) || '|'
        || pg_temp.call_as(v_badmin, format(c_del, r_admin)));
    v_answer := pg_temp.call_as(v_badmin, format(c_del, r_b1));
    perform pg_temp.expect('branch admin: deletes a removed member of their own branch; the audit row names them',
      pg_temp.deleted_answer(r_b1) || '|gone|1',
      v_answer || '|' || pg_temp.state(array[r_b1]) || '|'
        || (select count(*)::text from public.audit_logs a
             where a.entity_id::text = r_b1::text and a.action = 'staff_member_deleted'
               and a.actor_id::text = v_badmin::text));
    perform pg_temp.expect('every-branch admin: may delete the removed row with no branch and the one at branch two (both rolled back), not a removed admin',
      pg_temp.deleted_answer(r_wide) || '|' || pg_temp.deleted_answer(r_b2) || '|' || c_no_auth,
      pg_temp.try_as('authenticated', v_wadmin, array[format(c_del, r_wide)]) || '|'
        || pg_temp.try_as('authenticated', v_wadmin, array[format(c_del, r_b2)]) || '|'
        || pg_temp.try_as('authenticated', v_wadmin, array[format(c_del, r_admin)]));
    perform pg_temp.expect('owner: deletes the removed admin and the removed row with no branch',
      pg_temp.deleted_answer(r_admin) || '|' || pg_temp.deleted_answer(r_wide),
      pg_temp.call_as(v_owner, format(c_del, r_admin)) || '|' || pg_temp.call_as(v_owner, format(c_del, r_wide)));
    perform pg_temp.expect('after: b1, wide and admin are gone and three more deletions are audited; b2 is still there',
      'gone,removed,gone,gone|' || (v_audit + 3),
      pg_temp.state(array[r_b1, r_b2, r_wide, r_admin]) || '|' || pg_temp.deletions(v_ra));
  exception when others then
    perform pg_temp.expect('section 5 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 6. Inviting gone again. Starts: gone deleted in section 1. -----------------------------------
  begin
    perform pg_temp.expect('invite again: invite-staff''s lookup (restaurant and address, then branch) finds nothing left of them',
      '0',
      (select count(*)::text from public.staff_members
        where restaurant_id = v_ra and invited_email = v_gone_email and branch_id = v_a1));
    -- As invite-staff inserts one when it finds no row.
    insert into public.staff_members (restaurant_id, branch_id, invited_email, role, status, permissions)
    values (v_ra, v_a1, v_gone_email, 'kitchen', 'pending', '{}') returning id into v_new;
    perform pg_temp.expect('invite again: a new pending row for the same address and branch, nobody''s yet',
      'pending|-',
      (select status::text || '|' || coalesce(user_id::text, '-') from public.staff_members where id = v_new));
    perform pg_temp.expect('invite again: they accept it (rolled back) and are an active kitchen member of branch one on that row, their only row there',
      'ok active|kitchen|1',
      pg_temp.try_sql(array[
        format(c_sub, u_gone),
        format('select public.accept_staff_invite(%L)::text', v_new),
        format('select (select status::text || ''|'' || role::text from public.staff_members where id = %L) || ''|'' || (select count(*) from public.staff_members where user_id = %L and restaurant_id = %L and branch_id = %L)',
               v_new, u_gone, v_ra, v_a1)]));
  exception when others then
    perform pg_temp.expect('section 6 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 7. Cancel keeps history. Starts: shift removed with its shift on record (section 3 kept both,
  --    section 5 never touched it); pending as the fixture wrote it (section 2 refused it). ---------
  begin
    perform pg_temp.act_as(null);
    -- As invite-staff revives a removed row as the new invitation.
    update public.staff_members
       set status = 'pending', user_id = null, accepted_at = null, invited_at = now()
     where id = r_shift;
    v_answer := pg_temp.call_as(v_owner, format(c_cancel, r_shift));
    perform pg_temp.expect('cancel: an invitation revived from a removed member with a shift on record is put back to removed, the shift still theirs, and the answer says it was kept',
      'ok ' || jsonb_build_object('staff_id', r_shift, 'cancelled', true, 'kept', true)::text || '|removed|true',
      v_answer || '|' || pg_temp.state(array[r_shift]) || '|'
        || coalesce((select (s.staff_member_id = r_shift)::text from public.staff_shifts s where s.id = v_shift), 'gone'));
    perform pg_temp.expect('cancel: audited once as staff_status_changed pending -> removed by the owner as staff, with its role',
      '1|staff|true|pending|removed|kitchen',
      (select count(*)::text from public.audit_logs a
        where a.entity_id::text = r_shift::text and a.action = 'staff_status_changed'
          and a.metadata ->> 'reason' = 'invitation_cancelled_history_kept')
      || '|' || coalesce(
        (select a.actor_type || '|' || (a.actor_id::text = v_owner::text)::text || '|'
                || (a.metadata ->> 'from_status') || '|' || (a.metadata ->> 'to_status') || '|' || (a.metadata ->> 'role')
           from public.audit_logs a
          where a.entity_id::text = r_shift::text and a.action = 'staff_status_changed'
            and a.metadata ->> 'reason' = 'invitation_cancelled_history_kept'
          limit 1), '-'));
    perform pg_temp.expect('cancel: the kept row is refused by Delete for its history, and a second Cancel is told it was already cancelled',
      c_history || '|ERR P0001 invite_already_cancelled',
      pg_temp.try_as('authenticated', v_owner, array[format(c_del, r_shift)]) || '|'
        || pg_temp.try_as('authenticated', v_owner, array[format(c_cancel, r_shift)]));
    v_answer := pg_temp.call_as(v_owner, format(c_cancel, r_pending));
    perform pg_temp.expect('cancel: a pending invitation with no history is deleted as before',
      'ok ' || jsonb_build_object('staff_id', r_pending, 'cancelled', true)::text || '|gone',
      v_answer || '|' || pg_temp.state(array[r_pending]));
    perform pg_temp.expect('cancel: the branch cashier may not cancel either', c_no_auth,
      pg_temp.try_as('authenticated', v_cashier, array[format(c_cancel, r_order)]));
  exception when others then
    perform pg_temp.act_as(null);
    perform pg_temp.expect('section 7 ran', 'ok', 'ERR ' || sqlerrm);
  end;

  -- 8. Accepting. Starts: shift kept as removed and nobody's (section 7); opened removed with its
  --    opened sitting, and b2 removed at branch two (sections 3 and 5 kept both). ------------------
  begin
    perform pg_temp.act_as(null);
    update auth.users set email_confirmed_at = now() where id in (u_shift, u_open, u_b2);
    perform pg_temp.expect('accept: the link of an invitation Cancel kept as removed says it no longer exists',
      'ERR P0001 invite_not_found',
      pg_temp.try_as('authenticated', u_shift, array[format(c_accept, r_shift)]));

    -- opened is invited again (invite-staff revives the row: pending, nobody's), while the same
    -- account holds a second, removed row at branch one (set_staff_branch_scope can leave one, as
    -- the revived row's empty user_id is outside uniq_staff_user_branch).
    update public.staff_members
       set status = 'pending', user_id = null, accepted_at = null, invited_at = now()
     where id = r_open;
    v_x := pg_temp.staff_row(u_open, v_ra, v_a1, 'server', 'removed');
    v_answer := pg_temp.call_as(u_open, format(c_accept, r_open));
    perform pg_temp.expect('accept: on the clash the account''s removed row comes back active, and the revived invitation with a sitting on record goes back to removed, still named on the sitting',
      'ok ' || jsonb_build_object('staff_id', v_x, 'restaurant_id', v_ra, 'branch_id', v_a1, 'role', 'server',
                                  'already_accepted', false, 'revived', true)::text
        || '|active,removed|-|true',
      v_answer || '|' || pg_temp.state(array[v_x, r_open]) || '|'
        || coalesce((select user_id::text from public.staff_members where id = r_open), '-') || '|'
        || coalesce((select (ts.opened_by_staff = r_open)::text from public.table_sessions ts where ts.id = v_sess_open), 'gone'));

    -- b2 is invited again on a new row (no history) while their removed row stays at branch two.
    perform pg_temp.act_as(null);
    insert into public.staff_members (restaurant_id, branch_id, invited_email, role, status)
    values (v_ra, v_a2, (select lower(email) from auth.users where id = u_b2), 'kitchen', 'pending')
    returning id into v_inv;
    v_answer := pg_temp.call_as(u_b2, format(c_accept, v_inv));
    perform pg_temp.expect('accept: with no history on the spent invitation, the removed row comes back as kitchen and the invitation is deleted, as before',
      'ok ' || jsonb_build_object('staff_id', r_b2, 'restaurant_id', v_ra, 'branch_id', v_a2, 'role', 'kitchen',
                                  'already_accepted', false, 'revived', true)::text
        || '|active,gone|kitchen',
      v_answer || '|' || pg_temp.state(array[r_b2, v_inv]) || '|'
        || (select role::text from public.staff_members where id = r_b2));
  exception when others then
    perform pg_temp.act_as(null);
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
