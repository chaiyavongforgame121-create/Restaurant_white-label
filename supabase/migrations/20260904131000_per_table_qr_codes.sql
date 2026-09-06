-- Per-table QR codes.
--
-- `public.tables` has carried `qr_code_token` (UNIQUE, nullable) and an anon read policy
-- since the original schema, but nothing ever wrote a token and nothing ever read one --
-- the only QR the product ships is one code per branch. Every row is still NULL. This
-- makes the column real so a table tent can carry a code that means "this branch, this
-- table" instead of "this branch, please type your table number at checkout".
--
-- The token is a uuid with its dashes removed rather than gen_random_bytes: pgcrypto
-- lives in a non-default schema here, and gen_random_uuid is in pg_catalog on every
-- Postgres this project runs on, so the column DEFAULT resolves with no extension
-- dependency. Uniqueness is already enforced by tables_qr_code_token_key.

alter table public.tables
  alter column qr_code_token set default replace(gen_random_uuid()::text, '-', '');

update public.tables
   set qr_code_token = replace(gen_random_uuid()::text, '-', '')
 where qr_code_token is null;

alter table public.tables
  alter column qr_code_token set not null;

-- RESOLVER -------------------------------------------------------------------
-- A diner scanning a table tent has no session, and the storefront must be able to prove
-- the scanned table belongs to the branch in the URL before it pins anything -- otherwise
-- one restaurant's token would seat a diner at another restaurant's table. Returning the
-- branch and restaurant slugs alongside the table is what makes that check possible.
create or replace function public.resolve_table_qr(p_token text)
returns table (
  branch_id       uuid,
  branch_slug     text,
  branch_name     text,
  restaurant_slug text,
  table_id        uuid,
  table_number    text,
  display_name    text
)
language sql stable security definer set search_path to 'public','pg_temp' as $function$
  select b.id, b.slug, b.name, r.slug, t.id, t.table_number, t.display_name
    from public.tables t
    join public.branches b    on b.id = t.branch_id
    join public.restaurants r on r.id = b.restaurant_id
   where t.qr_code_token = p_token
     and t.is_active
     and b.is_active
   limit 1;
$function$;

-- Deliberately callable by anon, the same way is_delivery_available is: the storefront
-- has to resolve the code before anybody signs in.
revoke execute on function public.resolve_table_qr(text) from public;
grant  execute on function public.resolve_table_qr(text) to anon, authenticated;

-- ROTATION -------------------------------------------------------------------
-- PostgREST cannot ask for a column DEFAULT on update, so re-issuing a token needs a
-- function. The capability is re-checked inside because security definer bypasses the
-- policies below.
create or replace function public.rotate_table_qr_token(p_table_id uuid)
returns text
language plpgsql volatile security definer set search_path to 'public','pg_temp' as $function$
declare
  v_branch uuid;
  v_token  text;
begin
  select branch_id into v_branch from public.tables where id = p_table_id;
  if v_branch is null then
    raise exception 'table_not_found' using errcode = 'P0001';
  end if;
  if not private.staff_has_capability(v_branch, 'branch.settings') then
    raise exception 'not_permitted' using errcode = 'P0001';
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '');
  update public.tables set qr_code_token = v_token where id = p_table_id;
  return v_token;
end;
$function$;

revoke execute on function public.rotate_table_qr_token(uuid) from public, anon;
grant  execute on function public.rotate_table_qr_token(uuid) to authenticated;

-- POLICIES -------------------------------------------------------------------
-- tables_public_qr let ANY unauthenticated caller list every table of every branch over
-- /rest/v1/tables -- numbers, zones, capacities and, once this migration fills them, the
-- tokens themselves. A diner needs exactly one row, the one they scanned, and the
-- resolver above hands it to them. Nothing in the apps ever used the policy.
--
-- Writes move from "any active staff member of the branch" to branch.settings, matching
-- every other setup surface since 20260827210000_scope_sensitive_reads_by_capability.
-- Reads stay open to branch staff: the kitchen board embeds tables(table_number,
-- display_name) on its orders query and must keep working for the kitchen role.
drop policy if exists tables_public_qr on public.tables;
drop policy if exists tables_staff on public.tables;

drop policy if exists tables_staff_read on public.tables;
create policy tables_staff_read on public.tables
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));

drop policy if exists tables_staff_insert on public.tables;
create policy tables_staff_insert on public.tables
  for insert to authenticated
  with check (private.staff_has_capability(branch_id, 'branch.settings'));

drop policy if exists tables_staff_update on public.tables;
create policy tables_staff_update on public.tables
  for update to authenticated
  using (private.staff_has_capability(branch_id, 'branch.settings'))
  with check (private.staff_has_capability(branch_id, 'branch.settings'));

drop policy if exists tables_staff_delete on public.tables;
create policy tables_staff_delete on public.tables
  for delete to authenticated
  using (private.staff_has_capability(branch_id, 'branch.settings'));
