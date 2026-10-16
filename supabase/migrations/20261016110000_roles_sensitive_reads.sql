-- Roles, sensitive reads (owner role spec, decisions D7 and D8 of the 2026-10-16 roles audit;
-- plan items DB-5, DB-8 and DR-2). Every policy and function below that has no repo file was
-- re-created from its live definition (pg_policies / pg_get_functiondef on 2026-10-16); where a
-- body changed, only the lines named here changed.
--
-- 1. THE MANAGER NO LONGER ADMINISTERS RIDERS (D7). (manager, drivers.manage) is deleted. The spec
--    gives the manager Delivery and Assign driver (delivery.manage, kept), not rider approval, KYC
--    or Driver payouts (riders' bank details). driver_approvals writes followed user_manages_branch
--    (owner, admin, manager hard-coded), so the manager could still approve a rider through the
--    Data API after losing the screen; they now need drivers.manage too.
--
-- 2. RIDERS' PERSONAL DATA IS FOR RIDER ADMINS. drivers_staff_read let every active member of a
--    branch the rider had applied to (cashier, kitchen, server, a 'driver' staff row) read the whole
--    drivers row: phone, email, live location, national_id_encrypted, bank_account_encrypted,
--    payout_qr_path. The whole row now needs drivers.manage at such a branch (owner, admin). RLS
--    cannot hide columns per role, so the boards that only show a name get a narrow reader instead:
--    public.branch_rider_names(branch, ids) -> (driver_id, full_name), for kitchen.access,
--    delivery.manage, counter.access or drivers.manage at that branch. A rider's phone and vehicle
--    stay available to Live deliveries through list_branch_riders (delivery.manage), unchanged.
--    A PostgREST embed or select of drivers (driver:drivers(...)) now comes back null or empty for
--    anyone without drivers.manage: no error, just no name, until that screen reads one of these two.
--
-- 3. RIDERS' WITHDRAWALS (bank name, account number, account name) need drivers.manage at the
--    withdrawal's branch. They were readable by every member. So do their transfer slips in the
--    payout-slips bucket (private.staffs_withdrawal_folder), which any member could read and
--    overwrite, and the riders' applications with their review notes (driver_approvals_staff_read).
--
-- 4. DRIVER SCHEDULES, PER-BRANCH AVAILABILITY AND DELIVERIES: every member reads them as before,
--    and writing needs delivery.manage at the branch. The three policies were FOR ALL on
--    membership, so a cashier or a cook could insert or delete a delivery row, or switch a rider
--    online, through the Data API. No screen writes these tables directly (the rider writes their own
--    rows through the *_driver_self policies; dispatch and staff actions go through SECURITY
--    DEFINER functions), so nothing that works today stops working.
--
-- 5. SUBSCRIPTION AND INVOICE ROWS are the owner's (billing.manage), through
--    private.user_can_manage_billing, the rule get_billing_overview and the plan page already use.
--    Every active staff member of the restaurant could read them. The plan page, the entitlement
--    banners and the storefront gates read through SECURITY DEFINER functions (get_billing_overview,
--    get_entitlements, billing_branch_context) or branches.entitled_through, none of which change.
--
-- 6. AUDIT LOGS AND THE NOTIFICATION OUTBOX. audit_staff_read let any member read every audit row of
--    the branch (refunds, payments, who did what), and through its restaurant_id arm the rows of
--    every other branch of the restaurant. A branch row now needs reports.view at that branch (the
--    Activity page's own gate); a restaurant-level row (no branch) needs the owner or a
--    restaurant-wide admin (user_administers_restaurant). notifications_staff was FOR ALL, so any
--    member could insert outbox rows, which notify-worker then sends as email, SMS or push. Reading
--    needs reports.view (the rows carry customers' emails and order numbers; no screen reads the
--    branch's outbox, and staff still read their own rows through notifications_recipient); every writer is a SECURITY DEFINER function or the service role (live check:
--    no SECURITY INVOKER function in public or private writes these tables), so the write side goes.
--
-- 7. BRANCH IDENTITY IS BRANCH SETTINGS (D8). guard_branch_privileged_columns let anyone
--    user_manages_restaurant() approved (owner, admin, manager) change a branch's name, address, map
--    pin, tax rate, open/closed state, time zone, theme and brand. Those now need branch.settings at
--    that branch (owner, admin), answered as 'branch_settings_required' (42501). The opening hours
--    (open_hours) stay with the branch's owner, admin or manager (user_manages_branch, so a manager
--    of one branch no longer edits another's), and so do branch_hours, branch_closures and
--    happy_hours, whose policies are not touched. The settings JSON keeps its rule (the kitchen's two
--    pause/busy keys, everything else branch.settings, as tg_branches_settings_key_rules already
--    enforced). Owner-only columns (slug, custom domain, restaurant) are unchanged.
--    branches_staff_update let every member UPDATE the row and left the columns to the triggers; it
--    now admits only someone with a column they may write: branch.settings, brand.edit (logos and
--    icons, guard_branch_identity_columns), the branch's manager (hours) or kitchen.access (pause and
--    busy, which the board writes through patch_branch_settings).
--    set_branch_location moves the address and pin, so it asks for branch.settings as well; it said
--    it used "the same rule the branches column guard uses".
--    patch_branch_settings answered every caller with the whole settings object (payment set-up,
--    fees, delivery rules), so each Pause/Busy tap sent it to the kitchen tablet. Without
--    branch.settings it now answers with the board's four keys only (KT-2).
--    private.user_manages_restaurant() ignored the staff row's branch: a manager of one branch counted
--    as managing the whole restaurant. Only an owner row or a restaurant-wide row counts now. Its
--    remaining live caller is restaurants_staff_update's USING, whose WITH CHECK already needs
--    user_administers_restaurant, so nothing loses a write it could make.
--
-- 8. A RIDER'S OLD JOBS STOP SHOWING THE CUSTOMER'S CONTACT (DR-2). get_driver_order returned the
--    customer's phone, address and notes for every delivery the rider ever held, with no time limit.
--    Two hours after a delivery is delivered, failed or cancelled they come back null and
--    'contact_hidden' is true. The rider app only asks for jobs it still holds, and its history reads
--    driver_job_history, which carries no personal data.

-- ---------------------------------------------------------------------------------------------
-- 1. The manager no longer administers riders (D7)
-- ---------------------------------------------------------------------------------------------

delete from public.role_capabilities
 where role = 'manager'
   and capability = 'drivers.manage';

-- Re-created from the live definitions with the same names; user_manages_branch -> drivers.manage.
drop policy if exists driver_approvals_manager_insert on public.driver_approvals;
create policy driver_approvals_manager_insert on public.driver_approvals
  for insert to authenticated
  with check (private.staff_has_capability(branch_id, 'drivers.manage'));

drop policy if exists driver_approvals_manager_update on public.driver_approvals;
create policy driver_approvals_manager_update on public.driver_approvals
  for update to authenticated
  using (private.staff_has_capability(branch_id, 'drivers.manage'))
  with check (private.staff_has_capability(branch_id, 'drivers.manage'));

drop policy if exists driver_approvals_manager_delete on public.driver_approvals;
create policy driver_approvals_manager_delete on public.driver_approvals
  for delete to authenticated
  using (private.staff_has_capability(branch_id, 'drivers.manage'));

-- ---------------------------------------------------------------------------------------------
-- Helper: the caller's branches where they hold one capability
-- ---------------------------------------------------------------------------------------------

-- For policies that test a capability against a column (branch_id in (select ...)): evaluated once
-- per statement, not once per row. user_branch_ids() already covers restaurants.owner_user_id, an
-- owner row pinned to another branch, restaurant-wide rows and platform admins, and
-- staff_has_capability() applies the same scope to the capability.
create or replace function private.staff_branch_ids_with_capability(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select ub.id
    from private.user_branch_ids() as ub(id)
   where private.staff_has_capability(ub.id, p_capability);
$function$;

revoke all on function private.staff_branch_ids_with_capability(text) from public, anon;
grant execute on function private.staff_branch_ids_with_capability(text) to authenticated;

comment on function private.staff_branch_ids_with_capability(text) is
  'The branches where the caller holds p_capability (staff_has_capability over user_branch_ids). For RLS: branch_id in (select ...).';

-- The policies below call these as the signed-in user. user_can_manage_billing was only ever called
-- inside SECURITY DEFINER functions, so authenticated had no EXECUTE on it (live check); without the
-- grant every read of subscriptions would fail with "permission denied for function". It answers
-- only "may I manage this restaurant's billing". user_administers_restaurant already had the grant
-- (restaurants_staff_update calls it); it is restated so the audit policy does not depend on that.
grant execute on function private.user_can_manage_billing(uuid) to authenticated;
grant execute on function private.user_administers_restaurant(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Riders' personal data is for rider admins
-- ---------------------------------------------------------------------------------------------

-- Same name and only caller (drivers_staff_read); it now means "riders I administer": riders who
-- applied to a branch where the caller holds drivers.manage. It was every member of such a branch.
create or replace function private.driver_ids_for_staff()
returns setof uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select distinct da.driver_id
    from public.driver_approvals da
   where da.branch_id in (select private.staff_branch_ids_with_capability('drivers.manage'));
$function$;

comment on function private.driver_ids_for_staff() is
  'Riders the caller administers: a driver_approvals row (any status) at a branch where the caller holds drivers.manage. Used by drivers_staff_read.';

drop policy if exists drivers_staff_read on public.drivers;
create policy drivers_staff_read on public.drivers
  for select to authenticated
  using (id in (select private.driver_ids_for_staff()));

-- The name behind a driver_id, for the screens that show who has a job and nothing else: the kitchen
-- board ("Offered to ..."), Live deliveries, the till and Ratings. Riders approved at the branch, and
-- any rider who was offered or held one of its deliveries (so a past job or rating still has a name
-- after the rider left). p_driver_ids narrows to those ids; null lists them all.
create or replace function public.branch_rider_names(p_branch_id uuid, p_driver_ids uuid[] default null)
returns table (driver_id uuid, full_name text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
#variable_conflict use_column
begin
  if not (private.staff_has_capability(p_branch_id, 'kitchen.access')
          or private.staff_has_capability(p_branch_id, 'delivery.manage')
          or private.staff_has_capability(p_branch_id, 'counter.access')
          or private.staff_has_capability(p_branch_id, 'drivers.manage')) then
    raise exception 'not_authorized'
      using errcode = '42501',
            hint = 'Rider names need kitchen, counter or delivery access at this branch.';
  end if;

  return query
    select d.id, d.full_name
      from public.drivers d
     where (p_driver_ids is null or d.id = any (p_driver_ids))
       and (exists (select 1 from public.driver_approvals da
                     where da.driver_id = d.id and da.branch_id = p_branch_id and da.status = 'approved')
            or exists (select 1 from public.delivery_assignments a
                        where a.driver_id = d.id and a.branch_id = p_branch_id)
            or exists (select 1 from public.deliveries del
                        where del.driver_id = d.id and del.branch_id = p_branch_id))
     order by d.full_name, d.id;
end $function$;

revoke all on function public.branch_rider_names(uuid, uuid[]) from public, anon;
grant execute on function public.branch_rider_names(uuid, uuid[]) to authenticated;

comment on function public.branch_rider_names(uuid, uuid[]) is
  'Rider id and name only, for kitchen.access, delivery.manage, counter.access or drivers.manage at the branch: riders approved there or offered one of its deliveries. The full drivers row needs drivers.manage (drivers_staff_read).';

-- ---------------------------------------------------------------------------------------------
-- 3. Riders' withdrawals
-- ---------------------------------------------------------------------------------------------

drop policy if exists withdrawals_branch_staff_read on public.driver_withdrawals;
create policy withdrawals_branch_staff_read on public.driver_withdrawals
  for select to authenticated
  using (branch_id in (select private.staff_branch_ids_with_capability('drivers.manage')));

-- The transfer slips of those withdrawals (payout-slips bucket, <withdrawal id>/<file>) show the
-- rider's bank and account too, and the storage policies payout_slips_read, _staff_insert and
-- _staff_update all ask this definer function, which let any member read and overwrite them.
-- Rebuilt from the live body; only the branch scope changes. The rider's own read
-- (owns_withdrawal_folder) is untouched.
create or replace function private.staffs_withdrawal_folder(p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.driver_withdrawals w
     where w.id::text = (storage.foldername(p_name))[1]
       and w.branch_id in (select private.staff_branch_ids_with_capability('drivers.manage'))
  );
$function$;

-- Rider applications and their review notes: every reader in the apps (Drivers page, the
-- dashboard's rider buckets and no-riders warning) is already behind drivers.manage, and
-- branch_rider_names covers screens that only need a name. The rider's own read
-- (driver_approvals_driver_self) is untouched.
drop policy if exists driver_approvals_staff_read on public.driver_approvals;
create policy driver_approvals_staff_read on public.driver_approvals
  for select to authenticated
  using (branch_id in (select private.staff_branch_ids_with_capability('drivers.manage')));

-- ---------------------------------------------------------------------------------------------
-- 4. Driver schedules, per-branch availability and deliveries: members read, delivery.manage writes
-- ---------------------------------------------------------------------------------------------

drop policy if exists driver_schedules_staff on public.driver_schedules;
drop policy if exists driver_schedules_staff_read on public.driver_schedules;
create policy driver_schedules_staff_read on public.driver_schedules
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));
drop policy if exists driver_schedules_staff_write on public.driver_schedules;
create policy driver_schedules_staff_write on public.driver_schedules
  for all to authenticated
  using (branch_id in (select private.staff_branch_ids_with_capability('delivery.manage')))
  with check (branch_id in (select private.staff_branch_ids_with_capability('delivery.manage')));

drop policy if exists dba_staff on public.driver_branch_availability;
drop policy if exists dba_staff_read on public.driver_branch_availability;
create policy dba_staff_read on public.driver_branch_availability
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));
drop policy if exists dba_staff_write on public.driver_branch_availability;
create policy dba_staff_write on public.driver_branch_availability
  for all to authenticated
  using (branch_id in (select private.staff_branch_ids_with_capability('delivery.manage')))
  with check (branch_id in (select private.staff_branch_ids_with_capability('delivery.manage')));

drop policy if exists deliveries_staff on public.deliveries;
drop policy if exists deliveries_staff_read on public.deliveries;
create policy deliveries_staff_read on public.deliveries
  for select to authenticated
  using (branch_id in (select private.user_branch_ids()));
drop policy if exists deliveries_staff_write on public.deliveries;
create policy deliveries_staff_write on public.deliveries
  for all to authenticated
  using (branch_id in (select private.staff_branch_ids_with_capability('delivery.manage')))
  with check (branch_id in (select private.staff_branch_ids_with_capability('delivery.manage')));

-- ---------------------------------------------------------------------------------------------
-- 5. Subscription and invoice rows are the owner's
-- ---------------------------------------------------------------------------------------------

-- user_can_manage_billing: billing.manage at a branch of the restaurant (owner rows), the restaurant's
-- owner_user_id, or a platform admin (the /platform pages read subscriptions directly).
drop policy if exists subscriptions_owner_read on public.subscriptions;
create policy subscriptions_owner_read on public.subscriptions
  for select to authenticated
  using (private.user_can_manage_billing(restaurant_id));

drop policy if exists invoices_owner on public.invoices;
create policy invoices_owner on public.invoices
  for select to authenticated
  using (private.user_can_manage_billing(restaurant_id));

-- ---------------------------------------------------------------------------------------------
-- 6. Audit logs and the notification outbox
-- ---------------------------------------------------------------------------------------------

drop policy if exists audit_staff_read on public.audit_logs;
create policy audit_staff_read on public.audit_logs
  for select to authenticated
  using (
    branch_id in (select private.staff_branch_ids_with_capability('reports.view'))
    or (branch_id is null and private.user_administers_restaurant(restaurant_id))
    or private.user_is_platform_admin()
  );

drop policy if exists notifications_staff on public.notifications_outbox;
drop policy if exists notifications_staff_read on public.notifications_outbox;
create policy notifications_staff_read on public.notifications_outbox
  for select to authenticated
  using (branch_id in (select private.staff_branch_ids_with_capability('reports.view')));

-- ---------------------------------------------------------------------------------------------
-- 7. Branch identity is branch settings (D8)
-- ---------------------------------------------------------------------------------------------

-- Re-created from the live definition (20260830085951_role_helpers_include_admin.sql, identical
-- live). Only the branch-scope line is new.
create or replace function private.user_manages_restaurant(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    private.user_is_platform_admin()
    or exists (
      select 1 from public.restaurants r
       where r.id = p_restaurant_id and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.staff_members sm
       where sm.restaurant_id = p_restaurant_id
         and sm.user_id = auth.uid()
         and sm.status = 'active'
         and sm.role in ('owner', 'admin', 'manager')
         -- A row tied to one branch manages that branch (user_manages_branch), not the
         -- restaurant. An owner owns every branch whichever one their row names.
         and (sm.role = 'owner' or sm.branch_id is null)
    ),
    false);
$function$;

revoke execute on function private.user_manages_restaurant(uuid) from public, anon;

-- Re-created from the live definition (live-only). The owner-only block is unchanged; the manager
-- block is split into branch.settings (identity, tax, open state, time zone, theme, brand, the
-- settings JSON) and the branch's manager (opening hours).
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

-- Re-created from the live definition with the same name. It was USING/CHECK branch membership.
drop policy if exists branches_staff_update on public.branches;
create policy branches_staff_update on public.branches
  for update to authenticated
  using (private.staff_has_capability(id, 'branch.settings')
         or private.staff_has_capability(id, 'brand.edit')
         or private.user_manages_branch(id)
         or private.staff_has_capability(id, 'kitchen.access'))
  with check (private.staff_has_capability(id, 'branch.settings')
              or private.staff_has_capability(id, 'brand.edit')
              or private.user_manages_branch(id)
              or private.staff_has_capability(id, 'kitchen.access'));

-- Re-created from the live definition (live-only). Only the authorization check changed:
-- user_manages_branch -> branch.settings, the rule the column guard now applies to address and
-- geo_location.
create or replace function public.set_branch_location(p_branch_id uuid, p_address text, p_lat double precision default null::double precision, p_lng double precision default null::double precision)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_old_address text;
  v_restaurant_id uuid;
  v_addr text := nullif(btrim(coalesce(p_address, '')), '');
  v_geo geography(Point, 4326);
begin
  if auth.uid() is null then
    raise exception 'auth_required';
  end if;

  select b.address, b.restaurant_id
    into v_old_address, v_restaurant_id
    from public.branches b
   where b.id = p_branch_id;

  if not found then
    raise exception 'branch_not_found';
  end if;

  -- Same rule the branches column guard uses for address/geo_location: branch.settings at THIS
  -- branch (the owner, an admin; platform admins included).
  if not private.staff_has_capability(p_branch_id, 'branch.settings') then
    raise exception 'not_authorized'
      using hint = 'Only the restaurant owner or an admin can move a branch.';
  end if;

  if (p_lat is null) <> (p_lng is null) then
    raise exception 'invalid_location'
      using hint = 'Latitude and longitude must be supplied together.';
  end if;

  if p_lat is not null then
    if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
      raise exception 'invalid_location'
        using hint = 'Coordinates are out of range.';
    end if;

    -- (0,0) is Null Island in the Gulf of Guinea. It is never a restaurant; it
    -- is what an absent pin looks like after packages/database's `?? 0`, and
    -- accepting it would make "no location" indistinguishable from "located".
    if abs(p_lat) < 0.0001 and abs(p_lng) < 0.0001 then
      raise exception 'invalid_location'
        using hint = 'Drop the pin on the store.';
    end if;

    -- ST_MakePoint is LONGITUDE FIRST. Getting this backwards is silent —
    -- it yields a valid point in the wrong hemisphere, not an error.
    v_geo := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lng, p_lat), 4326)::geography;
  end if;

  -- The invariant this whole function exists to hold: you may not change the
  -- address without also saying where that address is. Silently keeping the old
  -- pin is exactly how branch 44444444 ended up 1,408 mi from its own street.
  if v_addr is distinct from v_old_address and p_lat is null then
    raise exception 'location_pin_required'
      using hint = 'Pick the new address on the map so delivery knows where to collect.';
  end if;

  update public.branches
     set address = v_addr,
         -- Null lat/lng means "address unchanged, leave the pin alone" — never
         -- "wipe the pin". A NULL geo_location makes the branch undispatchable
         -- (find_dispatch_candidates requires it), so it must take a deliberate act.
         geo_location = coalesce(v_geo, geo_location)
   where id = p_branch_id;

  return jsonb_build_object(
    'branch_id', p_branch_id,
    'address',   v_addr,
    'lat',       coalesce(p_lat, (select geo_lat from public.branches where id = p_branch_id)),
    'lng',       coalesce(p_lng, (select geo_lng from public.branches where id = p_branch_id))
  );
