-- Kitchen stations the merchant manages (owner request 2026-10-24, docs/KITCHEN-STATIONS-2026-10-24.md).
--
-- Until now a station was free text on menu_items.station, offered from a fixed list in code (hot,
-- cold, bar, dessert, expo). Each branch now keeps its own list in public.kitchen_stations, which
-- anyone with menu.manage there adds to, renames, reorders and deletes from. The three functions
-- re-created below were copied from their live definitions (pg_get_functiondef on 2026-10-24) with
-- the same arguments, defaults, owner, grants, SECURITY DEFINER and search_path; only the lines
-- named here changed.
--
-- 1. A KEY THAT NEVER CHANGES, A NAME THAT CAN (§1). The key is what menu_items.station,
--    order_items.station, order_items.combo_contents[].station and the kitchen board's ?station=
--    already hold. No caller can change it after insert (kitchen_stations_rules refuses it, the
--    service role included), so a rename rewrites no dish and no order line, the station follow
--    trigger never fires for one, an open board keeps every ticket where it is, and a tablet
--    pinned to ?station=hot keeps its filter. The built-ins keep their keys; any other station
--    gets 'st_' and 10 hex characters from the column default. The API roles hold no privilege on
--    the key column at all, so the client never chooses one. A built-in may have no name, which
--    means "its translated label"; every other station has one. Names are 1-40 characters after
--    trimming and unique per branch, ignoring case.
--
-- 2. A DISH NAMES A STATION ITS BRANCH HAS. menu_items (branch_id, station) references
--    kitchen_stations (branch_id, key). NO ACTION rather than RESTRICT: it is checked once the
--    statement is done, so deleting a branch, which cascades to both tables, still works. MATCH
--    SIMPLE: a null station ("No station") needs no row. A blank station is stored as null, which
--    is how the board and the follow trigger already read it. Order lines and combo snapshots get
--    no foreign key: they are history.
--
-- 3. EVERY BRANCH STARTS WITH THE FIVE BUILT-INS (display_order 10-50, name null): the existing
--    ones here, new ones from an AFTER INSERT trigger on branches, which covers create_branch,
--    create_restaurant_with_branch and anything else that inserts a branch. Any other value a dish
--    holds becomes a station of its branch named as its key. Live on 2026-10-24 there is none
--    (17 dishes have no station, the rest hold hot, cold, bar or dessert). A value that cannot be
--    a key stops the file and is named in the error.
--
-- 4. WHO (§2). Staff of the branch read the list (private.user_branch_ids()), so the kitchen and
--    the counter can label lines. menu.manage at the branch inserts and renames or moves (name and
--    display_order only). Nobody deletes directly: a station is deleted only through
--    public.delete_kitchen_station. No anon access: customers never see stations, which is also
--    why the table does not bump storefront_versions.
--
-- 5. public.delete_kitchen_station(station, move_to, clear): moves the station's dishes to another
--    station of the branch, or to "No station" only when clear says so: with neither, a station
--    still on a dish is refused (station_in_use), so a page that last saw it unused cannot empty
--    a station another device has since given dishes. The follow trigger moves their lines not
--    yet made on active orders, and this function moves what that trigger leaves (lines already
--    made, combo entries naming the key), then deletes the row. Closed orders keep the key they
--    were made at.
--    public.reorder_kitchen_stations(branch, ids): the whole list in its new order.
--
-- 6. copy_branch_setup copies the source's stations before the dishes and says how many
--    (stations_copied); broadcast_franchise_menu adds to each target the stations the dishes it
--    adds there use, by key, leaving the target's own stations alone.
--
-- 7. kitchen_stations joins the supabase_realtime publication, so an open board hears a rename,
--    a reorder or a new station.
--
-- 8. LINES THAT REACH AN OPEN BOARD AFTER A DELETE. delete_kitchen_station moves only the lines
--    it can see. public.order_items_set_station (BEFORE INSERT on order_items, re-created from its
--    live definition) now also restamps every entry of a combo line's snapshot with its dish's
--    station as it is at insert, so the key place-order copied several round trips earlier does
--    not outlive a delete made in between. orders_reopened_station_keys (AFTER UPDATE OF status)
--    catches an order that comes back onto the board, such as the kitchen's Undo of a bump: its
--    lines and combo entries whose key the branch no longer has take their dish's current
--    station, or none.
--    Accepted: a line whose insert read its dish's station while a delete was running, and that
--    commits after the delete's sweeps, keeps the deleted key. The window is milliseconds; no row
--    lock closes it, because the insert trigger runs on every order line and the follow trigger
--    has the same window for every ordinary reassign. Nothing is lost: the board shows such a
--    line under All and under a pill of its own.
--
-- Everything is one transaction.

begin;

-- ---------------------------------------------------------------------------------------------
-- 0. Every station a dish holds today must be able to become a key.
-- ---------------------------------------------------------------------------------------------

do $guard$
declare
  v_bad text;
begin
  select string_agg(distinct format('%s at branch %s', quote_literal(mi.station), mi.branch_id), ', ')
    into v_bad
    from public.menu_items mi
   where btrim(mi.station) <> ''
     and (mi.station !~ '^[a-z0-9_-]{1,40}$' or mi.station = '_none');
  if v_bad is not null then
    raise exception 'menu_items_station_not_a_key'
      using detail = v_bad,
            hint = 'Give those dishes a built-in station (hot, cold, bar, dessert, expo) or none, then apply this file again.';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------------------------

