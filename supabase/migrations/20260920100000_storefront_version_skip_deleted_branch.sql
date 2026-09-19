-- Deleting a branch or a restaurant failed with 23503, first on storefront_versions_branch_id_fkey
-- and then on billing_entitlements_restaurant_id_fkey.
--
-- The cascade removes the branch's menu items, categories, hours and combos, and each of those
-- deletes fires private.bump_storefront_version, which upserts a storefront_versions row for the
-- branch. By then the branch row is already gone, so the insert breaks the foreign key and the
-- whole delete rolls back: a trial restaurant could not be removed at all (found removing the
-- account bobbybkk123@gmail.com and its restaurant, 2026-09-20). A branch that no longer exists
-- has no storefront to refresh, so the bump now skips it; its storefront_versions row goes with
-- the branch through its own cascade.

create or replace function private.bump_storefront_version()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
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
     -- Mid-cascade the branch is already deleted: nothing left to refresh.
     and exists (select 1 from public.branches x where x.id = b)
  on conflict (branch_id) do update
    set version = public.storefront_versions.version + 1,
        updated_at = now();

  return null;
end;
$function$;

-- The same trap one level up: deleting the restaurant cascades to its subscription, whose trigger
-- recomputes billing_entitlements for a restaurant that no longer exists.
CREATE OR REPLACE FUNCTION private.billing_compute(p_restaurant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sub              public.subscriptions%rowtype;
  v_plan_code        text := 'none';
  v_status           text := 'none';
  v_entitled_through timestamptz;
  v_trial_ends_at    timestamptz;
  v_seats            integer := 0;
  v_total            numeric(10,2) := 0;
  v_features         jsonb := '{}'::jsonb;
  v_addons           text[] := '{}'::text[];
  v_overrides        jsonb := '{}'::jsonb;
begin
  if p_restaurant_id is null then return; end if;
  -- Mid-cascade (a restaurant being deleted takes its subscription with it) the restaurant row is
  -- already gone, and writing its entitlements would break billing_entitlements_restaurant_id_fkey
  -- and roll the whole delete back.
  if not exists (select 1 from public.restaurants where id = p_restaurant_id) then return; end if;

  select * into v_sub
  from public.subscriptions
  where restaurant_id = p_restaurant_id
  limit 1;

  if found then
    v_status        := v_sub.status::text;
    v_trial_ends_at := v_sub.trial_ends_at;

    -- Deadline. past_due and cancelled keep access until the paid period ends.
    if v_status in ('trialing', 'active', 'past_due', 'cancelled') then
      v_entitled_through := greatest(v_sub.current_period_end, v_sub.trial_ends_at);
    else
      v_entitled_through := null;
    end if;

    -- One row per line item: seats, money, add-on list, plan code.
    select
      coalesce(sum(coalesce(bp.included_seats, 0) + coalesce(bp.seats_per_unit, 0) * si.quantity), 0),
      coalesce(sum(si.unit_price * si.quantity), 0),
      coalesce(array_agg(distinct bp.code) filter (where bp.kind = 'addon'), '{}'::text[]),
      coalesce(min(bp.code) filter (where bp.kind = 'plan'), 'none')
    into v_seats, v_total, v_addons, v_plan_code
    from public.subscription_items si
    join public.billing_products bp on bp.code = si.product_code
    where si.subscription_id = v_sub.id;

    -- Feature grants are a set union, computed separately so it cannot skew the sums.
    select coalesce(jsonb_object_agg(k, true), '{}'::jsonb)
    into v_features
    from (
      select distinct f.key as k
      from public.subscription_items si
      join public.billing_products bp on bp.code = si.product_code
      cross join lateral jsonb_each(bp.features) f
      where si.subscription_id = v_sub.id
        and f.value = to_jsonb(true)
    ) keys;

    if coalesce(v_sub.plan_code, '') <> '' and v_plan_code = 'none' then
      v_plan_code := v_sub.plan_code;
    end if;
  end if;

  -- The override is applied LAST, on top of whatever the package resolved to,
  -- and outside the `found` branch so it also covers a restaurant with no
  -- subscription row at all. A forced-on key still needs entitled_through to be
  -- live: this switch controls WHICH features, never WHETHER they are paid for.
  select coalesce(r.feature_overrides, '{}'::jsonb)
    into v_overrides
  from public.restaurants r
  where r.id = p_restaurant_id;

  if coalesce(v_overrides, '{}'::jsonb) <> '{}'::jsonb then
    select coalesce(jsonb_object_agg(merged.k, true), '{}'::jsonb)
      into v_features
    from (
      -- kept from the package, unless explicitly switched off
      select k from jsonb_object_keys(v_features) as k
      where coalesce(v_overrides -> k, 'null'::jsonb) is distinct from to_jsonb(false)
      union
      -- granted by the switch alone
      select e.key from jsonb_each(v_overrides) e where e.value = to_jsonb(true)
    ) merged(k);
  end if;

  insert into public.billing_entitlements as be
    (restaurant_id, plan_code, status, entitled_through, trial_ends_at,
     branch_seats, monthly_total, features, addons, computed_at)
  values
    (p_restaurant_id, v_plan_code, v_status, v_entitled_through, v_trial_ends_at,
     v_seats, v_total, v_features, v_addons, now())
  on conflict (restaurant_id) do update set
    plan_code        = excluded.plan_code,
    status           = excluded.status,
    entitled_through = excluded.entitled_through,
    trial_ends_at    = excluded.trial_ends_at,
    branch_seats     = excluded.branch_seats,
    monthly_total    = excluded.monthly_total,
    features         = excluded.features,
    addons           = excluded.addons,
    computed_at      = now();

  update public.branches
     set entitled_through = v_entitled_through
   where restaurant_id = p_restaurant_id
     and entitled_through is distinct from v_entitled_through;
end $function$;
