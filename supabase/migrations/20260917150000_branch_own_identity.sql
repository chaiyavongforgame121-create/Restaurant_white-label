-- Each branch owns its storefront identity: logo, favicon and installed-app icons.
--
-- Until now every one of those lived on the restaurant's single `brands` row (a restaurant may hold
-- one brand, 20260904132000). The Branding card sits on each branch's settings page but updated
-- that shared row, so two branches that uploaded different icons overwrote each other, and both
-- storefronts (and both installed apps) showed whichever was saved last. The owner of a
-- two-branch restaurant reported exactly that: same icon, same name, for both branches.
--
-- Now:
--   * branches carry their own logo_url, favicon_url, icon_192_url, icon_512_url,
--     icon_maskable_512_url and app_icon (the icon style: source, fit, background, appleUrl).
--   * Every existing branch is backfilled from the brand it renders from today (its brand_id row,
--     else the restaurant's default brand), so nothing changes on screen when this ships; from the
--     next save on, a branch's upload touches only that branch.
--   * The storefront reads the branch's own set first and falls back to the brand only for a
--     branch that has none (a branch created later), see packages/database/src/queries/tenant.ts.
--   * Editing them needs the same permission as editing a brand: the restaurant owner or
--     brand.edit (owner, admin). The branches UPDATE policy alone would let any staff member change
--     the app icon. Every URL must be a file in this restaurant's folder of the `branding` bucket,
--     the only place the back office uploads to.
--   * The storefront version trigger watches the new columns, so a save refreshes that branch's
--     storefront, manifest and installed app, and only that branch's.

alter table public.branches
  add column if not exists logo_url text,
  add column if not exists favicon_url text,
  add column if not exists icon_192_url text,
  add column if not exists icon_512_url text,
  add column if not exists icon_maskable_512_url text,
  add column if not exists app_icon jsonb;

comment on column public.branches.logo_url is 'This branch''s storefront logo. Null: the brand''s logo.';
comment on column public.branches.favicon_url is 'This branch''s browser-tab icon.';
comment on column public.branches.icon_192_url is 'This branch''s installed-app icon, 192 px. With icon_512_url, decides whether the branch uses its own icon set.';
comment on column public.branches.icon_512_url is 'This branch''s installed-app icon, 512 px.';
comment on column public.branches.icon_maskable_512_url is 'This branch''s Android maskable icon, 512 px.';
comment on column public.branches.app_icon is 'This branch''s icon style as saved by the back office (sourceUrl, fit, background, zoom, removeBackground, appleUrl).';

with src as (
  select b.id as branch_id,
         br.logo_url, br.favicon_url, br.icon_192_url, br.icon_512_url, br.icon_maskable_512_url,
         br.theme -> 'appIcon' as app_icon
    from public.branches b
    join lateral (
      select x.logo_url, x.favicon_url, x.icon_192_url, x.icon_512_url, x.icon_maskable_512_url, x.theme
        from public.brands x
       where x.restaurant_id = b.restaurant_id
         and (b.brand_id is null or x.id = b.brand_id)
       order by x.is_default desc, x.created_at asc
       limit 1
    ) br on true
)
update public.branches b
   set logo_url = coalesce(b.logo_url, s.logo_url),
       favicon_url = coalesce(b.favicon_url, s.favicon_url),
       icon_192_url = coalesce(b.icon_192_url, s.icon_192_url),
       icon_512_url = coalesce(b.icon_512_url, s.icon_512_url),
       icon_maskable_512_url = coalesce(b.icon_maskable_512_url, s.icon_maskable_512_url),
       app_icon = coalesce(b.app_icon, s.app_icon)
  from src s
 where b.id = s.branch_id
   and (s.logo_url is not null or s.favicon_url is not null or s.icon_192_url is not null
        or s.icon_512_url is not null or s.icon_maskable_512_url is not null or s.app_icon is not null);

create or replace function private.guard_branch_identity_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_prefix text := '/storage/v1/object/public/branding/' || old.restaurant_id::text || '/';
  v_url text;
begin
  if new.logo_url is not distinct from old.logo_url
     and new.favicon_url is not distinct from old.favicon_url
     and new.icon_192_url is not distinct from old.icon_192_url
     and new.icon_512_url is not distinct from old.icon_512_url
     and new.icon_maskable_512_url is not distinct from old.icon_maskable_512_url
     and new.app_icon is not distinct from old.app_icon then
    return new;
  end if;

  if auth.uid() is not null
     and not private.user_is_platform_admin()
     and not private.user_owns_restaurant(old.restaurant_id)
     and not private.staff_has_capability(old.id, 'brand.edit') then
    raise exception 'branch_brand_edit_required'
      using errcode = '42501',
            hint = 'Only the restaurant owner or an admin can change a branch''s logo or app icon.';
  end if;

  foreach v_url in array array[
    new.logo_url, new.favicon_url, new.icon_192_url, new.icon_512_url, new.icon_maskable_512_url,
    new.app_icon ->> 'appleUrl', new.app_icon ->> 'sourceUrl'
  ] loop
    if v_url is not null and v_url <> '' and position(v_prefix in v_url) = 0 then
      raise exception 'branch_icon_source_forbidden'
        using errcode = '42501',
              hint = 'Branch logos and icons must be files uploaded to this restaurant''s branding folder.';
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists branches_guard_identity_columns on public.branches;
create trigger branches_guard_identity_columns
  before update on public.branches
  for each row execute function private.guard_branch_identity_columns();

drop trigger if exists trg_bump_storefront_version on public.branches;
create trigger trg_bump_storefront_version
  after insert or delete or update of
    name, slug, address, timezone, theme_override, settings, is_active, custom_domain, brand_id,
    sales_tax_rate, geo_lat, geo_lng, open_hours,
    logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url, app_icon
  on public.branches
  for each row execute function private.bump_storefront_version();
