-- Branch setup: a new branch starts complete and separate, copying never carries another branch's
-- bank account or stock, and staff can be suspended or removed per branch.
--
-- The owner's rule is that every branch of a restaurant is its own shop: its own menu, stock,
-- settings, payment QR, staff and reports. Creating "Food Thai Thai" next to "Hamburger" showed
-- how far create_branch and copy_branch_setup were from that:
--
-- 1. private.default_branch_settings(p_restaurant_id) -> jsonb (new).
--    create_branch inserted the column default, a thin blob with currency always USD, no payment
--    matrix, no tip split, no dine-in or scheduling keys. Every reader has a fallback, so nothing
--    broke outright, but the Branch settings screens showed guesses and a Thai restaurant's second
--    branch started in dollars. A new branch now gets explicit values: cash and card on, transfer
--    OFF (there is no QR yet, and place-order refuses transfer without one), 100% of tips to the
--    worker, dine-in auto sessions, prep time 15, scheduling on with the same limits the storefront
--    already assumes, booking windows OFF (they fail closed: armed with no windows is no bookings),
--    not paused, and the currency of the restaurant's oldest branch.
--
-- 2. public.create_branch(...) gains p_sales_tax_rate numeric DEFAULT NULL (signature change: the
--    old eight-argument function is dropped and the new one re-granted). Callers that do not send
--    it keep working.
--      * Tax: a new branch started at 0% and "copy settings" never copied the column, so the first
--        orders went out untaxed. NULL now means "the rate of the restaurant's oldest active branch".
--      * The time zone is checked by private.is_valid_timezone (section 6): a name Postgres knows
--        (pg_timezone_names) that the browser's Intl knows too. An unknown zone was stored as typed
--        and later broke is_branch_open()'s `at time zone`; a posix/ or right/ name passed
--        Postgres but made every Intl.DateTimeFormat on the storefront and back office throw.
--      * The slug is checked against ^[a-z0-9]+(-[a-z0-9]+)*$ (2 to 64 characters) and a taken slug
--        is reported as slug_taken (SQLSTATE 23505, as before) instead of a raw constraint name.
--      * A creator who is not an owner (an admin: brand.edit is owner and admin only) and who has no
--        restaurant-wide row got a branch they could not open, and the copy step then failed with
--        not_authorized. They now get an active staff row at the new branch with the role that let
--        them create it. The escalation guard on staff_members refuses every self-insert by a
--        non-owner, which is right for the table in general; this one trusted insert is made with
--        the request's JWT claims blanked for that single statement (restored straight after), the
--        same "no JWT = trusted code" path migrations and the service role use. The row carries
--        the creator's email address, as every row with an account now does (section 5).
--      * create_branch no longer writes subscriptions.branch_count itself: greatest() made it a
--        high-water mark that never came down. The branches trigger in section 8 keeps it.
--      * An audit_logs row 'branch_created' records who created the branch.
--
-- 3. public.copy_branch_setup(...) gains p_copy_look and p_copy_loyalty, both boolean DEFAULT false
--    (signature change as above; the five- and six-argument versions are dropped).
--      * qr_transfer is never copied. It is a bank account: a copied QR sent the new branch's
--        customers' transfers to the other branch's account. When the target has no QR of its own,
--        transfer is switched off in the copied payment matrix and the result says
--        transfer_needs_qr = true when the source had it on.
--      * Copied dishes start with stock tracking off (the count is the source kitchen's live state,
--        and a tracked item with no count showed as sold out). stock_tracking_off reports how many.
--      * Settings now also copy sales_tax_rate, prep_time_min, dine_in, the scheduling keys and the
--        booking windows (branch_schedule_hours), which schedule_hours_enabled depends on. The dead
--        keys delivery_min_fee, delivery_max_fee and batch_max_dropoff_mi (no reader anywhere) are
--        no longer copied.
--      * The menu copy includes combos that are not archived, with their dishes remapped to the
--        copies. The archive filter reads the row as JSON so it holds whether or not the combos
--        migration's archived_at column is present.
--      * p_copy_look copies theme_override (colours) and settings.storefront_override (layout and
--        hero), never the logo or app icons, which each branch uploads itself.
--      * p_copy_loyalty copies the loyalty programme (points rate, tier ladder, labels, perks,
--        birthday points: the branch_loyalty_settings row, which clients cannot write) and the
--        rewards catalogue, each reward re-created at the new branch. A free-item reward points at
--        the copied dish, so it needs the menu copied in the same call; without it such a reward
--        is skipped and counted in rewards_skipped (the same-branch guard would refuse it).
--        Members, points and history are never copied: they belong to the branch they were
--        earned at. Gated by loyalty.manage at both branches; a target that already has rewards
--        is refused (target_rewards_not_empty) rather than getting duplicates.
--
-- 4. public.set_staff_status(p_staff_id, p_status) -> jsonb (new). There was no way to suspend or
--    remove a team member from the back office (staff_members has no write policy; writes go through
--    trusted functions). Gated by staff.manage where the row works: its branch, or restaurant-wide
--    authority (owner, or a restaurant-wide staff.manage row) for an owner row or a row with no
--    branch. Only an owner may change an owner or admin row, nobody changes their own row, the last
--    active owner cannot be suspended or removed, pending invitations are cancelled with
--    cancel_staff_invite instead, and a removed row is final (invite the person again).
--
-- 5. Every staff row with an account carries that account's email address (invited_email).
--    invite-staff finds a person by address, and "invite them again" revives their removed row
--    for the same branch. Four live rows had an account and no address (the owners' own rows and
--    the seed cashier and kitchen rows), so for them the lookup found nothing, a second pending
--    row was made, and accepting it failed with already_staff_here: uniq_staff_user_branch was
--    still held by the removed row. Removing such a person locked them out of that branch for
--    good, and they showed as "Unnamed" on the Staff page. The address is backfilled from
--    auth.users, and private.tg_staff_members_fill_invited_email fills it on every new row with
--    an account (onboarding's owner row, create_branch's creator row, anything later).
--
-- 6. private.is_valid_timezone(name) and a trigger on branches: every write of branches.timezone
--    (create_branch, the Location card's direct update, onboarding) must name a zone both
--    Postgres and the browser understand. pg_timezone_names also lists posix/*, right/* and
--    Factory, which Intl.DateTimeFormat refuses with a RangeError; checked against Node's full
--    Intl list, those are the only names it lacks.
--
-- 7. public.cancel_staff_invite(p_staff_id) is gated by the invitation's branch.
--    It only asked whether the caller was an active owner or admin anywhere in the restaurant,
--    so Hamburger's admin could withdraw Food Thai Thai's invitations and the owner's
--    restaurant-wide ones. It now follows set_staff_status: staff.manage at the row's branch, or
--    restaurant-wide authority for a row with no branch. An admin invitation is still the
--    owner's alone. The error codes are unchanged, so the Staff page reads them as before.
--
-- 8. subscriptions.branch_count follows the active branches.
--    create_branch was the only place that counted branches, so hiding or reopening a branch in
--    Branch settings (or a platform Suspend and Restore) left the count stale: Coastal Grill
--    read 3 with 2 branches. An AFTER trigger on branches now recounts on insert, on delete and
--    when is_active or restaurant_id changes. The column's CHECK (branch_count > 0) keeps a
--    subscription at 1 or more, so a restaurant with every branch hidden reads 1, not 0 (0 would
--    make the hide itself fail). The column is a reporting mirror only: billing_compute takes
--    seats from subscription_items. private.billing_apply_selection still writes the chosen seat
--    count here at a plan change; the next branch change recounts. The live rows are corrected
--    once, below.
--
-- Authorization throughout is private.staff_has_capability / private.user_owns_restaurant, which
-- cover an owner row pinned to another branch, restaurant-wide rows, restaurants.owner_user_id and
-- platform admins.

-- 1. default settings for a new branch ---------------------------------------------------------

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

-- A time zone both Postgres (`at time zone`) and the browser (Intl.DateTimeFormat) understand.
-- Used by create_branch and by the branches trigger in section 6, so it is defined first.
create or replace function private.is_valid_timezone(p_name text)
returns boolean
language sql
stable
set search_path to 'pg_catalog', 'pg_temp'
as $function$
  select coalesce(
    p_name !~ '^(posix|right)/'
      and p_name not in ('Factory', 'posixrules', 'localtime')
      and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_name),
    false);
$function$;

revoke all on function private.is_valid_timezone(text) from public, anon, authenticated;

-- 2. create_branch -----------------------------------------------------------------------------

drop function if exists public.create_branch(uuid, text, text, text, text, uuid, double precision, double precision);

create or replace function public.create_branch(
  p_restaurant_id uuid,
  p_name text,
  p_slug text,
  p_address text default null::text,
  p_timezone text default 'America/New_York'::text,
  p_brand_id uuid default null::uuid,
  p_lat double precision default null::double precision,
  p_lng double precision default null::double precision,
  p_sales_tax_rate numeric default null::numeric
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_branch_id uuid;
  v_can boolean;
  v_seats integer := 0;
  v_used integer := 0;
  v_geo geography(Point, 4326);
  v_name text := btrim(coalesce(p_name, ''));
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_timezone text := btrim(coalesce(p_timezone, ''));
  v_tax numeric;
  v_role public.staff_role;
  v_claims text;
  v_sub text;
  v_staff_id uuid;
begin
  if v_uid is null then raise exception 'auth_required'; end if;
  if v_name = '' or v_slug = '' then
    raise exception 'name_and_slug_required';
  end if;

  -- A new branch spends a paid seat, so it follows brand.edit (owner and admin in the
  -- capability matrix). Managers used to pass here by typing the URL.
  select exists (
    select 1 from public.restaurants r
     where r.id = p_restaurant_id and r.owner_user_id = v_uid
    union
    select 1 from public.branches b
     where b.restaurant_id = p_restaurant_id
       and private.staff_has_capability(b.id, 'brand.edit')
  ) into v_can;
  if not v_can then raise exception 'not_authorized'; end if;

  -- The same rule as branches_slug_check, said before the insert so the answer names the field.
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) < 2 or length(v_slug) > 64 then
    raise exception 'invalid_slug'
      using errcode = '22023',
            hint = 'Use 2 to 64 lowercase letters, digits and single hyphens, for example downtown-2.';
  end if;

  -- Opening hours, happy hour, scheduling and report days are all read in this zone, by Postgres
  -- and by the browser, so it must be a name both know.
  if not private.is_valid_timezone(v_timezone) then
    raise exception 'invalid_timezone'
      using errcode = '22023', hint = 'Pick a time zone from the list, for example Asia/Bangkok.';
  end if;

  if p_brand_id is not null and not exists (
     select 1 from public.brands b where b.id = p_brand_id and b.restaurant_id = p_restaurant_id
  ) then
    raise exception 'invalid_brand';
  end if;

  if (p_lat is null) <> (p_lng is null) then
    raise exception 'invalid_location'
      using hint = 'Latitude and longitude must be supplied together.';
  end if;
  if p_lat is not null then
    if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180
       or (abs(p_lat) < 0.0001 and abs(p_lng) < 0.0001) then
      raise exception 'invalid_location' using hint = 'Drop the pin on the store.';
    end if;
    -- longitude first
    v_geo := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lng, p_lat), 4326)::geography;
  end if;

  -- A new branch used to start at 0% and the first orders went out untaxed. Unless the caller
  -- says otherwise it charges what the restaurant's first branch charges.
  if p_sales_tax_rate is null then
    select b.sales_tax_rate into v_tax
      from public.branches b
     where b.restaurant_id = p_restaurant_id
     order by b.is_active desc, b.created_at, b.id
     limit 1;
    v_tax := coalesce(v_tax, 0);
  else
    v_tax := p_sales_tax_rate;
  end if;
  if v_tax < 0 or v_tax >= 0.5 then
    raise exception 'invalid_tax_rate'
      using errcode = '22023', hint = 'A sales tax rate is a fraction from 0 up to 0.5, for example 0.07 for 7%.';
  end if;

  if not private.restaurant_entitled(p_restaurant_id) then
    raise exception 'billing_inactive:branches' using errcode = 'P0001';
  end if;

  select coalesce(be.branch_seats, 0) into v_seats
    from public.billing_entitlements be where be.restaurant_id = p_restaurant_id;
  select count(*) into v_used from public.branches where restaurant_id = p_restaurant_id and is_active;

  if v_used >= coalesce(v_seats, 0) then
    raise exception 'plan_limit_exceeded:branches:%/%', v_used, coalesce(v_seats, 0)
      using errcode = 'P0001';
  end if;

  begin
    insert into public.branches (
      restaurant_id, slug, name, address, timezone, brand_id, is_active, geo_location, settings, sales_tax_rate
    )
    values (
      p_restaurant_id, v_slug, v_name, nullif(btrim(p_address), ''), v_timezone, p_brand_id, true, v_geo,
      private.default_branch_settings(p_restaurant_id), v_tax
    )
    returning id into v_branch_id;
  exception when unique_violation then
    raise exception 'slug_taken'
      using errcode = '23505', hint = 'Another branch of this restaurant already uses that URL slug.';
  end;

  -- An admin who is pinned to one branch could create a branch and then not open it: every
  -- back-office check asks for a staff row at that branch (or restaurant-wide, or owner). Give the
  -- creator a row here with the role that let them create it. Owners, restaurant-wide staff and
  -- platform admins already reach the new branch.
  if not private.user_owns_restaurant(p_restaurant_id)
     and not exists (
       select 1 from public.staff_members sm
        where sm.user_id = v_uid
          and sm.restaurant_id = p_restaurant_id
          and sm.status = 'active'
          and sm.branch_id is null
     ) then
    select sm.role into v_role
      from public.staff_members sm
      join public.role_capabilities rc on rc.role = sm.role::text and rc.capability = 'brand.edit'
     where sm.user_id = v_uid
       and sm.restaurant_id = p_restaurant_id
       and sm.status = 'active'
     order by sm.created_at, sm.id
     limit 1;

    if v_role is not null then
      -- private.guard_staff_role_escalation refuses any self-insert by a non-owner, and an admin
      -- row by a non-owner; both are right for writes a caller chooses. This row is decided here,
      -- so it is written as trusted code: without the request's JWT for this one statement.
      v_claims := current_setting('request.jwt.claims', true);
      v_sub := current_setting('request.jwt.claim.sub', true);
      perform set_config('request.jwt.claims', '', true);
      perform set_config('request.jwt.claim.sub', '', true);

      -- With the address, like every row with an account: the Staff page names the person by it,
      -- and invite-staff finds this row by it if they are ever removed and invited back.
      insert into public.staff_members (user_id, restaurant_id, branch_id, role, status, accepted_at, invited_email)
      values (v_uid, p_restaurant_id, v_branch_id, v_role, 'active', now(),
              (select lower(u.email) from auth.users u where u.id = v_uid))
      returning id into v_staff_id;

      perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
      perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
    end if;
  end if;

  -- subscriptions.branch_count is recounted by the branches trigger (section 8).

  insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (p_restaurant_id, v_branch_id, v_uid, 'staff', 'branch_created', 'branch', v_branch_id,
          jsonb_build_object('name', v_name, 'slug', v_slug, 'timezone', v_timezone,
                             'sales_tax_rate', v_tax, 'creator_staff_id', v_staff_id));

  return jsonb_build_object(
    'branch_id', v_branch_id,
    'slug', v_slug,
    'timezone', v_timezone,
    'sales_tax_rate', v_tax,
    'creator_staff_id', v_staff_id
  );
end
$function$;

revoke all on function public.create_branch(uuid, text, text, text, text, uuid, double precision, double precision, numeric)
  from public, anon;
grant execute on function public.create_branch(uuid, text, text, text, text, uuid, double precision, double precision, numeric)
  to authenticated, service_role;

-- 3. copy_branch_setup -------------------------------------------------------------------------

drop function if exists public.copy_branch_setup(uuid, uuid, boolean, boolean, boolean);
drop function if exists public.copy_branch_setup(uuid, uuid, boolean, boolean, boolean, boolean);

create or replace function public.copy_branch_setup(
  p_source_branch_id uuid,
  p_target_branch_id uuid,
  p_copy_menu boolean,
  p_copy_hours boolean,
  p_copy_settings boolean,
  p_copy_look boolean default false,
  p_copy_loyalty boolean default false
)
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
    return jsonb_build_object('categories_copied', 0, 'items_copied', 0, 'modifier_groups_copied', 0,
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

-- 4. set_staff_status --------------------------------------------------------------------------

create or replace function public.set_staff_status(p_staff_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.staff_members%rowtype;
  v_status public.staff_status;
  v_owns boolean;
  v_allowed boolean;
begin
  if v_uid is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;
  -- 'pending' is not a state anyone sets by hand: an invitation is created by invite-staff and
  -- withdrawn with cancel_staff_invite.
  if p_status is null or p_status not in ('active', 'suspended', 'removed') then
    raise exception 'invalid_status' using errcode = '22023', hint = 'Use active, suspended or removed.';
  end if;
  v_status := p_status::public.staff_status;

  select * into v_row from public.staff_members where id = p_staff_id for update;
  if not found then
    raise exception 'staff_not_found' using errcode = 'P0002';
  end if;

  v_owns := private.user_owns_restaurant(v_row.restaurant_id);

  -- staff.manage where the row works. An owner row names the branch the owner signed up at but
  -- reaches every branch, so it counts as restaurant-wide, like a row with no branch.
  if v_row.role = 'owner' or v_row.branch_id is null then
    v_allowed := v_owns or exists (
      select 1
        from public.staff_members sm
        join public.role_capabilities rc on rc.role = sm.role::text and rc.capability = 'staff.manage'
       where sm.restaurant_id = v_row.restaurant_id
         and sm.user_id = v_uid
         and sm.status = 'active'
         and sm.branch_id is null
    );
  else
    v_allowed := private.staff_has_capability(v_row.branch_id, 'staff.manage');
  end if;
  if not v_allowed then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- Only the owner may add an admin (invite-staff), so only the owner may take one away.
  if v_row.role in ('owner', 'admin') and not v_owns then
    raise exception 'not_authorized' using errcode = '42501', hint = 'Only the owner can change an owner or admin.';
  end if;

  if v_row.user_id = v_uid then
    raise exception 'cannot_change_self' using errcode = '42501', hint = 'Ask the owner to change your own access.';
  end if;

  if v_row.status = 'pending' then
    raise exception 'invite_pending' using errcode = 'P0001', hint = 'Cancel the invitation instead.';
  end if;
  if v_row.status = 'removed' then
    raise exception 'staff_removed' using errcode = 'P0001', hint = 'Invite the person again to give them access.';
  end if;

  if v_row.status = v_status then
    return jsonb_build_object('ok', true, 'staff_id', v_row.id, 'status', v_status, 'changed', false);
  end if;

  -- A restaurant always keeps an owner who can sign in and manage it.
  if v_row.role = 'owner' and v_status <> 'active'
     and not exists (
       select 1 from public.staff_members sm
        where sm.restaurant_id = v_row.restaurant_id
          and sm.role = 'owner'
          and sm.status = 'active'
          and sm.id <> v_row.id
          and sm.user_id is distinct from v_row.user_id
     )
     and not exists (
       select 1 from public.restaurants r
        where r.id = v_row.restaurant_id
          and r.owner_user_id is not null
          and r.owner_user_id is distinct from v_row.user_id
     ) then
    raise exception 'last_owner' using errcode = 'P0001', hint = 'A restaurant must keep at least one owner.';
  end if;

  update public.staff_members set status = v_status where id = v_row.id;

  insert into public.audit_logs (restaurant_id, branch_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_row.restaurant_id, v_row.branch_id, v_uid, 'staff', 'staff_status_changed', 'staff_member', v_row.id,
          jsonb_build_object('role', v_row.role, 'user_id', v_row.user_id, 'from_status', v_row.status, 'to_status', v_status));

  return jsonb_build_object('ok', true, 'staff_id', v_row.id, 'status', v_status, 'changed', true);
end;
$function$;

revoke all on function public.set_staff_status(uuid, text) from public, anon;
grant execute on function public.set_staff_status(uuid, text) to authenticated, service_role;

-- 5. every staff row with an account carries its email address -------------------------------

-- BEFORE INSERT only. After the backfill below every existing row with an account has an address,
-- and a row only gains an account on accept_staff_invite, which requires one already. Filling on
-- UPDATE as well would change invited_email on an owner or admin row during somebody else's write,
-- which private.guard_staff_role_escalation refuses for non-owners. The trigger name sorts before
-- that guard's, so the guard sees the finished row.
create or replace function private.tg_staff_members_fill_invited_email()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  new.invited_email := (select lower(u.email) from auth.users u where u.id = new.user_id);
  return new;
end;
$function$;

revoke all on function private.tg_staff_members_fill_invited_email() from public, anon, authenticated;

drop trigger if exists staff_members_fill_invited_email on public.staff_members;
create trigger staff_members_fill_invited_email
  before insert on public.staff_members
  for each row
  when (new.user_id is not null and new.invited_email is null)
  execute function private.tg_staff_members_fill_invited_email();

-- Data correction: the rows that already have an account but no address (live on 2026-09-18: the
-- two Coastal Grill owner rows and the seed cashier and kitchen rows at Hamburger). Only the
-- address is written; role, status and branch are untouched. Lower-cased, the spelling
-- invite-staff searches with and accept_staff_invite compares with.
update public.staff_members sm
   set invited_email = lower(u.email)
  from auth.users u
 where u.id = sm.user_id
   and sm.invited_email is null
   and u.email is not null;

-- 6. branches.timezone is always a zone Postgres and the browser both know ---------------------

create or replace function private.tg_branches_timezone_valid()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Only a new or changed zone is checked: saving a branch that happens to resend its zone
  -- costs no lookup and can never be refused for it.
  if tg_op = 'UPDATE' and new.timezone is not distinct from old.timezone then
    return new;
  end if;
  if not private.is_valid_timezone(new.timezone) then
    raise exception 'invalid_timezone'
      using errcode = '22023', hint = 'Pick a time zone from the list, for example Asia/Bangkok.';
  end if;
  return new;
end;
$function$;

revoke all on function private.tg_branches_timezone_valid() from public, anon, authenticated;

drop trigger if exists branches_timezone_valid on public.branches;
create trigger branches_timezone_valid
  before insert or update of timezone on public.branches
  for each row
  execute function private.tg_branches_timezone_valid();

-- 7. cancel_staff_invite: only the team the invitation would join may withdraw it ---------------

create or replace function public.cancel_staff_invite(p_staff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_row     public.staff_members%rowtype;
  v_owns    boolean;
  v_allowed boolean;
begin
  if v_uid is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;

  select * into v_row
    from public.staff_members
   where id = p_staff_id
     for update;
  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;

  v_owns := private.user_owns_restaurant(v_row.restaurant_id);

  -- The same rule as set_staff_status: staff.manage at the branch the invitation is for. A row
  -- with no branch (or an owner row) works at every branch, so it needs restaurant-wide
  -- authority. Being an admin of some other branch is not enough.
  if v_row.role = 'owner' or v_row.branch_id is null then
    v_allowed := v_owns or exists (
      select 1
        from public.staff_members sm
        join public.role_capabilities rc on rc.role = sm.role::text and rc.capability = 'staff.manage'
       where sm.restaurant_id = v_row.restaurant_id
         and sm.user_id = v_uid
         and sm.status = 'active'
         and sm.branch_id is null
    );
  else
    v_allowed := private.staff_has_capability(v_row.branch_id, 'staff.manage');
  end if;
  if not v_allowed then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- Only the owner may invite an admin (invite-staff), so only the owner may withdraw one.
  if v_row.role in ('owner', 'admin') and not v_owns then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_row.status <> 'pending' or v_row.user_id is not null then
    raise exception 'invite_not_pending' using errcode = 'P0001';
  end if;

  delete from public.staff_members where id = p_staff_id;

  return jsonb_build_object('staff_id', p_staff_id, 'cancelled', true);
end;
$function$;

revoke all on function public.cancel_staff_invite(uuid) from public, anon;
grant execute on function public.cancel_staff_invite(uuid) to authenticated, service_role;

-- 8. subscriptions.branch_count follows the active branches ------------------------------------

create or replace function private.tg_branches_sync_subscription_branch_count()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_old_restaurant_id uuid;
  v_new_restaurant_id uuid;
  v_restaurant_id uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old_restaurant_id := old.restaurant_id; end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new_restaurant_id := new.restaurant_id; end if;

  -- Both restaurants when a branch moves to another one.
  for v_restaurant_id in
    select distinct x
      from unnest(array[v_old_restaurant_id, v_new_restaurant_id]) x
     where x is not null
  loop
    -- greatest(.., 1): subscriptions_branch_count_check requires branch_count > 0, and a
    -- restaurant may hide every branch (or be suspended by the platform).
    update public.subscriptions s
       set branch_count = c.n
      from (select greatest(count(*), 1)::int as n
              from public.branches b
             where b.restaurant_id = v_restaurant_id
               and b.is_active) c
     where s.restaurant_id = v_restaurant_id
       and s.branch_count is distinct from c.n;
  end loop;
  return null;
end;
$function$;

revoke all on function private.tg_branches_sync_subscription_branch_count() from public, anon, authenticated;

drop trigger if exists branches_sync_subscription_branch_count on public.branches;
create trigger branches_sync_subscription_branch_count
  after insert or delete on public.branches
  for each row
  execute function private.tg_branches_sync_subscription_branch_count();

drop trigger if exists branches_sync_subscription_branch_count_upd on public.branches;
create trigger branches_sync_subscription_branch_count_upd
  after update of is_active, restaurant_id on public.branches
  for each row
  when (old.is_active is distinct from new.is_active or old.restaurant_id is distinct from new.restaurant_id)
  execute function private.tg_branches_sync_subscription_branch_count();

-- Data correction (live on 2026-09-19: Coastal Grill read 3 with 2 active branches). Only this
-- mirror column changes, and only where it differs.
update public.subscriptions s
   set branch_count = c.n
  from (select r.id as restaurant_id,
               greatest((select count(*) from public.branches b where b.restaurant_id = r.id and b.is_active), 1)::int as n
          from public.restaurants r) c
 where c.restaurant_id = s.restaurant_id
   and s.branch_count is distinct from c.n;
