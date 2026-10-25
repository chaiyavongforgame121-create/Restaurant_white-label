-- Short storefront addresses: a branch's web address (docs/SHORT-STOREFRONT-URLS-2026-10-26.md
-- §1–§3, the owner's decision of 2026-10-26; "Design B" of the appname-url map). The customer URL
-- follows the App name: app.favornoms.com/r/hamburger instead of /r/demo-favornoms/brooklyn.
--
-- 1. branches.public_slug, the branch's WEB ADDRESS (null = none). With one, the storefront lives
--    at /r/<public_slug>/… (the short form); without one it stays at /r/<restaurant>/<branch>/…
--    (the long form). The slug rule (2–64 lower-case letters, digits, single hyphens), unique
--    across the platform case-insensitively (branches_public_slug_uidx on lower()).
--
-- 2. ONE NAMESPACE for the first segment after /r/: it names a restaurant (long form) or a web
--    address (short form), never both, so /r/hamburger/cart can only mean one thing.
--      - A web address may not be any restaurants.slug, any restaurant-level alias (a slug a
--        restaurant gave up) or a reserved word (r, api, auth, admin, app, www, help, privacy,
--        terms, ccpa): branches_public_slug_rules, BEFORE INSERT OR UPDATE OF public_slug.
--      - A restaurant slug may not be any web address or web-address alias:
--        restaurants_slug_namespace, BEFORE INSERT OR UPDATE OF slug, which covers
--        create_restaurant_with_branch (onboarding) and a rename alike. It answers 23505
--        'slug_taken' with no "branch" in the message or detail, so the onboarding wizard (which
--        reads /branch/ there) names the restaurant field.
--      - A web address another branch gave up (a web-address alias, 4 below) is refused for every
--        other branch, switched on or off: that branch's printed codes, installed apps and sent
--        links keep pointing at it, and a live address would win over the alias. Only the branch
--        it points at may take it back. Releasing one would be an explicit platform action, not
--        something any branch can do. This closes, for web addresses, the check 20261026110000
--        put off "if the App name ever drives the URL".
--    Both sides take one advisory lock per first segment, so two transactions claiming the same
--    word from either side are serialised and the second sees the first.
--    Precise errors: 'slug_invalid' (22023), 'slug_reserved' (22023), 'slug_taken' (23505).
--
-- 3. Only public.set_branch_public_slug(p_branch_id, p_slug) writes it from the API.
--    branch.settings at that branch (the owner, an admin there or everywhere, platform admins:
--    private.staff_has_capability); lower-cases and trims; null or blank clears it; returns
--    {public_slug, path}. The branch guard (guard_branch_privileged_columns, re-created from its
--    live body with one block added above everything else) refuses any other API write to the
--    column, platform admins included, unless favornoms.public_slug_write is 'on' — raised with
--    set_config() inside the RPC and lowered right after its UPDATE (a custom setting in a
--    function's SET clause is refused on this project). An API INSERT carrying one is refused the
--    same way. Writes with no JWT role (migrations, the SQL editor, the service role) pass the
--    guard but still meet the rules above and the alias below.
--    public.check_public_slug(p_branch_id, p_slug) answers availability for the Branding card's
--    field: {slug, available, error, current}. Both: authenticated only.
--
-- 4. Old addresses keep working. A web address changed or cleared becomes a first-segment alias
--    row in storefront_path_aliases, pointing at the branch: (restaurant_slug = the old web
--    address, branch_slug null, the branch's restaurant, branch_id). The table already keeps one
--    row per first segment (storefront_path_aliases_restaurant_uidx, unique on restaurant_slug
--    where branch_slug is null), now shared by both first-segment kinds: an old restaurant slug
--    (branch_id null) and an old web address (branch_id set). Only the check that tied branch_id
--    to branch_slug changes: a branch_slug still needs a branch_id; a branch_id no longer needs a
--    branch_slug. private.record_storefront_path_alias() gains the web-address case (called with
--    the trigger argument 'public_slug' from its own trigger, trg_storefront_public_slug_alias, so
--    the slug/restaurant_id trigger and its definition are untouched), and its restaurant case now
--    clears branch_id when it takes a first segment over. No other branch may take an old web
--    address (2 above), so its row keeps pointing at the branch that gave it up.
--
-- 5. public.resolve_storefront_path(p_first, p_second default null), dropped and re-created
--    (its result columns grow) -> (status, restaurant_slug, branch_slug, public_slug, public_base,
--    segments). For the first two segments after /r/:
--      - 'live'     a long-form pair of a branch with no web address, spelled exactly so;
--      - 'short'    p_first is a live web address (p_second is the page, whatever it is);
--      - 'redirect' the request belongs at public_base: the long form of a branch that has a web
--                   address, any old address (restaurant, branch or web-address alias), other
--                   letter case. Restaurant and branch aliases land on the short form when the
--                   branch has one;
--      - 'none'     nothing answers, or the branch is switched off.
--    restaurant_slug and branch_slug are always the branch's long form today (the middleware
--    rewrites a short request onto them), public_slug its web address, public_base where its pages
--    live for the browser ('/r/<public_slug>' or '/r/<restaurant>/<branch>'), segments how many
--    path segments after /r/ the answer covers (1: a web address or an old one; 2: a long-form
--    pair or an old one). A live address always wins over an alias. A deployed web app that reads
--    only the first three columns keeps working: a long form it was serving answers 'redirect' to
--    the very pair it asked about, which it ignores; 'short' it does not know and ignores.
--
-- 6. trg_bump_storefront_version on branches also fires on public_slug (the storefront's cached
--    tenant carries it and builds every link from it), re-created with the live column list.
--
-- 7. The two showcase branches with an App name get theirs, only where still free: Hamburger
--    (44444444-…, demo-favornoms/brooklyn) -> 'hamburger', Food Thai Thai (d0b26b93-…,
--    demo-favornoms/food-thai-thai) -> 'food-thai-thai'. Read live 2026-10-26: neither word is a
--    restaurant slug, an alias or a web address.
--
-- Deploy order: this migration first (the web app's tenant read and notify-worker select
-- branches.public_slug); then the web app, which serves the short form; only then notify-worker,
-- the admin QR codes and the platform console, which hand out short links the old web app 404s.
--
-- Rolled-back checks: supabase/tests/branch_public_slugs.sql.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. branches.public_slug
-- ---------------------------------------------------------------------------------------------

alter table public.branches add column if not exists public_slug text;

alter table public.branches drop constraint if exists branches_public_slug_check;
alter table public.branches add constraint branches_public_slug_check check (
  public_slug is null
  or (public_slug ~ '^[a-z0-9](-?[a-z0-9])*$' and length(public_slug) >= 2 and length(public_slug) <= 64)
);

create unique index if not exists branches_public_slug_uidx
  on public.branches (lower(public_slug)) where public_slug is not null;

comment on column public.branches.public_slug is
  'The branch''s web address: its storefront lives at /r/<public_slug>/… (null: at /r/<restaurant>/<branch>/…). One namespace with restaurants.slug and restaurant-level aliases. Written only by public.set_branch_public_slug(); an old value becomes a storefront_path_aliases row.';

-- ---------------------------------------------------------------------------------------------
-- 2. The alias table holds first-segment branch aliases (an old web address)
-- ---------------------------------------------------------------------------------------------

alter table public.storefront_path_aliases drop constraint if exists storefront_path_aliases_branch_pair;
alter table public.storefront_path_aliases drop constraint if exists storefront_path_aliases_branch_slug_needs_branch;
alter table public.storefront_path_aliases add constraint storefront_path_aliases_branch_slug_needs_branch
  check (branch_slug is null or branch_id is not null);

comment on table public.storefront_path_aliases is
  'Storefront addresses given up by a rename. branch_slug null: a first segment after /r/ (restaurant_slug holds it), an old restaurant slug when branch_id is null, an old web address (branches.public_slug) of branch_id otherwise — one row per first segment. branch_slug set: an old branch slug inside restaurant_id. Written by private.record_storefront_path_alias(), read by public.resolve_storefront_path(); a live address always wins over a row here.';

-- ---------------------------------------------------------------------------------------------
-- 3. The rules: format, reserved words, the shared namespace
-- ---------------------------------------------------------------------------------------------

-- Why p_slug may not be p_branch_id's web address, or null when it may. p_slug is taken as given
-- (the callers lower-case and trim what a person typed; a stored value must already be lower
-- case). Keep the reserved words in step with RESERVED_PUBLIC_SLUGS in
-- packages/database/src/storefront-path.ts.
create or replace function private.public_slug_problem(p_slug text, p_branch_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_slug = any (array['r', 'api', 'auth', 'admin', 'app', 'www', 'help', 'privacy', 'terms', 'ccpa']) then
    return 'slug_reserved';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9](-?[a-z0-9])*$' or length(p_slug) < 2 or length(p_slug) > 64 then
    return 'slug_invalid';
  end if;
  -- Restaurant slugs and the slugs restaurants gave up are lower case (restaurants_slug_check).
  -- An old web address of another branch is taken too, whether that branch is switched on or not:
  -- its printed codes still point at it. The branch that gave it up may take it back.
  if exists (select 1 from public.restaurants r where r.slug = p_slug)
     or exists (select 1 from public.storefront_path_aliases a
                 where a.restaurant_slug = p_slug and a.branch_slug is null and a.branch_id is null)
     or exists (select 1 from public.branches b
                 where lower(b.public_slug) = p_slug and b.id is distinct from p_branch_id)
     or exists (select 1 from public.storefront_path_aliases a
                 where a.restaurant_slug = p_slug and a.branch_slug is null
                   and a.branch_id is not null and a.branch_id is distinct from p_branch_id) then
    return 'slug_taken';
  end if;
  return null;
end;
$function$;

comment on function private.public_slug_problem(text, uuid) is
  'Why p_slug cannot be p_branch_id''s web address (slug_reserved, slug_invalid, slug_taken), or null when it can. Shared by the branches trigger and check_public_slug.';

revoke execute on function private.public_slug_problem(text, uuid) from public, anon, authenticated;

-- BEFORE INSERT OR UPDATE OF public_slug on branches.
create or replace function private.tg_branches_public_slug()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_problem text;
begin
  if tg_op = 'UPDATE' and new.public_slug is not distinct from old.public_slug then
    return new;
  end if;

  -- An API insert carrying a web address skips set_branch_public_slug() exactly as an update
  -- would; the branch guard (BEFORE UPDATE only) refuses the update.
  if tg_op = 'INSERT'
     and coalesce(auth.role(), '') in ('anon', 'authenticated')
     and coalesce(current_setting('favornoms.public_slug_write', true), 'off') <> 'on' then
    raise exception 'branch_privileged_column_forbidden'
      using hint = 'A branch''s web address is set through set_branch_public_slug().';
  end if;

  -- The same lock restaurants_slug_namespace takes for this word.
  perform pg_advisory_xact_lock(hashtextextended('favornoms.storefront_first_segment:' || lower(new.public_slug), 0));

  v_problem := private.public_slug_problem(new.public_slug, new.id);
  if v_problem is not null then
    raise exception using
      message = v_problem,
      errcode = case when v_problem = 'slug_taken' then '23505' else '22023' end,
      hint = case v_problem
               when 'slug_reserved' then 'That word is kept for the platform. Pick another web address.'
               when 'slug_invalid' then 'Use 2 to 64 lowercase letters, digits and single hyphens, for example pho-ha-noi.'
               else 'Another storefront already answers to that address. Pick another.'
             end;
  end if;
  return new;
end;
$function$;

revoke execute on function private.tg_branches_public_slug() from public, anon, authenticated;

drop trigger if exists branches_public_slug_rules on public.branches;
create trigger branches_public_slug_rules
  before insert or update of public_slug on public.branches
  for each row
  when (new.public_slug is not null)
  execute function private.tg_branches_public_slug();

-- BEFORE INSERT OR UPDATE OF slug on restaurants: the other side of the namespace.
create or replace function private.tg_restaurants_slug_namespace()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_slug text := lower(new.slug);
begin
  if tg_op = 'UPDATE' and new.slug is not distinct from old.slug then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('favornoms.storefront_first_segment:' || v_slug, 0));

  if exists (select 1 from public.branches b where lower(b.public_slug) = v_slug)
     or exists (select 1 from public.storefront_path_aliases a
                 where a.restaurant_slug = v_slug and a.branch_slug is null and a.branch_id is not null) then
    -- No "branch" in the message or a detail: the onboarding wizard reads /branch/ there to pick
    -- which of its two slug fields to blame.
    raise exception 'slug_taken'
      using errcode = '23505',
            hint = 'That address is a storefront''s web address. Pick another.';
  end if;
  return new;
