-- Third and last part of the `admin` role regression (see 20260830085951 for the helpers
-- and 20260830091155 for RLS). 17 SECURITY DEFINER functions carry their own inline
-- `role in ('owner','manager', ...)` check and call neither the helpers nor
-- role_capabilities, so an admin was still refused by all of them.
--
-- Reached through these, an admin could not: cancel, recall or refund an order; create a
-- branch; duplicate or reorder menu items and categories; toggle availability; read the
-- forecast, cohort, LTV or sales-tax reports; issue a tax invoice; distribute the tip pool;
-- or set a rider's KYC status — the Verify button in the KYC review modal.
--
-- Same discipline as the policy migration: match one of two exact substrings and insert
-- 'admin' after 'owner', touching nothing else. Roles below manager stay where they are.
-- CREATE OR REPLACE preserves each function's grants, volatility, SECURITY DEFINER flag and
-- search_path, all of which come back verbatim from pg_get_functiondef.
do $mig$
declare
  r record;
  v_def text;
  v_new text;
  v_count int := 0;
  v_t1 constant text := '''owner'',''manager''';
  v_r1 constant text := '''owner'',''admin'',''manager''';
  v_t2 constant text := '''owner'', ''manager''';
  v_r2 constant text := '''owner'', ''admin'', ''manager''';
begin
  for r in
    select p.oid, n.nspname as sch, p.proname as fn
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and p.prokind = 'f'
       and (pg_get_functiondef(p.oid) like '%' || v_t1 || '%'
         or pg_get_functiondef(p.oid) like '%' || v_t2 || '%')
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(replace(v_def, v_t1, v_r1), v_t2, v_r2);
    if v_new is distinct from v_def then
      execute v_new;
      v_count := v_count + 1;
      raise notice 'patched %.%', r.sch, r.fn;
    end if;
  end loop;
  raise notice 'functions patched: %', v_count;
end $mig$;
