-- Tenant and branch isolation checks for 20260918110000_tenant_isolation_hardening.
--
-- Runs against the live data and changes nothing: everything happens inside one transaction that
-- is rolled back. Run it from the repo root with
--   npx supabase db query --linked --project-ref <ref> -f supabase/tests/tenant_isolation.sql
-- and read the `step | result | ok` rows it prints. Each `ok` is the expectation for that step.
--
-- Identities (never owner@test.com: it is a platform admin, so every check passes for it):
--   9467cf42 real owner, owner row pinned to Hamburger     147d5c02 bb@bb.com, admin at Hamburger only
--   a3333333 kitchen at Hamburger                            a2222222 cashier at Hamburger
--   1e74fba1 Bobby, diner with orders at Food Thai Thai     a1111111 customer@test.com, a diner at Hamburger
--   8c8c806e E2E Tester, a diner used as the cross-tenant forger from the audit's repro
-- Branches: Hamburger 44444444-…, Food Thai Thai (FTT) d0b26b93-…; Somtam Zab is restaurant 11111111-….

begin;

create temp table t_out(step text, result text, ok boolean) on commit drop;
create temp table t_fx(k text primary key, v uuid) on commit drop;
grant all on t_out, t_fx to authenticated, anon;

insert into t_fx select 'ftt_item',  id from public.menu_items      where branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083' order by created_at, id limit 1;
insert into t_fx select 'ftt_group', id from public.modifier_groups where branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083' order by created_at, id limit 1;
insert into t_fx select 'ham_group', id from public.modifier_groups where branch_id = '44444444-4444-4444-4444-444444444444' order by created_at, id limit 1;
-- Riders: one who works only with Hamburger, one shared by Hamburger and FTT, one shared by
-- Hamburger and another restaurant (a branch that turned a rider down does not count).
insert into t_fx select 'ham_driver', da.driver_id from public.driver_approvals da
 where da.branch_id = '44444444-4444-4444-4444-444444444444'
   and not exists (select 1 from public.driver_approvals x where x.driver_id = da.driver_id
                      and x.branch_id <> da.branch_id and x.status <> 'rejected')
 order by da.driver_id limit 1;