end;
$function$;

revoke execute on function private.tg_restaurants_slug_namespace() from public, anon, authenticated;

drop trigger if exists restaurants_slug_namespace on public.restaurants;
create trigger restaurants_slug_namespace
  before insert or update of slug on public.restaurants
  for each row
  execute function private.tg_restaurants_slug_namespace();

-- ---------------------------------------------------------------------------------------------
-- 4. The branch guard: re-created from its live body; only the public_slug block is new
-- ---------------------------------------------------------------------------------------------

create or replace function private.guard_branch_privileged_columns()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  -- The only settings keys a caller without branch.settings may touch: the kitchen's pause / busy
  -- controls. Keep in step with v_ops_keys in public.patch_branch_settings().
  v_ops_keys constant text[] := array['orders_paused', 'busy_extra_prep_min'];
  v_settings boolean;
begin
  -- The web address (20261026120000): only set_branch_public_slug() writes it, which checks
  -- branch.settings and raises the flag around its own UPDATE. Above the early return below, so
  -- a platform admin goes through the RPC too. Writes with no JWT role (migrations, the service
  -- role) pass; the namespace trigger and the alias trigger still apply to them.
  if new.public_slug is distinct from old.public_slug
     and coalesce(auth.role(), '') in ('anon', 'authenticated')
     and coalesce(current_setting('favornoms.public_slug_write', true), 'off') <> 'on' then
    raise exception 'branch_privileged_column_forbidden'
      using hint = 'A branch''s web address is changed through set_branch_public_slug().';
  end if;

  if auth.uid() is null or private.user_is_platform_admin() then
    return new;
  end if;

  -- Owner-only. custom_domain is UNIQUE platform-wide, so anyone else could otherwise squat
  -- another tenant's hostname; slug is baked into every printed QR code.
  if (new.custom_domain is distinct from old.custom_domain
      or new.slug is distinct from old.slug
      or new.restaurant_id is distinct from old.restaurant_id)
     and not private.user_owns_restaurant(old.restaurant_id) then
    raise exception 'branch_privileged_column_forbidden'
      using hint = 'Only the restaurant owner can change a branch slug, custom domain, or parent restaurant.';
  end if;

  -- branch.settings at THIS branch: the owner (any branch), an admin of every branch or of this one.
  v_settings := private.staff_has_capability(old.id, 'branch.settings');

  if not v_settings then
    if (new.name is distinct from old.name
        or new.address is distinct from old.address
        or new.geo_location is distinct from old.geo_location
        or new.theme_override is distinct from old.theme_override
        or new.sales_tax_rate is distinct from old.sales_tax_rate
        or new.is_active is distinct from old.is_active
        or new.brand_id is distinct from old.brand_id
        or new.timezone is distinct from old.timezone) then
      raise exception 'branch_settings_required'
        using errcode = '42501',
              hint = 'Only the restaurant owner or an admin can change a branch''s name, address, location, tax rate, theme, time zone, brand or whether it is open.';
    end if;

    -- settings: allow the ops keys, freeze everything else (fees, radius, payment methods).
    if new.settings is distinct from old.settings
       and (new.settings - v_ops_keys) is distinct from (old.settings - v_ops_keys) then
      raise exception 'branch_settings_required'
        using errcode = '42501',
              hint = 'Only the restaurant owner or an admin can change branch settings other than pause/busy mode.';
    end if;

    -- Opening hours are day-to-day work: the owner, an admin or a manager of THIS branch.
    if new.open_hours is distinct from old.open_hours
       and not private.user_manages_branch(old.id) then
      raise exception 'branch_manager_required'
        using hint = 'Only an owner, admin or manager of this branch can change its opening hours.';
    end if;
  end if;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 5. Old web addresses become aliases