create table public.kitchen_stations (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references public.branches (id) on delete cascade,
  -- Opaque on purpose: a Thai name does not slugify, and a key made from a name is stale after the
  -- first rename.
  key           text not null default ('st_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  name          text,
  display_order integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- '_none' is the kitchen board's "No station" pill (NO_STATION in kitchen-model.ts).
  constraint kitchen_stations_key_check
    check (key ~ '^[a-z0-9_-]{1,40}$' and key <> '_none'),
  -- No name shows the built-in's translated label, so only a built-in may go without one.
  constraint kitchen_stations_name_check
    check ((name is null and key in ('hot', 'cold', 'bar', 'dessert', 'expo'))
           or (name is not null and char_length(btrim(name)) between 1 and 40)),
  -- Also what menu_items_branch_id_station_fkey points at.
  constraint kitchen_stations_branch_key unique (branch_id, key)
);

create unique index kitchen_stations_branch_name_key
  on public.kitchen_stations (branch_id, lower(name))
  where name is not null;

comment on table public.kitchen_stations is
  'Each branch''s kitchen stations (docs/KITCHEN-STATIONS-2026-10-24.md). key is what menu_items.station, order_items.station, order_items.combo_contents[].station and the kitchen board''s ?station= hold, and never changes; name is what people see (null on a built-in: its translated label); display_order is the order everywhere. Read by the branch''s staff, written by menu.manage, deleted only through public.delete_kitchen_station.';
comment on column public.kitchen_stations.key is
  'The station''s identity: hot, cold, bar, dessert, expo for the built-ins, st_ and 10 hex characters for any other. Set at insert by the database, never changed.';
comment on column public.kitchen_stations.name is
  'What people see, 1-40 characters, unique per branch ignoring case. Null only on a built-in, meaning its translated label (stations.<key>).';

-- ---------------------------------------------------------------------------------------------
-- 2. Its rules: the key and the branch never change; names are trimmed.
-- ---------------------------------------------------------------------------------------------

create or replace function private.tg_kitchen_stations_rules()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op = 'UPDATE' then
    -- A dish, an order line, a combo snapshot and a pinned tablet all hold the key; changing it
    -- would strand every one of them.
    if new.key is distinct from old.key then
      raise exception 'station_key_immutable' using errcode = 'P0001';
    end if;
    if new.branch_id is distinct from old.branch_id then
      raise exception 'station_branch_immutable' using errcode = 'P0001';
    end if;
  end if;
  -- Surrounding whitespace is not part of a name, and a blank name is none: on a built-in that
  -- means its translated label again, on any other station the name check refuses it.
  new.name := nullif(regexp_replace(new.name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  return new;
end;
$function$;

comment on function private.tg_kitchen_stations_rules() is
  'BEFORE INSERT OR UPDATE on kitchen_stations: refuses a change of key or branch_id, trims the name (a blank one becomes null).';

revoke all on function private.tg_kitchen_stations_rules() from public, anon, authenticated;

create trigger kitchen_stations_rules
  before insert or update on public.kitchen_stations
  for each row execute function private.tg_kitchen_stations_rules();

create trigger set_updated_at_kitchen_stations
  before update on public.kitchen_stations
  for each row execute function extensions.moddatetime('updated_at');

create trigger trg_platform_admin_audit
  after insert or delete or update on public.kitchen_stations
  for each row execute function private.log_platform_admin_write();

-- ---------------------------------------------------------------------------------------------
-- 3. Who reads and writes it (§2).
-- ---------------------------------------------------------------------------------------------

alter table public.kitchen_stations enable row level security;

create policy kitchen_stations_staff_read on public.kitchen_stations
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));

create policy kitchen_stations_staff_insert on public.kitchen_stations
  for insert to authenticated
  with check (private.staff_has_capability(branch_id, 'menu.manage'));

create policy kitchen_stations_staff_update on public.kitchen_stations
  for update to authenticated
  using (private.staff_has_capability(branch_id, 'menu.manage'))
  with check (private.staff_has_capability(branch_id, 'menu.manage'));

-- Column grants keep the key the database's: a client insert names only the branch, the name and
-- the position, and an update only the name and the position. No DELETE: a station still on a
-- dish is moved off it first, which only delete_kitchen_station does.
revoke all on public.kitchen_stations from public, anon, authenticated;
grant select on public.kitchen_stations to authenticated;
grant insert (branch_id, name, display_order) on public.kitchen_stations to authenticated;
grant update (name, display_order) on public.kitchen_stations to authenticated;
grant all on public.kitchen_stations to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. Every branch has the five built-ins.
-- ---------------------------------------------------------------------------------------------

-- Before the backfill: a branch inserted while this file runs waits on the lock this trigger takes
-- and is seeded by it, or committed first and is seen by the backfill.
create or replace function private.tg_branches_seed_kitchen_stations()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- As the owner: whoever inserts a branch (an owner through create_branch, a platform admin)
  -- holds no privilege on the key column.
  insert into public.kitchen_stations (branch_id, key, display_order)
  values (new.id, 'hot', 10), (new.id, 'cold', 20), (new.id, 'bar', 30), (new.id, 'dessert', 40),
         (new.id, 'expo', 50)
  on conflict (branch_id, key) do nothing;
  return null;
end;
$function$;

alter function private.tg_branches_seed_kitchen_stations() owner to postgres;

comment on function private.tg_branches_seed_kitchen_stations() is
  'AFTER INSERT on branches: the new branch gets the five built-in kitchen stations (hot, cold, bar, dessert, expo; display_order 10-50; no name).';

revoke all on function private.tg_branches_seed_kitchen_stations() from public, anon, authenticated;

create trigger branches_seed_kitchen_stations
  after insert on public.branches
  for each row execute function private.tg_branches_seed_kitchen_stations();

insert into public.kitchen_stations (branch_id, key, display_order)
select b.id, s.key, s.display_order
  from public.branches b
 cross join (values ('hot', 10), ('cold', 20), ('bar', 30), ('dessert', 40), ('expo', 50))
         as s (key, display_order)
on conflict (branch_id, key) do nothing;

-- Any other station a dish holds, after the built-ins in key order, named as its key so the
-- merchant can rename it.
insert into public.kitchen_stations (branch_id, key, name, display_order)
select v.branch_id, v.station, v.station,
       50 + 10 * row_number() over (partition by v.branch_id order by v.station)
  from (select distinct mi.branch_id, mi.station
          from public.menu_items mi
         where btrim(mi.station) <> ''
           and mi.station not in ('hot', 'cold', 'bar', 'dessert', 'expo')) as v
on conflict (branch_id, key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 5. A dish names a station its branch has, or none.
-- ---------------------------------------------------------------------------------------------

create or replace function private.tg_menu_items_station_blank_is_null()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- A blank station is "No station" everywhere it is read; stored as null it also needs no row in
  -- kitchen_stations.
  if btrim(new.station) = '' then
    new.station := null;
  end if;
  return new;
end;
$function$;

comment on function private.tg_menu_items_station_blank_is_null() is
  'BEFORE INSERT OR UPDATE OF station on menu_items: a blank station is stored as null ("No station").';

revoke all on function private.tg_menu_items_station_blank_is_null() from public, anon, authenticated;

create trigger menu_items_station_blank_is_null
  before insert or update of station on public.menu_items
  for each row execute function private.tg_menu_items_station_blank_is_null();

-- None live on 2026-10-24. The follow trigger does not fire: '' and null are the same station to it.
update public.menu_items set station = null where btrim(station) = '';

alter table public.menu_items
  add constraint menu_items_branch_id_station_fkey
  foreign key (branch_id, station) references public.kitchen_stations (branch_id, key);

-- The foreign key's check when a station row is deleted, and delete_kitchen_station's dish move.
create index if not exists menu_items_branch_station_idx
  on public.menu_items (branch_id, station)
  where station is not null;

-- ---------------------------------------------------------------------------------------------
-- 6. Delete and reorder (§2).
-- ---------------------------------------------------------------------------------------------

create or replace function public.delete_kitchen_station(
  p_station_id uuid,
  p_move_to    text default null,
  p_clear      boolean default false
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_station public.kitchen_stations%rowtype;
  v_move_to text := nullif(btrim(p_move_to), '');
  v_moved   integer := 0;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  -- Locked first. Giving a dish this station takes a key-share lock on the row for the foreign key
  -- check, so a dish given it at this moment waits and then fails against the deleted row instead
  -- of slipping in after the dishes were moved.
  select * into v_station
    from public.kitchen_stations
   where id = p_station_id
     for update;
  if not found then
    raise exception 'station_not_found' using errcode = 'P0002';
  end if;

  if not private.staff_has_capability(v_station.branch_id, 'menu.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_move_to is not null then
    -- Another station of the same branch, held until commit so it cannot be deleted under the
    -- dishes moving to it.
    perform 1
       from public.kitchen_stations t
      where t.branch_id = v_station.branch_id
        and t.key = v_move_to
        and t.id <> v_station.id
        for share;
    if not found then
      raise exception 'move_target_invalid' using errcode = 'P0001';
    end if;
  elsif not coalesce(p_clear, false)
        and exists (select 1
                      from public.menu_items mi
                     where mi.branch_id = v_station.branch_id
                       and mi.station = v_station.key) then
    -- "No station" only when the caller chose it. A page that last saw this station unused sends
    -- neither a target nor p_clear; a dish given the station since (another device, an import)
    -- is refused here rather than quietly emptied, as delete_menu_category refuses
    -- category_not_empty. Read after the lock above, so a dish given it before then is seen.
    raise exception 'station_in_use' using errcode = 'P0001';
  end if;

  -- The dishes. Each is an UPDATE OF station, so menu_items_station_follows moves the lines of
  -- these dishes not made yet on active orders, and their entries in combo lines.
  update public.menu_items mi
     set station = v_move_to
   where mi.branch_id = v_station.branch_id
     and mi.station = v_station.key;
  get diagnostics v_moved = row_count;

  -- What the follow trigger deliberately leaves: lines already made here, whether their dish is
  -- still at this station or has moved to another since. On an open board they would sit under a
  -- key nobody can name any more. Orders the board does not show keep the key they were made at.
  update public.order_items oi
     set station = v_move_to
    from public.orders o
   where o.id = oi.order_id
     and o.branch_id = v_station.branch_id
     and o.status in ('pending', 'confirmed', 'preparing', 'ready')
     and oi.station = v_station.key;

  -- Likewise every combo entry still naming the key, whatever its dish and the line's prep state.
  update public.order_items oi
     set combo_contents = (
           select jsonb_agg(
                    case
                      when jsonb_typeof(a.e) = 'object' and a.e ->> 'station' = v_station.key
                      then a.e || jsonb_build_object('station', v_move_to)
                      else a.e
                    end
                    order by a.i)
             from jsonb_array_elements(oi.combo_contents) with ordinality as a(e, i))
    from public.orders o
   where o.id = oi.order_id
     and o.branch_id = v_station.branch_id
     and o.status in ('pending', 'confirmed', 'preparing', 'ready')
     and oi.combo_id is not null
     and jsonb_typeof(oi.combo_contents) = 'array'
     and exists (
           select 1
             from jsonb_array_elements(oi.combo_contents) as c(e)
            where jsonb_typeof(c.e) = 'object' and c.e ->> 'station' = v_station.key);

  delete from public.kitchen_stations where id = v_station.id;

  return v_moved;
end;
$function$;

alter function public.delete_kitchen_station(uuid, text, boolean) owner to postgres;

comment on function public.delete_kitchen_station(uuid, text, boolean) is
  'Deletes a kitchen station (menu.manage at its branch). Its dishes move to p_move_to, another station key of the same branch, or to no station when p_move_to is null and p_clear is true; with neither, a station still on a dish is refused (station_in_use). Lines on active orders still under the key, made or not, and combo entries naming it move with the dishes. Closed orders keep the key. Returns how many dishes moved. Refuses with auth_required, station_not_found, forbidden, move_target_invalid or station_in_use.';

revoke all on function public.delete_kitchen_station(uuid, text, boolean) from public, anon;
grant execute on function public.delete_kitchen_station(uuid, text, boolean) to authenticated, service_role;

create or replace function public.reorder_kitchen_stations(p_branch_id uuid, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_current uuid[];
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if not private.staff_has_capability(p_branch_id, 'menu.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Locked in one order, so two managers reordering at once queue instead of deadlocking.
  select coalesce(array_agg(locked.id order by locked.id), '{}')
    into v_current
    from (select ks.id
            from public.kitchen_stations ks
           where ks.branch_id = p_branch_id
           order by ks.id
             for update) as locked;

  -- Every station of the branch, each once. A list from before a station was added or deleted is
  -- refused rather than half applied.
  if p_ids is null
     or cardinality(p_ids) <> cardinality(v_current)
     or v_current is distinct from coalesce((select array_agg(x order by x) from unnest(p_ids) as x), '{}') then
    raise exception 'ids_mismatch' using errcode = 'P0001';
  end if;

  -- Steps of ten, as the built-ins start, so a station added later can go between two. A station
  -- already in place is not written: no realtime event for nothing.
  update public.kitchen_stations ks
     set display_order = 10 * o.ord
    from unnest(p_ids) with ordinality as o(id, ord)
   where ks.id = o.id
     and ks.branch_id = p_branch_id
     and ks.display_order is distinct from 10 * o.ord;
end;
$function$;

alter function public.reorder_kitchen_stations(uuid, uuid[]) owner to postgres;

comment on function public.reorder_kitchen_stations(uuid, uuid[]) is
  'Puts the branch''s kitchen stations in the order of p_ids, which must name every station of the branch once (else ids_mismatch). Requires menu.manage (else forbidden).';

revoke all on function public.reorder_kitchen_stations(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_kitchen_stations(uuid, uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. copy_branch_setup: the stations before the dishes (§2). Changed: v_stations, the stations
--    step in the menu block, and stations_copied in both answers.
-- ---------------------------------------------------------------------------------------------

create or replace function public.copy_branch_setup(p_source_branch_id uuid, p_target_branch_id uuid, p_copy_menu boolean, p_copy_hours boolean, p_copy_settings boolean, p_copy_look boolean default false, p_copy_loyalty boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  -- The payment, delivery, tip, service-fee, kitchen-timing, dine-in and scheduling settings the
  -- Branch settings cards edit, plus the currency the copied prices are written in.
  -- Deliberately absent:
  --   qr_transfer            the source branch's bank account. Each branch uploads its own.
  --   storefront_override    the look, copied only with p_copy_look.
  --   orders_paused, busy_extra_prep_min   the source kitchen's live state.
  --   driver_* tuning        set by the platform.
  --   delivery_min_fee, delivery_max_fee, batch_max_dropoff_mi   read by nothing.
  v_setting_keys constant text[] := array[
    'currency', 'payment_methods', 'tip_config', 'service_fee_percent', 'prep_time_min', 'dine_in',
    'delivery_mode', 'delivery_hours_enabled', 'delivery_base_fee', 'delivery_per_km_fee',
    'delivery_radius_km', 'delivery_surge_from_mi', 'delivery_surge_multiplier',
    'batch_enabled', 'batch_max_detour_mi',
    'scheduling_enabled', 'schedule_hours_enabled', 'schedule_min_lead_min', 'schedule_max_days',
    'schedule_slot_minutes', 'schedule_lead_time_min'
  ];
  -- Theme keys that describe the logo or icons rather than colours; each branch owns those.
  v_icon_theme_keys constant text[] := array['logoUrl', 'logo_url', 'faviconUrl', 'appIcon', 'brandName'];
  v_source public.branches%rowtype;
  v_target public.branches%rowtype;
  v_cat_map jsonb;
  v_item_map jsonb;
  v_group_map jsonb;
  v_combo_map jsonb;
  v_settings jsonb;
  v_pm jsonb;
  v_target_has_qr boolean;
  v_source_transfer boolean := false;
  v_transfer_needs_qr boolean := false;
  v_categories int := 0;
  v_stations int := 0;
  v_items int := 0;
  v_groups int := 0;
  v_combos int := 0;
  v_stock_off int := 0;
  v_hours int := 0;
  v_schedule_windows int := 0;
  v_settings_copied boolean := false;
  v_tax_copied boolean := false;
  v_look_copied boolean := false;
  v_loyalty jsonb;
  v_ladder jsonb;
  v_loyalty_copied boolean := false;
  v_rewards int := 0;
  v_rewards_skipped int := 0;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  if p_source_branch_id is null or p_target_branch_id is null then raise exception 'branch_required'; end if;
  -- Nothing ticked means nothing to authorise, so answer before the lookups below could tell a
  -- caller whether two branch ids share a restaurant.
  if not (coalesce(p_copy_menu, false) or coalesce(p_copy_hours, false) or coalesce(p_copy_settings, false)
          or coalesce(p_copy_look, false) or coalesce(p_copy_loyalty, false)) then
    return jsonb_build_object('categories_copied', 0, 'stations_copied', 0, 'items_copied', 0, 'modifier_groups_copied', 0,
                              'combos_copied', 0, 'stock_tracking_off', 0, 'hours_copied', 0,
                              'schedule_windows_copied', 0, 'settings_copied', false, 'tax_copied', false,
                              'transfer_needs_qr', false, 'look_copied', false,
                              'loyalty_copied', false, 'rewards_copied', 0, 'rewards_skipped', 0);
  end if;
  if p_source_branch_id = p_target_branch_id then raise exception 'same_branch'; end if;

  select * into v_source from public.branches where id = p_source_branch_id;
  if not found then raise exception 'source_not_found'; end if;
  -- Locked so two retries of the same copy cannot both find the target menu empty.
  select * into v_target from public.branches where id = p_target_branch_id for update;
  if not found then raise exception 'target_not_found'; end if;
  if v_source.restaurant_id <> v_target.restaurant_id then raise exception 'different_restaurant'; end if;

  if coalesce(p_copy_menu, false) then
    if not (private.staff_has_capability(p_source_branch_id, 'menu.manage')
            and private.staff_has_capability(p_target_branch_id, 'menu.manage')) then
      raise exception 'not_authorized';
    end if;
    -- Copying into a branch that already has a menu would duplicate every dish and group.
    if exists (select 1 from public.menu_items where branch_id = p_target_branch_id)
       or exists (select 1 from public.menu_categories where branch_id = p_target_branch_id)
       or exists (select 1 from public.modifier_groups where branch_id = p_target_branch_id)
       or exists (select 1 from public.combo_sets where branch_id = p_target_branch_id) then
      raise exception 'target_menu_not_empty';
    end if;
  end if;

  if (coalesce(p_copy_hours, false) or coalesce(p_copy_settings, false) or coalesce(p_copy_look, false))
     and not (private.staff_has_capability(p_source_branch_id, 'branch.settings')
              and private.staff_has_capability(p_target_branch_id, 'branch.settings')) then
    raise exception 'not_authorized';
  end if;

  if coalesce(p_copy_loyalty, false) then
    if not (private.staff_has_capability(p_source_branch_id, 'loyalty.manage')
            and private.staff_has_capability(p_target_branch_id, 'loyalty.manage')) then
      raise exception 'not_authorized';
    end if;
    -- Like the menu: copying next to an existing catalogue would list every reward twice.
    if exists (select 1 from public.loyalty_rewards where branch_id = p_target_branch_id) then
      raise exception 'target_rewards_not_empty';
    end if;
  end if;

  if coalesce(p_copy_menu, false) then
    -- Fresh ids are minted up front so every child row can point at its copied parent.
    select coalesce(jsonb_object_agg(c.id::text, gen_random_uuid()), '{}'::jsonb) into v_cat_map
      from public.menu_categories c where c.branch_id = p_source_branch_id;
    select coalesce(jsonb_object_agg(i.id::text, gen_random_uuid()), '{}'::jsonb) into v_item_map
      from public.menu_items i where i.branch_id = p_source_branch_id;
    select coalesce(jsonb_object_agg(g.id::text, gen_random_uuid()), '{}'::jsonb) into v_group_map
      from public.modifier_groups g where g.branch_id = p_source_branch_id;
    -- Archived combos are history, not menu. Read as JSON so this holds with or without the column.
    select coalesce(jsonb_object_agg(cs.id::text, gen_random_uuid()), '{}'::jsonb) into v_combo_map
      from public.combo_sets cs
     where cs.branch_id = p_source_branch_id
       and (to_jsonb(cs) ->> 'archived_at') is null;

    insert into public.menu_categories (
      id, branch_id, name, name_translations, description, icon_emoji, display_order, is_active, available_hours
    )
    select (v_cat_map ->> c.id::text)::uuid, p_target_branch_id, c.name, c.name_translations, c.description,
           c.icon_emoji, c.display_order, c.is_active, c.available_hours
      from public.menu_categories c
     where c.branch_id = p_source_branch_id;
    get diagnostics v_categories = row_count;

    -- Kitchen stations before the dishes, which may only name a station their branch has
    -- (menu_items_branch_id_station_fkey). The target's menu is empty (checked above, with the
    -- target row locked so no dish can be added meanwhile), so none of its stations is in use, and
    -- its list is replaced by the source's, keys, names and order included, as hours are: the
    -- copied dishes keep their keys, and a station of the same name under another key would
    -- collide with the source's.
    delete from public.kitchen_stations where branch_id = p_target_branch_id;
    insert into public.kitchen_stations (branch_id, key, name, display_order)
    select p_target_branch_id, s.key, s.name, s.display_order
      from public.kitchen_stations s
     where s.branch_id = p_source_branch_id;
    get diagnostics v_stations = row_count;

    -- Stock counts, sold-out-until and ratings are the source kitchen's live state, not menu. The
    -- new kitchen has counted nothing, so tracking starts off (a tracked dish with no count shows
    -- as sold out); the merchant switches it on after the first stock count.
    select count(*) into v_stock_off
      from public.menu_items i
     where i.branch_id = p_source_branch_id and i.track_stock;

    insert into public.menu_items (
      id, branch_id, category_id, name, name_translations, description, description_translations,
      price, cost, image_url, image_urls, is_active, is_recommended, is_new, available_channels,
      track_stock, low_stock_threshold, allergens, dietary_tags, prep_time_minutes, calories,
      display_order, layout_config, slug, station, availability_schedule, requires_age_verification
    )
    select (v_item_map ->> i.id::text)::uuid, p_target_branch_id, (v_cat_map ->> i.category_id::text)::uuid,
           i.name, i.name_translations, i.description, i.description_translations,
           i.price, i.cost, i.image_url, i.image_urls, i.is_active, i.is_recommended, i.is_new, i.available_channels,
           false, i.low_stock_threshold, i.allergens, i.dietary_tags, i.prep_time_minutes, i.calories,
           i.display_order, i.layout_config, i.slug, i.station, i.availability_schedule, i.requires_age_verification
      from public.menu_items i
     where i.branch_id = p_source_branch_id;
    get diagnostics v_items = row_count;

    insert into public.modifier_groups (
      id, branch_id, name, name_translations, selection_type, is_required, min_select, max_select, display_order
    )
    select (v_group_map ->> g.id::text)::uuid, p_target_branch_id, g.name, g.name_translations, g.selection_type,
           g.is_required, g.min_select, g.max_select, g.display_order
      from public.modifier_groups g
     where g.branch_id = p_source_branch_id;
    get diagnostics v_groups = row_count;

    insert into public.modifier_options (group_id, name, name_translations, price_delta, is_default, is_active, display_order)
    select (v_group_map ->> o.group_id::text)::uuid, o.name, o.name_translations, o.price_delta,
           o.is_default, o.is_active, o.display_order
      from public.modifier_options o
      join public.modifier_groups g on g.id = o.group_id
     where g.branch_id = p_source_branch_id;

    -- A link to another branch's group has no copy to point at, so it is left behind.
    insert into public.menu_item_modifiers (menu_item_id, modifier_group_id, display_order)
    select (v_item_map ->> m.menu_item_id::text)::uuid, (v_group_map ->> m.modifier_group_id::text)::uuid, m.display_order
      from public.menu_item_modifiers m
      join public.menu_items i on i.id = m.menu_item_id
     where i.branch_id = p_source_branch_id
       and v_group_map ? m.modifier_group_id::text;

    insert into public.combo_sets (id, branch_id, name, description, total_price, image_url, is_active, display_order)
    select (v_combo_map ->> cs.id::text)::uuid, p_target_branch_id, cs.name, cs.description, cs.total_price,
           cs.image_url, cs.is_active, cs.display_order
      from public.combo_sets cs
     where cs.branch_id = p_source_branch_id
       and v_combo_map ? cs.id::text;
    get diagnostics v_combos = row_count;

    -- Each dish of a combo points at its copy; one that is not on the source menu has none.
    insert into public.combo_items (combo_id, menu_item_id, quantity, is_swappable, swap_group, position)
    select (v_combo_map ->> ci.combo_id::text)::uuid, (v_item_map ->> ci.menu_item_id::text)::uuid,
           ci.quantity, ci.is_swappable, ci.swap_group, ci.position
      from public.combo_items ci
     where v_combo_map ? ci.combo_id::text
       and v_item_map ? ci.menu_item_id::text;
  end if;

  if coalesce(p_copy_hours, false) then
    -- Replaced, not merged, like set_branch_hours: copying hours means "open when that branch is".
    delete from public.branch_hours where branch_id = p_target_branch_id;
    insert into public.branch_hours (branch_id, day_of_week, opens_at, closes_at)
    select p_target_branch_id, h.day_of_week, h.opens_at, h.closes_at
      from public.branch_hours h
     where h.branch_id = p_source_branch_id;
    get diagnostics v_hours = row_count;
  end if;

  if coalesce(p_copy_settings, false) then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_settings
      from jsonb_each(case when jsonb_typeof(v_source.settings) = 'object' then v_source.settings else '{}'::jsonb end) e
     where e.key = any (v_setting_keys);

    -- Transfer needs this branch's own QR (place-order refuses transfer without one). Until it has
    -- one, the copied matrix takes transfer off in both modes and the caller is told why.
    v_target_has_qr := coalesce(btrim(v_target.settings #>> '{qr_transfer,image_url}'), '') <> '';
    if jsonb_typeof(v_settings -> 'payment_methods') = 'object' and not v_target_has_qr then
      v_pm := v_settings -> 'payment_methods';
      v_source_transfer := (v_pm #> '{asap,transfer}') = 'true'::jsonb
                        or (v_pm #> '{scheduled,transfer}') = 'true'::jsonb;
      v_pm := v_pm || jsonb_build_object(
        'asap', (case when jsonb_typeof(v_pm -> 'asap') = 'object' then v_pm -> 'asap' else '{}'::jsonb end)
                || '{"transfer": false}'::jsonb,
        'scheduled', (case when jsonb_typeof(v_pm -> 'scheduled') = 'object' then v_pm -> 'scheduled' else '{}'::jsonb end)
                || '{"transfer": false}'::jsonb);
      v_settings := v_settings || jsonb_build_object('payment_methods', v_pm);
      v_transfer_needs_qr := v_source_transfer;
    end if;

    update public.branches b
       set settings = (case when jsonb_typeof(b.settings) = 'object' then b.settings else '{}'::jsonb end)
                      || v_settings,
           sales_tax_rate = v_source.sales_tax_rate
     where b.id = p_target_branch_id;
    v_settings_copied := v_settings <> '{}'::jsonb;
    v_tax_copied := true;

    -- delivery_hours_enabled copied without its windows would close delivery all week.
    delete from public.branch_delivery_hours where branch_id = p_target_branch_id;
    insert into public.branch_delivery_hours (branch_id, day_of_week, opens_at, closes_at)
    select p_target_branch_id, h.day_of_week, h.opens_at, h.closes_at
      from public.branch_delivery_hours h
     where h.branch_id = p_source_branch_id;

    -- Likewise schedule_hours_enabled without its booking windows would refuse every booking.
    delete from public.branch_schedule_hours where branch_id = p_target_branch_id;
    insert into public.branch_schedule_hours (branch_id, day_of_week, opens_at, closes_at)
    select p_target_branch_id, h.day_of_week, h.opens_at, h.closes_at
      from public.branch_schedule_hours h
     where h.branch_id = p_source_branch_id;
    get diagnostics v_schedule_windows = row_count;
  end if;

  if coalesce(p_copy_look, false) then
    -- Colours, layout and hero. Never the logo or icons: every branch uploads its own.
    update public.branches b
       set theme_override = (case when jsonb_typeof(v_source.theme_override) = 'object'
                                  then v_source.theme_override else '{}'::jsonb end) - v_icon_theme_keys,
           settings = case
                        when jsonb_typeof(v_source.settings -> 'storefront_override') = 'object'
                          then (case when jsonb_typeof(b.settings) = 'object' then b.settings else '{}'::jsonb end)
                               || jsonb_build_object('storefront_override', v_source.settings -> 'storefront_override')
                        else b.settings
                      end
     where b.id = p_target_branch_id;
    v_look_copied := true;
  end if;

  if coalesce(p_copy_loyalty, false) then
    -- The programme. A source that never saved one runs on the platform defaults ('{}'), and so
    -- will the copy.
    select bls.settings into v_loyalty
      from public.branch_loyalty_settings bls
     where bls.branch_id = p_source_branch_id;
    insert into public.branch_loyalty_settings (branch_id, restaurant_id, settings, updated_at, updated_by)
    values (p_target_branch_id, v_target.restaurant_id, coalesce(v_loyalty, '{}'::jsonb), now(), auth.uid())
    on conflict (branch_id) do update
       set settings = excluded.settings,
           restaurant_id = excluded.restaurant_id,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by;
    v_loyalty_copied := true;

    -- Members this branch already has are re-graded on the ladder they now follow, as
    -- set_loyalty_settings does. A brand-new branch has none.
    v_ladder := public.loyalty_settings_for(p_target_branch_id);
    update public.loyalty_points lp
       set tier = (case
                     when lp.lifetime_earned >= (v_ladder ->> 'platinum')::int then 'platinum'
                     when lp.lifetime_earned >= (v_ladder ->> 'gold')::int     then 'gold'
                     when lp.lifetime_earned >= (v_ladder ->> 'silver')::int   then 'silver'
                     else 'bronze'
                   end)::loyalty_tier
     where lp.branch_id = p_target_branch_id
       and lp.tier is distinct from (case
                     when lp.lifetime_earned >= (v_ladder ->> 'platinum')::int then 'platinum'
                     when lp.lifetime_earned >= (v_ladder ->> 'gold')::int     then 'gold'
                     when lp.lifetime_earned >= (v_ladder ->> 'silver')::int   then 'silver'
                     else 'bronze'
                   end)::loyalty_tier;

    -- The catalogue. A free-item reward must name a dish on this branch's own menu, which only
    -- exists when the menu was copied in this same call.
    insert into public.loyalty_rewards (
      branch_id, restaurant_id, name, description, kind, points_cost, value, max_discount,
      menu_item_id, min_subtotal, is_active, sort_order
    )
    select p_target_branch_id, v_target.restaurant_id, r.name, r.description, r.kind, r.points_cost,
           r.value, r.max_discount,
           case when r.menu_item_id is not null then (v_item_map ->> r.menu_item_id::text)::uuid end,
           r.min_subtotal, r.is_active, r.sort_order
      from public.loyalty_rewards r
     where r.branch_id = p_source_branch_id
       and (r.menu_item_id is null or coalesce(v_item_map, '{}'::jsonb) ? r.menu_item_id::text);
    get diagnostics v_rewards = row_count;

    select count(*) into v_rewards_skipped
      from public.loyalty_rewards r
     where r.branch_id = p_source_branch_id
       and r.menu_item_id is not null
       and not (coalesce(v_item_map, '{}'::jsonb) ? r.menu_item_id::text);
  end if;

  return jsonb_build_object(
    'categories_copied', v_categories,
    'stations_copied', v_stations,
    'items_copied', v_items,
    'modifier_groups_copied', v_groups,
    'combos_copied', v_combos,
    'stock_tracking_off', v_stock_off,
    'hours_copied', v_hours,
    'schedule_windows_copied', v_schedule_windows,
    'settings_copied', v_settings_copied,
    'tax_copied', v_tax_copied,
    'sales_tax_rate', case when v_tax_copied then v_source.sales_tax_rate end,
    'transfer_needs_qr', v_transfer_needs_qr,
    'look_copied', v_look_copied,
    'loyalty_copied', v_loyalty_copied,
    'rewards_copied', v_rewards,
    'rewards_skipped', v_rewards_skipped
  );
end $function$;

revoke all on function public.copy_branch_setup(uuid, uuid, boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.copy_branch_setup(uuid, uuid, boolean, boolean, boolean, boolean, boolean)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. broadcast_franchise_menu: the stations its dishes use (§2). Changed: the stations insert
--    before the dish insert, and the dish insert's station, which is the target's key for it.
-- ---------------------------------------------------------------------------------------------

create or replace function public.broadcast_franchise_menu(p_source_branch_id uuid, p_target_branch_ids uuid[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_target_branch uuid;
  v_inserted_categories int := 0;
  v_inserted_items int := 0;
  v_updated_items int := 0;
  v_n int;
begin
  if v_uid is null then raise exception 'auth_required'; end if;

  select r.franchise_group_id into v_group_id
    from public.branches b
    join public.restaurants r on r.id = b.restaurant_id
   where b.id = p_source_branch_id;
  if v_group_id is null then raise exception 'source_not_in_group'; end if;

  if not exists (
    select 1 from public.franchise_groups
     where id = v_group_id and owner_user_id = v_uid
  ) then
    raise exception 'not_franchise_owner';
  end if;

  foreach v_target_branch in array p_target_branch_ids loop
    if not exists (
      select 1 from public.branches b
      join public.restaurants r on r.id = b.restaurant_id
      where b.id = v_target_branch and r.franchise_group_id = v_group_id
    ) then continue; end if;
    if v_target_branch = p_source_branch_id then continue; end if;

    insert into public.menu_categories (branch_id, name, name_translations, icon_emoji, display_order)
    select v_target_branch, sc.name, sc.name_translations, sc.icon_emoji, sc.display_order
      from public.menu_categories sc
     where sc.branch_id = p_source_branch_id
       and not exists (
         select 1 from public.menu_categories tc
          where tc.branch_id = v_target_branch and lower(tc.name) = lower(sc.name)
       );
    get diagnostics v_n = row_count;
    v_inserted_categories := v_inserted_categories + v_n;

    -- The stations the dishes added below use, which a dish may only name when its branch has
    -- them (menu_items_branch_id_station_fkey). Matched by key, so a station broadcast once lines
    -- up with every later broadcast; one the target already has is left as the target keeps it.
    -- One whose name the target already uses under another key is not added (names are unique per
    -- branch): its dishes take the target's station of that name instead. New ones go after the
    -- target's own, in the source's order.
    insert into public.kitchen_stations (branch_id, key, name, display_order)
    select v_target_branch, n.key, n.name,
           (select coalesce(max(t.display_order), 0) from public.kitchen_stations t
             where t.branch_id = v_target_branch)
             + 10 * row_number() over (order by n.display_order, n.key)
      from (
        select distinct ss.key, ss.name, ss.display_order
          from public.menu_items si
          join public.menu_categories sc on sc.id = si.category_id
          join public.kitchen_stations ss on ss.branch_id = p_source_branch_id and ss.key = si.station
         where si.branch_id = p_source_branch_id
           and exists (
             select 1 from public.menu_categories tc
              where tc.branch_id = v_target_branch and lower(tc.name) = lower(sc.name)
           )
           and not exists (
             select 1 from public.menu_items ti
              where ti.branch_id = v_target_branch
                and lower(ti.name) = lower(si.name)
           )
      ) as n
     where not exists (
       select 1 from public.kitchen_stations t
        where t.branch_id = v_target_branch
          and (t.key = n.key or (n.name is not null and lower(t.name) = lower(n.name)))
     )
    on conflict do nothing;

    with src as (
      select si.*, sc.name as cat_name
        from public.menu_items si
        join public.menu_categories sc on sc.id = si.category_id
       where si.branch_id = p_source_branch_id
    ),
    tgt as (
      select tc.id as target_category_id, tc.name as cat_name
        from public.menu_categories tc
       where tc.branch_id = v_target_branch
    ),
    upserted_inserts as (
      insert into public.menu_items (
        branch_id, category_id, name, name_translations, description, description_translations,
        price, cost, image_url, station, is_active, display_order
      )
      select v_target_branch,
             t.target_category_id,
             s.name, s.name_translations, s.description, s.description_translations,
             s.price, s.cost, s.image_url,
             -- The target's station with the source's key, else the target's station of the same
             -- name (see the stations insert above).
             coalesce(
               (select tk.key from public.kitchen_stations tk
                 where tk.branch_id = v_target_branch and tk.key = s.station),
               (select tk.key
                  from public.kitchen_stations sk
                  join public.kitchen_stations tk
                    on tk.branch_id = v_target_branch and lower(tk.name) = lower(sk.name)
                 where sk.branch_id = p_source_branch_id and sk.key = s.station
                 limit 1)),
             s.is_active, s.display_order
        from src s
        join tgt t on lower(t.cat_name) = lower(s.cat_name)
       where not exists (
         select 1 from public.menu_items ti
          where ti.branch_id = v_target_branch
            and lower(ti.name) = lower(s.name)
       )
      returning 1 as ins
    )
    select count(*) into v_n from upserted_inserts;
    v_inserted_items := v_inserted_items + v_n;

    with src as (
      select si.name, si.description, si.price
        from public.menu_items si
       where si.branch_id = p_source_branch_id
    ),
    locked as (
      select item_signature, locked_fields from public.franchise_menu_locks
       where group_id = v_group_id
    )
    update public.menu_items ti
       set name = src.name,
           description = case when 'description' = any(locked.locked_fields) then src.description else ti.description end,
           price = case when 'price' = any(locked.locked_fields) then src.price else ti.price end,
           updated_at = now()
      from src
      join locked on locked.item_signature = lower(src.name)
     where ti.branch_id = v_target_branch
       and lower(ti.name) = lower(src.name);
    get diagnostics v_n = row_count;
    v_updated_items := v_updated_items + v_n;
  end loop;

  return jsonb_build_object(
    'inserted_categories', v_inserted_categories,
    'inserted_items', v_inserted_items,
    'updated_items', v_updated_items
  );
end $function$;

revoke all on function public.broadcast_franchise_menu(uuid, uuid[]) from public, anon;
grant execute on function public.broadcast_franchise_menu(uuid, uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 9. Realtime (§3). Under RLS a DELETE event carries only the id and cannot be filtered by
--    branch, so the board re-reads the list on any event rather than patching it.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'kitchen_stations'
  ) then
    alter publication supabase_realtime add table public.kitchen_stations;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 10. Lines that reach an open board after a delete (header, 8).
-- ---------------------------------------------------------------------------------------------

-- Live definition, plus the combo step. The dish line's own station is filled exactly as before.
create or replace function public.order_items_set_station()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_station text;
  v_branch uuid;
begin
  if new.station is null then
    select station into v_station from public.menu_items where id = new.menu_item_id;
    new.station := v_station;
  end if;

  -- A combo line's snapshot carries each dish's station as place-order read it, several round
  -- trips before this insert; a station deleted in between would outlive its row there. Each
  -- entry takes its dish's station as it is now. An entry whose dish is not on this order's
  -- branch's menu keeps what it holds. Only a combo line has an array here, so a dish line pays
  -- nothing for this; no row is locked (header, 8).
  if jsonb_typeof(new.combo_contents) = 'array' then
    select o.branch_id into v_branch from public.orders o where o.id = new.order_id;
    new.combo_contents := (
      -- An empty array aggregates to null; it comes back as it was.
      select coalesce(
               jsonb_agg(
                 case
                   when mi.id is not null then a.e || jsonb_build_object('station', mi.station)
                   else a.e
                 end
                 order by a.i),
               new.combo_contents)
        from jsonb_array_elements(new.combo_contents) with ordinality as a(e, i)
        left join public.menu_items mi
          on mi.branch_id = v_branch
         -- Cast only what reads as a uuid: a malformed id must not fail the order.
         and mi.id = case
                       when jsonb_typeof(a.e) = 'object'
                        and coalesce(a.e ->> 'menu_item_id', a.e ->> 'id')
                            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       then coalesce(a.e ->> 'menu_item_id', a.e ->> 'id')::uuid
                     end);
  end if;
  return new;
end;
$function$;

alter function public.order_items_set_station() owner to postgres;

comment on function public.order_items_set_station() is
  'BEFORE INSERT on order_items (order_items_default_station): a line with no station takes its dish''s; every entry of a combo line''s combo_contents takes its dish''s current station (an entry whose dish is not on the order''s branch keeps its own).';

revoke all on function public.order_items_set_station() from public, anon, authenticated;

create or replace function private.tg_orders_reopened_station_keys()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- The order is back on the board (the kitchen's Undo of a bump, a correction).
  -- delete_kitchen_station left it alone while it was closed, so a line may still hold a key the
  -- branch no longer has: it takes its dish's station now, or none. A key the branch still has
  -- stays, even where the dish has moved on since: the line was made there.
  update public.order_items oi
     set station = (select mi.station
                      from public.menu_items mi
                     where mi.id = oi.menu_item_id
                       and mi.branch_id = new.branch_id)
   where oi.order_id = new.id
     and nullif(btrim(oi.station), '') is not null
     and not exists (select 1
                       from public.kitchen_stations ks
                      where ks.branch_id = new.branch_id
                        and ks.key = oi.station);

  -- Likewise each combo entry naming such a key.
  update public.order_items oi
     set combo_contents = (
           select jsonb_agg(
                    case
                      when jsonb_typeof(a.e) = 'object'
                       and nullif(btrim(a.e ->> 'station'), '') is not null
                       and not exists (select 1
                                         from public.kitchen_stations ks
                                        where ks.branch_id = new.branch_id
                                          and ks.key = a.e ->> 'station')
                      then a.e || jsonb_build_object('station', (
                             select mi.station
                               from public.menu_items mi
                              where mi.branch_id = new.branch_id
                                and mi.id = case
                                              when coalesce(a.e ->> 'menu_item_id', a.e ->> 'id')
                                                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                              then coalesce(a.e ->> 'menu_item_id', a.e ->> 'id')::uuid
                                            end))
                      else a.e
                    end
                    order by a.i)
             from jsonb_array_elements(oi.combo_contents) with ordinality as a(e, i))
   where oi.order_id = new.id
     and jsonb_typeof(oi.combo_contents) = 'array'
     and exists (
           select 1
             from jsonb_array_elements(oi.combo_contents) as c(e)
            where jsonb_typeof(c.e) = 'object'
              and nullif(btrim(c.e ->> 'station'), '') is not null
              and not exists (select 1
                                from public.kitchen_stations ks
                               where ks.branch_id = new.branch_id
                                 and ks.key = c.e ->> 'station'));

  return null;
end;
$function$;

alter function private.tg_orders_reopened_station_keys() owner to postgres;

comment on function private.tg_orders_reopened_station_keys() is
  'AFTER UPDATE OF status on orders, when an order comes back to pending, confirmed, preparing or ready: its lines and combo entries whose station key the branch no longer has take their dish''s current station, or none.';

revoke all on function private.tg_orders_reopened_station_keys() from public, anon, authenticated;

create trigger orders_reopened_station_keys
  after update of status on public.orders
  for each row
  when (old.status not in ('pending', 'confirmed', 'preparing', 'ready')
        and new.status in ('pending', 'confirmed', 'preparing', 'ready'))
  execute function private.tg_orders_reopened_station_keys();

commit;