insert into t_fx select 'shared_ftt_driver', da.driver_id from public.driver_approvals da
 where da.branch_id = '44444444-4444-4444-4444-444444444444' and da.status <> 'rejected'
   and exists (select 1 from public.driver_approvals x where x.driver_id = da.driver_id
                  and x.branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083' and x.status <> 'rejected')
   and not exists (select 1 from public.driver_approvals x join public.branches b on b.id = x.branch_id
                      where x.driver_id = da.driver_id and x.status <> 'rejected'
                        and b.restaurant_id <> '33333333-3333-3333-3333-333333333333')
 order by da.driver_id limit 1;
insert into t_fx select 'shared_tenant_driver', da.driver_id from public.driver_approvals da
 where da.branch_id = '44444444-4444-4444-4444-444444444444'
   and exists (select 1 from public.driver_approvals x join public.branches b on b.id = x.branch_id
                  where x.driver_id = da.driver_id and x.status <> 'rejected'
                    and b.restaurant_id <> '33333333-3333-3333-3333-333333333333')
 order by da.driver_id limit 1;
insert into t_fx select 'ftt_combo', id from public.combo_sets where branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083' order by created_at, id limit 1;
insert into t_fx select 'ham_combo', id from public.combo_sets where branch_id = '44444444-4444-4444-4444-444444444444' order by created_at, id limit 1;
-- Customer rows are resolved, not hard-coded: they are per branch, so the ids change when data moves.
insert into t_fx select 'bobby_order_customer',  customer_id from public.orders where id = '3b920582-92ff-4d36-9e54-7c33fde6ffa9';
insert into t_fx select 'other_order_customer',  customer_id from public.orders where id = '6594c863-c3cc-4b8b-ac70-8564ef549caf';
insert into t_fx select 'ticket_order_customer', customer_id from public.orders where id = '0a63506f-f5fd-4d3b-8e0e-cf22acacd2c3';
insert into t_fx select 'diner_a_customer', id from public.customers
 where user_id = 'a1111111-1111-1111-1111-111111111111' and restaurant_id = '33333333-3333-3333-3333-333333333333'
 order by created_at limit 1;
insert into t_fx select 'bobby_ftt_customer', coalesce(
  (select id from public.customers where user_id = '1e74fba1-cebf-46b1-a963-fb4915bd899d'
      and branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083' order by created_at limit 1),
  (select id from public.customers where user_id = '1e74fba1-cebf-46b1-a963-fb4915bd899d'
      and restaurant_id = '33333333-3333-3333-3333-333333333333' order by created_at limit 1));

-- Dish photos already in each branch's folder, for the replace (update) checks.
insert into storage.objects(bucket_id, name) values
  ('branch-assets', 'menu/d0b26b93-4539-4065-8b16-bcfa1e5b8083/isolation-existing.png'),
  ('branch-assets', 'menu/44444444-4444-4444-4444-444444444444/isolation-existing.png');

-- ---------- 00. Catalogue -------------------------------------------------------------------------
insert into t_out select '00 composite key ' || conrelid::regclass::text, pg_get_constraintdef(oid), true
  from pg_constraint where conname like '%\_branch\_in\_restaurant\_fkey';
insert into t_out select '00 authenticated may execute ' || p.proname,
       has_function_privilege('authenticated', p.oid, 'execute')::text,
       not has_function_privilege('authenticated', p.oid, 'execute')
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('check_rate_limit', 'find_dispatch_candidates', 'dispatch_candidate_diagnostics', 'sweep_abandoned_carts');
insert into t_out select '00 anon may execute sweep_abandoned_carts',
       has_function_privilege('anon', 'public.sweep_abandoned_carts()', 'execute')::text,
       not has_function_privilege('anon', 'public.sweep_abandoned_carts()', 'execute');
insert into t_out select '00 anon may read menu_items.cost',
       has_column_privilege('anon', 'public.menu_items', 'cost', 'select')::text,
       not has_column_privilege('anon', 'public.menu_items', 'cost', 'select');
insert into t_out select '00 anon may read menu_items.price/stock_quantity',
       (has_column_privilege('anon', 'public.menu_items', 'price', 'select')
        and has_column_privilege('anon', 'public.menu_items', 'stock_quantity', 'select'))::text,
       has_column_privilege('anon', 'public.menu_items', 'price', 'select')
        and has_column_privilege('anon', 'public.menu_items', 'stock_quantity', 'select');
insert into t_out select '00 promos_public_read_active policies', count(*)::text, count(*) = 0
  from pg_policies where schemaname = 'public' and tablename = 'promos' and policyname = 'promos_public_read_active';
insert into t_out select '00 menu FOR ALL staff policies left', count(*)::text, count(*) = 0
  from pg_policies
 where schemaname = 'public' and cmd = 'ALL'
   and tablename in ('menu_items', 'menu_categories', 'modifier_groups', 'modifier_options',
                     'menu_item_modifiers', 'combo_sets', 'combo_items');
insert into t_out select '00 branding bucket', file_size_limit || ' ' || array_to_string(allowed_mime_types, ','),
       file_size_limit >= 10485760 and 'image/png' = any(allowed_mime_types)
  from storage.buckets where id = 'branding';

-- ---------- 01. The audit's forged cross-tenant staff row -------------------------------------------
-- Restaurant Somtam Zab, branch Food Thai Thai, for a diner with no staff role anywhere.
do $$ begin
  insert into public.staff_members(user_id, restaurant_id, branch_id, role, status)
  values ('8c8c806e-a883-4c19-9045-820f44fe21f6', '11111111-1111-1111-1111-111111111111',
          'd0b26b93-4539-4065-8b16-bcfa1e5b8083', 'admin', 'active');
  insert into t_out values ('01 forged row (Somtam Zab + FTT branch) inserted', 'INSERTED', false);
exception
  when foreign_key_violation then
    insert into t_out values ('01 forged row (Somtam Zab + FTT branch) inserted', 'refused: ' || sqlerrm, true);
  when others then
    insert into t_out values ('01 forged row (Somtam Zab + FTT branch) inserted', sqlstate || ' ' || sqlerrm, false);
end $$;

-- 02. Defence in depth: suppose such a row existed anyway (written with the key checks off, as a row
-- from before the key would be). The helpers must still not open the branch.
set local session_replication_role = replica;
insert into public.staff_members(user_id, restaurant_id, branch_id, role, status)
values ('8c8c806e-a883-4c19-9045-820f44fe21f6', '11111111-1111-1111-1111-111111111111',
        'd0b26b93-4539-4065-8b16-bcfa1e5b8083', 'admin', 'active');
set local session_replication_role = origin;

select set_config('request.jwt.claims', json_build_object('sub', '8c8c806e-a883-4c19-9045-820f44fe21f6', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', '8c8c806e-a883-4c19-9045-820f44fe21f6', true);
set local role authenticated;

insert into t_out select '02 forger: FTT in user_branch_ids()', (count(*) > 0)::text, count(*) = 0
  from private.user_branch_ids() u(id) where u.id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';
insert into t_out select '02 forger: FTT orders visible', count(*)::text, count(*) = 0
  from public.orders where branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';
do $$ declare n int; begin
  update public.menu_items set price = 0.01 where branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';
  get diagnostics n = row_count;
  insert into t_out values ('02 forger: FTT dishes repriced', n::text, n = 0);
exception when others then
  insert into t_out values ('02 forger: FTT dishes repriced', sqlstate || ' ' || sqlerrm, sqlstate = '42501');
end $$;
insert into t_out select '02 forger: staff_has_capability(FTT, menu.manage)',
       private.staff_has_capability('d0b26b93-4539-4065-8b16-bcfa1e5b8083', 'menu.manage')::text,
       not private.staff_has_capability('d0b26b93-4539-4065-8b16-bcfa1e5b8083', 'menu.manage');
insert into t_out select '02 forger: user_has_role_in_branch(FTT, admin)',
       private.user_has_role_in_branch('d0b26b93-4539-4065-8b16-bcfa1e5b8083', 'admin')::text,
       not private.user_has_role_in_branch('d0b26b93-4539-4065-8b16-bcfa1e5b8083', 'admin');
reset role;
delete from public.staff_members
 where user_id = '8c8c806e-a883-4c19-9045-820f44fe21f6' and restaurant_id = '11111111-1111-1111-1111-111111111111';

-- ---------- 03. bb@bb.com: admin at Hamburger only ----------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', '147d5c02-04e7-44af-8595-337605d785e6', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', '147d5c02-04e7-44af-8595-337605d785e6', true);
set local role authenticated;

do $$ begin
  insert into public.menu_items(branch_id, name, price) values ('d0b26b93-4539-4065-8b16-bcfa1e5b8083', 'isolation test', 1);
  insert into t_out values ('03 bb: add a dish to FTT', 'INSERTED', false);
exception when others then insert into t_out values ('03 bb: add a dish to FTT', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
do $$ declare n int; begin
  update public.menu_items set price = price where branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';
  get diagnostics n = row_count;
  insert into t_out values ('03 bb: FTT dishes updated', n::text, n = 0);
exception when others then insert into t_out values ('03 bb: FTT dishes updated', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ declare n int; begin
  update public.menu_items set price = price where branch_id = '44444444-4444-4444-4444-444444444444';
  get diagnostics n = row_count;
  insert into t_out values ('03 bb: Hamburger dishes updated (own branch)', n::text, n > 0);
exception when others then insert into t_out values ('03 bb: Hamburger dishes updated (own branch)', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ begin
  insert into public.menu_categories(branch_id, name) values ('d0b26b93-4539-4065-8b16-bcfa1e5b8083', 'isolation test');
  insert into t_out values ('03 bb: add a category to FTT', 'INSERTED', false);
exception when others then insert into t_out values ('03 bb: add a category to FTT', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
do $$ declare n int; begin
  update public.restaurants set storefront = storefront where id = '33333333-3333-3333-3333-333333333333';
  get diagnostics n = row_count;
  insert into t_out values ('03 bb: edit the shared restaurant row', 'updated ' || n, false);
exception when others then insert into t_out values ('03 bb: edit the shared restaurant row', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
do $$ declare n int; begin
  update public.brands set name = name where restaurant_id = '33333333-3333-3333-3333-333333333333';
  get diagnostics n = row_count;
  insert into t_out values ('03 bb: edit the shared brand', 'updated ' || n, false);
exception when others then insert into t_out values ('03 bb: edit the shared brand', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
do $$ begin
  insert into storage.objects(bucket_id, name) values ('branch-assets', 'menu/d0b26b93-4539-4065-8b16-bcfa1e5b8083/isolation-test.png');
  insert into t_out values ('03 bb: upload a dish photo into FTT''s folder', 'INSERTED', false);
exception when others then insert into t_out values ('03 bb: upload a dish photo into FTT''s folder', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
do $$ begin
  insert into storage.objects(bucket_id, name) values ('branch-assets', 'menu/44444444-4444-4444-4444-444444444444/isolation-test.png');
  insert into t_out values ('03 bb: upload a dish photo into Hamburger''s folder', 'INSERTED', true);
exception when others then insert into t_out values ('03 bb: upload a dish photo into Hamburger''s folder', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ begin
  insert into storage.objects(bucket_id, name) values ('branch-assets', 'pod/44444444-4444-4444-4444-444444444444/isolation-test.png');
  insert into t_out values ('03 bb: write into a rider photo folder', 'INSERTED', false);
exception when others then insert into t_out values ('03 bb: write into a rider photo folder', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
do $$ declare n int; begin
  update storage.objects set metadata = '{"isolation":1}'
   where bucket_id = 'branch-assets' and name = 'menu/44444444-4444-4444-4444-444444444444/isolation-existing.png';
  get diagnostics n = row_count;
  insert into t_out values ('03 bb: replace a Hamburger dish photo', n::text, n = 1);
exception when others then insert into t_out values ('03 bb: replace a Hamburger dish photo', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ declare n int; begin
  update storage.objects set metadata = '{"isolation":1}'
   where bucket_id = 'branch-assets' and name = 'menu/d0b26b93-4539-4065-8b16-bcfa1e5b8083/isolation-existing.png';
  get diagnostics n = row_count;
  insert into t_out values ('03 bb: replace an FTT dish photo', n::text, n = 0);
exception when others then insert into t_out values ('03 bb: replace an FTT dish photo', sqlstate || ' ' || sqlerrm, false); end $$;
insert into t_out select '03 bb: FTT dish photos listed', count(*)::text, count(*) = 0
  from storage.objects where bucket_id = 'branch-assets' and name like 'menu/d0b26b93-4539-4065-8b16-bcfa1e5b8083/%';
insert into t_out select '03 bb: rider KYC folders visible', count(distinct split_part(name, '/', 1))::text, count(*) > 0
  from storage.objects where bucket_id = 'driver-kyc';
do $$ begin
  perform public.set_driver_kyc_status((select v from t_fx where k = 'ham_driver'), 'verified', 'isolation test');
  insert into t_out values ('03 bb: KYC decision for a Hamburger rider', 'ok', true);
exception when others then insert into t_out values ('03 bb: KYC decision for a Hamburger rider', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ begin
  -- kyc_status is one platform-wide column: rejecting here would stop FTT dispatching this rider.
  perform public.set_driver_kyc_status((select v from t_fx where k = 'shared_ftt_driver'), 'rejected', 'isolation test');
  insert into t_out values ('03 bb: KYC decision for a rider shared with FTT', 'ok', false);
exception when others then insert into t_out values ('03 bb: KYC decision for a rider shared with FTT', sqlstate || ' ' || sqlerrm,
  sqlerrm like 'forbidden: kyc_shared_with_other_branch%'); end $$;
do $$ begin
  perform public.set_driver_kyc_status((select v from t_fx where k = 'shared_tenant_driver'), 'rejected', 'isolation test');
  insert into t_out values ('03 bb: KYC decision for a rider shared with Somtam Zab', 'ok', false);
exception when others then insert into t_out values ('03 bb: KYC decision for a rider shared with Somtam Zab', sqlstate || ' ' || sqlerrm,
  sqlerrm like 'forbidden: kyc_shared_with_other_branch%'); end $$;
reset role;

-- ---------- 04. Kitchen at Hamburger ------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', 'a3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', 'a3333333-3333-3333-3333-333333333333', true);
set local role authenticated;

do $$ declare n int; begin
  update public.combo_sets set total_price = 0 where id = (select v from t_fx where k = 'ham_combo');
  get diagnostics n = row_count;
  insert into t_out values ('04 kitchen: set a Hamburger combo price to 0', n::text, n = 0);
exception when others then insert into t_out values ('04 kitchen: set a Hamburger combo price to 0', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
do $$ declare n int; begin
  update public.combo_items set quantity = quantity + 1 where combo_id = (select v from t_fx where k = 'ham_combo');
  get diagnostics n = row_count;
  insert into t_out values ('04 kitchen: change a combo''s dishes', n::text, n = 0);
exception when others then insert into t_out values ('04 kitchen: change a combo''s dishes', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
do $$ declare n int; begin
  update public.menu_items set price = 0 where branch_id = '44444444-4444-4444-4444-444444444444';
  get diagnostics n = row_count;
  insert into t_out values ('04 kitchen: reprice Hamburger dishes', n::text, n = 0);
exception when others then insert into t_out values ('04 kitchen: reprice Hamburger dishes', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
insert into t_out select '04 kitchen: still reads Hamburger combos', count(*)::text, count(*) > 0
  from public.combo_sets where branch_id = '44444444-4444-4444-4444-444444444444';
insert into t_out select '04 kitchen: still reads Hamburger dishes', count(*)::text, count(*) > 0
  from public.menu_items where branch_id = '44444444-4444-4444-4444-444444444444';
insert into t_out select '04 kitchen: rider KYC objects visible', count(*)::text, count(*) = 0
  from storage.objects where bucket_id = 'driver-kyc';
do $$ begin
  perform public.set_driver_kyc_status((select v from t_fx where k = 'ham_driver'), 'rejected', 'isolation test');
  insert into t_out values ('04 kitchen: KYC decision', 'ok', false);
exception when others then insert into t_out values ('04 kitchen: KYC decision', sqlstate || ' ' || sqlerrm, sqlerrm = 'forbidden'); end $$;
reset role;

-- ---------- 05. Cashier at Hamburger ------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', 'a2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', 'a2222222-2222-2222-2222-222222222222', true);
set local role authenticated;
do $$ declare n int; begin
  update public.menu_items set is_active = is_active where branch_id = '44444444-4444-4444-4444-444444444444';
  get diagnostics n = row_count;
  insert into t_out values ('05 cashier: edit Hamburger dishes', n::text, n = 0);
exception when others then insert into t_out values ('05 cashier: edit Hamburger dishes', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
do $$ begin
  perform public.check_rate_limit('order:phone:x:0', 1, 60);
  insert into t_out values ('05 cashier: call check_rate_limit', 'ok', false);
exception when others then insert into t_out values ('05 cashier: call check_rate_limit', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
reset role;

-- ---------- 06. The real owner (owner row on Hamburger) works on both branches ------------------------
select set_config('request.jwt.claims', json_build_object('sub', '9467cf42-0a03-4abe-86d5-a2610ee15d0a', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', '9467cf42-0a03-4abe-86d5-a2610ee15d0a', true);
set local role authenticated;

do $$ declare n int; begin
  update public.menu_items set price = price where branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083';
  get diagnostics n = row_count;
  insert into t_out values ('06 owner: FTT dishes updated', n::text, n > 0);
exception when others then insert into t_out values ('06 owner: FTT dishes updated', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ begin
  insert into public.menu_categories(branch_id, name) values ('d0b26b93-4539-4065-8b16-bcfa1e5b8083', 'isolation test');
  insert into t_out values ('06 owner: add a category to FTT', 'ok', true);
exception when others then insert into t_out values ('06 owner: add a category to FTT', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ declare n int; begin
  update public.combo_sets set total_price = total_price where id = (select v from t_fx where k = 'ftt_combo');
  get diagnostics n = row_count;
  insert into t_out values ('06 owner: FTT combo updated', n::text, n = 1);
exception when others then insert into t_out values ('06 owner: FTT combo updated', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ declare n int; begin
  update public.restaurants set storefront = storefront where id = '33333333-3333-3333-3333-333333333333';
  get diagnostics n = row_count;
  insert into t_out values ('06 owner: edit the shared restaurant row', n::text, n = 1);
exception when others then insert into t_out values ('06 owner: edit the shared restaurant row', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ declare n int; begin
  update public.brands set name = name where restaurant_id = '33333333-3333-3333-3333-333333333333';
  get diagnostics n = row_count;
  insert into t_out values ('06 owner: edit the shared brand', n::text, n >= 1);
exception when others then insert into t_out values ('06 owner: edit the shared brand', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ begin
  insert into storage.objects(bucket_id, name) values ('branch-assets', 'menu/d0b26b93-4539-4065-8b16-bcfa1e5b8083/isolation-test-owner.png');
  insert into t_out values ('06 owner: upload a dish photo into FTT''s folder', 'ok', true);
exception when others then insert into t_out values ('06 owner: upload a dish photo into FTT''s folder', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ begin
  insert into storage.objects(bucket_id, name) values ('branding', '33333333-3333-3333-3333-333333333333/isolation-test-owner.png');
  insert into t_out values ('06 owner: upload into the restaurant branding folder', 'ok', true);
exception when others then insert into t_out values ('06 owner: upload into the restaurant branding folder', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ declare n int; begin
  update storage.objects set metadata = '{"isolation":1}'
   where bucket_id = 'branch-assets' and name = 'menu/d0b26b93-4539-4065-8b16-bcfa1e5b8083/isolation-existing.png';
  get diagnostics n = row_count;
  insert into t_out values ('06 owner: replace an FTT dish photo', n::text, n = 1);
exception when others then insert into t_out values ('06 owner: replace an FTT dish photo', sqlstate || ' ' || sqlerrm, false); end $$;
insert into t_out select '06 owner: rider KYC folders visible', count(distinct split_part(name, '/', 1))::text, count(*) > 0
  from storage.objects where bucket_id = 'driver-kyc';
do $$ begin
  -- The owner row covers Hamburger and FTT, so the owner decides for a rider the two share.
  perform public.set_driver_kyc_status((select v from t_fx where k = 'shared_ftt_driver'), 'verified', 'isolation test');
  insert into t_out values ('06 owner: KYC decision for a rider shared by Hamburger and FTT', 'ok', true);
exception when others then insert into t_out values ('06 owner: KYC decision for a rider shared by Hamburger and FTT', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ begin
  perform public.set_driver_kyc_status((select v from t_fx where k = 'shared_tenant_driver'), 'rejected', 'isolation test');
  insert into t_out values ('06 owner: KYC decision for a rider shared with Somtam Zab', 'ok', false);
exception when others then insert into t_out values ('06 owner: KYC decision for a rider shared with Somtam Zab', sqlstate || ' ' || sqlerrm,
  sqlerrm like 'forbidden: kyc_shared_with_other_branch%'); end $$;
do $$ begin
  insert into public.menu_item_modifiers(menu_item_id, modifier_group_id)
  values ((select v from t_fx where k = 'ftt_item'), (select v from t_fx where k = 'ham_group'));
  insert into t_out values ('06 owner: give an FTT dish a Hamburger modifier group', 'INSERTED', false);
exception when others then insert into t_out values ('06 owner: give an FTT dish a Hamburger modifier group', sqlstate || ' ' || sqlerrm, sqlstate = '23514'); end $$;
do $$ begin
  insert into public.menu_item_modifiers(menu_item_id, modifier_group_id)
  values ((select v from t_fx where k = 'ftt_item'), (select v from t_fx where k = 'ftt_group'));
  insert into t_out values ('06 owner: give an FTT dish an FTT modifier group', 'ok', true);
exception
  when unique_violation then insert into t_out values ('06 owner: give an FTT dish an FTT modifier group', 'already linked', true);
  when others then insert into t_out values ('06 owner: give an FTT dish an FTT modifier group', sqlstate || ' ' || sqlerrm, false);
end $$;
reset role;

-- ---------- 07. Ratings: branch and rider come from the order ---------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', '1e74fba1-cebf-46b1-a963-fb4915bd899d', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', '1e74fba1-cebf-46b1-a963-fb4915bd899d', true);
set local role authenticated;
do $$ declare v_branch uuid; v_driver uuid; begin
  -- Bobby's own completed FTT order (A-2609-575079, a pickup), sent with Hamburger's id and a rider.
  insert into public.order_ratings(order_id, customer_id, branch_id, driver_id, food_stars)
  values ('3b920582-92ff-4d36-9e54-7c33fde6ffa9', (select v from t_fx where k = 'bobby_order_customer'),
          '44444444-4444-4444-4444-444444444444', (select v from t_fx where k = 'ham_driver'), 5)
  returning branch_id, driver_id into v_branch, v_driver;
  insert into t_out values ('07 Bobby rates his FTT order with a spoofed branch and rider',
    'stored branch=' || v_branch || ' driver=' || coalesce(v_driver::text, 'null'),
    v_branch = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083' and v_driver is null);
exception when others then insert into t_out values ('07 Bobby rates his FTT order with a spoofed branch and rider', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ declare v_branch uuid; begin
  update public.order_ratings set branch_id = '44444444-4444-4444-4444-444444444444'
   where order_id = '3b920582-92ff-4d36-9e54-7c33fde6ffa9'
  returning branch_id into v_branch;
  insert into t_out values ('07 Bobby moves his rating to Hamburger', 'stored branch=' || v_branch,
    v_branch = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083');
exception when others then insert into t_out values ('07 Bobby moves his rating to Hamburger', sqlstate || ' ' || sqlerrm, false); end $$;
reset role;

select set_config('request.jwt.claims', json_build_object('sub', 'a1111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
set local role authenticated;
do $$ begin
  -- Somebody else's FTT order, as his own customer row, filed under Hamburger.
  insert into public.order_ratings(order_id, customer_id, branch_id, food_stars)
  values ('6594c863-c3cc-4b8b-ac70-8564ef549caf', (select v from t_fx where k = 'diner_a_customer'),
          '44444444-4444-4444-4444-444444444444', 1);
  insert into t_out values ('07 diner rates another diner''s FTT order (spoofed branch)', 'INSERTED', false);
exception when others then insert into t_out values ('07 diner rates another diner''s FTT order (spoofed branch)', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
do $$ begin
  insert into public.order_ratings(order_id, customer_id, branch_id, food_stars)
  values ('6594c863-c3cc-4b8b-ac70-8564ef549caf', (select v from t_fx where k = 'other_order_customer'),
          'd0b26b93-4539-4065-8b16-bcfa1e5b8083', 1);
  insert into t_out values ('07 diner rates it as the other diner', 'INSERTED', false);
exception when others then insert into t_out values ('07 diner rates it as the other diner', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;

-- ---------- 08. Tickets -----------------------------------------------------------------------------
do $$ begin
  insert into public.support_tickets(order_id, branch_id, customer_id, category, message)
  values ('0a63506f-f5fd-4d3b-8e0e-cf22acacd2c3', 'd0b26b93-4539-4065-8b16-bcfa1e5b8083',
          (select v from t_fx where k = 'diner_a_customer'), 'other', 'isolation test');
  insert into t_out values ('08 diner files a ticket on another diner''s order', 'INSERTED', false);
exception when others then insert into t_out values ('08 diner files a ticket on another diner''s order', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
do $$ begin
  -- No order: the ticket goes only to the branch that owns the customer row it is filed as.
  insert into public.support_tickets(order_id, branch_id, customer_id, category, message)
  values (null, (select case when c.branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083'
                             then '44444444-4444-4444-4444-444444444444'::uuid
                             else 'd0b26b93-4539-4065-8b16-bcfa1e5b8083'::uuid end
                   from public.customers c where c.id = (select v from t_fx where k = 'diner_a_customer')),
          (select v from t_fx where k = 'diner_a_customer'), 'other', 'isolation test');
  insert into t_out values ('08 diner files an orderless ticket at another branch', 'INSERTED', false);
exception when others then insert into t_out values ('08 diner files an orderless ticket at another branch', sqlstate || ' ' || sqlerrm,
  sqlerrm = 'ticket_branch_mismatch'); end $$;
do $$ declare v_branch uuid; begin
  insert into public.support_tickets(order_id, branch_id, customer_id, category, message)
  values (null, (select c.branch_id from public.customers c where c.id = (select v from t_fx where k = 'diner_a_customer')),
          (select v from t_fx where k = 'diner_a_customer'), 'other', 'isolation test')
  returning branch_id into v_branch;
  insert into t_out values ('08 diner files an orderless ticket at their own branch', 'stored branch=' || v_branch, true);
exception when others then insert into t_out values ('08 diner files an orderless ticket at their own branch', sqlstate || ' ' || sqlerrm, false); end $$;

-- ---------- 09. Promo codes are not listable ---------------------------------------------------------
insert into t_out select '09 diner lists promos', count(*)::text, count(*) = 0 from public.promos;
reset role;

select set_config('request.jwt.claims', json_build_object('sub', '1e74fba1-cebf-46b1-a963-fb4915bd899d', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', '1e74fba1-cebf-46b1-a963-fb4915bd899d', true);
set local role authenticated;
do $$ declare v_branch uuid; v_customer uuid; begin
  -- What the storefront sends at FTT today: the customer lookup by (user, FTT) finds nothing.
  insert into public.support_tickets(order_id, branch_id, customer_id, category, message)
  values ('0a63506f-f5fd-4d3b-8e0e-cf22acacd2c3', '44444444-4444-4444-4444-444444444444', null, 'other', 'isolation test')
  returning branch_id, customer_id into v_branch, v_customer;
  insert into t_out values ('08 Bobby reports a problem on his FTT order (no customer id, spoofed branch)',
    'stored branch=' || v_branch || ' customer=' || coalesce(v_customer::text, 'null'),
    v_branch = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083' and v_customer = (select v from t_fx where k = 'ticket_order_customer'));
exception when others then insert into t_out values ('08 Bobby reports a problem on his FTT order (no customer id, spoofed branch)', sqlstate || ' ' || sqlerrm, false); end $$;
reset role;

-- ---------- 10. Anonymous visitor ---------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true),
       set_config('request.jwt.claim.sub', '', true);
set local role anon;
do $$ begin
  perform cost from public.menu_items limit 1;
  insert into t_out values ('10 anon reads menu_items.cost', 'read', false);
exception when others then insert into t_out values ('10 anon reads menu_items.cost', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
insert into t_out
select '10 anon reads the storefront columns of FTT''s menu', count(*)::text, count(*) > 0
  from (select id, price, is_active, track_stock, stock_quantity, sold_out_until
          from public.menu_items where branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083') s;
-- The exact column list listMenuItems (packages/database/src/queries/menu.ts) asks for, and the combos view.
do $$ declare n int; begin
  select count(*) into n from (
    select id, branch_id, category_id, name, name_translations, description, description_translations,
           price, image_url, is_recommended, is_new, dietary_tags, allergens, rating, review_count,
           prep_time_minutes, calories, display_order, track_stock, stock_quantity, sold_out_until, is_active
      from public.menu_items where branch_id = '44444444-4444-4444-4444-444444444444' and is_active) s;
  insert into t_out values ('10 anon loads the storefront menu query', n::text, n > 0);
exception when others then insert into t_out values ('10 anon loads the storefront menu query', sqlstate || ' ' || sqlerrm, false); end $$;
do $$ declare n int; begin
  select count(*) into n from public.v_active_combos;
  insert into t_out values ('10 anon reads v_active_combos', n::text, true);
exception when others then insert into t_out values ('10 anon reads v_active_combos', sqlstate || ' ' || sqlerrm, false); end $$;
-- promos' remaining (staff) policy calls a helper anon may not execute, so anon is refused outright.
do $$ declare n int; begin
  select count(*) into n from public.promos;
  insert into t_out values ('10 anon lists promos', n::text, n = 0);
exception when others then insert into t_out values ('10 anon lists promos', sqlstate || ' ' || sqlerrm, sqlstate = '42501'); end $$;
reset role;

-- ---------- 11. Abandoned-cart emails carry their branch ---------------------------------------------
do $$ declare v_cart uuid; v_guest uuid; v_noemail uuid; v_row record; v_guest_notified timestamptz; v_noemail_notified timestamptz; begin
  -- Bobby's cart at FTT (addressed to his FTT customer row, or his Coastal Grill one), a guest
  -- cart nobody can be emailed about, and a signed-in diner whose customer rows have no address
  -- notify-worker could send to.
  update public.customers set email = 'isolation-test@example.com' where id = (select v from t_fx where k = 'bobby_ftt_customer');
  update public.customers set email = null
   where user_id = 'a1111111-1111-1111-1111-111111111111' and restaurant_id = '33333333-3333-3333-3333-333333333333';
  insert into public.abandoned_carts(user_id, customer_email, branch_id, cart, subtotal, created_at)
  values ('a1111111-1111-1111-1111-111111111111', 'isolation-noemail@example.com',
          'd0b26b93-4539-4065-8b16-bcfa1e5b8083', '[]'::jsonb, 1, now() - interval '2 hours')
  returning id into v_noemail;
  insert into public.abandoned_carts(user_id, customer_email, branch_id, cart, subtotal, created_at)
  values ('1e74fba1-cebf-46b1-a963-fb4915bd899d', 'isolation-test@example.com',
          'd0b26b93-4539-4065-8b16-bcfa1e5b8083', '[]'::jsonb, 1, now() - interval '2 hours')
  returning id into v_cart;
  insert into public.abandoned_carts(customer_email, branch_id, cart, subtotal, created_at)
  values ('isolation-guest@example.com', 'd0b26b93-4539-4065-8b16-bcfa1e5b8083', '[]'::jsonb, 1, now() - interval '2 hours')
  returning id into v_guest;
  perform public.sweep_abandoned_carts();
  select branch_id, recipient_type, recipient_id into v_row
    from public.notifications_outbox where variables->>'cart_id' = v_cart::text;
  select notified_at into v_guest_notified from public.abandoned_carts where id = v_guest;
  insert into t_out values ('11 abandoned-cart email: branch, recipient',
    coalesce(v_row.branch_id::text, 'null') || ' ' || coalesce(v_row.recipient_type, 'null') || ' ' || coalesce(v_row.recipient_id::text, 'null'),
    v_row.branch_id = 'd0b26b93-4539-4065-8b16-bcfa1e5b8083' and v_row.recipient_type = 'customer'
      and v_row.recipient_id = (select v from t_fx where k = 'bobby_ftt_customer'));
  insert into t_out values ('11 guest cart left for later', coalesce(v_guest_notified::text, 'not notified'), v_guest_notified is null);
  select notified_at into v_noemail_notified from public.abandoned_carts where id = v_noemail;
  insert into t_out select '11 diner with no sendable address left for later',
    coalesce(v_noemail_notified::text, 'not notified') || ', outbox rows ' || count(*),
    v_noemail_notified is null and count(*) = 0
    from public.notifications_outbox where variables->>'cart_id' = v_noemail::text;
exception when others then insert into t_out values ('11 abandoned-cart email', sqlstate || ' ' || sqlerrm, false); end $$;

select step, result, ok from t_out order by step;

rollback;
