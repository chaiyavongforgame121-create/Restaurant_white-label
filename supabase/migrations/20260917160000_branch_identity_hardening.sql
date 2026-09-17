-- Hardening around per-branch identity (20260917150000), from review.
--
-- 1. Existing branding files can no longer be replaced or deleted by a manager.
--    A branch's logo and icon URLs point at public objects in branding/<restaurant_id>/. The guard
--    on branches only lets the owner or brand.edit (owner, admin) change those columns, but the
--    storage policies let any owner, admin OR MANAGER update or delete any object in the folder, so
--    a manager could overwrite the file another branch's icon points at, or delete it, without
--    touching a branches row. Uploading stays open to managers (payment QR, storefront image): every
--    upload gets a fresh random name, so a new object can never replace another. Replacing or
--    deleting an existing object now needs the owner, a platform admin, or brand.edit at a branch of
--    that restaurant. The back office uploads without upsert from this change on.
--
-- 2. A branch can only link a brand of its own restaurant.
--    branches.brand_id was a plain FK to brands(id). A manager could link another restaurant's brand
--    (brand ids are publicly readable) and the storefront would then carry that restaurant's name,
--    theme and fallback icons. Enforced by a trigger; the storefront and notify-worker also filter
--    the brand lookup by restaurant.

drop policy if exists branding_owner_update on storage.objects;
create policy branding_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'branding'
    and (
      private.user_is_platform_admin()
      or exists (
        select 1 from public.restaurants r
         where r.id::text = (storage.foldername(objects.name))[1]
           and r.owner_user_id = auth.uid()
      )
      or exists (
        select 1 from public.branches b
         where b.restaurant_id::text = (storage.foldername(objects.name))[1]
           and private.staff_has_capability(b.id, 'brand.edit')
      )
    )
  );

drop policy if exists branding_owner_delete on storage.objects;
create policy branding_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'branding'
    and (
      private.user_is_platform_admin()
      or exists (
        select 1 from public.restaurants r
         where r.id::text = (storage.foldername(objects.name))[1]
           and r.owner_user_id = auth.uid()
      )
      or exists (
        select 1 from public.branches b
         where b.restaurant_id::text = (storage.foldername(objects.name))[1]
           and private.staff_has_capability(b.id, 'brand.edit')
      )
    )
  );

create or replace function private.guard_branch_brand_same_restaurant()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.brand_id is not null
     and (tg_op = 'INSERT' or new.brand_id is distinct from old.brand_id or new.restaurant_id is distinct from old.restaurant_id)
     and not exists (
       select 1 from public.brands x
        where x.id = new.brand_id and x.restaurant_id = new.restaurant_id
     ) then
    raise exception 'branch_brand_other_restaurant'
      using errcode = '23514',
            hint = 'A branch can only use a brand of its own restaurant.';
  end if;
  return new;
end;
$$;

drop trigger if exists branches_guard_brand_same_restaurant on public.branches;
create trigger branches_guard_brand_same_restaurant
  before insert or update of brand_id, restaurant_id on public.branches
  for each row execute function private.guard_branch_brand_same_restaurant();