-- ---------------------------------------------------------------------------------------------

create or replace function private.record_storefront_path_alias()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_table_name = 'restaurants' then
    -- One row per first segment: an old web address of the same word (which the namespace never
    -- lets coexist with a live restaurant slug) is taken over whole.
    insert into public.storefront_path_aliases (restaurant_slug, branch_slug, restaurant_id, branch_id)
    values (old.slug, null, old.id, null)
    on conflict (restaurant_slug) where branch_slug is null
    do update set restaurant_id = excluded.restaurant_id, branch_id = null, created_at = now();
  elsif tg_nargs > 0 and tg_argv[0] = 'public_slug' then
    -- A web address changed or cleared (trg_storefront_public_slug_alias): /r/<old>/… follows
    -- the branch from now on, wherever it lives. Pointing at the branch id, so changing it twice
    -- builds no chain; one row per first segment. public_slug_problem refuses an old web address
    -- to every other branch, so a word given up again was taken back by this same branch: the
    -- update only refreshes the row.
    if old.public_slug is not null then
      insert into public.storefront_path_aliases (restaurant_slug, branch_slug, restaurant_id, branch_id)
      values (lower(old.public_slug), null, new.restaurant_id, old.id)
      on conflict (restaurant_slug) where branch_slug is null
      do update set restaurant_id = excluded.restaurant_id, branch_id = excluded.branch_id, created_at = now();
    end if;
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

