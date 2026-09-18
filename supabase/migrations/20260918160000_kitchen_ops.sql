-- Kitchen operations: branch settings are patched key by key, and cooks can tick off a line.
--
-- 1. public.patch_branch_settings(p_branch_id, p_patch) -> the branch's new settings.
--    Every writer of branches.settings (the kitchen's Pause / Busy pills and each Branch settings
--    card) read the whole JSON once, spread its change over that snapshot and wrote the whole blob
--    back. The kitchen board stays open for a whole service, so pressing Pause at 21:00 wrote back
--    the settings as they were at 17:00 and silently undid whatever the owner had changed since
--    (payment methods, the QR-transfer account, delivery fees, tips); a stale Branch settings tab
--    did the same to the kitchen, un-pausing a branch that had just paused.
--
--    The patch is merged in ONE UPDATE, so two writers can no longer overwrite each other's keys:
--      settings = coalesce(settings, '{}') || patch, and a key whose value is JSON null is removed.
--
--    Who may write which key:
--      * orders_paused, busy_extra_prep_min (the kitchen's operations keys): kitchen.access or
--        branch.settings at THIS branch. The same two keys private.guard_branch_privileged_columns()
--        already lets a non-manager change; the list here must stay in step with it.
--      * every other key: branch.settings at this branch.
--    Authority is private.staff_has_capability(), which covers an owner row pinned to another
--    branch, a restaurant-wide row, restaurants.owner_user_id and platform admins. Nothing is looser
--    than today: the UPDATE still runs every BEFORE UPDATE trigger on branches with the caller's
--    auth.uid(), so guard_branch_privileged_columns() keeps enforcing its rules as well.
--    The two operations keys are also type-checked, because quote_delivery() and is_branch_open()
--    cast them: a string in busy_extra_prep_min broke delivery quotes for the whole storefront.
--    A caller with neither capability is refused before anything else, so an empty patch cannot be
--    used to read the settings of a branch the caller could not otherwise see (an inactive one).
--
-- 2. public.set_order_item_prep_status(p_order_item_id, p_prep_status).
--    Each ticket draws one dot per line, green once the line is ready, but nothing ever wrote
--    order_items.prep_status (all 116 live rows were 'pending'), so the dots were dead. The board now
--    lets a cook tick a line off. This function is the only path the board uses for it: it writes
--    that one column and nothing else on the line, and it keeps working once order_items' staff
--    policy is narrowed. It does NOT by itself stop staff from editing a line: the order_items_staff
--    policy (FOR ALL to any staff of the order's branch, owned by the security migration) still
--    lets them UPDATE price and quantity directly; narrowing that policy is handed off. Gated by
--    kitchen.access at the order's branch; closed orders are left alone.
--
-- 3. order_items.combo_contents (jsonb) - added here with IF NOT EXISTS only so the kitchen's select
--    works whichever migration lands first. The column belongs to the order flow (place-order fills
--    it with the combo's dishes); nothing here writes it.
--
-- 4. private.tg_branches_settings_key_rules(), a BEFORE UPDATE trigger on branches.
--    The rules of section 1 held only inside the RPC. branches_staff_update lets any staff member of
--    the branch UPDATE the row, and guard_branch_privileged_columns() lets any of them change the
--    two operations keys and a manager change every key, so a direct UPDATE still let a cashier
--    pause the branch, store "abc" in busy_extra_prep_min (quote_delivery() then failed with 22P02
--    for every diner) and a manager change the payment methods. The trigger applies the RPC's rules
--    to the keys a write actually changes, on every path: the ops keys need kitchen.access or
--    branch.settings and must have the right type; any other key needs branch.settings; the
--    settings stay a JSON object. No screen writes branches.settings directly any more (the kitchen
--    and every Branch settings card go through the RPC), and the only other writer, copy_branch_setup(),
--    already requires branch.settings at the target. Writes without auth.uid() (service role, cron,
--    migrations) and platform admins pass, as in guard_branch_privileged_columns().

alter table public.order_items add column if not exists combo_contents jsonb;

-- 1. patch_branch_settings ---------------------------------------------------------------------

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
    return v_new;
  end if;

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

  return v_new;
end;
$function$;

comment on function public.patch_branch_settings(uuid, jsonb) is
  'Merge keys into branches.settings (a JSON null removes the key) and return the new settings. '
  'orders_paused / busy_extra_prep_min need kitchen.access or branch.settings; every other key needs branch.settings.';

revoke all on function public.patch_branch_settings(uuid, jsonb) from public, anon;
grant execute on function public.patch_branch_settings(uuid, jsonb) to authenticated;

-- 2. set_order_item_prep_status ----------------------------------------------------------------

create or replace function public.set_order_item_prep_status(p_order_item_id uuid, p_prep_status text)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branch_id uuid;
  v_status    text;
begin
  if auth.uid() is null then
    raise exception 'sign_in_required' using errcode = '42501';
  end if;

  -- The values order_items_prep_status_check allows.
  if p_prep_status is null or p_prep_status not in ('pending', 'in_progress', 'ready', 'served') then
    raise exception 'invalid_prep_status' using errcode = '22023';
  end if;

  select o.branch_id, o.status::text
    into v_branch_id, v_status
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where oi.id = p_order_item_id;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  if not private.staff_has_capability(v_branch_id, 'kitchen.access') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if v_status not in ('pending', 'confirmed', 'preparing', 'ready') then
    raise exception 'order_closed' using errcode = 'P0001';
  end if;

  update public.order_items set prep_status = p_prep_status where id = p_order_item_id;
  return p_prep_status;
end;
$function$;

comment on function public.set_order_item_prep_status(uuid, text) is
  'Kitchen: mark one order line pending / in_progress / ready / served. Needs kitchen.access at the order''s branch.';

revoke all on function public.set_order_item_prep_status(uuid, text) from public, anon;
grant execute on function public.set_order_item_prep_status(uuid, text) to authenticated;

-- 4. The same key rules on every write path ---------------------------------------------------

create or replace function private.tg_branches_settings_key_rules()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  -- Keep in step with v_ops_keys in public.patch_branch_settings().
  v_ops_keys constant text[] := array['orders_paused', 'busy_extra_prep_min'];
  v_old      jsonb;
  v_key      text;
  v_value    jsonb;
  v_minutes  numeric;
  v_ops      boolean := false;
  v_other    boolean := false;
begin
  if new.settings is not distinct from old.settings then
    return new;
  end if;

  -- Not staff: the service role, cron and migrations (no auth.uid()), and platform admins.
  if auth.uid() is null or private.user_is_platform_admin() then
    return new;
  end if;

  if jsonb_typeof(new.settings) is distinct from 'object' then
    raise exception 'invalid_setting_value'
      using errcode = '22023', hint = 'Branch settings must be a JSON object.';
  end if;

  v_old := case when jsonb_typeof(old.settings) = 'object' then old.settings else '{}'::jsonb end;

  -- Only the keys this write adds, removes or changes: a stale value somewhere else in the blob
  -- is not the caller's doing and must not block a pause.
  for v_key in
    select k.key from (select jsonb_object_keys(v_old) as key
                       union
                       select jsonb_object_keys(new.settings)) k
  loop
    continue when (v_old -> v_key) is not distinct from (new.settings -> v_key);

    if v_key = any (v_ops_keys) then
      v_ops := true;
      v_value := new.settings -> v_key;  -- SQL null when the write removed the key

      if v_key = 'orders_paused' and coalesce(jsonb_typeof(v_value), 'null') not in ('boolean', 'null') then
        raise exception 'invalid_setting_value'
          using errcode = '22023', hint = 'orders_paused must be true or false.';
      end if;

      if v_key = 'busy_extra_prep_min' and coalesce(jsonb_typeof(v_value), 'null') <> 'null' then
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
    else
      v_other := true;
    end if;
  end loop;

  if v_other and not private.staff_has_capability(old.id, 'branch.settings') then
    raise exception 'not_authorized'
      using errcode = '42501',
            hint = 'Changing branch settings needs the branch settings permission at this branch.';
  end if;

  if v_ops and not (private.staff_has_capability(old.id, 'kitchen.access')
                    or private.staff_has_capability(old.id, 'branch.settings')) then
    raise exception 'not_authorized'
      using errcode = '42501',
            hint = 'Pausing orders and busy mode need kitchen access at this branch.';
  end if;

  return new;
end;
$function$;

comment on function private.tg_branches_settings_key_rules() is
  'BEFORE UPDATE on branches: the patch_branch_settings() key rules for every write of branches.settings.';

revoke all on function private.tg_branches_settings_key_rules() from public, anon, authenticated;

drop trigger if exists branches_settings_key_rules on public.branches;
create trigger branches_settings_key_rules
  before update on public.branches
  for each row
  execute function private.tg_branches_settings_key_rules();