end
$function$;

-- patch_branch_settings answers with the branch's whole settings object, so every Pause or Busy
-- tap on a kitchen tablet carried the payment set-up, fees and delivery rules to it (KT-2). Rebuilt
-- from the live body (20260918160000_kitchen_ops); only the answer changes: a caller without
-- branch.settings gets the board's own keys (pause, busy, prep time, schedule lead time; the
-- board's OPS_SETTING_KEYS in kitchen-model.ts) and nothing else.
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

-- ---------------------------------------------------------------------------------------------
-- 8. A rider's old jobs stop showing the customer's contact (DR-2)
-- ---------------------------------------------------------------------------------------------

-- The window on its own, so it can be checked without a delivery: a job the rider still has (or
-- one that has not closed) shows the contact; a delivered, failed or cancelled one shows it for two
-- hours after it closed. A closed job with no known close time shows nothing.
create or replace function private.driver_sees_customer_contact(p_status public.delivery_status, p_closed_at timestamptz)
returns boolean
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select p_status not in ('delivered', 'failed', 'cancelled')
         or coalesce(p_closed_at, '-infinity'::timestamptz) > now() - interval '2 hours';
$function$;

revoke all on function private.driver_sees_customer_contact(public.delivery_status, timestamptz) from public, anon, authenticated;

