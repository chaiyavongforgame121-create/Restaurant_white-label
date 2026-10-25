-- A storefront keeps answering at its old address after a rename (owner requests 3 and 4,
-- 2026-10-26; the investigation is the "appname-url" section of the 2026-10-26 map).
--
-- Every printed QR code, every link in an order text or email, every installed iPhone app (iOS
-- keeps the start URL it was installed with, forever) and every Stripe return carries
-- /r/<restaurant-slug>/<branch-slug>. Renaming either slug used to break all of them. The one
-- rename so far (2026-10-24, the showcase store Coastal Grill became Demo-FavorNoms) was patched
-- with a map hard-coded in apps/web/src/lib/tenant.ts that answered with a 200 and a meta refresh
-- and dropped the query string, so a table code's ?t= and a Stripe return's ?payment_intent=…
-- were lost on the way. This replaces the map with data, and the web middleware now sends a real
-- 308 that keeps the query string.
--
-- 1. public.storefront_path_aliases: one row per address a storefront gave up, pointing at an ID,
--    never at a slug, so renaming twice never builds a chain to follow.
--      - A restaurant rename: (restaurant_slug, null, restaurant_id, null) — every branch of that
--        restaurant under the old restaurant slug.
--      - A branch rename (or a branch moved to another restaurant): (the restaurant's slug at the
--        time, branch_slug, the restaurant it was in, branch_id). Looked up by restaurant_id, so it
--        still works after the restaurant is renamed too.
--    Rows never expire: printed codes and iPhone home-screen apps do not change. One row per old
--    address; when an address is given up again by someone else, the row moves to them. Deleting
--    a restaurant or branch deletes its rows (nothing to send anyone to). RLS on, no policy, no
--    grant: only the trigger below writes it and only resolve_storefront_path reads it.
--    Seeded with coastal-grill -> the Demo-FavorNoms restaurant (33333333-…).
--
-- 2. private.record_storefront_path_alias(), AFTER UPDATE OF slug on restaurants and AFTER UPDATE
--    OF slug, restaurant_id on branches: writes the old pair whenever it actually changes,
--    whoever changes it (the owner, the platform, a hand-written statement). The existing guards
--    still decide who may change a slug; this only remembers the old one.
--
-- 3. public.resolve_storefront_path(p_first, p_second) -> (status, restaurant_slug, branch_slug),
--    SECURITY DEFINER, STABLE, executable by anon (the Edge middleware and the storefront call it
--    with the publishable key):
--      - 'live'     the pair is a storefront today, spelled exactly so;
--      - 'redirect' it is an old address (or the same one in other letter case), and the two slugs
--                   are where that storefront lives now;
--      - 'none'     nothing answers to it, or the branch it names is switched off.
--    A LIVE SLUG ALWAYS WINS over an alias: an old restaurant slug is consulted only when no
--    restaurant has it today, an old branch slug only when no branch of that restaurant has it
--    (switched off or not — a closed branch still owns its address, and its printed codes must
--    not start opening another branch's menu).
--
-- Not here, on purpose: refusing a new slug that is still an alias of a different live branch of
-- the same restaurant. Nothing in the product renames a slug today (only the owner, through the
-- API or SQL); add it with the rename RPC if the App name ever drives the URL.
--
-- Rolled-back checks: supabase/tests/storefront_path_aliases.sql.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. public.storefront_path_aliases
-- ---------------------------------------------------------------------------------------------

create table if not exists public.storefront_path_aliases (
  id              bigint generated always as identity primary key,
  restaurant_slug text not null,
  -- null: the whole restaurant answered to restaurant_slug.
  branch_slug     text,
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  branch_id       uuid references public.branches(id) on delete cascade,
  created_at      timestamptz not null default now(),
  constraint storefront_path_aliases_branch_pair check ((branch_slug is null) = (branch_id is null))
);

comment on table public.storefront_path_aliases is
  'Storefront addresses given up by a rename, each pointing at the restaurant (branch_slug null) or branch that used it. Written by private.record_storefront_path_alias(), read by public.resolve_storefront_path(); a live slug always wins over a row here.';

-- One row per old address. A restaurant alias is platform-wide (restaurant slugs are); a branch
-- alias is per restaurant (branch slugs are), keyed by the restaurant's id so a later restaurant
-- rename does not orphan it.
create unique index if not exists storefront_path_aliases_restaurant_uidx
  on public.storefront_path_aliases (restaurant_slug) where branch_slug is null;
create unique index if not exists storefront_path_aliases_branch_uidx
  on public.storefront_path_aliases (restaurant_id, branch_slug) where branch_slug is not null;
-- The foreign keys' cascades.
create index if not exists storefront_path_aliases_restaurant_id_idx
  on public.storefront_path_aliases (restaurant_id);
create index if not exists storefront_path_aliases_branch_id_idx
  on public.storefront_path_aliases (branch_id) where branch_id is not null;

alter table public.storefront_path_aliases enable row level security;
-- No policy, and the API roles' default table grants taken back: nobody reads or writes this
-- through the API. The trigger and the RPC below run as its owner.
revoke all on table public.storefront_path_aliases from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. The rename trigger
-- ---------------------------------------------------------------------------------------------

create or replace function private.record_storefront_path_alias()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_table_name = 'restaurants' then
    insert into public.storefront_path_aliases (restaurant_slug, branch_slug, restaurant_id, branch_id)
    values (old.slug, null, old.id, null)
    on conflict (restaurant_slug) where branch_slug is null
    do update set restaurant_id = excluded.restaurant_id, created_at = now();
  else
    -- The restaurant the branch was in, under the slug it has now (informational: the lookup
    -- goes by restaurant_id).
    insert into public.storefront_path_aliases (restaurant_slug, branch_slug, restaurant_id, branch_id)
    select r.slug, old.slug, old.restaurant_id, old.id
      from public.restaurants r
     where r.id = old.restaurant_id
    on conflict (restaurant_id, branch_slug) where branch_slug is not null
    do update set branch_id = excluded.branch_id, restaurant_slug = excluded.restaurant_slug, created_at = now();
  end if;
  return null;
end;
$function$;

revoke execute on function private.record_storefront_path_alias() from public, anon, authenticated;

drop trigger if exists trg_storefront_path_alias on public.restaurants;
create trigger trg_storefront_path_alias
  after update of slug on public.restaurants
  for each row
  when (old.slug is distinct from new.slug)
  execute function private.record_storefront_path_alias();

-- restaurant_id too: a branch moved to another restaurant changes its address exactly as a
-- rename does.
drop trigger if exists trg_storefront_path_alias on public.branches;
create trigger trg_storefront_path_alias
  after update of slug, restaurant_id on public.branches
  for each row
  when (old.slug is distinct from new.slug or old.restaurant_id is distinct from new.restaurant_id)
  execute function private.record_storefront_path_alias();

-- ---------------------------------------------------------------------------------------------
-- 3. public.resolve_storefront_path
-- ---------------------------------------------------------------------------------------------

create or replace function public.resolve_storefront_path(p_first text, p_second text)
returns table (status text, restaurant_slug text, branch_slug text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
#variable_conflict use_column
declare
  -- Slugs are lower case (restaurants_slug_check, branches' check); an address typed or printed
  -- in other letter case is the same storefront and is sent to the spelling it really has.
  v_first  text := lower(btrim(coalesce(p_first, '')));
  v_second text := lower(btrim(coalesce(p_second, '')));
  v_restaurant_id   uuid;
  v_moved           boolean := false;
  v_restaurant_slug text;
  v_branch_slug     text;
  v_branch_active   boolean;
begin
  if v_first = '' or v_second = '' then
    return query select 'none'::text, null::text, null::text;
    return;
  end if;

  -- 1. The restaurant: the one with this slug today; only when none has it, the one that gave it
  --    up last.
  select r.id into v_restaurant_id
    from public.restaurants r
   where r.slug = v_first;
  if not found then
    select a.restaurant_id into v_restaurant_id
      from public.storefront_path_aliases a
     where a.restaurant_slug = v_first
       and a.branch_slug is null;
    if not found then
      return query select 'none'::text, null::text, null::text;
      return;
    end if;
    v_moved := true;
  end if;

  -- 2. The branch, inside that restaurant: the one with this slug today, switched on or not;
  --    only when none has it, the one that gave it up last, wherever that branch is now.
  select r.slug, b.slug, b.is_active into v_restaurant_slug, v_branch_slug, v_branch_active
    from public.branches b
    join public.restaurants r on r.id = b.restaurant_id
   where b.restaurant_id = v_restaurant_id
     and b.slug = v_second;
  if not found then
    select r.slug, b.slug, b.is_active into v_restaurant_slug, v_branch_slug, v_branch_active
      from public.storefront_path_aliases a
      join public.branches b on b.id = a.branch_id
      join public.restaurants r on r.id = b.restaurant_id
     where a.restaurant_id = v_restaurant_id
       and a.branch_slug = v_second;
    if not found then
      return query select 'none'::text, null::text, null::text;
      return;
    end if;
    v_moved := true;
  end if;

  -- 3. A switched-off branch is no storefront (the storefront's read asks for is_active), and
  --    sending its old address somewhere else would be wrong too.
  if not v_branch_active then
    return query select 'none'::text, null::text, null::text;
    return;
  end if;

  return query
  select case when not v_moved and v_restaurant_slug = p_first and v_branch_slug = p_second
              then 'live' else 'redirect' end,
         v_restaurant_slug,
         v_branch_slug;
end;
$function$;

comment on function public.resolve_storefront_path(text, text) is
  'Where /r/<p_first>/<p_second> lives now: live (a storefront today, spelled so), redirect (an old address or other letter case; the current slugs), none. A live slug always wins over an alias. Anon-executable: the web middleware 308s on it.';

revoke all on function public.resolve_storefront_path(text, text) from public;
grant execute on function public.resolve_storefront_path(text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. The one rename that happened before this table: coastal-grill (2026-10-24). Only where that
--    restaurant exists (a local stack built from the migrations may not have the showcase store).
-- ---------------------------------------------------------------------------------------------

insert into public.storefront_path_aliases (restaurant_slug, branch_slug, restaurant_id, branch_id)
select 'coastal-grill', null, r.id, null
  from public.restaurants r
 where r.id = '33333333-3333-3333-3333-333333333333'
on conflict (restaurant_slug) where branch_slug is null do nothing;

commit;
