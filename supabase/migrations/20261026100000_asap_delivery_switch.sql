-- "Accept ASAP delivery orders": one switch per branch (owner request 2026-10-26,
-- docs/ASAP-AND-SCHEDULING-2026-10-25.md §1).
--
-- branches.settings.asap_delivery_enabled decides whether the storefront offers an ASAP delivery.
-- It is ON ONLY WHEN IT IS EXACTLY true: a missing key is off. That is read in code, not seeded
-- here, because the first branch of every new restaurant is inserted with the column-default
-- settings and never sees private.default_branch_settings. Existing branches are NOT backfilled:
-- the owner asked that a branch which has not ticked the box shows no ASAP, so ASAP leaves every
-- storefront until it is ticked in Branch settings (booked delivery is unaffected). The readers
-- are asapDeliveryEnabled() in packages/shared/src/utils/asap-delivery.ts (the storefront
-- resolver, the checkout, the admin card) and its pinned copy in
-- supabase/functions/place-order/asap-delivery.ts (v11.9 refuses a web ASAP delivery with 409
-- delivery_must_be_scheduled when it is off; counter and POS are exempt). storefront_status is not
-- changed: the storefront reads branches.settings fresh on every request already.
--
-- The three functions re-created below were copied from their live definitions
-- (pg_get_functiondef on 2026-10-26, which matched 20261025100000_scheduling_release,
-- 20260918190000_branch_setup and 20261024200000_kitchen_stations) with the same arguments, owner,
-- grants, SECURITY DEFINER and search_path; only the lines named here changed.
--
-- 1. patch_branch_settings TAKES ONLY A BOOLEAN for asap_delivery_enabled: a JSON true or false,
--    or a JSON null, which removes the key (off). Anything else ("true", 1, an object) is refused
--    with 22023 'invalid_setting_value' and a hint naming the rule, and nothing is written. A
--    string "true" would read as on to SQL's ->> and off to `=== true`; refusing it keeps every
--    reader agreeing. The key needs branch.settings like every non-kitchen key (it is not in
--    v_ops_keys), and guard_branch_privileged_columns already freezes it for anyone else.
--
-- 2. private.default_branch_settings SEEDS false for a branch made with create_branch, so the
--    setting is written out next to scheduling_enabled. Clarity only: missing reads as off anyway.
--
-- 3. copy_branch_setup COPIES IT with the other settings the Branch settings cards edit. A source
--    that never ticked the box (no key, or a value other than true) is copied as an explicit
--    false: merged as it stands, the target would have kept its own true and taken ASAP orders the
--    source does not.
--
-- No backfill, no storefront_status change. Rolled-back checks: supabase/tests/asap_delivery_switch.sql.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. public.patch_branch_settings (live body; the asap_delivery_enabled check added)
-- ---------------------------------------------------------------------------------------------

