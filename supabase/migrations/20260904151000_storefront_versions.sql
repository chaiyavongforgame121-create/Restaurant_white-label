-- Storefront change counter — one row per branch, bumped whenever anything the customer
-- storefront renders changes.
--
-- Why: the storefront caches restaurant/branch/brand data across requests
-- (apps/web/src/lib/tenant.ts, unstable_cache) and an INSTALLED customer PWA keeps a rendered
-- menu open on a phone for hours. Neither had any signal that the shop had changed something.
-- A merchant who replaced their logo stared at the old one for up to 30 seconds and re-uploaded
-- it, twice; a diner whose app had been in the background since lunch was still being shown
-- lunch's prices, lunch's sold-out flags and lunch's "Currently closed" banner at dinner. The
-- admin app is a separate deployment and cannot call revalidateTag() inside the web app, so
-- there was no invalidation at all — only a TTL nobody could see.
--
-- This table is the missing signal, and it travels the one channel both apps already share:
-- the database. The web app keys its tenant cache on the version (a bump is a cache MISS, so
-- the next request re-reads), and an open storefront subscribes to the row over realtime (a
-- bump is a router.refresh()). It works for every write path — admin UI, kitchen 86, CSV
-- import, a cron job, a hand-written SQL statement — because it is a trigger, not a callback
-- somebody has to remember to add.
--
-- Anon-readable on purpose: it carries no data, only a counter, and the storefront it describes
-- is public. Nothing but the security-definer trigger below may write it.

create table if not exists public.storefront_versions (
  branch_id  uuid primary key references public.branches(id) on delete cascade,
  version    bigint not null default 1,
  updated_at timestamptz not null default now()
);

comment on table public.storefront_versions is
  'Per-branch change counter. Bumped by private.bump_storefront_version() on menu, brand, branch and hours changes; the storefront keys its caches on it and refreshes already-open apps from it.';

alter table public.storefront_versions enable row level security;

drop policy if exists storefront_versions_public_read on public.storefront_versions;
create policy storefront_versions_public_read on public.storefront_versions
  for select to anon, authenticated
  using (true);
-- No insert/update/delete policies at all: only the security definer trigger writes here.

-- Realtime UPDATE events need a row that already exists, so every current branch gets one.
insert into public.storefront_versions (branch_id)
select id from public.branches
on conflict (branch_id) do nothing;

create or replace function private.bump_storefront_version()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  r record;
  v_branch_ids uuid[];
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;

  if tg_table_name = 'branches' then
    v_branch_ids := array[r.id];
  elsif tg_table_name = 'restaurants' then
    select array_agg(id) into v_branch_ids from public.branches where restaurant_id = r.id;
  elsif tg_table_name = 'brands' then
    -- A brand is restaurant-scoped; every branch of that restaurant may render from it.
    select array_agg(id) into v_branch_ids from public.branches where restaurant_id = r.restaurant_id;
  elsif tg_table_name = 'combo_items' then
    -- The only storefront table with no branch_id of its own.
    select array_agg(c.branch_id) into v_branch_ids from public.combo_sets c where c.id = r.combo_id;
  else
    -- menu_items, menu_categories, happy_hours, branch_hours, branch_delivery_hours,
    -- branch_closures, combo_sets: all carry branch_id.
    v_branch_ids := array[r.branch_id];
  end if;

  insert into public.storefront_versions (branch_id, version, updated_at)
  select b, 1, now()
    from unnest(coalesce(v_branch_ids, '{}'::uuid[])) as b
   where b is not null
  on conflict (branch_id) do update
    set version = public.storefront_versions.version + 1,
        updated_at = now();

  return null;
end;
$$;

revoke execute on function private.bump_storefront_version() from public, anon, authenticated;

-- Tables whose every change is storefront-visible.
do $$
declare t text;
begin
  foreach t in array array['menu_categories','happy_hours','branch_hours',
                           'branch_delivery_hours','branch_closures','combo_sets',
                           'combo_items','brands']
  loop
    execute format('drop trigger if exists trg_bump_storefront_version on public.%I', t);
    execute format(
      'create trigger trg_bump_storefront_version after insert or update or delete on public.%I
         for each row execute function private.bump_storefront_version()', t);
  end loop;
end $$;

-- menu_items is column-scoped: `rating` and `review_count` are recomputed every time a diner
-- rates an order, and `updated_at`/`cost` are merchant bookkeeping. Bumping on those would
-- refresh every open phone for a change nobody can see on the card. `stock_quantity` and
-- `sold_out_until` ARE in the list on purpose — sold-out has to propagate mid-service, which
-- is the single most expensive thing to get wrong.
drop trigger if exists trg_bump_storefront_version on public.menu_items;
create trigger trg_bump_storefront_version
  after insert or delete
     or update of name, name_translations, description, description_translations, price,
                  image_url, image_urls, is_active, is_new, is_recommended, category_id,
                  display_order, dietary_tags, allergens, calories, prep_time_minutes,
                  track_stock, stock_quantity, sold_out_until, available_channels,
                  availability_schedule, station, requires_age_verification, slug
  on public.menu_items
  for each row execute function private.bump_storefront_version();

-- branches/restaurants are column-scoped too, so a cron mirror of entitled_through or a bare
-- updated_at touch does not wake every installed app.
drop trigger if exists trg_bump_storefront_version on public.branches;
create trigger trg_bump_storefront_version
  after insert or delete
     or update of name, slug, address, timezone, theme_override, settings, is_active,
                  custom_domain, brand_id, sales_tax_rate, geo_lat, geo_lng, open_hours
  on public.branches
  for each row execute function private.bump_storefront_version();

drop trigger if exists trg_bump_storefront_version on public.restaurants;
create trigger trg_bump_storefront_version
  after update of name, slug, brand_settings, storefront
  on public.restaurants
  for each row execute function private.bump_storefront_version();

-- Slug-keyed read for the storefront's server render: it has slugs, not ids, before the tenant
-- has been resolved — and resolving the tenant is exactly what this value decides whether to
-- do. Anon-executable on purpose, like public.is_delivery_available: the storefront renders for
-- anonymous diners.
create or replace function public.storefront_version(p_restaurant_slug text, p_branch_slug text)
returns bigint
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(v.version, 0)
    from public.restaurants r
    join public.branches b on b.restaurant_id = r.id and b.slug = p_branch_slug
    left join public.storefront_versions v on v.branch_id = b.id
   where r.slug = p_restaurant_slug
   limit 1
$$;

revoke execute on function public.storefront_version(text, text) from public;
grant  execute on function public.storefront_version(text, text) to anon, authenticated;

comment on function public.storefront_version(text, text) is
  'Storefront change counter by slugs; null for an unknown branch. Anon-callable: the storefront renders for anonymous diners.';

-- Realtime: an open storefront subscribes to UPDATEs on this row. Filtered postgres_changes
-- DELETEs carry only the primary key, which is why a trigger-bumped row (always an UPDATE
-- after the backfill) is the signal rather than watching every source table.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'storefront_versions'
  ) then
    alter publication supabase_realtime add table public.storefront_versions;
  end if;
end $$;
