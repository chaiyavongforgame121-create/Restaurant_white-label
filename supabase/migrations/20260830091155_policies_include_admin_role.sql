-- Second part of the same regression as 20260830085951. That migration fixed the two
-- private.user_manages_* helpers, but 20 policies never called them — they inline their own
-- `staff_members.role = ANY (ARRAY['owner', 'manager', ...])` list, so `admin` was still
-- missing everywhere those appear.
--
-- Found because an admin opening a rider's KYC review saw three "Not uploaded" rows while
-- the rider's own app showed all three documents uploaded. The files were there
-- (storage.objects had license.jpg, vehicle_reg.jpg and selfie.jpg); the SELECT policy
-- driver_kyc_admin_read simply filtered them out. Storage denials and genuinely absent
-- files are indistinguishable in that UI, which is why it read as a broken upload.
--
-- Every affected policy shares one exact substring, verified across all 20 before writing
-- this: "'owner'::staff_role, 'manager'::staff_role". The rewrite inserts 'admin' between
-- them and touches nothing else, so a policy that happens to mention manager for another
-- reason cannot be caught by accident. Roles below manager (cashier, kitchen) are left
-- exactly where they are.
do $$
declare
  r record;
  v_old_using text;
  v_old_check text;
  v_new_using text;
  v_new_check text;
  v_sql text;
  v_target constant text := '''owner''::staff_role, ''manager''::staff_role';
  v_repl   constant text := '''owner''::staff_role, ''admin''::staff_role, ''manager''::staff_role';
  v_count int := 0;
begin
  for r in
    select n.nspname as sch, c.relname as tbl, p.polname as pol, p.polqual, p.polwithcheck, p.polrelid
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ||
            coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) like '%' || v_target || '%'
  loop
    v_old_using := pg_get_expr(r.polqual, r.polrelid);
    v_old_check := pg_get_expr(r.polwithcheck, r.polrelid);
    v_new_using := replace(coalesce(v_old_using, ''), v_target, v_repl);
    v_new_check := replace(coalesce(v_old_check, ''), v_target, v_repl);

    v_sql := format('alter policy %I on %I.%I', r.pol, r.sch, r.tbl);
    if v_old_using is not null then
      v_sql := v_sql || format(' using (%s)', v_new_using);
    end if;
    if v_old_check is not null then
      v_sql := v_sql || format(' with check (%s)', v_new_check);
    end if;

    execute v_sql;
    v_count := v_count + 1;
    raise notice 'patched %.%.%', r.sch, r.tbl, r.pol;
  end loop;
  raise notice 'policies patched: %', v_count;
end $$;