comment on function private.driver_sees_customer_contact(public.delivery_status, timestamptz) is
  'get_driver_order: whether the rider still sees the customer''s phone, address and notes. Open jobs yes; delivered, failed or cancelled ones for 2 hours after they closed.';

-- Re-created from the live definition (20260922120000_order_lines_menu_order.sql, identical live).
-- New: the contact window and the 'contact_hidden' key. The close time is delivered_at for a
-- delivered job, else the end of this rider's assignment (fail_delivery, a cancel or a withdrawal
-- stamp delivery_assignments.ended_at).
create or replace function public.get_driver_order(p_delivery_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_driver_id uuid := private.driver_id_for_user();
  v_contact   boolean;
  v_result    jsonb;
begin
  if v_driver_id is null then raise exception 'not_a_driver'; end if;

  select private.driver_sees_customer_contact(
           d.status,
           coalesce(case when d.status = 'delivered' then d.delivered_at end,
                    (select max(a.ended_at)
                       from public.delivery_assignments a
                      where a.delivery_id = d.id
                        and a.driver_id = v_driver_id)))
    into v_contact
    from public.deliveries d
   where d.id = p_delivery_id
     and d.driver_id = v_driver_id;   -- caller must be the assigned/offered driver

  if not found then
    return null; -- not found / not theirs
  end if;

  select jsonb_build_object(
    'id', o.id,
    'order_number', o.order_number,
    'customer_name', o.customer_name,
    'customer_phone', case when v_contact then o.customer_phone end,
    'delivery_address', case when v_contact then o.delivery_address end,
    'customer_notes', case when v_contact then o.customer_notes end,
    'contact_hidden', not v_contact,
    'order_items', coalesce((
      select jsonb_agg(jsonb_build_object('item_name', oi.item_name, 'quantity', oi.quantity)
                       order by oi.category_position nulls last, oi.item_position nulls last,
                                oi.item_name collate "C",
                                private.order_line_options_key(oi.modifiers) collate "C",
                                oi.created_at, oi.id)
      from public.order_items oi where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  into v_result
  from public.deliveries d
  join public.orders o on o.id = d.order_id
  where d.id = p_delivery_id
    and d.driver_id = v_driver_id;

  return v_result;
end;
$function$;