create or replace function public.patch_branch_settings(p_branch_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  -- The kitchen's operations keys. Keep in step with v_ops_keys in
  -- private.guard_branch_privileged_columns().
  v_ops_keys constant text[] := array['orders_paused', 'busy_extra_prep_min'];
  -- What a caller without branch.settings is answered with: the ops keys plus the two the board
  -- reads for its scheduled-ticket clocks. Keep in step with OPS_SETTING_KEYS (kitchen-model.ts).
  v_board_keys constant text[] := array['orders_paused', 'busy_extra_prep_min', 'prep_time_min', 'schedule_lead_time_min'];
  v_can_settings boolean;
  v_can_ops      boolean;
  v_key          text;
  v_value        jsonb;
  v_minutes      numeric;
  v_set          jsonb  := '{}'::jsonb;
  v_remove       text[] := '{}'::text[];
  v_new          jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'invalid_patch'
      using errcode = '22023', hint = 'The patch must be a JSON object of settings keys.';
  end if;

  v_can_settings := private.staff_has_capability(p_branch_id, 'branch.settings');
  v_can_ops := v_can_settings or private.staff_has_capability(p_branch_id, 'kitchen.access');

  -- Every key needs at least one of the two, and so does the empty patch, which answers with the
  -- settings: without this check it read the settings of any branch, an inactive one included.
  if not v_can_ops then
    raise exception 'not_authorized'
      using errcode = '42501',
            hint = 'Branch settings need kitchen access or the branch settings permission at this branch.';
  end if;

  for v_key, v_value in select e.key, e.value from jsonb_each(p_patch) e loop
    if v_key = any (v_ops_keys) then
      if v_key = 'orders_paused' and jsonb_typeof(v_value) not in ('boolean', 'null') then
        raise exception 'invalid_setting_value'
          using errcode = '22023', hint = 'orders_paused must be true or false.';
      end if;

      if v_key = 'busy_extra_prep_min' and jsonb_typeof(v_value) <> 'null' then
        if jsonb_typeof(v_value) <> 'number' then
          raise exception 'invalid_setting_value'
            using errcode = '22023', hint = 'busy_extra_prep_min must be a whole number of minutes.';
        end if;
        v_minutes := v_value::numeric;
        if v_minutes < 0 or v_minutes > 240 or v_minutes <> trunc(v_minutes) then
          raise exception 'invalid_setting_value'
            using errcode = '22023', hint = 'busy_extra_prep_min must be a whole number from 0 to 240.';
        end if;
      end if;
    elsif not v_can_settings then
      raise exception 'not_authorized'
        using errcode = '42501',
              hint = 'Changing branch settings needs the branch settings permission at this branch.';
    end if;

    -- "Accept ASAP delivery orders": a JSON boolean, or a null that removes the key (off). The
    -- storefront, the admin card and place-order read it as on only when it is exactly true, and
    -- SQL's ->> would read a string "true" as on: refusing anything else keeps them agreeing.
    if v_key = 'asap_delivery_enabled' and jsonb_typeof(v_value) not in ('boolean', 'null') then
      raise exception 'invalid_setting_value'
        using errcode = '22023', hint = 'asap_delivery_enabled must be true or false.';
    end if;

    -- The kitchen lead and the prep time: whole minutes from 0 to a week, the only values
    -- private.branch_kitchen_lead_min (the release job), place-order's hold and the screens take.
    -- A value outside that was read differently by each of them (7.5 stopped the release job for
    -- every branch; place-order read "abc" as NaN and held nothing). A null still removes the key.
    if v_key in ('schedule_lead_time_min', 'prep_time_min') and jsonb_typeof(v_value) <> 'null' then
      if jsonb_typeof(v_value) = 'number' then
        v_minutes := v_value::numeric;
      else
        v_minutes := -1;  -- not a number: refused below like any other bad value
      end if;
      if v_minutes < 0 or v_minutes > 10080 or v_minutes <> trunc(v_minutes) then
        raise exception using
          message = case when v_key = 'prep_time_min' then 'invalid_prep_time' else 'invalid_lead_time' end,
          errcode = 'P0001',
          hint = v_key || ' must be a whole number of minutes from 0 to 10080.';
      end if;
    end if;

    if jsonb_typeof(v_value) = 'null' then
      v_remove := v_remove || v_key;
    else
      v_set := v_set || jsonb_build_object(v_key, v_value);
    end if;
  end loop;

  -- Nothing to change: answer with the current settings instead of writing the row (which would
  -- bump updated_at and the storefront version for nothing).
  if v_set = '{}'::jsonb and cardinality(v_remove) = 0 then
    select coalesce(b.settings, '{}'::jsonb) into v_new from public.branches b where b.id = p_branch_id;
    if not found then
      raise exception 'branch_not_found' using errcode = 'P0002';
    end if;
  else
    -- One statement: under a concurrent write the row is re-read after the lock is taken, so the
    -- merge always lands on the latest settings, never on a snapshot.
    update public.branches b
       set settings = (case when jsonb_typeof(b.settings) = 'object' then b.settings else '{}'::jsonb end
                       || v_set) - v_remove
     where b.id = p_branch_id
    returning b.settings into v_new;

    if not found then
      raise exception 'branch_not_found' using errcode = 'P0002';
    end if;
  end if;

  if v_can_settings then
    return v_new;
  end if;
  return coalesce(
    (select jsonb_object_agg(e.key, e.value)
       from jsonb_each(case when jsonb_typeof(v_new) = 'object' then v_new else '{}'::jsonb end) e
      where e.key = any (v_board_keys)),
    '{}'::jsonb);
end;
$function$;

comment on function public.patch_branch_settings(uuid, jsonb) is
  'Merge keys into branches.settings (a JSON null removes the key) and return the new settings. '
  'orders_paused / busy_extra_prep_min need kitchen.access or branch.settings; every other key needs branch.settings. '
  'schedule_lead_time_min and prep_time_min must be whole numbers 0-10080 (invalid_lead_time / invalid_prep_time). '
  'asap_delivery_enabled must be true or false (invalid_setting_value).';

-- As live: authenticated and the service role.
revoke all on function public.patch_branch_settings(uuid, jsonb) from public, anon;
grant execute on function public.patch_branch_settings(uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. private.default_branch_settings (live body; asap_delivery_enabled false added)
-- ---------------------------------------------------------------------------------------------

create or replace function private.default_branch_settings(p_restaurant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    -- Prices are copied between branches as plain numbers, so a second branch in another currency
    -- would silently mislabel them. Follow the restaurant's first branch.
    'currency', coalesce(
      (select nullif(btrim(b.settings ->> 'currency'), '')
         from public.branches b
        where b.restaurant_id = p_restaurant_id
        order by b.is_active desc, b.created_at, b.id
        limit 1),
      'USD'),
    -- Transfer stays off until this branch uploads its own payment QR.
    'payment_methods', jsonb_build_object(
      'asap',      jsonb_build_object('cash', true, 'card', true, 'transfer', false),
      'scheduled', jsonb_build_object('cash', true, 'card', true, 'transfer', false)),
    -- The shape serializeTipConfig() writes: every tip to the worker until the owner decides.
    'tip_config', jsonb_build_object(
      'delivery',    jsonb_build_object('distribution', jsonb_build_object('driver', 100, 'house', 0)),
      'pickup',      jsonb_build_object('distribution', jsonb_build_object('staff', 100, 'house', 0)),
      'dine_in',     jsonb_build_object('distribution', jsonb_build_object('staff', 100, 'house', 0)),
      'qr_ordering', jsonb_build_object('distribution', jsonb_build_object('staff', 100, 'house', 0))),
    'dine_in', jsonb_build_object('session_mode', 'auto', 'ttl_min', 240, 'require_join_code', false),
    'prep_time_min', 15,
    'service_fee_percent', 5,
    'delivery_radius_km', 8,
    -- storefront_status's defaults, written out; booking windows fail closed, so they start off.
    'scheduling_enabled', true,
    -- "Accept ASAP delivery orders" starts unticked (the code reads a missing key the same way).
    'asap_delivery_enabled', false,
    'schedule_hours_enabled', false,
    'schedule_min_lead_min', 15,
    'schedule_max_days', 14,
    'schedule_slot_minutes', 15,
    'schedule_lead_time_min', 15,
    'orders_paused', false,
    'busy_extra_prep_min', 0,
    -- The column default's rider dispatch tuning, unchanged.
    'driver_max_attempts', 3,
    'driver_search_radius_km', 5,
    'driver_search_max_radius_km', 15,
    'driver_batch_dispatch_enabled', false,
    'driver_dispatch_timeout_seconds', 45,
    'driver_expand_radius_on_failure', true
  );
$function$;

revoke all on function private.default_branch_settings(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. public.copy_branch_setup (live body; asap_delivery_enabled copied, a missing one as false)
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
    'schedule_slot_minutes', 'schedule_lead_time_min', 'asap_delivery_enabled'
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

    -- "Accept ASAP delivery orders" is off unless it is exactly true, so a source that never
    -- ticked it is copied as an explicit false: merged as it stands, the target kept its own true.
    v_settings := v_settings || jsonb_build_object('asap_delivery_enabled',
      coalesce((v_source.settings -> 'asap_delivery_enabled') = 'true'::jsonb, false));

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

commit;