drop trigger if exists trg_storefront_public_slug_alias on public.branches;
create trigger trg_storefront_public_slug_alias
  after update of public_slug on public.branches
  for each row
  when (old.public_slug is distinct from new.public_slug)
  execute function private.record_storefront_path_alias('public_slug');

-- ---------------------------------------------------------------------------------------------
-- 6. The storefront version follows the web address (live column list + public_slug)
-- ---------------------------------------------------------------------------------------------

drop trigger if exists trg_bump_storefront_version on public.branches;
create trigger trg_bump_storefront_version
  after insert or delete or update of name, slug, address, timezone, theme_override, settings, is_active,
    custom_domain, brand_id, sales_tax_rate, geo_lat, geo_lng, open_hours, logo_url, favicon_url, icon_192_url,
    icon_512_url, icon_maskable_512_url, app_icon, public_slug
  on public.branches
  for each row
  execute function private.bump_storefront_version();

-- ---------------------------------------------------------------------------------------------
-- 7. The RPCs
-- ---------------------------------------------------------------------------------------------

create or replace function public.set_branch_public_slug(p_branch_id uuid, p_slug text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  -- What a person typed: "Hamburger " is hamburger. Blank is "no web address".
  v_slug text := nullif(lower(btrim(coalesce(p_slug, ''))), '');
  v_old text;
  v_restaurant_id uuid;
  v_restaurant_slug text;
  v_branch_slug text;
begin
  if v_uid is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;

  -- The owner (any branch), an admin of every branch or of this one, platform admins.
  if not private.staff_has_capability(p_branch_id, 'branch.settings') then
    raise exception 'not_authorized'
      using errcode = '42501',
            hint = 'Changing the web address needs the branch settings permission at this branch.';
  end if;

  select b.public_slug, b.restaurant_id, b.slug, r.slug
    into v_old, v_restaurant_id, v_branch_slug, v_restaurant_slug
    from public.branches b
    join public.restaurants r on r.id = b.restaurant_id
   where b.id = p_branch_id
     for update of b;
  if not found then
    raise exception 'branch_not_found' using errcode = 'P0002';
  end if;

  -- Unchanged: nothing written, so no alias, no version bump, no audit row.
  if v_slug is distinct from v_old then
    -- branches_public_slug_rules answers slug_invalid / slug_reserved / slug_taken; the guard lets
    -- this one UPDATE through. The flag is raised in a block of its own, so an error inside it
    -- takes the flag down with it.
    begin
      perform set_config('favornoms.public_slug_write', 'on', true);
      update public.branches set public_slug = v_slug where id = p_branch_id;
      perform set_config('favornoms.public_slug_write', 'off', true);
    exception when unique_violation then
      -- Only without the rules trigger's lock (a writer that never took it): the same answer.
      raise exception 'slug_taken'
        using errcode = '23505', hint = 'Another storefront already answers to that address. Pick another.';
    end;

    insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
    values (v_restaurant_id, p_branch_id, v_uid,
            case when private.user_is_platform_admin() then 'platform_admin' else 'staff' end,
            'branch_public_slug_changed', 'branch', p_branch_id,
            jsonb_build_object('from', v_old, 'to', v_slug));
  end if;

  return jsonb_build_object(
    'public_slug', v_slug,
    'path', case when v_slug is null then '/r/' || v_restaurant_slug || '/' || v_branch_slug else '/r/' || v_slug end
  );
end;
$function$;

comment on function public.set_branch_public_slug(uuid, text) is
  'Sets (null or blank clears) a branch''s web address: branch.settings at that branch; lower-cased and trimmed; slug_invalid / slug_reserved (22023) or slug_taken (23505) otherwise. The old address becomes an alias. Returns {public_slug, path}.';

revoke all on function public.set_branch_public_slug(uuid, text) from public, anon, service_role;
grant execute on function public.set_branch_public_slug(uuid, text) to authenticated;

create or replace function public.check_public_slug(p_branch_id uuid, p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_slug text := nullif(lower(btrim(coalesce(p_slug, ''))), '');
  v_current text;
  v_problem text;
begin
  if auth.uid() is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;
  if not private.staff_has_capability(p_branch_id, 'branch.settings') then
    raise exception 'not_authorized'
      using errcode = '42501',
            hint = 'Changing the web address needs the branch settings permission at this branch.';
  end if;

  select b.public_slug into v_current from public.branches b where b.id = p_branch_id;
  if not found then
    raise exception 'branch_not_found' using errcode = 'P0002';
  end if;

  -- No web address is always allowed.
  if v_slug is null then
    return jsonb_build_object('slug', null, 'available', true, 'error', null, 'current', v_current is null);
  end if;

  v_problem := private.public_slug_problem(v_slug, p_branch_id);
  return jsonb_build_object(
    'slug', v_slug,
    'available', v_problem is null,
    'error', v_problem,
    'current', v_slug is not distinct from v_current
  );
end;
$function$;

comment on function public.check_public_slug(uuid, text) is
  'Whether p_slug (lower-cased, trimmed) could be p_branch_id''s web address: {slug, available, error: null | slug_invalid | slug_reserved | slug_taken, current}. branch.settings at that branch.';

revoke all on function public.check_public_slug(uuid, text) from public, anon, service_role;
grant execute on function public.check_public_slug(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 8. public.resolve_storefront_path, re-created
-- ---------------------------------------------------------------------------------------------

drop function if exists public.resolve_storefront_path(text, text);

create function public.resolve_storefront_path(p_first text, p_second text default null)
returns table (status text, restaurant_slug text, branch_slug text, public_slug text, public_base text, segments integer)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
#variable_conflict use_column
declare
  -- Slugs and web addresses are lower case (their checks); an address typed or printed in other
  -- letter case is the same storefront and is sent to the spelling it really has.
  v_first  text := lower(btrim(coalesce(p_first, '')));
  v_second text := lower(btrim(coalesce(p_second, '')));
  v_restaurant_id   uuid;
  v_alias_branch_id uuid;
  v_moved           boolean := false;
  v_restaurant_slug text;
  v_branch_slug     text;
  v_public_slug     text;
  v_branch_active   boolean;
begin
  if v_first = '' then
    return query select 'none'::text, null::text, null::text, null::text, null::text, null::integer;
    return;
  end if;

  -- 1. A restaurant today: the long form, /r/<restaurant>/<branch>/…
  select r.id into v_restaurant_id
    from public.restaurants r
   where r.slug = v_first;

  if not found then
    -- 2. A web address today: the short form, /r/<web-address>/…, whatever follows it.
    select r.slug, b.slug, b.public_slug, b.is_active
      into v_restaurant_slug, v_branch_slug, v_public_slug, v_branch_active
      from public.branches b
      join public.restaurants r on r.id = b.restaurant_id
     where lower(b.public_slug) = v_first;
    if found then
      if not v_branch_active then
        return query select 'none'::text, null::text, null::text, null::text, null::text, null::integer;
        return;
      end if;
      return query
      select (case when v_public_slug = p_first then 'short' else 'redirect' end)::text,
             v_restaurant_slug, v_branch_slug, v_public_slug, ('/r/' || v_public_slug)::text, 1;
      return;
    end if;

    -- 3. A first segment given up: an old restaurant slug (branch_id null) or an old web address.
    select a.restaurant_id, a.branch_id into v_restaurant_id, v_alias_branch_id
      from public.storefront_path_aliases a
     where a.restaurant_slug = v_first
       and a.branch_slug is null;
    if not found then
      return query select 'none'::text, null::text, null::text, null::text, null::text, null::integer;
      return;
    end if;

    if v_alias_branch_id is not null then
      -- An old web address: the branch it belonged to, at its address today.
      select r.slug, b.slug, b.public_slug, b.is_active
        into v_restaurant_slug, v_branch_slug, v_public_slug, v_branch_active
        from public.branches b
        join public.restaurants r on r.id = b.restaurant_id
       where b.id = v_alias_branch_id;
      if not found or not v_branch_active then
        return query select 'none'::text, null::text, null::text, null::text, null::text, null::integer;
        return;
      end if;
      return query
      select 'redirect'::text, v_restaurant_slug, v_branch_slug, v_public_slug,
             (case when v_public_slug is not null then '/r/' || v_public_slug
                   else '/r/' || v_restaurant_slug || '/' || v_branch_slug end)::text,
             1;
      return;
    end if;
    v_moved := true;
  end if;

  -- 4. The long form: the branch p_second names inside that restaurant. /r/<restaurant> alone is
  --    no storefront.
  if v_second = '' then
    return query select 'none'::text, null::text, null::text, null::text, null::text, null::integer;
    return;
  end if;

  -- The one with this slug today, switched on or not; only when none has it, the one that gave
  -- it up last, wherever that branch is now.
  select r.slug, b.slug, b.public_slug, b.is_active
    into v_restaurant_slug, v_branch_slug, v_public_slug, v_branch_active
    from public.branches b
    join public.restaurants r on r.id = b.restaurant_id
   where b.restaurant_id = v_restaurant_id
     and b.slug = v_second;
  if not found then
    select r.slug, b.slug, b.public_slug, b.is_active
      into v_restaurant_slug, v_branch_slug, v_public_slug, v_branch_active
      from public.storefront_path_aliases a
      join public.branches b on b.id = a.branch_id
      join public.restaurants r on r.id = b.restaurant_id
     where a.restaurant_id = v_restaurant_id
       and a.branch_slug = v_second;
    if not found then
      return query select 'none'::text, null::text, null::text, null::text, null::text, null::integer;
      return;
    end if;
    v_moved := true;
  end if;

  -- A switched-off branch is no storefront (the storefront's read asks for is_active), and
  -- sending its old address somewhere else would be wrong too.
  if not v_branch_active then
    return query select 'none'::text, null::text, null::text, null::text, null::text, null::integer;
    return;
  end if;

  -- A branch with a web address lives there: its long form and every old address of it go to the
  -- short form.
  if v_public_slug is not null then
    return query
    select 'redirect'::text, v_restaurant_slug, v_branch_slug, v_public_slug, ('/r/' || v_public_slug)::text, 2;
    return;
  end if;

  return query
  select (case when not v_moved and v_restaurant_slug = p_first and v_branch_slug = p_second
               then 'live' else 'redirect' end)::text,
         v_restaurant_slug,
         v_branch_slug,
         null::text,
         ('/r/' || v_restaurant_slug || '/' || v_branch_slug)::text,
         2;
end;
$function$;

comment on function public.resolve_storefront_path(text, text) is
  'Where /r/<p_first>[/<p_second>] lives now: live (a long-form pair, spelled so, of a branch with no web address), short (p_first is a live web address), redirect (to public_base: the long form of a branch with a web address, an old address, other letter case), none. Also the branch''s long-form slugs, its web address and how many segments the answer covers. A live address always wins over an alias. Anon-executable: the web middleware rewrites and 308s on it.';

revoke all on function public.resolve_storefront_path(text, text) from public;
grant execute on function public.resolve_storefront_path(text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 9. The two showcase branches with an App name, only where the word is still free
-- ---------------------------------------------------------------------------------------------

update public.branches b
   set public_slug = v.slug
  from (values ('44444444-4444-4444-4444-444444444444'::uuid, 'hamburger'),
               ('d0b26b93-4539-4065-8b16-bcfa1e5b8083'::uuid, 'food-thai-thai')) as v(id, slug)
 where b.id = v.id
   and b.public_slug is null
   and private.public_slug_problem(v.slug, b.id) is null;

commit;
