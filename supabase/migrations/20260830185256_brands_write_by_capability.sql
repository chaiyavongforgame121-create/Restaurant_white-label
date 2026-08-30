-- role_capabilities grants 'brand.edit' to admin AND owner, and the admin UI gates the
-- branding screens on it — but the brands table itself required private.user_owns_restaurant,
-- which is owner-only. So an admin could open the Brands editor, fill it in, press save, and
-- be refused by RLS with no row written. Same divergence between the capability table and a
-- hardcoded role check that 20260830085951 fixed elsewhere; this is the table it missed.
--
-- Reported as "the restaurant logo and favicon have disappeared" — they had not, but the one
-- role the owner had switched themselves to could not write them.
--
-- DELETE stays owner-only on purpose: dropping a brand orphans every branch pointing at it,
-- which is a different kind of decision from editing a logo.
drop policy if exists brands_owner_insert on public.brands;
drop policy if exists brands_owner_update on public.brands;

create policy brands_brand_edit_insert on public.brands
  for insert to authenticated
  with check (
    private.user_owns_restaurant(restaurant_id)
    or exists (
      select 1 from public.branches b
       where b.restaurant_id = brands.restaurant_id
         and private.staff_has_capability(b.id, 'brand.edit')
    )
  );

create policy brands_brand_edit_update on public.brands
  for update to authenticated
  using (
    private.user_owns_restaurant(restaurant_id)
    or exists (
      select 1 from public.branches b
       where b.restaurant_id = brands.restaurant_id
         and private.staff_has_capability(b.id, 'brand.edit')
    )
  )
  with check (
    private.user_owns_restaurant(restaurant_id)
    or exists (
      select 1 from public.branches b
       where b.restaurant_id = brands.restaurant_id
         and private.staff_has_capability(b.id, 'brand.edit')
    )
  );
