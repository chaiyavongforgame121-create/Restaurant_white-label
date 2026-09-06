-- "New brand" is gone from the admin UI (owner request, 2026-09-04): a tenant has one
-- brand -- its own -- and the multi-concept story it advertised was never something we
-- sold. Removing the button alone changes nothing at the API: `authenticated` holds
-- table-level INSERT on public.brands, and brands_brand_edit_insert let any owner or
-- admin create unlimited rows straight through PostgREST.
--
-- INSERT cannot simply be denied. The Branding card on Branch settings
-- (apps/admin/src/app/b/[branchId]/branch/_components/branding-card.tsx) mints the
-- restaurant's default brand on first save, and it is the only way a restaurant that has
-- never had one gets a logo at all: create_restaurant_with_branch writes
-- restaurants.brand_settings and branches.theme_override and has never inserted a brands
-- row, so every fresh tenant starts at zero. So the FIRST brand may still be created; a
-- second may not.
--
-- The "already has one" test goes through a security definer helper rather than an inline
-- `not exists (select 1 from public.brands ...)`, because a subquery on the same table
-- inside a policy is still filtered by that table's SELECT policies -- a caller who could
-- not see the existing row would read "no brands" and be waved through.
--
-- UPDATE is untouched: editing the logo, icons and colours is exactly what stays.
-- DELETE stays owner-only, as set in 20260830185256.

create or replace function private.restaurant_has_brand(p_restaurant_id uuid)
returns boolean language sql stable security definer set search_path to 'public','pg_temp' as $$
  select exists (select 1 from public.brands b where b.restaurant_id = p_restaurant_id);
$$;

revoke execute on function private.restaurant_has_brand(uuid) from public, anon;
grant execute on function private.restaurant_has_brand(uuid) to authenticated;

drop policy if exists brands_brand_edit_insert on public.brands;
drop policy if exists brands_default_brand_insert on public.brands;

create policy brands_default_brand_insert on public.brands
  for insert to authenticated
  with check (
    not private.restaurant_has_brand(restaurant_id)
    and (
      private.user_owns_restaurant(restaurant_id)
      or exists (
        select 1 from public.branches b
         where b.restaurant_id = brands.restaurant_id
           and private.staff_has_capability(b.id, 'brand.edit')
      )
    )
  );
